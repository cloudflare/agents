import type { AISDKInstrumentationOptions } from "../options";
import { readBoolean, readString } from "../read";
import {
  metadataAttributes,
  operationSpan,
  operationSpanName
} from "../../genai/telemetry";
import type { SemanticContext } from "../../genai/telemetry";
import { writeSpanAttributes } from "../../tracing/tracer";
import type { AgentTracer } from "../../tracing/tracer";
import {
  extractInputContent,
  extractModelInfo,
  extractRequestSummary,
  finishAttributesFromResult
} from "./extract";
import type { ModelInfo } from "./extract";
import { wrapModel } from "./model";
import { finishWhenStreamCompletes } from "./streams";
import { wrapTools } from "./tools";
import type { ContentRecording } from "./tools";
import type {
  AISDKV6CallParams,
  AISDKV6Operation,
  AISDKV6WrapLanguageModel
} from "./types";

type AISDKV6OperationName =
  | "generateObject"
  | "generateText"
  | "streamObject"
  | "streamText";

export type { AISDKV6Namespace } from "./types";

/** Tracing configuration for the AI SDK v6 wrapper. */
export type AISDKV6Instrumentation = {
  readonly options?: AISDKInstrumentationOptions;
  readonly tracer: AgentTracer;
};

/**
 * Wraps an AI SDK namespace object with v6 tracing while preserving its public
 * shape and overloaded call signatures.
 */
export function createAISDKV6Wrapper<T extends Record<string, unknown>>(
  ai: T,
  instrumentation: AISDKV6Instrumentation
): T {
  const target = isModuleNamespace(ai) ? Object.setPrototypeOf({}, ai) : ai;
  // Cache wrappers so repeated property reads return the same function
  // (memoization patterns like `wrapped.streamText === wrapped.streamText`).
  const wrapperCache = new Map<PropertyKey, AISDKV6Operation>();

  return new Proxy(target, {
    get(proxyTarget, property, receiver) {
      const original = Reflect.get(proxyTarget, property, receiver) as unknown;

      if (isWrappedOperationName(property) && typeof original === "function") {
        let wrapper = wrapperCache.get(property);
        if (!wrapper) {
          wrapper = createOperationWrapper(
            property,
            toAISDKV6Operation(original),
            readWrapLanguageModel(ai),
            instrumentation
          );
          wrapperCache.set(property, wrapper);
        }
        return wrapper;
      }

      return original;
    }
  }) as T;
}

function readWrapLanguageModel(
  ai: Record<string, unknown>
): AISDKV6WrapLanguageModel | undefined {
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
    return descriptor
      ? !descriptor.configurable && !descriptor.writable
      : false;
  } catch {
    return false;
  }
}

function createOperationWrapper(
  operationName: AISDKV6OperationName,
  operation: AISDKV6Operation,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  instrumentation: AISDKV6Instrumentation
): AISDKV6Operation {
  // Only the span NAME is computed before the sampling check (it is required
  // to open a span at all, and needs a single metadata property the SDK reads
  // anyway). The full attribute spec — metadata enumeration, request fields,
  // context allowlists — is computed lazily, after isTraced confirms someone
  // is listening, so untraced calls never touch caller getters beyond that.
  if (isStreamOperation(operationName)) {
    return (params, ...args) => {
      return instrumentation.tracer.openSpan(
        operationSpanName(agentNameForCall(params)),
        {},
        (operationSpan) => {
          // Untraced invocations take the pristine path: original params, no
          // tool wrapping, no model middleware, no stream patching.
          if (!operationSpan.isTraced) {
            operationSpan.finish();
            return operation(params, ...args);
          }

          const content = contentRecordingForCall(
            params,
            instrumentation.options
          );
          const span = operationSpanForCall(
            operationName,
            extractModelInfo(params.model),
            params,
            instrumentation.options,
            content
          );
          writeSpanAttributes(operationSpan, span.attributes);

          const startedAtMs = Date.now();
          const result = operation(
            operationParamsForCall(
              params,
              operationName,
              wrapLanguageModel,
              instrumentation.tracer,
              content
            ),
            ...args
          );
          const hasModelSpan = canWrapModel(wrapLanguageModel, params.model);

          return finishWhenStreamCompletes(result, operationSpan, {
            includeResponse: !hasModelSpan,
            recordOutputs: content.recordOutputs,
            startedAtMs: hasModelSpan ? undefined : startedAtMs
          });
        }
      );
    };
  }

  return async (params, ...args) => {
    return instrumentation.tracer.withSpan(
      operationSpanName(agentNameForCall(params)),
      {},
      async (operationSpan) => {
        if (!operationSpan.isTraced) {
          return operation(params, ...args);
        }

        const content = contentRecordingForCall(
          params,
          instrumentation.options
        );
        const span = operationSpanForCall(
          operationName,
          extractModelInfo(params.model),
          params,
          instrumentation.options,
          content
        );
        writeSpanAttributes(operationSpan, span.attributes);

        const result = await operation(
          operationParamsForCall(
            params,
            operationName,
            wrapLanguageModel,
            instrumentation.tracer,
            content
          ),
          ...args
        );

        operationSpan.finish(
          finishAttributesFromResult(result, {
            includeResponse: !canWrapModel(wrapLanguageModel, params.model),
            recordOutputs: content.recordOutputs
          })
        );
        return result;
      }
    );
  };
}

/**
 * Reads only the agent name (metadata.agentName / gen_ai.agent.name /
 * functionId) for the span name. `functionId` is the AI SDK's canonical
 * projection to `gen_ai.agent.name`; an explicit metadata name takes priority.
 */
