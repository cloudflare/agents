/**
 * Resumable run-path stream (vendored from workers-ai-provider's
 * `createResumableStream`, RFC §7.1). Kept local so this experiment is
 * self-contained — the shipping version lives in `workers-ai-provider`.
 *
 * Two modes:
 *  - **In-stream wrap** (`initial` set): a transient mid-stream drop reconnects
 *    transparently via the gateway resume endpoint.
 *  - **Cross-invocation re-attach** (no `initial`, `fromEvent` set): a fresh
 *    Durable Object invocation re-joins a run it never started, replaying from a
 *    persisted SSE event index.
 *
 * `from` is an SSE *event* index (count of `\n\n` terminators), so the wrapper
 * emits only complete events and buffers the trailing partial — on a drop the
 * partial is discarded and resume realigns on the boundary (no duplicated or
 * truncated bytes).
 */

/** Minimal shape we need off the AI binding — the resume endpoint is reached via `binding.fetch`. */
export interface ResumeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class ResumeExpiredError extends Error {
  readonly fromEvent: number;
  constructor(fromEvent: number) {
    super(`Resume buffer expired (404) at event index ${fromEvent}.`);
    this.name = "ResumeExpiredError";
    this.fromEvent = fromEvent;
  }
}

export interface CreateResumableArgs {
  binding: ResumeFetcher;
  gateway: string;
  runId: string;
  /** Live run-path body. Omit for cross-invocation re-attach. */
  initial?: ReadableStream<Uint8Array>;
  /** SSE event index to (re-)attach from. Defaults to 0. */
  fromEvent?: number;
  /** Max reconnect attempts before giving up. Defaults to 5. */
  maxReconnects?: number;
  onReconnect?: (fromEvent: number, attempt: number) => void;
  onProgress?: (eventOffset: number) => void;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function lastEventBoundary(buf: Uint8Array): number {
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
  }
  return -1;
}

function countEvents(buf: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
      n++;
      i++;
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
  const { binding, gateway, runId } = args;
  const maxReconnects = args.maxReconnects ?? 5;

  let emittedEvents = args.fromEvent ?? 0;
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  let reconnects = 0;

  async function fetchResume(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<ReadableStream<Uint8Array> | null> {
    const res = await binding.fetch(resumeUrl(gateway, runId, emittedEvents), {
      method: "GET"
    });
    if (res.status === 404) {
      controller.error(new ResumeExpiredError(emittedEvents));
      return null;
    }
    if (!res.ok || !res.body) {
      controller.error(
        new Error(`Resume failed (${res.status}) at event ${emittedEvents}.`)
      );
      return null;
    }
    return res.body;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let current: ReadableStream<Uint8Array>;
      if (args.initial) {
        current = args.initial;
      } else {
        const body = await fetchResume(controller);
        if (!body) return;
        current = body;
      }

      for (;;) {
        const reader = current.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (pending.length > 0) {
                controller.enqueue(pending);
                pending = new Uint8Array(new ArrayBuffer(0));
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
              args.onProgress?.(emittedEvents);
              pending = pending.slice(boundary);
            }
          }
        } catch (err) {
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
          if (reconnects >= maxReconnects) {
            controller.error(err);
            return;
          }
          pending = new Uint8Array(new ArrayBuffer(0));
          reconnects++;
          args.onReconnect?.(emittedEvents, reconnects);
          const body = await fetchResume(controller);
          if (!body) return;
          current = body;
        }
      }
    }
  });
}
