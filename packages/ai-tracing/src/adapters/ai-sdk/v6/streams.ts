import { finishAttributes } from "../../../genai/telemetry.js";
import type { OutputSummary, TokenUsageSummary } from "../../../genai/telemetry.js";
import type { Attributes, Span } from "../../../tracing/tracer.js";
import { extractAISDKv6TokenUsage, extractFinishReason } from "./extract.js";

type StreamSummary = {
  readonly finishReason?: string;
  readonly outputSummary?: OutputSummary;
  readonly usage?: TokenUsageSummary;
};

export function finishWhenStreamCompletes(
  result: unknown,
  span: Span,
): unknown {
  return patchStreamFields(result, {
    onComplete: (summary) => {
      span.finish(finishAttributesFromStreamSummary(summary));
    },
    onError: (cause) => {
      span.fail(cause);
    },
  });
}

function finishAttributesFromStreamSummary(summary: StreamSummary | undefined): Attributes {
  return finishAttributes({
    finishReason: summary?.finishReason,
    outputSummary: summary?.outputSummary,
    usage: summary?.usage,
  });
}

function patchStreamFields(
  result: unknown,
  hooks: {
    readonly onComplete: (summary: StreamSummary | undefined) => void;
    readonly onError: (cause: unknown) => void;
  },
): unknown {
  if (typeof result !== "object" || result === null) {
    hooks.onComplete(undefined);
    return result;
  }

  // SAFETY: AI SDK stream results are records with stream fields and promise-like properties.
  const record = result as Record<string, unknown>;
  attachKnownResultPromiseHandlers(record);

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

  if (isReadableStream(record.baseStream)) {
    Object.defineProperty(record, "baseStream", {
      configurable: true,
      enumerable: true,
      value: wrapReadableStream(record.baseStream, {
        onComplete: completeOnce,
        onError: errorOnce,
      }),
      writable: true,
    });
    return result;
  }

  const streamField = findStreamField(record, [
    "partialObjectStream",
    "textStream",
    "fullStream",
    "stream",
  ]);

  if (streamField) {
    Object.defineProperty(record, streamField.field, {
      configurable: true,
      enumerable: true,
      value: streamField.kind === "readable"
        ? wrapReadableStream(streamField.stream, {
            onComplete: completeOnce,
            onError: errorOnce,
          })
        : wrapAsyncIterable(streamField.stream, {
            onComplete: completeOnce,
            onError: errorOnce,
          }),
      writable: true,
    });
    patchedAny = true;
  }

  if (!patchedAny) {
    hooks.onComplete(undefined);
    return result;
  }

  return result;
}

function attachKnownResultPromiseHandlers(result: Record<string, unknown>): void {
  const promiseLikeFields = [
    "content",
    "text",
    "object",
    "value",
    "values",
    "finishReason",
    "usage",
    "totalUsage",
    "steps",
  ];

  for (const field of promiseLikeFields) {
    try {
      const value = result[field];
      if (isPromiseLike(value)) {
        void Promise.resolve(value).catch(() => {});
      }
    } catch {
      // Ignore getter failures while attaching safeguards.
    }
  }
}

function findStreamField(
  result: Record<string, unknown>,
  candidateFields: readonly string[],
):
  | { readonly field: string; readonly kind: "asyncIterable"; readonly stream: AsyncIterable<unknown> }
  | { readonly field: string; readonly kind: "readable"; readonly stream: ReadableStream<unknown> }
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
  },
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
    },
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
  },
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
    },
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
  let observedError: { readonly cause: unknown } | undefined;

  return {
    get closed() {
      return closed;
    },
    cancel() {
      if (closed) {
        return;
      }

      closed = true;
      if (observedError) {
        hooks.onError(observedError.cause);
        return;
      }

      hooks.onComplete(undefined);
    },
    complete() {
      if (closed) {
        return;
      }

      closed = true;
      if (observedError) {
        hooks.onError(observedError.cause);
        return;
      }

      hooks.onComplete(streamSummaryFromParts({
        finishReason,
        hasText,
        toolCallCount,
        usage,
      }));
    },
    fail(cause) {
      if (closed) {
        return;
      }

      closed = true;
      hooks.onError(cause);
    },
    observeChunk(chunk) {
      // AI SDK v6 signals mid-stream provider failures as an in-band
      // `{ type: "error" }` chunk rather than rejecting the stream, so the
      // stream still reaches normal completion afterward. Record it here and
      // fail the span on completion instead of treating it as a success.
      if (isErrorChunk(chunk)) {
        observedError = { cause: chunk.error };
      }
      if (isContentChunk(chunk)) {
        hasText = true;
      }
      if (isToolCallChunk(chunk)) {
        toolCallCount += 1;
      }
      finishReason = extractFinishReason(chunk) ?? finishReason;
      usage = extractAISDKv6TokenUsage(chunk) ?? usage;
    },
  };
}

function isErrorChunk(chunk: unknown): chunk is { readonly error: unknown } {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as Record<string, unknown>).type === "error"
  );
}

function streamSummaryFromParts(input: {
  readonly finishReason: string | undefined;
  readonly hasText: boolean;
  readonly toolCallCount: number;
  readonly usage: TokenUsageSummary | undefined;
}): StreamSummary {
  return {
    ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
    outputSummary: {
      ...(input.hasText ? { hasText: true } : {}),
      ...(input.toolCallCount > 0 ? { toolCallCount: input.toolCallCount } : {}),
    },
    ...(input.usage ? { usage: input.usage } : {}),
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

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
