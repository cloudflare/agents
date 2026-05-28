/**
 * Shared SSE keepalive utility for MCP transports.
 *
 * Cloudflare's edge closes idle SSE responses after ~5 minutes. Writers
 * that may sit silent for that long (long-running tool calls, idle
 * standalone GET streams) arm a keepalive to keep the response under the
 * watchdog.
 *
 * See cloudflare/agents#1583.
 */

/** Interval between SSE keepalive comment frames, in ms.
 *
 * The WHATWG SSE spec recommends a comment line every "15 seconds or so"
 * (html.spec.whatwg.org §9.2.7). 25s gives comfortable headroom below
 * both the ~30s post-handler background-work cancellation window on
 * Workers and the ~5min Cloudflare edge idle-stream watchdog.
 */
export const KEEPALIVE_INTERVAL_MS = 25_000;

/** SSE comment frame the parser drops before any event dispatch. */
export const KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * Start an SSE keepalive on `writer`. Returns a `clearInterval` handle
 * that the stream cleanup must invoke when the stream closes.
 */
export function startKeepalive(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
): ReturnType<typeof setInterval> {
  const handle = setInterval(() => {
    writer
      .write(encoder.encode(KEEPALIVE_FRAME))
      .catch(() => clearInterval(handle));
  }, KEEPALIVE_INTERVAL_MS);
  return handle;
}
