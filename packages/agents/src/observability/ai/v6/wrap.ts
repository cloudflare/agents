import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../../../internal_context";
import type {
  AISDKInstrumentationOptions,
  ResolvedAISDKStorageOptions
} from "../options";
import { readString } from "../read";
import { TraceAttribute } from "../../genai/attributes";
import {
  metadataAttributes,
  operationSpan,
  operationSpanName
} from "../../genai/telemetry";
import type { SemanticContext } from "../../genai/telemetry";
import { writeSpanAttributes } from "../../tracing/tracer";
import type { AgentTracer } from "../../tracing/tracer";
import {
  extractModelInfo,
  extractRequestSummary,
  finishAttributesFromResult
} from "./extract";
import type { ModelInfo } from "./extract";
import { wrapModel } from "./model";
import { finishWhenStreamCompletes } from "./streams";
import {
  recordDeniedApprovalResponses,
  wrapToolApprovalPolicy,
  wrapTools
} from "./tools";
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
  const storage: ResolvedAISDKStorageOptions = {
    storeMessages: instrumentation.options?.storeMessages === true,
    storeTools: instrumentation.options?.storeTools === true
  };

  // Only the span NAME is computed before the sampling check (it is required
  // to open a span at all, and needs a single metadata property the SDK reads
  // anyway). The full attribute spec — metadata enumeration, request fields,
  // context allowlists — is computed lazily, after isTraced confirms someone
  // is listening, so untraced calls never touch caller getters beyond that.
  if (isStreamOperation(operationName)) {
    return (params, ...args) => {
      const boundToInvocation = isAISDKInvocationBounded(params);
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

          const span = operationSpanForCall(
            operationName,
            extractModelInfo(params.model),
            params,
            instrumentation.options
          );
          writeSpanAttributes(operationSpan, span.attributes);
          recordDeniedApprovalResponses(
            instrumentation.tracer,
            params.messages
          );

          const startedAtMs = Date.now();
          const result = operation(
            operationParamsForCall(
              params,
              operationName,
              wrapLanguageModel,
              instrumentation.tracer,
              storage,
              boundToInvocation
            ),
            ...args
          );
          const hasModelSpan = canWrapModel(wrapLanguageModel, params.model);

          return finishWhenStreamCompletes(result, operationSpan, {
            includeResponse: !hasModelSpan,
            startedAtMs: hasModelSpan ? undefined : startedAtMs
          });
        },
        boundToInvocation ? { boundToInvocation: true } : undefined
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

        const span = operationSpanForCall(
          operationName,
          extractModelInfo(params.model),
          params,
          instrumentation.options
        );
        writeSpanAttributes(operationSpan, span.attributes);
        recordDeniedApprovalResponses(instrumentation.tracer, params.messages);

        const result = await operation(
          operationParamsForCall(
            params,
            operationName,
            wrapLanguageModel,
            instrumentation.tracer,
            storage
          ),
          ...args
        );

        operationSpan.finish(
          finishAttributesFromResult(result, {
            includeResponse: !canWrapModel(wrapLanguageModel, params.model)
          })
        );
        return result;
      }
    );
  };
}

/**
 * Reads only the agent name for the span name, from the same sources and in
 * the same order as {@link semanticContext}, so the span name and
 * `gen_ai.agent.name` never disagree. `functionId` is the AI SDK's canonical
 * projection; an explicit name from v6 metadata or v7 runtime context wins.
 */
function agentNameForCall(params: AISDKV6CallParams): string | undefined {
  const telemetry = telemetryOptions(params);
  const metadata = telemetryMetadata(params);
  const runtimeContext =
    typeof params.runtimeContext === "object" && params.runtimeContext !== null
      ? (params.runtimeContext as Record<string, unknown>)
      : undefined;

  return (
    metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
    metadataValue(runtimeContext, "agentName", "gen_ai.agent.name") ??
    readString(telemetry?.functionId)
  );
}

