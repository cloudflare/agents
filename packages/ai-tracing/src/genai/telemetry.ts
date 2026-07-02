import { TraceAttribute } from "./attributes.js";
import type { Attributes } from "../tracing/tracer.js";

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

/** Canonical output summary shape used by model adapters. */
export type OutputSummary = {
  readonly embeddingCount?: number | undefined;
  readonly embeddingDimensions?: number | undefined;
  readonly hasObject?: boolean | undefined;
  readonly hasText?: boolean | undefined;
  readonly toolCallCount?: number | undefined;
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
  readonly attributes: Attributes;
  readonly name: string;
};

/** Builds the root span for an SDK operation such as generateText or streamText. */
export function operationSpan(input: {
  readonly attributes: Attributes | undefined;
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
      [TraceAttribute.AI.IntegrationName]: input.integration,
      [TraceAttribute.AI.OperationID]: input.operation,
      [TraceAttribute.GenAI.AgentID]: input.context?.agentId,
      [TraceAttribute.GenAI.AgentName]: input.context?.agentName,
      [TraceAttribute.GenAI.AgentVersion]: input.context?.agentVersion,
      [TraceAttribute.GenAI.ConversationID]: input.context?.conversationId,
      [TraceAttribute.GenAI.OperationName]: TraceAttribute.GenAI.OperationNameValueInvokeAgent,
      [TraceAttribute.GenAI.ProviderName]: input.provider,
      ...requestAttributes(input.request, input.model),
    },
    name: "gen_ai.operation",
  };
}

/** Builds the child span for an underlying model call. */
export function modelCallSpan(input: {
  readonly attributes?: Attributes | undefined;
  readonly integration: IntegrationName;
  readonly model: string | undefined;
  readonly operation: string;
  readonly provider: string | undefined;
  readonly request?: RequestSummary | undefined;
}): SpanSpec {
  return {
    attributes: {
      ...input.attributes,
      [TraceAttribute.AI.IntegrationName]: input.integration,
      [TraceAttribute.AI.OperationID]: input.operation,
      [TraceAttribute.GenAI.OperationName]: TraceAttribute.GenAI.OperationNameValueChat,
      [TraceAttribute.GenAI.ProviderName]: input.provider,
      ...requestAttributes(input.request, input.model),
    },
    name: "gen_ai.chat",
  };
}

function requestAttributes(
  request: RequestSummary | undefined,
  model: string | undefined,
): Attributes {
  return {
    [TraceAttribute.GenAI.OutputType]: request?.outputType,
    [TraceAttribute.GenAI.RequestFrequencyPenalty]: request?.frequencyPenalty,
    [TraceAttribute.GenAI.RequestMaxTokens]: request?.maxTokens,
    [TraceAttribute.GenAI.RequestModel]: model,
    [TraceAttribute.GenAI.RequestPresencePenalty]: request?.presencePenalty,
    [TraceAttribute.GenAI.RequestSeed]: request?.seed,
    [TraceAttribute.GenAI.RequestStream]: request?.stream,
    [TraceAttribute.GenAI.RequestTemperature]: request?.temperature,
    [TraceAttribute.GenAI.RequestTopK]: request?.topK,
    [TraceAttribute.GenAI.RequestTopP]: request?.topP,
  };
}

/** Builds the child span for a tool execution. */
export function toolCallSpan(input: {
  readonly integration: IntegrationName;
  readonly operation: string;
  readonly toolName: string;
}): SpanSpec {
  return {
    attributes: {
      [TraceAttribute.AI.IntegrationName]: input.integration,
      [TraceAttribute.AI.OperationID]: input.operation,
      [TraceAttribute.GenAI.OperationName]: TraceAttribute.GenAI.OperationNameValueExecuteTool,
      [TraceAttribute.GenAI.ToolName]: input.toolName,
      [TraceAttribute.GenAI.ToolType]: "function",
    },
    name: "gen_ai.execute_tool",
  };
}

/** Projects a completed model operation into canonical finish attributes. */
export function finishAttributes(input: {
  readonly finishReason: string | undefined;
  readonly outputSummary: OutputSummary | undefined;
  readonly response?: ResponseSummary | undefined;
  readonly usage: TokenUsageSummary | undefined;
}): Attributes {
  return {
    [TraceAttribute.AI.EmbeddingCount]: input.outputSummary?.embeddingCount,
    [TraceAttribute.AI.EmbeddingDimensions]: input.outputSummary?.embeddingDimensions,
    [TraceAttribute.AI.OutputHasObject]: input.outputSummary?.hasObject,
    [TraceAttribute.AI.OutputHasText]: input.outputSummary?.hasText,
    [TraceAttribute.AI.ResponseFinishReason]: input.finishReason,
    [TraceAttribute.AI.ToolCount]: input.outputSummary?.toolCallCount,
    [TraceAttribute.AI.UsageTotalTokens]: input.usage?.totalTokens,
    [TraceAttribute.GenAI.ResponseFinishReasons]: finishReasonsAttribute(input.finishReason),
    [TraceAttribute.GenAI.ResponseID]: input.response?.id,
    [TraceAttribute.GenAI.ResponseModel]: input.response?.model,
    [TraceAttribute.GenAI.UsageCacheCreationInputTokens]: input.usage?.cacheCreationInputTokens,
    [TraceAttribute.GenAI.UsageCacheReadInputTokens]: input.usage?.cacheReadInputTokens,
    [TraceAttribute.GenAI.UsageInputTokens]: input.usage?.inputTokens,
    [TraceAttribute.GenAI.UsageOutputTokens]: input.usage?.outputTokens,
    [TraceAttribute.GenAI.UsageReasoningOutputTokens]: input.usage?.reasoningTokens,
  };
}

function finishReasonsAttribute(finishReason: string | undefined): string | undefined {
  // OTel GenAI defines gen_ai.response.finish_reasons as string[], but the
  // Cloudflare span attribute seam only accepts scalar values, so encode the
  // single-reason array as JSON.
  return finishReason === undefined ? undefined : JSON.stringify([finishReason]);
}
