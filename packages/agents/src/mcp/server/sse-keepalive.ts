/**
 * SSE keepalive for the retained McpAgent WebSocket-to-SSE bridge.
 *
 * SDK-backed HTTP transports own their keepalive timers. This helper remains
 * only for the custom bridge, where long-running POST tool calls can otherwise
 * sit silent until Cloudflare's edge closes the idle stream.
 *
 * See cloudflare/agents#1583.
 */

/** Interval between bridge SSE keepalive comment frames, in ms. */
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
