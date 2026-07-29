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
import type { TraceAttributes } from "../../tracing/tracer";
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
  AISDKCallParams,
  AISDKOperation,
  AISDKWrapLanguageModel
} from "./types";

type AISDKOperationName =
  | "generateObject"
  | "generateText"
  | "streamObject"
  | "streamText";

export type { AISDKNamespace } from "./types";

/** Tracing configuration for the AI SDK compatibility wrapper. */
export type AISDKWrapperInstrumentation = {
  readonly options?: AISDKInstrumentationOptions;
  readonly tracer: AgentTracer;
};

/**
 * Wraps an AI SDK namespace object with tracing while preserving its public
 * shape and overloaded call signatures across supported majors.
 */
export function createAISDKWrapper<T extends Record<string, unknown>>(
  ai: T,
  instrumentation: AISDKWrapperInstrumentation
): T {
  const target = isModuleNamespace(ai) ? Object.setPrototypeOf({}, ai) : ai;
  // Cache wrappers so repeated property reads return the same function
  // (memoization patterns like `wrapped.streamText === wrapped.streamText`).
  const wrapperCache = new Map<PropertyKey, AISDKOperation>();

  return new Proxy(target, {
    get(proxyTarget, property, receiver) {
      const original = Reflect.get(proxyTarget, property, receiver) as unknown;

      if (isWrappedOperationName(property) && typeof original === "function") {
        let wrapper = wrapperCache.get(property);
        if (!wrapper) {
          wrapper = createOperationWrapper(
            property,
            toAISDKOperation(original),
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
): AISDKWrapLanguageModel | undefined {
  const value = ai.wrapLanguageModel;
  if (typeof value !== "function") {
    return undefined;
  }

  // SAFETY: This is a vendored structural contract shared by the supported AI
  // SDK majors; the public wrapper preserves the caller's installed SDK type.
  return value as AISDKWrapLanguageModel;
}

function toAISDKOperation(value: unknown): AISDKOperation {
  // SAFETY: The proxy only calls this after selecting known AI SDK operation
  // export names. The wrapper uses the narrow params fields it reads/replaces.
  return value as AISDKOperation;
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
  operationName: AISDKOperationName,
  operation: AISDKOperation,
  wrapLanguageModel: AISDKWrapLanguageModel | undefined,
  instrumentation: AISDKWrapperInstrumentation
): AISDKOperation {
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
    const boundToInvocation = isAISDKInvocationBounded(params);
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
            storage,
            boundToInvocation
          ),
          ...args
        );

        operationSpan.finish(
          finishAttributesFromResult(result, {
            includeResponse: !canWrapModel(wrapLanguageModel, params.model)
          })
        );
        return result;
      },
      boundToInvocation ? { boundToInvocation: true } : undefined
    );
  };
}

/**
 * Reads only the agent name for the span name, from the same sources and in
 * the same order as {@link semanticContext}, so the span name and
 * `gen_ai.agent.name` never disagree. `functionId` is the AI SDK's canonical
 * projection; an explicit name from v6 metadata or v7 runtime context wins.
 */
function agentNameForCall(params: AISDKCallParams): string | undefined {
  const telemetry = telemetryOptions(params);
  const metadata = telemetryMetadata(params);
  const runtimeContext = runtimeContextRecord(params);

  return (
    metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
    metadataValue(runtimeContext, "agentName", "gen_ai.agent.name") ??
    readString(telemetry?.functionId)
  );
}

function operationParamsForCall(
  params: AISDKCallParams,
  operationName: AISDKOperationName,
  wrapLanguageModel: AISDKWrapLanguageModel | undefined,
  tracer: AgentTracer,
  storage: ResolvedAISDKStorageOptions,
  boundToInvocation = false
): AISDKCallParams {
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
            approvedToolCalls,
            boundToInvocation
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
  wrapLanguageModel: AISDKWrapLanguageModel | undefined,
  model: unknown
): boolean {
  return (
    wrapLanguageModel !== undefined &&
    typeof model === "object" &&
    model !== null
  );
}

function isStreamOperation(operationName: AISDKOperationName): boolean {
  return operationName === "streamObject" || operationName === "streamText";
}

function shouldWrapTools(operationName: AISDKOperationName): boolean {
  return operationName === "generateText" || operationName === "streamText";
}

function isWrappedOperationName(
  value: PropertyKey
): value is AISDKOperationName {
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
  params: AISDKCallParams,
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
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(params, operation)
  });
}

/** Reads the per-call `experimental_telemetry.metadata` record, if present. */
function telemetryMetadata(
  params: AISDKCallParams
): Record<string, unknown> | undefined {
  const telemetry = telemetryOptions(params);

  return typeof telemetry?.metadata === "object" && telemetry.metadata !== null
    ? (telemetry.metadata as Record<string, unknown>)
    : undefined;
}

/**
 * The caller's application-data channel: `runtimeContext` on v7, the
 * `experimental_context` it replaced on v6. Read through one accessor so the
 * two majors cannot drift on which one identity and metadata come from.
 */
