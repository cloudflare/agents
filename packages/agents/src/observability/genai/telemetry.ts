import { TraceAttribute } from "./attributes";
import type { TraceAttributes } from "../tracing/tracer";

/** Integrations that project into the shared telemetry schema. */
export type IntegrationName = "ai-sdk" | "pi-ai";

/** Canonical token usage shape used by model adapters. */
export type TokenUsageSummary = {
  readonly cacheCreationInputTokens?: number | undefined;
  readonly cacheReadInputTokens?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
};

/** Safe request settings that map to scalar GenAI semantic attributes. */
export type RequestSummary = {
  readonly frequencyPenalty?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly outputType?: string | undefined;
  readonly presencePenalty?: number | undefined;
  readonly seed?: number | undefined;
  readonly stream?: boolean | undefined;
  readonly temperature?: number | undefined;
  readonly topK?: number | undefined;
  readonly topP?: number | undefined;
};

/** Safe response metadata that maps to scalar GenAI semantic attributes. */
export type ResponseSummary = {
  readonly id?: string | undefined;
  readonly model?: string | undefined;
};

/** Safe agent/conversation metadata provided explicitly by callers. */
export type SemanticContext = {
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly agentVersion?: string | undefined;
  readonly conversationId?: string | undefined;
};

/** Name and initial attributes for a model-operation span. */
export type SpanSpec = {
  readonly attributes: TraceAttributes;
  readonly name: string;
};

/**
 * Opt-in chat content captured on the operation span. These carry raw prompts,
 * messages, and model output — potentially PII — so callers MUST leave the
 * field undefined unless the explicit `recordInputs`/`recordOutputs` flag is
 * set. When undefined the corresponding attribute is simply never written.
 */
export type OperationContent = {
  readonly inputMessages?: unknown;
  readonly outputMessages?: unknown;
};

/** Opt-in tool arguments captured on the execute_tool span (PII). */
export type ToolContent = {
  readonly arguments?: unknown;
};

/**
 * workerd soft-caps total user-span data at 64 KiB (`MAX_SPAN_BYTES` in the
 * runtime's trace implementation); past that it silently ignores span
 * modifications, and downstream tail-stream submission may apply further
 * limits. The cap is on the WHOLE span, not per attribute — and a single span
 * can carry up to two opt-in content attributes (input + output messages, or
 * tool arguments + result) alongside its scalar metadata. So reserve headroom
 * for the span name and scalar attributes, then split the remainder across
 * those two content values, keeping even the worst case under the ceiling.
 * Oversized values are truncated with a marker rather than risking the whole
 * span being dropped. (Caller-supplied scalar metadata passes through
 * untruncated; unusually large metadata values eat into the reserved headroom,
 * so keep them small when content recording is enabled.)
 */
const MAX_SPAN_BYTES = 64 * 1024;
const SPAN_METADATA_HEADROOM_BYTES = 8 * 1024;
const MAX_CONTENT_ATTRIBUTES_PER_SPAN = 2;
const MAX_CONTENT_ATTRIBUTE_BYTES = Math.floor(
  (MAX_SPAN_BYTES - SPAN_METADATA_HEADROOM_BYTES) /
    MAX_CONTENT_ATTRIBUTES_PER_SPAN
);
const CONTENT_TRUNCATION_MARKER = "…[truncated]";

/**
 * Serializes an opt-in content payload (chat messages, tool arguments/results)
 * to a JSON string bounded to {@link MAX_CONTENT_ATTRIBUTE_BYTES}. Returns
 * undefined for an absent or non-JSON-representable value so the attribute is
 * omitted rather than written as a broken value. This is the single point where
 * content is projected onto a scalar span attribute.
 */
export function serializeContent(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    // Circular structures or throwing getters: drop the attribute, fail open.
    return undefined;
  }

  // JSON.stringify returns undefined for functions, symbols, and bare undefined.
  if (json === undefined) {
    return undefined;
  }

  return truncateToBytes(json, MAX_CONTENT_ATTRIBUTE_BYTES);
}

