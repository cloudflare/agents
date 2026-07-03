import { finishAttributes } from "../../genai/telemetry";
import type {
  OutputSummary,
  ResponseSummary,
  TokenUsageSummary
} from "../../genai/telemetry";
import type { TraceAttributes, AgentSpan } from "../../tracing/tracer";
import {
  extractAISDKv6TokenUsage,
  extractFinishReason,
  extractResponseInfo
} from "./extract";

type StreamSummary = {
  readonly finishReason?: string;
  readonly outputSummary?: OutputSummary;
  readonly response?: ResponseSummary;
  readonly timeToFirstChunkSeconds?: number;
  readonly usage?: TokenUsageSummary;
};

export function finishWhenStreamCompletes(
  result: unknown,
  span: AgentSpan
): unknown {
  return patchStreamFields(result, {
    onComplete: (summary) => {
      span.finish(finishAttributesFromStreamSummary(summary));
    },
    onError: (cause) => {
      span.fail(cause);
    }
  });
}

function finishAttributesFromStreamSummary(
  summary: StreamSummary | undefined
): TraceAttributes {
  return finishAttributes({
    finishReason: summary?.finishReason,
    outputSummary: summary?.outputSummary,
    response: summary?.response,
    timeToFirstChunkSeconds: summary?.timeToFirstChunkSeconds,
    usage: summary?.usage
  });
}

function patchStreamFields(
  result: unknown,
  hooks: {
    readonly onComplete: (summary: StreamSummary | undefined) => void;
    readonly onError: (cause: unknown) => void;
  }
): unknown {
  if (typeof result !== "object" || result === null) {
    hooks.onComplete(undefined);
    return result;
  }

  // SAFETY: AI SDK stream results are records with stream fields.
  const record = result as Record<string, unknown>;

  let patchedAny = false;
  let closed = false;

  const completeOnce = (summary: StreamSummary | undefined) => {
    if (closed) {
      return;
    }
    closed = true;
    hooks.onComplete(summary);
  };

  const errorOnce = (cause: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    hooks.onError(cause);
  };

  // Instrumentation must fail open: if the SDK's private stream fields change
  // shape or refuse patching, close the span and return the result untouched
  // rather than breaking an otherwise valid call.
  try {
    if (isReadableStream(record.baseStream)) {
      Object.defineProperty(record, "baseStream", {
        configurable: true,
        enumerable: true,
        value: wrapReadableStream(record.baseStream, {
          onComplete: completeOnce,
          onError: errorOnce
        }),
        writable: true
      });
      return result;
    }

    const streamField = findStreamField(record, [
      "partialObjectStream",
      "textStream",
      "fullStream",
      "stream"
    ]);

    if (streamField) {
      Object.defineProperty(record, streamField.field, {
        configurable: true,
        enumerable: true,
        value:
          streamField.kind === "readable"
            ? wrapReadableStream(streamField.stream, {
                onComplete: completeOnce,
                onError: errorOnce
              })
            : wrapAsyncIterable(streamField.stream, {
                onComplete: completeOnce,
                onError: errorOnce
              }),
        writable: true
      });
      patchedAny = true;
    }
  } catch {
    patchedAny = false;
  }

  if (!patchedAny) {
    hooks.onComplete(undefined);
    return result;
  }

  return result;
}

function findStreamField(
  result: Record<string, unknown>,
  candidateFields: readonly string[]
):
  | {
      readonly field: string;
      readonly kind: "asyncIterable";
      readonly stream: AsyncIterable<unknown>;
    }
  | {
      readonly field: string;
      readonly kind: "readable";
      readonly stream: ReadableStream<unknown>;
    }
  | undefined {
  for (const field of candidateFields) {
    try {
      const stream = result[field];
      if (isReadableStream(stream)) {
        return { field, kind: "readable", stream };
      }
      if (isAsyncIterable(stream)) {
        return { field, kind: "asyncIterable", stream };
      }
    } catch {
      // Ignore getter failures.
    }
  }

  return undefined;
}

function wrapReadableStream(
  stream: ReadableStream<unknown>,
  hooks: {
    readonly onComplete: (summary: StreamSummary | undefined) => void;
    readonly onError: (cause: unknown) => void;
  }
): ReadableStream<unknown> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  const state = createStreamState(hooks);

  return new ReadableStream<unknown>({
    async pull(controller) {
      reader ??= stream.getReader();
      try {
        const result = await reader.read();
        if (state.closed) {
          return;
        }

        if (result.done) {
          state.complete();
          controller.close();
          releaseReader();
          return;
        }

        state.observeChunk(result.value);
        controller.enqueue(result.value);
      } catch (cause: unknown) {
        if (!state.closed) {
          state.fail(cause);
          controller.error(cause);
        }
        releaseReader();
      }
    },
    async cancel(reason) {
      state.cancel();
      try {
        if (reader) {
          await reader.cancel(reason);
          return;
        }

        await stream.cancel(reason);
      } catch (cause: unknown) {
        state.fail(cause);
        throw cause;
      } finally {
        releaseReader();
      }
    }
  });

  function releaseReader(): void {
    if (!reader) {
      return;
    }

    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release failures after stream errors or cancellation.
    } finally {
      reader = undefined;
    }
  }
}

function wrapAsyncIterable(
  stream: AsyncIterable<unknown>,
  hooks: {
    readonly onComplete: (summary: StreamSummary | undefined) => void;
    readonly onError: (cause: unknown) => void;
  }
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const state = createStreamState(hooks);
      try {
        for await (const chunk of stream) {
          state.observeChunk(chunk);
          yield chunk;
        }

        state.complete();
      } catch (cause: unknown) {
        state.fail(cause);
        throw cause;
      } finally {
        state.cancel();
      }
    }
  };
}

