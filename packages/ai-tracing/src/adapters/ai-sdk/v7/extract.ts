import { TraceAttribute } from "../../../genai/attributes.js";
import { finishAttributes } from "../../../genai/telemetry.js";
import type {
  OutputSummary,
  RequestSummary,
  ResponseSummary,
  SemanticContext,
  TokenUsageSummary
} from "../../../genai/telemetry.js";
import type { Attributes } from "../../../tracing/tracer.js";
import {
  readNestedTokenField,
  readNumber,
  readString,
  readTokenCount
} from "../read.js";

/** Extracts the safe operation name from an AI SDK v7 operation id. */
export function operationNameFromId(operationId: unknown): string {
  const value = readString(operationId);
  if (value === undefined) {
    return "ai-sdk";
  }

  return value.startsWith("ai.") ? value.slice("ai.".length) : value;
}

/** Extracts safe GenAI semantic context from an AI SDK v7 event. */
export function semanticContextFromEvent(event: object): SemanticContext {
  const record = eventRecord(event);
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;

  return {
    agentId: metadataValue(metadata, "agentId", "gen_ai.agent.id"),
    agentName:
      metadataValue(metadata, "agentName", "gen_ai.agent.name") ??
      readString(record.functionId),
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

/** Extracts safe request settings from an AI SDK v7 event. */
export function requestSummaryFromEvent(
  event: object,
  operationName: string
): RequestSummary {
  const record = eventRecord(event);
  return {
    frequencyPenalty: readNumber(record.frequencyPenalty),
    maxTokens: readNumber(record.maxOutputTokens ?? record.maxTokens),
    outputType:
      operationName === "generateObject" || operationName === "streamObject"
        ? "json"
        : "text",
    presencePenalty: readNumber(record.presencePenalty),
    seed: readNumber(record.seed),
    stream: operationName === "streamText" || operationName === "streamObject",
    temperature: readNumber(record.temperature),
    topK: readNumber(record.topK),
    topP: readNumber(record.topP)
  };
}

/** Extracts safe finish attributes from an AI SDK v7 result-like event. */
export function finishAttributesFromEvent(event: object): Attributes {
  const record = eventRecord(event);
  return finishAttributes({
    finishReason: extractFinishReason(record),
    outputSummary: outputSummaryFromEvent(record),
    response: responseSummaryFromEvent(record),
    usage: tokenUsageFromEvent(record)
  });
}

/** Builds correlation attributes for AI SDK v7 callback ids. */
export function correlationAttributes(input: {
  readonly callId: string;
  readonly toolCallId?: string | undefined;
}): Attributes {
  return {
    [TraceAttribute.AI.CallID]: input.callId,
    [TraceAttribute.AI.ToolCallID]: input.toolCallId
  };
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
  semanticKey: string
): string | undefined {
  return readString(metadata?.[key] ?? metadata?.[semanticKey]);
}

function eventRecord(event: object): Record<string, unknown> {
  return event as Record<string, unknown>;
}

function extractFinishReason(
  event: Record<string, unknown>
): string | undefined {
  const finishReason = event.finishReason;
  if (typeof finishReason === "string") {
    return finishReason;
  }

  if (typeof finishReason === "object" && finishReason !== null) {
    return readString((finishReason as Record<string, unknown>).unified);
  }

  return undefined;
}

function outputSummaryFromEvent(
  event: Record<string, unknown>
): OutputSummary | undefined {
  const text = readString(event.text);
  const summary: OutputSummary = {
    ...(text !== undefined ? { hasText: text.length > 0 } : {}),
    ...(event.object !== undefined ? { hasObject: true } : {}),
    ...(Array.isArray(event.toolCalls)
      ? { toolCallCount: event.toolCalls.length }
      : {})
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function responseSummaryFromEvent(
  event: Record<string, unknown>
): ResponseSummary | undefined {
  const response =
    typeof event.response === "object" && event.response !== null
      ? (event.response as Record<string, unknown>)
      : undefined;
  const id = readString(event.responseId ?? response?.id);
  const model = readString(
    event.responseModel ?? event.modelId ?? response?.model
  );

  if (id === undefined && model === undefined) {
    return undefined;
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {})
  };
}

function tokenUsageFromEvent(
  event: Record<string, unknown>
): TokenUsageSummary | undefined {
  const raw = event.totalUsage ?? event.usage;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const usage = raw as Record<string, unknown>;
  const inputTokens = readTokenCount(usage.inputTokens);
  const outputTokens = readTokenCount(usage.outputTokens);
  const totalTokens = readNumber(usage.totalTokens);
  const cacheReadInputTokens = readNestedTokenField(
    usage.inputTokens,
    "cacheRead"
  );
  const cacheCreationInputTokens = readNestedTokenField(
    usage.inputTokens,
    "cacheWrite"
  );
  const reasoningTokens = readNestedTokenField(usage.outputTokens, "reasoning");

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}