function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }

  const budget = maxBytes - encoder.encode(CONTENT_TRUNCATION_MARKER).length;
  let bytes = 0;
  let result = "";
  // Iterating the string yields whole code points, so a multi-byte character is
  // never split across the truncation boundary.
  for (const character of text) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > budget) {
      break;
    }
    bytes += characterBytes;
    result += character;
  }

  return `${result}${CONTENT_TRUNCATION_MARKER}`;
}

/**
 * Projects an opt-in tool result onto the execute_tool span. Callers invoke
 * this only when `recordOutputs` is set; the value is serialized and truncated
 * through the same enforcement point as every other content attribute.
 */
export function toolResultAttributes(result: unknown): TraceAttributes {
  return {
    [TraceAttribute.GenAI.ToolCallResult]: serializeContent(result)
  };
}

/**
 * Builds a semconv-formula span name (`"{operation} {target}"`), falling back
 * to the bare operation when the target is unavailable or the combined name
 * exceeds the Workers Observability 64 UTF-8-byte budget. The full target
 * remains available as an attribute; the stable query key is always
 * `gen_ai.operation.name`, never the span name.
 */
function spanName(operation: string, target: string | undefined): string {
  if (!target) {
    return operation;
  }

  const name = `${operation} ${target}`;
  return new TextEncoder().encode(name).length <= 64 ? name : operation;
}

/**
 * Normalizes an AI SDK provider identifier to the semconv
 * `gen_ai.provider.name` enum where a member exists: sub-provider suffixes
 * are stripped (`anthropic.messages` → `anthropic`) and known aliases mapped.
 * Unknown providers pass through verbatim (semconv sanctions custom values).
 */
function normalizeProviderName(
  provider: string | undefined
): string | undefined {
  if (provider === undefined) {
    return undefined;
  }

  const lower = provider.toLowerCase();
  const mappings: ReadonlyArray<readonly [prefix: string, value: string]> = [
    ["google.vertex", "gcp.vertex_ai"],
    ["google.generative-ai", "gcp.gemini"],
    ["google-vertex", "gcp.vertex_ai"],
    ["amazon-bedrock", "aws.bedrock"],
    ["azure-openai", "azure.ai.openai"],
    ["anthropic", "anthropic"],
    ["openai", "openai"],
    ["azure", "azure.ai.inference"],
    ["google", "gcp.gemini"],
    ["mistral", "mistral_ai"],
    ["cohere", "cohere"],
    ["bedrock", "aws.bedrock"],
    ["groq", "groq"],
    ["deepseek", "deepseek"],
    ["perplexity", "perplexity"],
    ["xai", "x_ai"]
  ];

  for (const [prefix, value] of mappings) {
    if (
      lower === prefix ||
      lower.startsWith(`${prefix}.`) ||
      lower.startsWith(`${prefix}-`)
    ) {
      return value;
    }
  }

  return provider;
}

/**
 * Reserved telemetry-metadata keys that map to dedicated attributes on the
 * operation root span. Everything else scalar passes through under
 * `cloudflare.agents.metadata.{key}`; identity keys are consumed by
 * SemanticContext extraction and never passed through.
 */
const RESERVED_METADATA_ATTRIBUTES: Readonly<Record<string, string>> = {
  [TraceAttribute.Cloudflare.TurnAdmission]:
    TraceAttribute.Cloudflare.TurnAdmission,
  [TraceAttribute.Cloudflare.TurnChannel]:
    TraceAttribute.Cloudflare.TurnChannel,
  [TraceAttribute.Cloudflare.TurnContinuation]:
    TraceAttribute.Cloudflare.TurnContinuation,
  [TraceAttribute.Cloudflare.TurnGeneration]:
    TraceAttribute.Cloudflare.TurnGeneration,
  [TraceAttribute.Cloudflare.TurnRequestID]:
    TraceAttribute.Cloudflare.TurnRequestID,
  [TraceAttribute.Cloudflare.TurnTrigger]:
    TraceAttribute.Cloudflare.TurnTrigger,
  [TraceAttribute.General.UserID]: TraceAttribute.General.UserID
};

