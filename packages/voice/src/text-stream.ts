/**
 * Utilities for normalising various text-producing sources into a uniform
 * `AsyncGenerator<string>`.  This lets `onTurn()` return any of:
 *
 *   - A plain `string`
 *   - An `AsyncIterable<string>` (deprecated for AI SDK `textStream`)
 *   - An `AsyncIterable` of AI SDK `fullStream` parts
 *   - A `ReadableStream<Uint8Array>` (e.g. a raw `fetch` response body
 *     containing newline-delimited JSON / SSE)
 *   - A `ReadableStream<string>`
 *
 * The generator yields individual text chunks as they become available.
 */

/** Union of every source type that {@link iterateText} accepts. */
export type TextSource = string | TextReadableStream | AsyncIterable<unknown>;

export type TextStreamEvent =
  | { type: "text"; text: string }
  | { type: "boundary" }
  | { type: "error"; error: Error };

type TextReadableStreamReader = {
  read(): Promise<ReadableStreamReadResult<unknown>>;
};

interface TextReadableStream {
  getReader(): TextReadableStreamReader;
}

/** Shape of a parsed NDJSON/SSE chunk from common AI APIs. */
interface AIStreamChunk {
  response?: string;
  choices?: {
    delta?: { content?: string; role?: string };
  }[];
}

const warnedTextStreamSources = new WeakSet<object>();

/**
 * Turn any {@link TextSource} into a lazy async generator of string chunks.
 *
 * - `string` → yields the string once (if non-empty).
 * - `ReadableStream<string>` → yields each chunk directly.
 * - `ReadableStream<Uint8Array>` → decodes and parses as newline-delimited
 *   JSON (NDJSON) / SSE (`data: …` lines), extracting text from common AI
 *   response formats.
 * - `AsyncIterable<string>` → re-yields each chunk.
 */
export async function* iterateText(source: TextSource): AsyncGenerator<string> {
  for await (const event of iterateTextEvents(source)) {
    if (event.type === "text") {
      yield event.text;
    } else if (event.type === "error") {
      throw toError(event.error);
    }
  }
}

export async function* iterateTextEvents(
  source: TextSource
): AsyncGenerator<TextStreamEvent> {
  // --- plain string ---
  if (typeof source === "string") {
    if (source) yield textEvent(source);
    return;
  }

  // --- Custom AsyncIterable ---
  // AI SDK textStream/fullStream are ReadableStreams with custom async
  // iterators. Prefer those custom iterators before the generic ReadableStream
  // parser, while still letting native ReadableStream async iteration fall
  // through to the stream-specific branches below.
  if (hasCustomAsyncIterator(source)) {
    for await (const event of iterateAsyncTextEvents(
      source as AsyncIterable<unknown>
    )) {
      yield event;
    }
    return;
  }

  // --- ReadableStream ---
  if (source instanceof ReadableStream) {
    const reader = source.getReader();

    const first = await reader.read();
    if (first.done || first.value === undefined) return;

    if (first.value instanceof Uint8Array) {
      // ReadableStream<Uint8Array> — re-assemble into an NDJSON stream
      // by pushing the already-read first chunk back into a new stream.
      const peeked = first.value as Uint8Array;
      const combined = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(peeked);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value as Uint8Array);
          }
          controller.close();
        }
      });

      for await (const chunk of parseNDJSON(combined.getReader())) {
        const ai = chunk as AIStreamChunk;
        if (ai.response) {
          yield textEvent(ai.response);
        } else if (ai.choices && ai.choices.length > 0) {
          const choice = ai.choices[0];
          if (choice.delta?.content && choice.delta?.role === "assistant") {
            yield textEvent(choice.delta.content);
          }
        }
      }
    } else {
      for await (const event of iterateAsyncTextEvents(
        readWithFirst(first.value, reader)
      )) {
        yield event;
      }
    }
    return;
  }

  // --- AsyncIterable ---
  if (Symbol.asyncIterator in source) {
    for await (const event of iterateAsyncTextEvents(source)) {
      yield event;
    }
  }
}

async function* readWithFirst(
  first: unknown,
  reader: TextReadableStreamReader
): AsyncGenerator<unknown> {
  yield first;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield value;
  }
}

