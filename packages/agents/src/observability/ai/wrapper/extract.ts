import { finishAttributes } from "../../genai/telemetry";
import type {
  RequestSummary,
  ResponseSummary,
  TokenUsageSummary
} from "../../genai/telemetry";
import type { TraceAttributes } from "../../tracing/tracer";
import {
  readNestedTokenField,
  readNumber,
  readString,
  readTokenCount
} from "../read";

/** Identity fields extracted from an AI SDK language model object. */
export type ModelInfo = {
  readonly modelId: string | undefined;
  readonly provider: string | undefined;
};

export function finishAttributesFromResult(
  result: unknown,
  options: {
    readonly aiGatewayLogId?: string | undefined;
    readonly includeResponse?: boolean;
  } = {}
): TraceAttributes {
  return finishAttributes({
    aiGatewayLogId: options.aiGatewayLogId,
    finishReason: extractFinishReason(result),
    response: options.includeResponse ? extractResponseInfo(result) : undefined,
    toolCallCount: extractToolCallCount(result),
    usage: extractAISDKTokenUsage(result)
  });
}

export function extractRequestSummary(
  params: Record<string, unknown>,
  operation: string
): RequestSummary {
  return {
    frequencyPenalty: readNumber(params.frequencyPenalty),
    maxTokens: readNumber(params.maxOutputTokens ?? params.maxTokens),
    outputType:
      operation === "generateObject" || operation === "streamObject"
        ? "json"
        : "text",
    presencePenalty: readNumber(params.presencePenalty),
    seed: readNumber(params.seed),
    stream: operation === "streamText" || operation === "streamObject",
    temperature: readNumber(params.temperature),
    topK: readNumber(params.topK),
    topP: readNumber(params.topP)
  };
}

/** Extracts model identity from an AI SDK model object. */
export function extractModelInfo(value: unknown): ModelInfo | undefined {
  // Gateway-style string model ids still identify the model.
  if (typeof value === "string") {
    return value.length > 0
      ? { modelId: value, provider: undefined }
      : undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK model objects are records; we only read modelId and provider.
  const record = value as Record<string, unknown>;
  const modelId =
    typeof record.modelId === "string" ? record.modelId : undefined;
  const provider =
    typeof record.provider === "string" ? record.provider : undefined;

  if (modelId === undefined && provider === undefined) {
    return undefined;
  }

  return { modelId, provider };
}

/**
 * Extracts token usage from an AI SDK result or stream chunk across supported
 * majors. Token counts may be plain numbers or nested objects such as
 * `{ total, cacheRead, cacheWrite }` / `{ total, reasoning }`.
 */
export function extractAISDKTokenUsage(
  value: unknown
): TokenUsageSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK result/chunk objects are records with known optional fields.
  const record = value as Record<string, unknown>;

  // Results expose totalUsage (multi-step aggregate) or usage.
  const raw = record.totalUsage ?? record.usage;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  // SAFETY: AI SDK usage is a record with inputTokens, outputTokens, totalTokens.
  const usage = raw as Record<string, unknown>;

  const inputTokens = readTokenCount(usage.inputTokens);
  const outputTokens = readTokenCount(usage.outputTokens);
  const totalTokens = readNumber(usage.totalTokens);
  // The public result usage keeps details in inputTokenDetails/outputTokenDetails
  // (with deprecated flat fields); provider-level usage nests them on the token
  // counts themselves. Read all shapes.
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

function extractToolCallCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const toolCalls = (value as Record<string, unknown>).toolCalls;
  return Array.isArray(toolCalls) && toolCalls.length > 0
    ? toolCalls.length
    : undefined;
}

/**
 * Reads a finish reason from an AI SDK result or `finish`-type stream chunk.
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

  // The SDK may expose finishReason as { unified: string }.
  if (typeof finishReason === "object" && finishReason !== null) {
    // SAFETY: finishReason object has an optional unified string field.
    const unified = (finishReason as Record<string, unknown>).unified;
    return typeof unified === "string" ? unified : undefined;
  }

  return undefined;
}

export function extractResponseInfo(
  value: unknown
): ResponseSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  // SAFETY: AI SDK result objects may expose a response record with id/model.
  const record = value as Record<string, unknown>;

  // Provider-level `response-metadata` stream parts carry id/modelId at the
  // top level (no nested response record).
  if (record.type === "response-metadata") {
    const id = readString(record.id);
    const model = readString(record.modelId);
    if (id === undefined && model === undefined) {
      return undefined;
    }
    return {
      ...(id !== undefined ? { id } : {}),
      ...(model !== undefined ? { model } : {})
    };
  }

  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : undefined;
  const id = readString(record.responseId ?? response?.id);
  const model = readString(
    record.responseModel ?? response?.modelId ?? response?.model
  );

  if (id === undefined && model === undefined) {
    return undefined;
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {})
  };
}
