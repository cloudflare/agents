import type { AISDKInstrumentationOptions } from "../options.js";
import { readString } from "../read.js";
import { operationSpan } from "../../../genai/telemetry.js";
import type { SemanticContext } from "../../../genai/telemetry.js";
import type { Tracer } from "../../../tracing/tracer.js";
import { extractModelInfo, extractRequestSummary, finishAttributesFromResult } from "./extract.js";
import type { ModelInfo } from "./extract.js";
import { wrapModel } from "./model.js";
import { finishWhenStreamCompletes } from "./streams.js";
import { wrapTools } from "./tools.js";
import type {
  AISDKV6CallParams,
  AISDKV6Operation,
  AISDKV6WrapLanguageModel,
} from "./types.js";

type AISDKV6OperationName =
  | "generateObject"
  | "generateText"
  | "streamObject"
  | "streamText";

export type { AISDKV6Namespace } from "./types.js";

/** Tracing configuration for the AI SDK v6 wrapper. */
export type AISDKV6Instrumentation = {
  readonly options?: AISDKInstrumentationOptions;
  readonly tracer: Tracer;
};

/**
 * Wraps an AI SDK namespace object with v6 tracing while preserving its public
 * shape and overloaded call signatures.
 */
export function createAISDKV6Wrapper<T extends Record<string, unknown>>(
  ai: T,
  instrumentation: AISDKV6Instrumentation,
): T {
  const target = isModuleNamespace(ai) ? Object.setPrototypeOf({}, ai) : ai;

  return new Proxy(target, {
    get(proxyTarget, property, receiver) {
      const original = Reflect.get(proxyTarget, property, receiver) as unknown;
      const wrapLanguageModel = readWrapLanguageModel(ai);

      if (isWrappedOperationName(property) && typeof original === "function") {
        return createOperationWrapper(
          property,
          toAISDKV6Operation(original),
          wrapLanguageModel,
          instrumentation,
        );
      }

      return original;
    },
  }) as T;
}

function readWrapLanguageModel(ai: Record<string, unknown>): AISDKV6WrapLanguageModel | undefined {
  const value = ai.wrapLanguageModel;
  if (typeof value !== "function") {
    return undefined;
  }

  // SAFETY: This is a vendored structural contract for the AI SDK v6 adapter;
  // the public wrapper preserves the caller's AI SDK type instead of importing ai.
  return value as AISDKV6WrapLanguageModel;
}

function toAISDKV6Operation(value: unknown): AISDKV6Operation {
  // SAFETY: The proxy only calls this after selecting known AI SDK operation
  // export names. The adapter uses the narrow params fields it reads/replaces.
  return value as AISDKV6Operation;
}

function isModuleNamespace(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (value.constructor?.name === "Module") {
    return true;
  }

  try {
    const keys = Object.keys(value);
    const firstKey = keys[0];
    if (firstKey === undefined) {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, firstKey);
    return descriptor ? !descriptor.configurable && !descriptor.writable : false;
  } catch {
    return false;
  }
}

function createOperationWrapper(
  operationName: AISDKV6OperationName,
  operation: AISDKV6Operation,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  instrumentation: AISDKV6Instrumentation,
): AISDKV6Operation {
  if (isStreamOperation(operationName)) {
    return (params, ...args) => {
      const model = extractModelInfo(params.model);
      const span = operationSpanForCall(operationName, model, params, instrumentation.options);
      return instrumentation.tracer.startSpan(
        span.name,
        span.attributes,
        (operationSpan) => {
          const result = operation(
            operationParamsForCall(
              params,
              operationName,
              wrapLanguageModel,
              instrumentation.tracer,
            ),
            ...args,
          );

          return finishWhenStreamCompletes(result, operationSpan);
        },
      );
    };
  }

  return async (params, ...args) => {
    const model = extractModelInfo(params.model);
    const span = operationSpanForCall(operationName, model, params, instrumentation.options);
    return instrumentation.tracer.withSpan(
      span.name,
      span.attributes,
      async (operationSpan) => {
        const result = await operation(
          operationParamsForCall(
            params,
            operationName,
            wrapLanguageModel,
            instrumentation.tracer,
          ),
          ...args,
        );

        operationSpan.finish(finishAttributesFromResult(result));
        return result;
      },
    );
  };
}