const CONSUMED_METADATA_KEYS = new Set([
  "agentId",
  "agentName",
  "agentVersion",
  "conversationId",
  "gen_ai.agent.id",
  "gen_ai.agent.name",
  "gen_ai.agent.version",
  "gen_ai.conversation.id"
]);

/**
 * Projects the AI SDK's per-call `experimental_telemetry.metadata` onto root
 * span attributes: reserved keys map to their dedicated attributes, any other
 * SCALAR entry passes through as `cloudflare.agents.metadata.{key}`, and
 * object/array values are dropped (scalar-only attribute rule).
 */
export function metadataAttributes(
  metadata: Record<string, unknown> | undefined
): TraceAttributes {
  if (metadata === undefined) {
    return {};
  }

  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (CONSUMED_METADATA_KEYS.has(key)) {
      continue;
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }

    const reserved = Object.hasOwn(RESERVED_METADATA_ATTRIBUTES, key)
      ? RESERVED_METADATA_ATTRIBUTES[key]
      : undefined;
    attributes[
      reserved ?? `${TraceAttribute.Cloudflare.MetadataPrefix}${key}`
    ] = value;
  }

  return attributes;
}

/**
 * Cheap root-span name for an agent operation: needs only the agent name (the
 * one value instrumentation may read before the sampling check), never the
 * full attribute spec.
 */
export function operationSpanName(agentName: string | undefined): string {
  return spanName(
    TraceAttribute.GenAI.OperationNameValueInvokeAgent,
    agentName
  );
}

/** Builds the root span for an SDK operation such as generateText or streamText. */
export function operationSpan(input: {
  readonly attributes: TraceAttributes | undefined;
  readonly context?: SemanticContext | undefined;
  readonly integration: IntegrationName;
  readonly model: string | undefined;
  readonly operation: string;
  readonly provider: string | undefined;
  readonly request?: RequestSummary | undefined;
}): SpanSpec {
  return {
    attributes: {
      ...input.attributes,
      [TraceAttribute.Cloudflare.IntegrationName]: input.integration,
      [TraceAttribute.Cloudflare.OperationName]: input.operation,
      [TraceAttribute.GenAI.AgentID]: input.context?.agentId,
      [TraceAttribute.GenAI.AgentName]: input.context?.agentName,
      [TraceAttribute.GenAI.AgentVersion]: input.context?.agentVersion,
      [TraceAttribute.GenAI.ConversationID]: input.context?.conversationId,
      [TraceAttribute.GenAI.OperationName]:
        TraceAttribute.GenAI.OperationNameValueInvokeAgent,
      [TraceAttribute.GenAI.ProviderName]: normalizeProviderName(
        input.provider
      ),
      ...requestAttributes(input.request, input.model)
    },
    name: spanName(
      TraceAttribute.GenAI.OperationNameValueInvokeAgent,
      input.context?.agentName
    )
  };
}

/** Builds the child span for an underlying model call. */
export function modelCallSpan(input: {
  readonly attributes?: TraceAttributes | undefined;
  readonly content?: OperationContent | undefined;
  readonly integration: IntegrationName;
  readonly model: string | undefined;
  readonly operation: string;
  readonly provider: string | undefined;
  readonly request?: RequestSummary | undefined;
}): SpanSpec {
  return {
    attributes: {
      ...input.attributes,
      [TraceAttribute.GenAI.InputMessages]: serializeContent(
        input.content?.inputMessages
      ),
      [TraceAttribute.Cloudflare.IntegrationName]: input.integration,
      [TraceAttribute.Cloudflare.OperationName]: input.operation,
      [TraceAttribute.GenAI.OperationName]:
        TraceAttribute.GenAI.OperationNameValueChat,
      [TraceAttribute.GenAI.ProviderName]: normalizeProviderName(
        input.provider
      ),
      ...requestAttributes(input.request, input.model)
    },
    name: spanName(TraceAttribute.GenAI.OperationNameValueChat, input.model)
  };
}

