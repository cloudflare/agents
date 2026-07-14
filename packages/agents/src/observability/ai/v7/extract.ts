import { TraceAttribute } from "../../genai/attributes";
import { finishAttributes } from "../../genai/telemetry";
import type {
  RequestSummary,
  ResponseSummary,
  SemanticContext,
  TokenUsageSummary
} from "../../genai/telemetry";
import type { TraceAttributes } from "../../tracing/tracer";
import {
  readNestedTokenField,
  readNumber,
  readString,
  readTokenCount
} from "../read";

/** Extracts the safe operation name from an AI SDK v7 operation id. */
export function operationNameFromId(operationId: unknown): string {
  const value = readString(operationId);
  if (value === undefined) {
    return "ai-sdk";
  }

  return value.startsWith("ai.") ? value.slice("ai.".length) : value;
}

/**
 * Extracts safe GenAI semantic context from an AI SDK v7 event. The AI SDK's
 * canonical OpenTelemetry projection maps `functionId` to agent name. v7 has
 * no telemetry metadata bag, so other identity fields come from the SDK-
 * filtered runtime context only when the caller explicitly includes them.
 */
export function semanticContextFromEvent(event: object): SemanticContext {
  const record = eventRecord(event);
  const runtimeContext =
    typeof record.runtimeContext === "object" && record.runtimeContext !== null
      ? (record.runtimeContext as Record<string, unknown>)
      : undefined;

  return {
    agentId: metadataValue(runtimeContext, "agentId", "gen_ai.agent.id"),
    agentName:
      metadataValue(runtimeContext, "agentName", "gen_ai.agent.name") ??
      readString(record.functionId),
    agentVersion: metadataValue(
      runtimeContext,
      "agentVersion",
      "gen_ai.agent.version"
    ),
    conversationId: metadataValue(
      runtimeContext,
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

/**
 * Reads the opt-in input content (prompt/messages) from an AI SDK v7 operation
 * event. Prefers the structured message list; falls back to the bare prompt.
 * Callers gate this behind `recordInputs`; it is potentially PII.
 */
export function inputContentFromEvent(event: object): unknown {
  const record = eventRecord(event);
  if (Array.isArray(record.messages)) {
    return record.messages;
  }
  return record.prompt;
}

/**
 * Reads the opt-in output content (text/object/tool calls) from an AI SDK v7
 * result-like event. Callers gate this behind `recordOutputs`; it is
 * potentially PII.
 */
export function outputContentFromEvent(event: object): unknown {
  const record = eventRecord(event);
  const output: Record<string, unknown> = {};
  if (record.text !== undefined) {
    output.text = record.text;
  }
  if (record.object !== undefined) {
    output.object = record.object;
  }
  if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) {
    output.toolCalls = record.toolCalls;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

/** Extracts safe finish attributes from an AI SDK v7 result-like event. */
export function finishAttributesFromEvent(
  event: object,
  options: {
    readonly includePerformance?: boolean;
    readonly includeResponse?: boolean;
    readonly recordOutputs?: boolean;
  } = {}
): TraceAttributes {
  const record = eventRecord(event);
  return finishAttributes({
    content: options.recordOutputs
      ? { outputMessages: outputContentFromEvent(record) }
      : undefined,
    finishReason: extractFinishReason(record),
    response: options.includeResponse
      ? responseSummaryFromEvent(record)
      : undefined,
    timeToFirstChunkSeconds: options.includePerformance
      ? timeToFirstChunkSeconds(record)
      : undefined,
    usage: tokenUsageFromEvent(record)
  });
}

/** Builds correlation attributes for AI SDK v7 callback ids. */
export function correlationAttributes(input: {
  readonly callId: string;
  readonly toolCallId?: string | undefined;
}): TraceAttributes {
  return {
    [TraceAttribute.Cloudflare.CallID]: input.callId,
    [TraceAttribute.GenAI.ToolCallID]: input.toolCallId
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

function responseSummaryFromEvent(
  event: Record<string, unknown>
): ResponseSummary | undefined {
  const response =
    typeof event.response === "object" && event.response !== null
      ? (event.response as Record<string, unknown>)
      : undefined;
  const id = readString(event.responseId ?? response?.id);
  // Never fall back to event.modelId: v7 carries the requested model there,
  // not the model that actually served the response.
  const model = readString(
    event.responseModel ?? response?.modelId ?? response?.model
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
  // Mirror the v6 extractor: public result shapes keep details in
  // inputTokenDetails/outputTokenDetails (with deprecated flat fields);
  // provider-level usage nests them on the token counts themselves.
  const cacheReadInputTokens =
    readNestedTokenField(usage.inputTokenDetails, "cacheReadTokens") ??
    readNestedTokenField(usage.inputTokens, "cacheRead") ??
    readNumber(usage.cachedInputTokens);
  const cacheCreationInputTokens =
    readNestedTokenField(usage.inputTokenDetails, "cacheWriteTokens") ??
    readNestedTokenField(usage.inputTokens, "cacheWrite");
  const reasoningTokens =
    readNestedTokenField(usage.outputTokenDetails, "reasoningTokens") ??
    readNestedTokenField(usage.outputTokens, "reasoning") ??
    readNumber(usage.reasoningTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
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
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  };
}

function timeToFirstChunkSeconds(
  event: Record<string, unknown>
): number | undefined {
  const performance =
    typeof event.performance === "object" && event.performance !== null
      ? (event.performance as Record<string, unknown>)
      : undefined;
  const milliseconds = readNumber(performance?.timeToFirstOutputMs);
  return milliseconds === undefined ? undefined : milliseconds / 1000;
}