function operationParamsForCall(
  params: AISDKV6CallParams,
  operationName: AISDKV6OperationName,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  tracer: Tracer,
): AISDKV6CallParams {
  return {
    ...params,
    ...(shouldWrapTools(operationName) && params.tools !== undefined
      ? { tools: wrapTools(tracer, params.tools) }
      : {}),
    ...(params.model !== undefined
      ? { model: wrapModel(tracer, wrapLanguageModel, params.model, operationName) }
      : {}),
  };
}

function isStreamOperation(operationName: AISDKV6OperationName): boolean {
  return operationName === "streamObject" || operationName === "streamText";
}

function shouldWrapTools(operationName: AISDKV6OperationName): boolean {
  return operationName === "generateText" || operationName === "streamText";
}

function isWrappedOperationName(value: PropertyKey): value is AISDKV6OperationName {
  return (
    value === "generateObject" ||
    value === "generateText" ||
    value === "streamObject" ||
    value === "streamText"
  );
}

function operationSpanForCall(
  operation: string,
  model: ModelInfo | undefined,
  params: AISDKV6CallParams,
  options: AISDKInstrumentationOptions | undefined,
): ReturnType<typeof operationSpan> {
  return operationSpan({
    attributes: contextAttributes(params, options),
    context: semanticContext(params),
    integration: "ai-sdk",
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(params, operation),
  });
}

/**
 * Reads agent/conversation semantic context from the AI SDK's own
 * `experimental_telemetry` fields — `metadata` (per-call custom attributes)
 * and `functionId` (a natural fallback for agent name). There is no
 * package-level default; callers who want these attributes set them per
 * call through the SDK's native telemetry option.
 */
function semanticContext(params: AISDKV6CallParams): SemanticContext {
  const telemetry = typeof params.experimental_telemetry === "object" &&
    params.experimental_telemetry !== null
    ? params.experimental_telemetry as Record<string, unknown>
    : undefined;
  const metadata = typeof telemetry?.metadata === "object" && telemetry.metadata !== null
    ? telemetry.metadata as Record<string, unknown>
    : undefined;

  return {
    agentId: metadataValue(metadata, "agentId", "gen_ai.agent.id"),
    agentName:
      metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
      readString(telemetry?.functionId),
    agentVersion: metadataValue(metadata, "agentVersion", "gen_ai.agent.version"),
    conversationId: metadataValue(metadata, "conversationId", "gen_ai.conversation.id"),
  };
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
  semanticKey: string,
): string | undefined {
  return readString(metadata?.[key] ?? metadata?.[semanticKey]);
}

function contextAttributes(
  params: AISDKV6CallParams,
  options: AISDKInstrumentationOptions | undefined,
): Record<string, string | number | boolean> | undefined {
  const attributes: Record<string, string | number | boolean> = {};

  const runtimeContext =
    typeof params.experimental_context === "object" && params.experimental_context !== null
      // SAFETY: AI SDK experimental_context is a user-provided record of scalar values.
      ? (params.experimental_context as Record<string, unknown>)
      : undefined;

  for (const key of options?.includeRuntimeContext ?? []) {
    const value = runtimeContext?.[key];
    if (isScalarAttributeValue(value)) {
      attributes[`ai.runtime_context.${key}`] = value;
    }
  }

  const toolsContext =
    typeof params.toolsContext === "object" && params.toolsContext !== null
      // SAFETY: AI SDK toolsContext is a user-provided record of per-tool context records.
      ? (params.toolsContext as Record<string, unknown>)
      : undefined;

  for (const [toolName, keys] of Object.entries(options?.includeToolsContext ?? {})) {
    const toolContextValue = toolsContext?.[toolName];
    const toolContext =
      typeof toolContextValue === "object" && toolContextValue !== null
        // SAFETY: Each tool's context is a record of scalar values.
        ? (toolContextValue as Record<string, unknown>)
        : undefined;
    for (const key of keys) {
      const value = toolContext?.[key];
      if (isScalarAttributeValue(value)) {
        attributes[`ai.tool_context.${toolName}.${key}`] = value;
      }
    }
  }

  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function isScalarAttributeValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