function hasCustomAsyncIterator(source: Exclude<TextSource, string>): boolean {
  const iterator = (source as Partial<AsyncIterable<unknown>>)[
    Symbol.asyncIterator
  ];

  if (typeof iterator !== "function") return false;

  if (!(source instanceof ReadableStream)) return true;

  return (
    Object.prototype.hasOwnProperty.call(source, Symbol.asyncIterator) ||
    iterator !==
      (ReadableStream.prototype as Partial<AsyncIterable<unknown>>)[
        Symbol.asyncIterator
      ]
  );
}

async function* iterateAsyncTextEvents(
  source: AsyncIterable<unknown>
): AsyncGenerator<TextStreamEvent> {
  let needsBoundarySpace = false;
  let hasYieldedText = false;
  let lastTextEndedWithWhitespace = false;

  for await (const chunk of source) {
    if (typeof chunk === "string") {
      warnDeprecatedTextStream(source);
      if (chunk) yield textEvent(chunk);
      continue;
    }

    if (!isRecord(chunk)) continue;

    if (chunk.type === "text-delta") {
      const text = getTextDelta(chunk);
      if (!text) continue;

      if (
        needsBoundarySpace &&
        hasYieldedText &&
        !lastTextEndedWithWhitespace &&
        !startsWithWhitespace(text)
      ) {
        yield textEvent(" ");
      }

      yield textEvent(text);
      hasYieldedText = true;
      lastTextEndedWithWhitespace = endsWithWhitespace(text);
      needsBoundarySpace = false;
      continue;
    }

    if (chunk.type === "error") {
      if (hasYieldedText) {
        yield { type: "boundary" };
      }
      yield { type: "error", error: toError(chunk.error) };
      return;
    }

    if (hasYieldedText && isTextBoundary(chunk.type)) {
      if (!needsBoundarySpace) yield { type: "boundary" };
      needsBoundarySpace = true;
    }
  }
}

function textEvent(text: string): TextStreamEvent {
  return { type: "text", text };
}

function warnDeprecatedTextStream(source?: object): void {
  if (!source || !(source instanceof ReadableStream)) return;
  if (warnedTextStreamSources.has(source)) return;
  warnedTextStreamSources.add(source);

  console.warn(
    "[voice] AI SDK textStream is not recommended because non-adjacent text parts may be joined incorrectly. Return result.fullStream from onTurn() instead."
  );
}

function getTextDelta(chunk: Record<string, unknown>): string | null {
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  return null;
}

function isTextBoundary(type: unknown): boolean {
  return (
    typeof type === "string" &&
    type !== "text-start" &&
    type !== "text-end" &&
    type !== "start" &&
    type !== "finish" &&
    type !== "start-step" &&
    type !== "finish-step"
  );
}

function startsWithWhitespace(text: string): boolean {
  return /^\s/.test(text);
}

function endsWithWhitespace(text: string): boolean {
  return /\s$/.test(text);
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("AI SDK stream error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Internal: NDJSON / SSE stream parser
// ---------------------------------------------------------------------------

/**
 * Parse a `ReadableStream<Uint8Array>` that contains newline-delimited JSON
 * or Server-Sent Events (`data: {…}` lines).  Yields each parsed JSON object.
 *
 * Handles the `data: [DONE]` sentinel used by OpenAI-compatible APIs.
 */
async function* parseNDJSON(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  leftOverBuffer = ""
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = leftOverBuffer;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed === "DONE") return;
      if (parsed) yield parsed;
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const remaining = buffer.split("\n").filter((l) => l.trim());
    for (const line of remaining) {
      const parsed = parseLine(line);
      if (parsed === "DONE") return;
      if (parsed) yield parsed;
    }
  }
}

function parseLine(line: string): Record<string, unknown> | "DONE" | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("data:")) {
    const json = trimmed.slice(5).trim();
    if (json === "[DONE]") return "DONE";
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      console.warn("[voice] Skipping malformed SSE data:", json);
      return null;
    }
  }

  if (trimmed === "[DONE]") return "DONE";

  // Ignore SSE metadata/comment lines. Only `data:` carries payload.
  if (
    trimmed.startsWith(":") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith("id:") ||
    trimmed.startsWith("retry:")
  ) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    console.warn("[voice] Skipping malformed NDJSON line:", trimmed);
    return null;
  }
}
