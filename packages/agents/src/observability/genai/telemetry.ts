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
 * Builds a semconv-formula span name (`"{operation} {target}"`), falling back
 * to the bare operation when the target is unavailable. The stable query key
 * is always `gen_ai.operation.name`, never the span name.
 */
function spanName(operation: string, target: string | undefined): string {
  return target ? `${operation} ${target}` : operation;
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
  readonly integration: IntegrationName;
  readonly operation: string;
  readonly toolCallId?: string | undefined;
  readonly toolName: string;
}): SpanSpec {
  return {
    attributes: {
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
  readonly finishReason: string | undefined;
  readonly response?: ResponseSummary | undefined;
  readonly timeToFirstChunkSeconds?: number | undefined;
  readonly usage: TokenUsageSummary | undefined;
}): TraceAttributes {
  return {
    [TraceAttribute.Cloudflare.ResponseFinishReason]: input.finishReason,
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