function agentNameForCall(params: AISDKV6CallParams): string | undefined {
  const telemetry =
    typeof params.experimental_telemetry === "object" &&
    params.experimental_telemetry !== null
      ? (params.experimental_telemetry as Record<string, unknown>)
      : undefined;
  const metadata =
    typeof telemetry?.metadata === "object" && telemetry.metadata !== null
      ? (telemetry.metadata as Record<string, unknown>)
      : undefined;

  return (
    readString(metadata?.agentName ?? metadata?.["gen_ai.agent.name"]) ??
    readString(telemetry?.functionId)
  );
}

function operationParamsForCall(
  params: AISDKV6CallParams,
  operationName: AISDKV6OperationName,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  tracer: AgentTracer,
  content: ContentRecording
): AISDKV6CallParams {
  return {
    ...params,
    ...(shouldWrapTools(operationName) && params.tools !== undefined
      ? { tools: wrapTools(tracer, params.tools, content) }
      : {}),
    ...(params.model !== undefined
      ? {
          model: wrapModel(
            tracer,
            wrapLanguageModel,
            params.model,
            operationName
          )
        }
      : {})
  };
}

function canWrapModel(
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  model: unknown
): boolean {
  return (
    wrapLanguageModel !== undefined &&
    typeof model === "object" &&
    model !== null
  );
}

function isStreamOperation(operationName: AISDKV6OperationName): boolean {
  return operationName === "streamObject" || operationName === "streamText";
}

function shouldWrapTools(operationName: AISDKV6OperationName): boolean {
  return operationName === "generateText" || operationName === "streamText";
}

function isWrappedOperationName(
  value: PropertyKey
): value is AISDKV6OperationName {
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
  content: ContentRecording
): ReturnType<typeof operationSpan> {
  return operationSpan({
    attributes: {
      ...metadataAttributes(telemetryMetadata(params)),
      ...contextAttributes(params, options)
    },
    // Opt-in chat inputs (prompt/messages) on the operation root span; only
    // read from caller params when recordInputs is set. Potentially PII.
    content: content.recordInputs
      ? { inputMessages: extractInputContent(params) }
      : undefined,
    context: semanticContext(params),
    integration: "ai-sdk",
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(params, operation)
  });
}

/**
 * Resolves opt-in content recording for a call. The per-call
 * `experimental_telemetry.recordInputs`/`recordOutputs` settings (the AI SDK's
 * own {@link https://sdk.vercel.ai TelemetrySettings} vocabulary) are
 * authoritative and may opt in OR out; they fall back to the wrapper-level
 * option, and finally to `false`. Content is potentially PII, so the effective
 * default is OFF and content is emitted only when a flag resolves to `true`.
 */
function contentRecordingForCall(
  params: AISDKV6CallParams,
  options: AISDKInstrumentationOptions | undefined
): ContentRecording {
  const telemetry =
    typeof params.experimental_telemetry === "object" &&
    params.experimental_telemetry !== null
      ? (params.experimental_telemetry as Record<string, unknown>)
      : undefined;

  return {
    recordInputs:
      readBoolean(telemetry?.recordInputs) ?? options?.recordInputs ?? false,
    recordOutputs:
      readBoolean(telemetry?.recordOutputs) ?? options?.recordOutputs ?? false
  };
}

/** Reads the per-call `experimental_telemetry.metadata` record, if present. */
function telemetryMetadata(
  params: AISDKV6CallParams
): Record<string, unknown> | undefined {
  const telemetry =
    typeof params.experimental_telemetry === "object" &&
    params.experimental_telemetry !== null
      ? (params.experimental_telemetry as Record<string, unknown>)
      : undefined;

  return typeof telemetry?.metadata === "object" && telemetry.metadata !== null
    ? (telemetry.metadata as Record<string, unknown>)
    : undefined;
}

/**
 * Reads agent/conversation semantic context from the AI SDK's own
 * `experimental_telemetry` fields. The AI SDK maps `functionId` to
 * `gen_ai.agent.name`; explicit `metadata.agentName` / `gen_ai.agent.name`
 * takes priority. Other semantic fields come only from metadata.
 */
function semanticContext(params: AISDKV6CallParams): SemanticContext {
  const telemetry =
    typeof params.experimental_telemetry === "object" &&
    params.experimental_telemetry !== null
      ? (params.experimental_telemetry as Record<string, unknown>)
      : undefined;
  const metadata =
    typeof telemetry?.metadata === "object" && telemetry.metadata !== null
      ? (telemetry.metadata as Record<string, unknown>)
      : undefined;

  return {
    agentId: metadataValue(metadata, "agentId", "gen_ai.agent.id"),
    agentName:
      metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
      readString(telemetry?.functionId),
    agentVersion: metadataValue(
      metadata,
      "agentVersion",
      "gen_ai.agent.version"
    ),
    conversationId: metadataValue(
      metadata,
      "conversationId",
      "gen_ai.conversation.id"
    )
  };
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
  semanticKey: string
): string | undefined {
  return readString(metadata?.[key] ?? metadata?.[semanticKey]);
}

function contextAttributes(
  params: AISDKV6CallParams,
  options: AISDKInstrumentationOptions | undefined
): Record<string, string | number | boolean> | undefined {
  const attributes: Record<string, string | number | boolean> = {};

  const runtimeContext =
    typeof params.experimental_context === "object" &&
    params.experimental_context !== null
      ? // SAFETY: AI SDK experimental_context is a user-provided record of scalar values.
        (params.experimental_context as Record<string, unknown>)
      : undefined;

  for (const key of options?.includeRuntimeContext ?? []) {
    const value = runtimeContext?.[key];
    if (isScalarAttributeValue(value)) {
      attributes[`cloudflare.agents.runtime_context.${key}`] = value;
    }
  }

  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function isScalarAttributeValue(
  value: unknown
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