function createStreamState(hooks: {
  readonly onComplete: (summary: StreamSummary | undefined) => void;
  readonly onError: (cause: unknown) => void;
}): {
  readonly closed: boolean;
  cancel(): void;
  complete(): void;
  fail(cause: unknown): void;
  observeChunk(chunk: unknown): void;
} {
  let closed = false;
  let finishReason: string | undefined;
  let hasText = false;
  let toolCallCount = 0;
  let usage: TokenUsageSummary | undefined;
  let response: ResponseSummary | undefined;
  let observedError: { readonly cause: unknown } | undefined;
  let observedAbort = false;
  let firstChunkAtMs: number | undefined;
  const startedAtMs = Date.now();

  const settleObserved = (): boolean => {
    if (observedError) {
      hooks.onError(observedError.cause);
      return true;
    }

    if (observedAbort) {
      // AI SDK v6 signals aborts as an in-band `{ type: "abort" }` chunk and
      // completes the stream normally — it never rejects with an AbortError.
      // Surface a structurally AbortError-shaped cause so the tracer
      // classifies the span as canceled instead of a false success.
      hooks.onError({ name: "AbortError" });
      return true;
    }

    return false;
  };

  return {
    get closed() {
      return closed;
    },
    cancel() {
      if (closed) {
        return;
      }

      closed = true;
      if (settleObserved()) {
        return;
      }

      hooks.onComplete(undefined);
    },
    complete() {
      if (closed) {
        return;
      }

      closed = true;
      if (settleObserved()) {
        return;
      }

      hooks.onComplete(
        streamSummaryFromParts({
          finishReason,
          hasText,
          response,
          timeToFirstChunkSeconds:
            firstChunkAtMs === undefined
              ? undefined
              : (firstChunkAtMs - startedAtMs) / 1000,
          toolCallCount,
          usage
        })
      );
    },
    fail(cause) {
      if (closed) {
        return;
      }

      closed = true;
      hooks.onError(cause);
    },
    observeChunk(rawChunk) {
      firstChunkAtMs ??= Date.now();
      const chunk = unwrapChunkEnvelope(rawChunk);
      // AI SDK v6 signals mid-stream provider failures as an in-band
      // `{ type: "error" }` chunk rather than rejecting the stream, so the
      // stream still reaches normal completion afterward. Record it here and
      // fail the span on completion instead of treating it as a success.
      if (isErrorChunk(chunk)) {
        observedError = { cause: chunk.error };
      }
      if (isAbortChunk(chunk)) {
        observedAbort = true;
      }
      if (isContentChunk(chunk)) {
        hasText = true;
      }
      if (isToolCallChunk(chunk)) {
        toolCallCount += 1;
      }
      finishReason = extractFinishReason(chunk) ?? finishReason;
      usage = extractAISDKv6TokenUsage(chunk) ?? usage;
      response = extractResponseInfo(chunk) ?? response;
    }
  };
}

/**
 * The streamText result's private `baseStream` carries `{ part, partialOutput }`
 * envelopes rather than bare stream parts; `fullStream` and provider-level
 * streams carry bare parts. Unwrap the envelope when present so chunk
 * inspection sees the actual part in both cases.
 */
function unwrapChunkEnvelope(chunk: unknown): unknown {
  if (typeof chunk !== "object" || chunk === null) {
    return chunk;
  }

  const part = (chunk as Record<string, unknown>).part;
  return typeof part === "object" &&
    part !== null &&
    "type" in (part as Record<string, unknown>)
    ? part
    : chunk;
}

function isErrorChunk(chunk: unknown): chunk is { readonly error: unknown } {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as Record<string, unknown>).type === "error"
  );
}

function isAbortChunk(chunk: unknown): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as Record<string, unknown>).type === "abort"
  );
}

function streamSummaryFromParts(input: {
  readonly finishReason: string | undefined;
  readonly hasText: boolean;
  readonly response: ResponseSummary | undefined;
  readonly timeToFirstChunkSeconds: number | undefined;
  readonly toolCallCount: number;
  readonly usage: TokenUsageSummary | undefined;
}): StreamSummary {
  return {
    ...(input.finishReason !== undefined
      ? { finishReason: input.finishReason }
      : {}),
    outputSummary: {
      ...(input.hasText ? { hasText: true } : {}),
      ...(input.toolCallCount > 0 ? { toolCallCount: input.toolCallCount } : {})
    },
    ...(input.response ? { response: input.response } : {}),
    ...(input.timeToFirstChunkSeconds !== undefined
      ? { timeToFirstChunkSeconds: input.timeToFirstChunkSeconds }
      : {}),
    ...(input.usage ? { usage: input.usage } : {})
  };
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipeThrough" in value &&
    typeof value.pipeThrough === "function" &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function isContentChunk(chunk: unknown): boolean {
  if (typeof chunk === "string") {
    return chunk.length > 0;
  }

  if (typeof chunk !== "object" || chunk === null) {
    return false;
  }

  // SAFETY: AI SDK stream chunks are records with a type discriminator.
  const record = chunk as Record<string, unknown>;

  if (record.type === "text-delta") {
    return (
      (typeof record.delta === "string" && record.delta.length > 0) ||
      (typeof record.textDelta === "string" && record.textDelta.length > 0) ||
      (typeof record.text === "string" && record.text.length > 0)
    );
  }

  return record.type === "text" && typeof record.text === "string";
}

function isToolCallChunk(chunk: unknown): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as Record<string, unknown>).type === "tool-call"
  );
}
