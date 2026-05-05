/**
 * Utilities for normalising various text-producing sources into a uniform
 * `AsyncGenerator<string>`.  This lets `onTurn()` return any of:
 *
 *   - A plain `string`
 *   - An `AsyncIterable<string>` (e.g. AI SDK `textStream`)
 *   - A `ReadableStream<Uint8Array>` (e.g. a raw `fetch` response body
 *     containing newline-delimited JSON / SSE)
 *   - A `ReadableStream<string>`
 *
 * The generator yields individual text chunks as they become available.
 */

/** Union of every source type that {@link iterateText} accepts. */
export type TextSource =
  | string
  | ReadableStream<Uint8Array>
  | ReadableStream<string>
  | AsyncIterable<string>;

/** Shape of a parsed NDJSON/SSE chunk from common AI APIs. */
interface AIStreamChunk {
  response?: string;
  choices?: {
    delta?: { content?: string; role?: string };
  }[];
}

type AsyncIteratorCandidate = {
  [Symbol.asyncIterator]?: unknown;
};

function getAsyncIteratorMethod(source: object): unknown {
  return (source as AsyncIteratorCandidate)[Symbol.asyncIterator];
}

function isAsyncIterable(source: object): source is AsyncIterable<string> {
  return typeof getAsyncIteratorMethod(source) === "function";
}

function hasExplicitAsyncIterator(
  source: object
): source is AsyncIterable<string> {
  const method = getAsyncIteratorMethod(source);
  if (typeof method !== "function") return false;

  if (Object.prototype.hasOwnProperty.call(source, Symbol.asyncIterator)) {
    return true;
  }

  if (source instanceof ReadableStream) {
    const nativeReadableStreamIterator = getAsyncIteratorMethod(
      ReadableStream.prototype
    );
    return (
      typeof nativeReadableStreamIterator === "function" &&
      method !== nativeReadableStreamIterator
    );
  }

  return false;
}

async function* iterateAsyncStrings(
  source: AsyncIterable<string>
): AsyncGenerator<string> {
  for await (const chunk of source) {
    if (typeof chunk === "string" && chunk) yield chunk;
  }
}

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
  // --- plain string ---
  if (typeof source === "string") {
    if (source) yield source;
    return;
  }

  // --- Explicit AsyncIterable<string> wrappers ---
  // AI SDK's `textStream` is both a ReadableStream and an AsyncIterable,
  // with an own/custom async iterator that yields raw text deltas. Prefer
  // that path before generic ReadableStream parsing. Native ReadableStreams
  // can also be async-iterable, so do not apply this to every stream.
  if (hasExplicitAsyncIterator(source)) {
    yield* iterateAsyncStrings(source);
    return;
  }

  // --- ReadableStream ---
  if (source instanceof ReadableStream) {
    const reader = (source as ReadableStream<string | Uint8Array>).getReader();

    const first = await reader.read();
    if (first.done || first.value === undefined) return;

    if (typeof first.value === "string") {
      // ReadableStream<string> — yield chunks as-is
      if (first.value) yield first.value;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (typeof value === "string" && value) yield value;
      }
    } else {
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
          yield ai.response;
        } else if (ai.choices && ai.choices.length > 0) {
          const choice = ai.choices[0];
          if (choice.delta?.content && choice.delta?.role === "assistant") {
            yield choice.delta.content;
          }
        }
      }
    }
    return;
  }

  // --- AsyncIterable<string> ---
  if (isAsyncIterable(source)) {
    yield* iterateAsyncStrings(source);
  }
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

  if (trimmed.startsWith("data: ")) {
    const json = trimmed.slice(6).trim();
    if (json === "[DONE]") return "DONE";
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      console.warn("[voice] Skipping malformed SSE data:", json);
      return null;
    }
  }

  return null;
}