function operationParamsForCall(
  params: AISDKV6CallParams,
  operationName: AISDKV6OperationName,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  tracer: AgentTracer,
  storage: ResolvedAISDKStorageOptions,
  boundToInvocation = false
): AISDKV6CallParams {
  const approvedToolCalls = new Map<string, string>();
  return {
    ...params,
    ...(shouldWrapTools(operationName) && params.tools !== undefined
      ? {
          tools: wrapTools(
            tracer,
            params.tools,
            storage.storeTools,
            boundToInvocation,
            approvedToolCalls
          )
        }
      : {}),
    ...(params.toolApproval !== undefined
      ? {
          toolApproval: wrapToolApprovalPolicy(
            tracer,
            params.toolApproval,
            approvedToolCalls
          )
        }
      : {}),
    ...(params.model !== undefined
      ? {
          model: wrapModel(
            tracer,
            wrapLanguageModel,
            params.model,
            operationName,
            storage.storeMessages,
            boundToInvocation
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
  options: AISDKInstrumentationOptions | undefined
): ReturnType<typeof operationSpan> {
  return operationSpan({
    attributes: {
      ...metadataAttributes(
        includedRuntimeContext(params),
        TraceAttribute.Cloudflare.RuntimeContextPrefix
      ),
      ...metadataAttributes(telemetryMetadata(params)),
      ...contextAttributes(params, options)
    },
    context: semanticContext(params),
    integration: "ai-sdk",
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(params, operation)
  });
}

/** Reads the per-call `experimental_telemetry.metadata` record, if present. */
function telemetryMetadata(
  params: AISDKV6CallParams
): Record<string, unknown> | undefined {
  const telemetry = telemetryOptions(params);

  return typeof telemetry?.metadata === "object" && telemetry.metadata !== null
    ? (telemetry.metadata as Record<string, unknown>)
    : undefined;
}

function telemetryOptions(
  params: AISDKV6CallParams
): Record<string, unknown> | undefined {
  const telemetryValue = params.telemetry ?? params.experimental_telemetry;

  return typeof telemetryValue === "object" && telemetryValue !== null
    ? (telemetryValue as Record<string, unknown>)
    : undefined;
}

/**
 * The v7 stand-in for `experimental_telemetry.metadata`.
 *
 * v7 dropped `metadata` from its telemetry options; callers put the same
 * values in `runtimeContext` and mark the telemetry-visible ones through the
 * SDK's own `telemetry.includeRuntimeContext`. Running the included subset
 * through {@link metadataAttributes} is what keeps reserved keys — Think's
 * `cloudflare.agents.turn.*` above all — on the attribute names v6 emits, so
 * a query written against v6 traces still matches v7 ones. Everything else
 * passes through as documented, under `cloudflare.agents.runtime_context.*`.
 *
 * Runtime context the caller did not mark as included stays off the span: on
 * v7 it is a general application-data channel, not a telemetry bag.
 */
function includedRuntimeContext(
  params: AISDKV6CallParams
): Record<string, unknown> | undefined {
  const runtimeContextValue =
    params.runtimeContext ?? params.experimental_context;
  const runtimeContext =
    typeof runtimeContextValue === "object" && runtimeContextValue !== null
      ? (runtimeContextValue as Record<string, unknown>)
      : undefined;
  if (runtimeContext === undefined) {
    return undefined;
  }

  // The SDK's own shape: `{ [key]: boolean }`, where a key is included only
  // when explicitly true. There is deliberately no "include everything"
  // shorthand — runtime context routinely carries credentials and user data
  // that no one asked to put on a span.
  const included = telemetryOptions(params)?.includeRuntimeContext;
  if (typeof included !== "object" || included === null) {
    return undefined;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, enabled] of Object.entries(
    included as Record<string, unknown>
  )) {
    if (enabled === true && Object.hasOwn(runtimeContext, key)) {
      projected[key] = runtimeContext[key];
    }
  }

  return projected;
}

/**
 * Reads agent/conversation semantic context from the AI SDK's own telemetry
 * fields. The AI SDK maps `functionId` to `gen_ai.agent.name`; an explicit
 * name takes priority. Each field comes from v6 `telemetry.metadata` or, on
 * v7 where that option no longer exists, from `runtimeContext`.
 */
function semanticContext(params: AISDKV6CallParams): SemanticContext {
  const telemetry = telemetryOptions(params);
  const metadata = telemetryMetadata(params);
  const runtimeContext =
    typeof params.runtimeContext === "object" && params.runtimeContext !== null
      ? (params.runtimeContext as Record<string, unknown>)
      : undefined;

  return {
    agentId:
      metadataValue(metadata, "agentId", "gen_ai.agent.id") ??
      metadataValue(runtimeContext, "agentId", "gen_ai.agent.id"),
    agentName:
      metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
      metadataValue(runtimeContext, "agentName", "gen_ai.agent.name") ??
      readString(telemetry?.functionId),
    agentVersion:
      metadataValue(metadata, "agentVersion", "gen_ai.agent.version") ??
      metadataValue(runtimeContext, "agentVersion", "gen_ai.agent.version"),
    conversationId:
      metadataValue(metadata, "conversationId", "gen_ai.conversation.id") ??
      metadataValue(runtimeContext, "conversationId", "gen_ai.conversation.id")
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

  const runtimeContextValue =
    params.runtimeContext ?? params.experimental_context;
  const runtimeContext =
    typeof runtimeContextValue === "object" && runtimeContextValue !== null
      ? (runtimeContextValue as Record<string, unknown>)
      : undefined;

  for (const key of options?.includeRuntimeContext ?? []) {
    const value = runtimeContext?.[key];
    if (isScalarAttributeValue(value)) {
      attributes[`cloudflare.agents.runtime_context.${key}`] = value;
    }
  }

  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

const invocationBounded = Symbol.for(
  "cloudflare.agents.ai-sdk.invocation-bounded"
);

function isAISDKInvocationBounded(params: AISDKV6CallParams): boolean {
  return (
    (params as Record<PropertyKey, unknown>)[invocationBounded] === true ||
    agentContext.getStore()?.connection !== undefined
  );
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