function runtimeContextRecord(
  params: AISDKCallParams
): Record<string, unknown> | undefined {
  const value = params.runtimeContext ?? params.experimental_context;

  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function telemetryOptions(
  params: AISDKCallParams
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
 * Runtime context the caller did not mark as included stays off the span as a
 * passthrough attribute: on v7 this is a general application-data channel, not
 * a telemetry bag. Identity (`agentId`, `agentName`, `agentVersion`,
 * `conversationId`) is separate — {@link semanticContext} reads it regardless,
 * because it names the operation rather than describing it, and v7 left
 * callers nowhere else to put it.
 */
function includedRuntimeContext(
  params: AISDKCallParams
): Record<string, unknown> | undefined {
  const runtimeContext = runtimeContextRecord(params);
  if (runtimeContext === undefined) {
    return undefined;
  }

  const included = includedContextKeys(telemetryOptions(params));
  if (included === undefined) {
    return undefined;
  }

  const projected: Record<string, unknown> = {};
  for (const key of included) {
    if (Object.hasOwn(runtimeContext, key)) {
      projected[key] = runtimeContext[key];
    }
  }

  return projected;
}

/**
 * The keys a caller marked as telemetry-visible.
 *
 * The SDK's own shape is `{ [key]: boolean }`, included only when explicitly
 * true; a plain array of key names is accepted too, since that is the shape of
 * the wrapper's option of the same name and silently ignoring it would be
 * worse than honouring it. There is deliberately no "include everything"
 * shorthand — runtime context routinely carries credentials and user data that
 * no one asked to put on a span.
 */
function includedContextKeys(
  telemetry: Record<string, unknown> | undefined
): string[] | undefined {
  const included = telemetry?.includeRuntimeContext;
  if (Array.isArray(included)) {
    return included.filter((key): key is string => typeof key === "string");
  }
  if (typeof included !== "object" || included === null) {
    return undefined;
  }

  return Object.entries(included as Record<string, unknown>)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
}

/**
 * Whether the caller explicitly opted a key OUT. Identity is read from runtime
 * context without an opt-in — on v7 there is nowhere else to put it, and
 * requiring one would silently cost every caller `gen_ai.agent.id` — but an
 * explicit `false` is a stated intention and is honoured.
 */
function isExcludedFromContext(params: AISDKCallParams, key: string): boolean {
  const included = telemetryOptions(params)?.includeRuntimeContext;

  return (
    typeof included === "object" &&
    included !== null &&
    !Array.isArray(included) &&
    (included as Record<string, unknown>)[key] === false
  );
}

/**
 * Reads agent/conversation semantic context from the AI SDK's own telemetry
 * fields. The AI SDK maps `functionId` to `gen_ai.agent.name`; an explicit
 * name takes priority. Each field comes from v6 `telemetry.metadata` or, on
 * v7 where that option no longer exists, from `runtimeContext`.
 */
function semanticContext(params: AISDKCallParams): SemanticContext {
  const telemetry = telemetryOptions(params);
  const metadata = telemetryMetadata(params);
  const runtimeContext = runtimeContextRecord(params);

  const fromContext = (key: string, semanticKey: string) =>
    isExcludedFromContext(params, key)
      ? undefined
      : metadataValue(runtimeContext, key, semanticKey);

  return {
    agentId:
      metadataValue(metadata, "agentId", "gen_ai.agent.id") ??
      fromContext("agentId", "gen_ai.agent.id"),
    agentName:
      metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
      fromContext("agentName", "gen_ai.agent.name") ??
      readString(telemetry?.functionId),
    agentVersion:
      metadataValue(metadata, "agentVersion", "gen_ai.agent.version") ??
      fromContext("agentVersion", "gen_ai.agent.version"),
    conversationId:
      metadataValue(metadata, "conversationId", "gen_ai.conversation.id") ??
      fromContext("conversationId", "gen_ai.conversation.id")
  };
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
  semanticKey: string
): string | undefined {
  return readString(metadata?.[key] ?? metadata?.[semanticKey]);
}

/**
 * The wrapper-level allowlist, set once for the instrumentation rather than
 * per call. It selects from the same context and lands on the same attributes
 * as the SDK's per-call allowlist: selecting a key through both must produce
 * one attribute, not a canonical one and a `runtime_context.*` near-duplicate.
 */
function contextAttributes(
  params: AISDKCallParams,
  options: AISDKInstrumentationOptions | undefined
): TraceAttributes | undefined {
  const included = options?.includeRuntimeContext;
  if (included === undefined || included.length === 0) {
    return undefined;
  }

  const runtimeContext = runtimeContextRecord(params);
  if (runtimeContext === undefined) {
    return undefined;
  }

  const projected: Record<string, unknown> = {};
  for (const key of included) {
    if (Object.hasOwn(runtimeContext, key)) {
      projected[key] = runtimeContext[key];
    }
  }

  return metadataAttributes(
    projected,
    TraceAttribute.Cloudflare.RuntimeContextPrefix
  );
}

const invocationBounded = Symbol.for(
  "cloudflare.agents.ai-sdk.invocation-bounded"
);

function isAISDKInvocationBounded(params: AISDKCallParams): boolean {
  return (
    (params as Record<PropertyKey, unknown>)[invocationBounded] === true ||
    agentContext.getStore()?.connection !== undefined
  );
}
