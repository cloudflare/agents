/**
 * Resumable run-path stream (prototype of RFC §7.1).
 *
 * Wraps the byte stream from a run-path response (`env.AI.run(..., {
 * returnRawResponse })`) so a mid-stream drop is recovered transparently: the
 * wrapper reconnects to the gateway resume endpoint and keeps feeding bytes to
 * the same consumer, so the downstream `@ai-sdk/*` parser never sees the break.
 *
 * The one correctness subtlety is **byte alignment on reconnect**. `from` is an
 * SSE *event index* (count of `\n\n` terminators), and resume returns whole
 * events from that index. So the wrapper only ever emits *complete* events
 * downstream and buffers any trailing partial event without emitting it. On a
 * drop the buffered partial is discarded and we resume from the count of complete
 * events already emitted — landing exactly on the next event boundary, with no
 * duplicated or truncated bytes.
 *
 * Expiry: once the gateway buffer TTL (~5.5 min) elapses, resume returns 404
 * `{"error":"Request not found"}`. The wrapper surfaces that as a typed
 * `ResumeExpiredError` so the caller can fall to tier-2/3 recovery (RFC §7).
 */

type AiWithFetch = Ai & {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export class ResumeExpiredError extends Error {
  readonly fromEvent: number;
  constructor(fromEvent: number) {
    super(`Resume buffer expired (404) at event index ${fromEvent}.`);
    this.name = "ResumeExpiredError";
    this.fromEvent = fromEvent;
  }
}

class SimulatedDrop extends Error {
  constructor(public readonly afterEvents: number) {
    super(`Simulated mid-stream drop after ${afterEvents} events.`);
    this.name = "SimulatedDrop";
  }
}

export interface ResumableHooks {
  /** Fired before each reconnect attempt with the resume `from` index. */
  onReconnect?: (fromEvent: number, attempt: number) => void;
  /** Fired when the buffer has expired (resume 404). */
  onExpired?: (fromEvent: number) => void;
  /** Fired with the cumulative SSE event offset as complete events are emitted. */
  onProgress?: (eventOffset: number) => void;
}

export interface CreateResumableArgs {
  env: { AI: Ai };
  gateway: string;
  runId: string;
  /** Initial run-path response body. Omit for cross-invocation re-attach (starts from `resume?from=fromEvent`). */
  initial?: ReadableStream<Uint8Array>;
  /** SSE event index to (re-)attach from. Defaults to 0. */
  fromEvent?: number;
  /** Test-only: simulate a drop once this many complete events have been emitted. */
  dropAfterEvents?: number;
  /** Max reconnect attempts before giving up. Defaults to 5. */
  maxReconnects?: number;
  hooks?: ResumableHooks;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index just past the last `\n\n` in `buf`, or -1 if there is no complete event. */
function lastEventBoundary(buf: Uint8Array): number {
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
  }
  return -1;
}

/** Count of `\n\n` terminators (= complete SSE events) in `buf`. */
function countEvents(buf: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
      n++;
      i++; // don't double-count "\n\n\n"
    }
  }
  return n;
}

function resumeUrl(gateway: string, runId: string, from: number): string {
  return `https://workers-binding.ai/ai-gateway/gateways/${gateway}/run/${runId}/resume?from=${from}`;
}

export function createResumableStream(
  args: CreateResumableArgs
): ReadableStream<Uint8Array> {
  const { env, gateway, runId } = args;
  const maxReconnects = args.maxReconnects ?? 5;

  let emittedEvents = args.fromEvent ?? 0; // absolute SSE event index reached
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0)); // buffered trailing partial event (not emitted)
  let reconnects = 0;
  let faultInjected = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // In-stream wrap starts from the live body; re-attach (no `initial`) starts
      // by resuming from `fromEvent`.
      let current: ReadableStream<Uint8Array>;
      if (args.initial) {
        current = args.initial;
      } else {
        const res = await (env.AI as AiWithFetch).fetch(
          resumeUrl(gateway, runId, emittedEvents),
          { method: "GET" }
        );
        if (res.status === 404) {
          args.hooks?.onExpired?.(emittedEvents);
          controller.error(new ResumeExpiredError(emittedEvents));
          return;
        }
        if (!res.ok || !res.body) {
          controller.error(
            new Error(
              `Re-attach failed (${res.status}) at event ${emittedEvents}.`
            )
          );
          return;
        }
        current = res.body;
      }

      for (;;) {
        const reader = current.getReader();
        try {
          for (;;) {
            // Fault injection (test): pretend the upstream dropped.
            if (
              args.dropAfterEvents !== undefined &&
              !faultInjected &&
              emittedEvents >= args.dropAfterEvents
            ) {
              faultInjected = true;
              throw new SimulatedDrop(emittedEvents);
            }

            const { done, value } = await reader.read();
            if (done) {
              // Clean end — flush any final buffered bytes and close.
              if (pending.length > 0) {
                controller.enqueue(pending);
                pending = new Uint8Array(0);
              }
              controller.close();
              return;
            }
            if (!value || value.length === 0) continue;

            pending = concat(pending, value);
            const boundary = lastEventBoundary(pending);
            if (boundary > 0) {
              const complete = pending.slice(0, boundary);
              controller.enqueue(complete);
              emittedEvents += countEvents(complete);
              args.hooks?.onProgress?.(emittedEvents);
              pending = pending.slice(boundary);
            }
          }
        } catch (err) {
          reader.releaseLock();
          const isDrop = err instanceof SimulatedDrop;
          if (!isDrop && reconnects >= maxReconnects) {
            controller.error(err);
            return;
          }
          if (reconnects >= maxReconnects) {
            controller.error(
              new Error(
                `Exceeded ${maxReconnects} reconnect attempts during resume.`
              )
            );
            return;
          }

          // Discard the unfinished partial — resume realigns on the boundary.
          pending = new Uint8Array(0);
          reconnects++;
          args.hooks?.onReconnect?.(emittedEvents, reconnects);

          const res = await (env.AI as AiWithFetch).fetch(
            resumeUrl(gateway, runId, emittedEvents),
            { method: "GET" }
          );
          if (res.status === 404) {
            args.hooks?.onExpired?.(emittedEvents);
            controller.error(new ResumeExpiredError(emittedEvents));
            return;
          }
          if (!res.ok || !res.body) {
            controller.error(
              new Error(
                `Resume failed (${res.status}) at event ${emittedEvents}.`
              )
            );
            return;
          }
          current = res.body;
          // loop continues with the resumed stream
        }
      }
    }
  });
}
