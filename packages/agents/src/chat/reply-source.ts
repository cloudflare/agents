/**
 * What the reply pump reads: a model's reply as UI message chunks.
 *
 * `Think` hands over an AI SDK result ({@link uiMessageStreamSource}).
 * `AIChatAgent` hands over the `Response` its `onChatMessage` returned
 * ({@link responseSource}): an AI SDK UI message stream (server-sent events),
 * or plain text, which becomes one text part.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { StreamChunkData } from "./message-builder";

/** @internal */
export interface ReplySource {
  readonly chunks: AsyncIterable<StreamChunkData>;
  /** The provider error behind the last in-band `error` chunk, if known. */
  errorCause?(): unknown;
  /**
   * Stop a read in progress when the turn is stopped. A source whose
   * producer already listens to the turn's signal needs none.
   */
  cancel?(): void;
  /** Release a source the pump stopped reading before its end. */
  release?(): void;
}

/**
 * The part of an AI SDK `streamText` result the pump reads.
 *
 * @internal
 */
export interface UIMessageStreamResult {
  toUIMessageStream(options?: {
    onError?: (error: unknown) => string;
  }): AsyncIterable<unknown>;
}

/**
 * The text an in-band error chunk carries for `error`.
 *
 * @internal
 */
export function streamErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Read an AI SDK result. The provider error behind an in-band `error`
 * chunk is kept for {@link ReplySource.errorCause}, so the host classifies
 * the error and not its text.
 *
 * @param release - Runs when the pump stopped before the stream's end.
 *
 * @internal
 */
export function uiMessageStreamSource(
  result: UIMessageStreamResult,
  release?: () => void
): ReplySource {
  let cause: unknown;
  const chunks = result.toUIMessageStream({
    onError: (error) => {
      cause = error;
      return streamErrorText(error);
    }
  }) as AsyncIterable<StreamChunkData>;
  return { chunks, errorCause: () => cause, release };
}

/**
 * Read the `Response` of an `onChatMessage`. A `text/event-stream` body is a
 * UI message stream: each `data:` line is one chunk, a line that is not JSON
 * is skipped. Any other body is plain text, sent as one text part under the
 * request id.
 *
 * @internal
 */
export function responseSource(
  response: Response,
  body: ReadableStream<Uint8Array>,
  requestId: string
): ReplySource {
  // Taken now: an unreadable body fails before the reply starts.
  const reader = body.getReader();
  const sse = (response.headers.get("content-type") ?? "").includes(
    "text/event-stream"
  );
  let released = false;
  const cancel = () => {
    if (released) return;
    released = true;
    reader.cancel().catch(() => {});
  };
  return {
    chunks: sse ? sseChunks(reader) : plainTextChunks(reader, requestId),
    cancel,
    release: cancel
  };
}

async function* readText(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) yield text;
    }
    const rest = decoder.decode();
    if (rest.length > 0) yield rest;
  } finally {
    reader.releaseLock();
  }
}

async function* sseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamChunkData> {
  // A line can span two reads: keep the unfinished tail for the next one.
  let pending = "";
  for await (const text of readText(reader)) {
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const chunk = parseSseLine(line);
      if (chunk) yield chunk;
    }
  }
  const last = parseSseLine(pending);
  if (last) yield last;
}

function parseSseLine(line: string): StreamChunkData | undefined {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(6)) as StreamChunkData;
  } catch {
    return undefined;
  }
}

async function* plainTextChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  id: string
): AsyncGenerator<StreamChunkData> {
  let started = false;
  for await (const delta of readText(reader)) {
    if (!started) {
      started = true;
      yield { type: "text-start", id };
    }
    yield { type: "text-delta", id, delta };
  }
  if (started) yield { type: "text-end", id };
}
