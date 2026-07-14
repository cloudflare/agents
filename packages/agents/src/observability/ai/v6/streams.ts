import {
  aiGatewayLogAttributes,
  finishAttributes
} from "../../genai/telemetry";
import type { ResponseSummary, TokenUsageSummary } from "../../genai/telemetry";
import { writeSpanAttributes } from "../../tracing/tracer";
import type { TraceAttributes, AgentSpan } from "../../tracing/tracer";
import { extractAIGatewayLogId } from "../ai-gateway";
import {
  extractAISDKv6TokenUsage,
  extractFinishReason,
  extractResponseInfo
} from "./extract";

type StreamSummary = {
  readonly aiGatewayLogId?: string;
  readonly finishReason?: string;
  readonly response?: ResponseSummary;
  readonly toolCallCount?: number;
  readonly timeToFirstChunkSeconds?: number;
  readonly usage?: TokenUsageSummary;
};

export function finishWhenStreamCompletes(
  result: unknown,
  span: AgentSpan,
  options: {
    readonly aiGatewayLogId?: string;
    readonly includeAIGatewayLog?: boolean;
    readonly includeResponse?: boolean;
    readonly startedAtMs?: number;
  } = {}
): unknown {
  return patchStreamFields(
    result,
    {
      onComplete: (summary) => {
        span.finish(
          finishAttributesFromStreamSummary(
            summary,
            options.includeResponse === true,
            options.includeAIGatewayLog === true,
            options.aiGatewayLogId
          )
        );
      },
      onError: (cause, observedAIGatewayLogId) => {
        if (options.includeAIGatewayLog) {
          writeSpanAttributes(
            span,
            aiGatewayLogAttributes(
              observedAIGatewayLogId ??
                extractAIGatewayLogId(cause) ??
                options.aiGatewayLogId
            )
          );
        }
        span.fail(cause);
      }
    },
    options.startedAtMs,
    options.includeAIGatewayLog ? options.aiGatewayLogId : undefined
  );
}

function finishAttributesFromStreamSummary(
  summary: StreamSummary | undefined,
  includeResponse: boolean,
  includeAIGatewayLog: boolean,
  initialAIGatewayLogId: string | undefined
): TraceAttributes {
  return finishAttributes({
    aiGatewayLogId: includeAIGatewayLog
      ? (summary?.aiGatewayLogId ?? initialAIGatewayLogId)
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
    readonly onError: (
      cause: unknown,
      aiGatewayLogId: string | undefined
    ) => void;
  },
  startedAtMs: number | undefined,
  aiGatewayLogId: string | undefined
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

  const errorOnce = (
    cause: unknown,
    observedAIGatewayLogId: string | undefined
  ) => {
    if (closed) {
      return;
    }
    closed = true;
    hooks.onError(cause, observedAIGatewayLogId);
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
          aiGatewayLogId
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
                aiGatewayLogId
              )
            : wrapAsyncIterable(
                streamField.stream,
                {
                  onComplete: completeOnce,
                  onError: errorOnce
                },
                startedAtMs,
                aiGatewayLogId
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
    readonly onError: (
      cause: unknown,
      aiGatewayLogId: string | undefined
    ) => void;
  },
  startedAtMs: number | undefined,
  aiGatewayLogId: string | undefined
): ReadableStream<unknown> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  const state = createStreamState(hooks, startedAtMs, aiGatewayLogId);

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
    readonly onError: (
      cause: unknown,
      aiGatewayLogId: string | undefined
    ) => void;
  },
  startedAtMs: number | undefined,
  aiGatewayLogId: string | undefined
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const state = createStreamState(hooks, startedAtMs, aiGatewayLogId);
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
    readonly onError: (
      cause: unknown,
      aiGatewayLogId: string | undefined
    ) => void;
  },
  startedAtMs: number | undefined,
  initialAIGatewayLogId: string | undefined
): {
  readonly closed: boolean;
  cancel(): void;
  complete(): void;
  fail(cause: unknown): void;
  observeChunk(chunk: unknown): void;
} {
  let closed = false;
  let aiGatewayLogId = initialAIGatewayLogId;
  let finishReason: string | undefined;
  let toolCallCount = 0;
  let usage: TokenUsageSummary | undefined;
  let response: ResponseSummary | undefined;
  let observedError: { readonly cause: unknown } | undefined;
  let observedAbort = false;
  let firstChunkAtMs: number | undefined;

  const settleObserved = (): boolean => {
    if (observedError) {
      hooks.onError(observedError.cause, aiGatewayLogId);
      return true;
    }

    if (observedAbort) {
      // AI SDK v6 signals aborts as an in-band `{ type: "abort" }` chunk and
      // completes the stream normally — it never rejects with an AbortError.
      // Surface a structurally AbortError-shaped cause so the tracer
      // classifies the span as canceled instead of a false success.
      hooks.onError({ name: "AbortError" }, aiGatewayLogId);
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
          aiGatewayLogId,
          finishReason,
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
      hooks.onError(cause, aiGatewayLogId);
    },
    observeChunk(rawChunk) {
      firstChunkAtMs ??= Date.now();
      const chunk = unwrapChunkEnvelope(rawChunk);
      aiGatewayLogId = extractAIGatewayLogId(chunk) ?? aiGatewayLogId;
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
  readonly aiGatewayLogId: string | undefined;
  readonly finishReason: string | undefined;
  readonly response: ResponseSummary | undefined;
  readonly timeToFirstChunkSeconds: number | undefined;
  readonly toolCallCount: number;
  readonly usage: TokenUsageSummary | undefined;
}): StreamSummary {
  return {
    ...(input.aiGatewayLogId !== undefined
      ? { aiGatewayLogId: input.aiGatewayLogId }
      : {}),
    ...(input.finishReason !== undefined
      ? { finishReason: input.finishReason }
      : {}),
    ...(input.response ? { response: input.response } : {}),
    ...(input.timeToFirstChunkSeconds !== undefined
      ? { timeToFirstChunkSeconds: input.timeToFirstChunkSeconds }
      : {}),
    ...(input.toolCallCount > 0 ? { toolCallCount: input.toolCallCount } : {}),
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
