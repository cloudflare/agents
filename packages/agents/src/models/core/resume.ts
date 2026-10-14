/**
 * Resuming a streamed `/run` answer that dropped mid-way.
 *
 * AI Gateway's Run Durable Object keeps every SSE event of a streamed run and
 * names the run in `cf-aig-run-id`. The binding can replay the stream from any
 * event index:
 *
 * ```ts
 * env.AI.fetch(`https://workers-binding.ai/ai-gateway/gateways/${id}/run/${runId}/resume?from=${n}`)
 * ```
 *
 * The run keeps going on the gateway after the client is gone, so a replay
 * from the right index continues the same answer rather than starting a new
 * one. This wrapper makes that transparent: it reads the original body, and
 * when a read fails it reconnects to the resume route and keeps feeding the
 * same consumer, which never sees the break.
 *
 * The one subtlety is alignment. `from` counts complete SSE events, so the
 * wrapper only ever passes complete events on and holds back a trailing
 * partial one. After a drop the partial is discarded and the replay starts at
 * the count of events already delivered: no byte is duplicated or lost.
 *
 * @experimental This surface is experimental and may change.
 */

import { CloudflareAIError } from "./errors";

/** Where a resumed stream reconnects. The transport supplies it. */
export type ResumeFetch = (
  from: number,
  signal: AbortSignal | undefined
) => Promise<Response>;

/** What {@link resumableBody} needs to keep a stream going. */
export interface ResumableBodyOptions {
  /** The original response body. */
  initial: ReadableStream<Uint8Array>;
  /** Fetches the replay from an event index. */
  resume: ResumeFetch;
  /** The model, for error reporting. */
  model: string;
  /** The binding path, for error reporting. */
  url: string;
  /**
   * The call's abort signal. An abort, like a consumer cancelling the stream,
   * never reconnects.
   */
  signal?: AbortSignal;
  /** Reconnects allowed before giving up. Defaults to 5. */
  maxReconnects?: number;
}

const EMPTY = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index just past the last `\n\n` in `buffer`, or -1 when none is complete. */
function lastEventBoundary(buffer: Uint8Array): number {
  for (let i = buffer.length - 2; i >= 0; i--) {
    if (buffer[i] === 0x0a && buffer[i + 1] === 0x0a) return i + 2;
  }
  return -1;
}

/** Complete SSE events in `buffer`: `\n\n` terminators, counted once each. */
function countEvents(buffer: Uint8Array): number {
  let count = 0;
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0x0a && buffer[i + 1] === 0x0a) {
      count++;
      i++;
    }
  }
  return count;
}

/**
 * Wraps a streamed `/run` body so a dropped connection resumes from the last
 * complete event. Errors once the replay buffer has expired (404), when a
 * replay fails, or after `maxReconnects` drops.
 *
 * @experimental This surface is experimental and may change.
 */
export function resumableBody(
  options: ResumableBodyOptions
): ReadableStream<Uint8Array> {
  const maxReconnects = options.maxReconnects ?? 5;
  let delivered = 0;
  let pending: Uint8Array = EMPTY;
  let reconnects = 0;
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const stopped = () => cancelled || options.signal?.aborted === true;

  const failure = (
    message: string,
    extra: { status?: number; cause?: unknown } = {}
  ) =>
    new CloudflareAIError({
      code: "provider-error",
      isRetryable: false,
      message,
      model: options.model,
      requestBodyValues: undefined,
      url: options.url,
      ...extra
    });

  /** The replay from the events already delivered, or undefined after an error. */
  async function replay(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    let response: Response;
    try {
      response = await options.resume(delivered, options.signal);
    } catch (error) {
      controller.error(
        failure(
          `The stream dropped at event ${delivered} and the resume request failed.`,
          {
            cause: error
          }
        )
      );
      return undefined;
    }
    if (response.status === 404) {
      controller.error(
        failure(
          `The stream dropped at event ${delivered}, and AI Gateway no longer holds the run to resume it.`,
          { status: 404 }
        )
      );
      return undefined;
    }
    if (!response.ok || response.body === null) {
      controller.error(
        failure(
          `The stream dropped at event ${delivered} and resuming it failed (${response.status}).`,
          {
            status: response.status
          }
        )
      );
      return undefined;
    }
    return response.body;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let current = options.initial;
      for (;;) {
        reader = current.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (pending.length > 0) controller.enqueue(pending);
              pending = EMPTY;
              controller.close();
              return;
            }
            if (value === undefined || value.length === 0) continue;
            pending = concat(pending, value);
            const boundary = lastEventBoundary(pending);
            if (boundary > 0) {
              const complete = pending.slice(0, boundary);
              controller.enqueue(complete);
              delivered += countEvents(complete);
              pending = pending.slice(boundary);
            }
          }
        } catch (error) {
          try {
            reader.releaseLock();
          } catch {
            // Already released.
          }
          // A cancel or an abort is the caller's decision, never a drop: an
          // abort reaches the consumer as the error it is.
          if (stopped()) {
            if (!cancelled) controller.error(error);
            return;
          }
          if (reconnects >= maxReconnects) {
            controller.error(
              failure(
                `The stream dropped ${reconnects + 1} times; giving up at event ${delivered}.`,
                {
                  cause: error
                }
              )
            );
            return;
          }
          // The partial event is replayed whole from the boundary.
          pending = EMPTY;
          reconnects++;
          const body = await replay(controller);
          if (body === undefined) return;
          current = body;
        }
      }
    },
    cancel(reason) {
      cancelled = true;
      reader?.cancel(reason).catch(() => {
        // The upstream may already be closed.
      });
    }
  });
}
