import { finishAttributes } from "../../genai/telemetry";
import type { ResponseSummary, TokenUsageSummary } from "../../genai/telemetry";
import type { TraceAttributes, AgentSpan } from "../../tracing/tracer";
import {
  extractAISDKv6TokenUsage,
  extractFinishReason,
  extractResponseInfo
} from "./extract";

type StreamSummary = {
  readonly finishReason?: string;
  readonly outputContent?: unknown;
  readonly response?: ResponseSummary;
  readonly toolCallCount?: number;
  readonly timeToFirstChunkSeconds?: number;
  readonly usage?: TokenUsageSummary;
};

export function finishWhenStreamCompletes(
  result: unknown,
  span: AgentSpan,
  options: {
    readonly includeResponse?: boolean;
    readonly recordOutputs?: boolean;
    readonly startedAtMs?: number;
  } = {}
): unknown {
  const recordOutputs = options.recordOutputs === true;
  return patchStreamFields(
    result,
    {
      onComplete: (summary) => {
        span.finish(
          finishAttributesFromStreamSummary(
            summary,
            options.includeResponse === true,
            recordOutputs
          )
        );
      },
      onError: (cause) => {
        span.fail(cause);
      }
    },
    options.startedAtMs,
    recordOutputs
  );
}

function finishAttributesFromStreamSummary(
  summary: StreamSummary | undefined,
  includeResponse: boolean,
  recordOutputs: boolean
): TraceAttributes {
  return finishAttributes({
    content: recordOutputs
      ? { outputMessages: summary?.outputContent }
      : undefined,
    finishReason: summary?.finishReason,
    response: includeResponse ? summary?.response : undefined,
    timeToFirstChunkSeconds: summary?.timeToFirstChunkSeconds,
    toolCallCount: summary?.toolCallCount,
    usage: summary?.usage
  });
}

function patchStreamFields(
  result: unknown,
  hooks: {
    readonly onComplete: (summary: StreamSummary | undefined) => void;
    readonly onError: (cause: unknown) => void;
  },
  startedAtMs: number | undefined,
  recordOutputs: boolean
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
        value: wrapReadableStream(
          record.baseStream,
          {
            onComplete: completeOnce,
            onError: errorOnce
          },
          startedAtMs,
          recordOutputs
        ),
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
            ? wrapReadableStream(
                streamField.stream,
                {
                  onComplete: completeOnce,
                  onError: errorOnce
                },
                startedAtMs,
                recordOutputs
              )
            : wrapAsyncIterable(
                streamField.stream,
                {
                  onComplete: completeOnce,
                  onError: errorOnce
                },
                startedAtMs,
                recordOutputs
              ),
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
  },
  startedAtMs: number | undefined,
  recordOutputs: boolean
): ReadableStream<unknown> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  const state = createStreamState(hooks, startedAtMs, recordOutputs);

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
  },
  startedAtMs: number | undefined,
  recordOutputs: boolean
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const state = createStreamState(hooks, startedAtMs, recordOutputs);
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

function createStreamState(
  hooks: {
    readonly onComplete: (summary: StreamSummary | undefined) => void;
    readonly onError: (cause: unknown) => void;
  },
  startedAtMs: number | undefined,
  recordOutputs: boolean
): {
  readonly closed: boolean;
  cancel(): void;
  complete(): void;
  fail(cause: unknown): void;
  observeChunk(chunk: unknown): void;
} {
  let closed = false;
  let finishReason: string | undefined;
  let toolCallCount = 0;
  let usage: TokenUsageSummary | undefined;
  let response: ResponseSummary | undefined;
  let observedError: { readonly cause: unknown } | undefined;
  let observedAbort = false;
  let firstChunkAtMs: number | undefined;
  // Opt-in output accumulation (PII); only populated when recordOutputs is set.
  const output = createOutputAccumulator();

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
          outputContent: recordOutputs ? output.content() : undefined,
          response,
          timeToFirstChunkSeconds:
            firstChunkAtMs === undefined || startedAtMs === undefined
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
      if (isToolCallChunk(chunk)) {
        toolCallCount += 1;
      }
      if (recordOutputs) {
        output.observe(chunk);
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
  readonly outputContent: unknown;
  readonly response: ResponseSummary | undefined;
  readonly timeToFirstChunkSeconds: number | undefined;
  readonly toolCallCount: number;
  readonly usage: TokenUsageSummary | undefined;
}): StreamSummary {
  return {
    ...(input.finishReason !== undefined
      ? { finishReason: input.finishReason }
      : {}),
    ...(input.outputContent !== undefined
      ? { outputContent: input.outputContent }
      : {}),
    ...(input.response ? { response: input.response } : {}),
    ...(input.timeToFirstChunkSeconds !== undefined
      ? { timeToFirstChunkSeconds: input.timeToFirstChunkSeconds }
      : {}),
    ...(input.toolCallCount > 0 ? { toolCallCount: input.toolCallCount } : {}),
    ...(input.usage ? { usage: input.usage } : {})
  };
}

/**
 * Accumulates opt-in output content from an AI SDK v6 stream: concatenates
 * `text-delta` chunks, collects `tool-call` chunks, and keeps the latest
 * object payload (streamObject). Only fed chunks when `recordOutputs` is set;
 * the assembled value is potentially PII.
 */
function createOutputAccumulator(): {
  content(): unknown;
  observe(chunk: unknown): void;
} {
  let text = "";
  const toolCalls: unknown[] = [];
  let object: unknown;

  return {
    content() {
      const output: Record<string, unknown> = {};
      if (text.length > 0) {
        output.text = text;
      }
      if (toolCalls.length > 0) {
        output.toolCalls = toolCalls;
      }
      if (object !== undefined) {
        output.object = object;
      }
      return Object.keys(output).length > 0 ? output : undefined;
    },
    observe(chunk) {
      if (typeof chunk !== "object" || chunk === null) {
        // streamObject's partialObjectStream yields bare object snapshots.
        if (chunk !== undefined) {
          object = chunk;
        }
        return;
      }

      const record = chunk as Record<string, unknown>;
      if (record.type === "text-delta") {
        const delta = record.text ?? record.delta;
        if (typeof delta === "string") {
          text += delta;
        }
        return;
      }
      if (record.type === "tool-call") {
        toolCalls.push(chunk);
        return;
      }
      if (record.object !== undefined) {
        object = record.object;
        return;
      }
      // A bare object snapshot (partialObjectStream) with no discriminant.
      if (record.type === undefined) {
        object = chunk;
      }
    }
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

function isToolCallChunk(chunk: unknown): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as Record<string, unknown>).type === "tool-call"
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
