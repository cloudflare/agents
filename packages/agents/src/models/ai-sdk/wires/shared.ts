import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning
} from "@ai-sdk/provider";

/** A request body plus whatever the conversion had to drop. */
export interface WireRequest {
  body: Record<string, unknown>;
  warnings: SharedV4Warning[];
  /** Chat completions only: the body turns reasoning off via the chat template. */
  reasoningOff?: boolean;
}

/** A fully parsed non-streaming response, in AI SDK terms. */
export interface WireGeneration {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
  usage: LanguageModelV4Usage;
  responseId: string | undefined;
  responseModelId: string | undefined;
  timestamp: Date | undefined;
}

/** Turns each SSE `data:` payload into AI SDK stream parts. */
export type WireStreamParser = TransformStream<
  string,
  LanguageModelV4StreamPart
>;

/** Usage with every field unknown — the shape callers can always fall back to. */
export function emptyUsage(): LanguageModelV4Usage {
  return {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: undefined,
      total: undefined
    },
    outputTokens: { reasoning: undefined, text: undefined, total: undefined }
  };
}

/** A fresh id for a stream part or a tool call the provider did not name. */
export function newId(): string {
  return crypto.randomUUID();
}

const BASE64_CHUNK = 0x8000;

/** Base64-encodes bytes without blowing the argument limit on large files. */
export function toBase64(data: Uint8Array | string): string {
  if (typeof data === "string") return data;
  let binary = "";
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...data.subarray(offset, offset + BASE64_CHUNK)
    );
  }
  return btoa(binary);
}

/** Reads a record field without widening everything to `any`. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads an array field, or `undefined` when it is not one. */
export function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Reads a string field, or `undefined` when it is not one. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Reads a number field, or `undefined` when it is not one. */
export function count(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** The finish reason used when a provider ends a stream without saying why. */
export function defaultFinishReason(): LanguageModelV4FinishReason {
  return { raw: undefined, unified: "stop" };
}
