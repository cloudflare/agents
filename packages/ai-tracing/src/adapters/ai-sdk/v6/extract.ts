import { finishAttributes } from "../../../genai/telemetry.js";
import type {
  OutputSummary,
  RequestSummary,
  ResponseSummary,
  TokenUsageSummary,
} from "../../../genai/telemetry.js";
import type { Attributes } from "../../../tracing/tracer.js";
import { readNestedTokenField, readNumber, readString, readTokenCount } from "../read.js";

/** Identity fields extracted from an AI SDK v6 language model object. */
export type ModelInfo = {
  readonly modelId: string | undefined;
  readonly provider: string | undefined;
};

export function finishAttributesFromResult(result: unknown): Attributes {
  const finishReason = extractFinishReason(result);
  const outputSummary = summarizeOutput(result);
  const response = extractResponseInfo(result);
  const usage = extractAISDKv6TokenUsage(result);

  return finishAttributes({ finishReason, outputSummary, response, usage });
}

export function extractRequestSummary(
  params: Record<string, unknown>,
  operation: string,
): RequestSummary {
  return {
    frequencyPenalty: readNumber(params.frequencyPenalty),
    maxTokens: readNumber(params.maxOutputTokens ?? params.maxTokens),
    outputType: operation === "generateObject" || operation === "streamObject" ? "json" : "text",
    presencePenalty: readNumber(params.presencePenalty),
    seed: readNumber(params.seed),
    stream: operation === "streamText" || operation === "streamObject",
    temperature: readNumber(params.temperature),
    topK: readNumber(params.topK),
    topP: readNumber(params.topP),
  };
}

/** Extracts model identity from an AI SDK v6 model object. */
export function extractModelInfo(value: unknown): ModelInfo | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK model objects are records; we only read modelId and provider.
  const record = value as Record<string, unknown>;
  const modelId = typeof record.modelId === "string" ? record.modelId : undefined;
  const provider = typeof record.provider === "string" ? record.provider : undefined;

  if (modelId === undefined && provider === undefined) {
    return undefined;
  }

  return { modelId, provider };
}

/**
 * Extracts token usage from an AI SDK v6 result or stream chunk.
 *
 * AI SDK v6 exposes usage as `{ inputTokens, outputTokens, totalTokens }`
 * where `inputTokens`/`outputTokens` may be plain numbers or nested objects
 * like `{ total, cacheRead, cacheWrite }` / `{ total, reasoning }`.
 */
export function extractAISDKv6TokenUsage(value: unknown): TokenUsageSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK result/chunk objects are records with known optional fields.
  const record = value as Record<string, unknown>;

  // AI SDK v6 results expose totalUsage (multi-step aggregate) or usage.
  const raw = record.totalUsage ?? record.usage;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  // SAFETY: AI SDK v6 usage is a record with inputTokens, outputTokens, totalTokens.
  const usage = raw as Record<string, unknown>;

  const inputTokens = readTokenCount(usage.inputTokens);
  const outputTokens = readTokenCount(usage.outputTokens);
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
  const cacheReadInputTokens = readNestedTokenField(usage.inputTokens, "cacheRead");
  const cacheCreationInputTokens = readNestedTokenField(usage.inputTokens, "cacheWrite");
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
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function summarizeOutput(value: unknown): OutputSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK result objects are records with optional text/object/toolCalls fields.
  const record = value as Record<string, unknown>;

  const summary: OutputSummary = {
    ...(typeof record.text === "string" ? { hasText: record.text.length > 0 } : {}),
    ...(record.object !== undefined ? { hasObject: true } : {}),
    ...(Array.isArray(record.toolCalls) ? { toolCallCount: record.toolCalls.length } : {}),
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Reads a finish reason from an AI SDK v6 result or `finish`-type stream chunk.
 */
export function extractFinishReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK result objects are records with an optional finishReason field.
  const record = value as Record<string, unknown>;
  const finishReason = record.finishReason;

  if (typeof finishReason === "string") {
    return finishReason;
  }

  // AI SDK v6 may expose finishReason as { unified: string }.
  if (typeof finishReason === "object" && finishReason !== null) {
    // SAFETY: finishReason object has an optional unified string field.
    const unified = (finishReason as Record<string, unknown>).unified;
    return typeof unified === "string" ? unified : undefined;
  }

  return undefined;
}

function extractResponseInfo(value: unknown): ResponseSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK result objects may expose a response record with id/model.
  const record = value as Record<string, unknown>;
  const response = typeof record.response === "object" && record.response !== null
    ? (record.response as Record<string, unknown>)
    : undefined;
  const id = readString(record.responseId ?? response?.id);
  const model = readString(record.responseModel ?? response?.model);

  if (id === undefined && model === undefined) {
    return undefined;
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