function requestAttributes(
  request: RequestSummary | undefined,
  model: string | undefined
): TraceAttributes {
  return {
    [TraceAttribute.GenAI.OutputType]: request?.outputType,
    [TraceAttribute.GenAI.RequestFrequencyPenalty]: request?.frequencyPenalty,
    [TraceAttribute.GenAI.RequestMaxTokens]: request?.maxTokens,
    [TraceAttribute.GenAI.RequestModel]: model,
    [TraceAttribute.GenAI.RequestPresencePenalty]: request?.presencePenalty,
    [TraceAttribute.GenAI.RequestSeed]: request?.seed,
    // Semconv: gen_ai.request.stream is set if and only if streaming.
    [TraceAttribute.GenAI.RequestStream]:
      request?.stream === true ? true : undefined,
    [TraceAttribute.GenAI.RequestTemperature]: request?.temperature,
    [TraceAttribute.GenAI.RequestTopK]: request?.topK,
    [TraceAttribute.GenAI.RequestTopP]: request?.topP
  };
}

/** Builds the child span for a tool execution. */
export function toolCallSpan(input: {
  readonly content?: ToolContent | undefined;
  readonly integration: IntegrationName;
  readonly operation: string;
  readonly toolCallId?: string | undefined;
  readonly toolName: string;
}): SpanSpec {
  return {
    attributes: {
      // Opt-in tool arguments: undefined unless the caller passed them under an
      // explicit record flag.
      [TraceAttribute.GenAI.ToolCallArguments]: serializeContent(
        input.content?.arguments
      ),
      [TraceAttribute.Cloudflare.IntegrationName]: input.integration,
      [TraceAttribute.Cloudflare.OperationName]: input.operation,
      [TraceAttribute.GenAI.OperationName]:
        TraceAttribute.GenAI.OperationNameValueExecuteTool,
      [TraceAttribute.GenAI.ToolCallID]: input.toolCallId,
      [TraceAttribute.GenAI.ToolName]: input.toolName,
      [TraceAttribute.GenAI.ToolType]: "function"
    },
    name: spanName(
      TraceAttribute.GenAI.OperationNameValueExecuteTool,
      input.toolName
    )
  };
}

/** Projects a completed model operation into canonical finish attributes. */
export function finishAttributes(input: {
  readonly content?: OperationContent | undefined;
  readonly finishReason: string | undefined;
  readonly response?: ResponseSummary | undefined;
  readonly timeToFirstChunkSeconds?: number | undefined;
  readonly toolCallCount?: number | undefined;
  readonly usage: TokenUsageSummary | undefined;
}): TraceAttributes {
  return {
    // Opt-in output content: undefined unless the caller passed it under an
    // explicit `recordOutputs` flag.
    [TraceAttribute.GenAI.OutputMessages]: serializeContent(
      input.content?.outputMessages
    ),
    [TraceAttribute.Cloudflare.ResponseFinishReason]: input.finishReason,
    [TraceAttribute.Cloudflare.ToolCount]: input.toolCallCount,
    [TraceAttribute.Cloudflare.UsageTotalTokens]: totalTokens(input.usage),
    [TraceAttribute.GenAI.ResponseID]: input.response?.id,
    [TraceAttribute.GenAI.ResponseModel]: input.response?.model,
    [TraceAttribute.GenAI.ResponseTimeToFirstChunk]:
      input.timeToFirstChunkSeconds,
    [TraceAttribute.GenAI.UsageCacheCreationInputTokens]:
      input.usage?.cacheCreationInputTokens,
    [TraceAttribute.GenAI.UsageCacheReadInputTokens]:
      input.usage?.cacheReadInputTokens,
    [TraceAttribute.GenAI.UsageInputTokens]: input.usage?.inputTokens,
    [TraceAttribute.GenAI.UsageOutputTokens]: input.usage?.outputTokens,
    [TraceAttribute.GenAI.UsageReasoningOutputTokens]:
      input.usage?.reasoningTokens
  };
}

function totalTokens(usage: TokenUsageSummary | undefined): number | undefined {
  if (usage?.totalTokens !== undefined) {
    return usage.totalTokens;
  }
  return usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens
    : undefined;
}
