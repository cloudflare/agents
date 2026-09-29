/**
 * Server-Sent Events serving for durable streams: turn one stream into an
 * SSE `Response` with resume built into the protocol. Every chunk is emitted
 * with its sequence number as the SSE `id:` field, so a browser
 * `EventSource` that reconnects sends `Last-Event-ID` automatically and the
 * helper resumes from the next chunk — cursor persistence with zero client
 * code. Control events mark the replay→live transition (`up-to-date`) and
 * settlement (`done` / `error`), mirroring the stream's own lifecycle.
 */

import type { Streams } from "./streams";
import type { StreamJson } from "./types";

const encoder = new TextEncoder();

/**
 * Options accepted by {@link sseResponse}.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface SSEResponseOptions {
  /**
   * The incoming request. Used for resume (the `Last-Event-ID` header a
   * reconnecting `EventSource` sends, or a `?from=` query parameter) and to
   * abort the tail when the client disconnects (`request.signal`).
   */
  request?: Request;
  /** First sequence number to yield. Overrides request-derived resume. */
  from?: number;
  /** Extra abort signal; composed with `request.signal`. */
  signal?: AbortSignal;
  /** Maximum chunks per write. Defaults to the read batch size (100). */
  batchSize?: number;
  /**
   * Milliseconds between `: heartbeat` comment frames while tailing, keeping
   * idle proxies from killing the connection. 0 disables. Default: 30000.
   */
  heartbeatMs?: number;
}

function resumeFrom(options: SSEResponseOptions): number {
  if (options.from !== undefined) return Math.max(0, options.from);
  const request = options.request;
  if (request) {
    // A fresh EventSource sends no Last-Event-ID at all; Number(null) is 0,
    // so the header must be checked for presence before parsing or every
    // first connection would skip chunk 0.
    const header = request.headers.get("Last-Event-ID");
    if (header !== null && header !== "") {
      const lastEventId = Number(header);
      // Last-Event-ID names the last chunk the client received; resume after.
      if (Number.isInteger(lastEventId) && lastEventId >= 0) {
        return lastEventId + 1;
      }
    }
    const fromParam = new URL(request.url).searchParams.get("from");
    if (fromParam !== null) {
      const from = Number(fromParam);
      if (Number.isInteger(from) && from >= 0) return from;
    }
  }
  return 0;
}

function frame(seq: number, chunk: StreamJson): string {
  // JSON.stringify never emits raw newlines, so one data line is always safe.
  return `id: ${seq}\ndata: ${JSON.stringify(chunk)}\n\n`;
}

function controlFrame(event: string, data: StreamJson): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Serve one durable stream as a Server-Sent Events response: replay from the
 * resume point, emit an `up-to-date` control event on reaching the tail,
 * tail live appends, and finish with `done` (completed) or `error` (errored,
 * carrying the recorded reason). Returns a 404 response when the stream does
 * not exist.
 *
 * ```ts
 * async onRequest(request: Request) {
 *   return sseResponse(this.streams, "reply:123", { request });
 * }
 * // client: new EventSource(url) — reconnect resume is automatic.
 * ```
 *
 * @experimental The API surface may change before stabilizing.
 */
export async function sseResponse(
  streams: Streams,
  streamId: string,
  options: SSEResponseOptions = {}
): Promise<Response> {
  if ((await streams.status(streamId)) === null) {
    return new Response(`Stream "${streamId}" does not exist`, { status: 404 });
  }

  const from = resumeFrom(options);
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const abort = new AbortController();
  const onUpstreamAbort = () => abort.abort();
  // A listener added to an already-aborted signal never fires: check first,
  // or a pre-aborted request would tail a live stream forever.
  if (options.signal?.aborted || options.request?.signal.aborted) {
    abort.abort();
  } else {
    options.signal?.addEventListener("abort", onUpstreamAbort, { once: true });
    options.request?.signal.addEventListener("abort", onUpstreamAbort, {
      once: true
    });
  }

  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The stream was cancelled between the check and the write (a
          // heartbeat tick racing a client disconnect): stop writing.
          open = false;
        }
      };
      const heartbeat =
        heartbeatMs > 0
          ? setInterval(() => write(": heartbeat\n\n"), heartbeatMs)
          : null;
      const finish = () => {
        if (heartbeat !== null) clearInterval(heartbeat);
        options.signal?.removeEventListener("abort", onUpstreamAbort);
        options.request?.signal.removeEventListener("abort", onUpstreamAbort);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // Already cancelled by the consumer.
          }
        }
      };

      void (async () => {
        try {
          const batches = streams.readBatches(streamId, {
            from,
            signal: abort.signal,
            batchSize: options.batchSize,
            onUpToDate: () => write(controlFrame("up-to-date", {}))
          });
          for await (const batch of batches) {
            write(batch.map((chunk) => frame(chunk.seq, chunk.chunk)).join(""));
          }
          const status = await streams.status(streamId);
          if (status?.state === "errored") {
            write(controlFrame("error", { reason: status.error ?? null }));
          } else {
            write(controlFrame("done", {}));
          }
        } catch {
          // The client disconnected or the caller aborted: nothing to send.
        } finally {
          finish();
        }
      })();
    },
    cancel: () => {
      open = false;
      abort.abort();
    }
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
