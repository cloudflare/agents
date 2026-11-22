/**
 * The largest WebSocket message a Durable Object can send. A larger one is
 * dropped silently: `send()` returns normally and the peer gets nothing,
 * not even a close (measured on a deployed Worker; see the WebSockets
 * section of design/durable-object-lifecycle.md). The documented limit for
 * received messages is the same 32 MiB.
 *
 * @internal
 */
export const MAX_OUTBOUND_FRAME_BYTES = 32 * 1024 * 1024;

const utf8 = new TextEncoder();

/** Whether a text frame is small enough to reach the peer. @internal */
export function fitsOutboundFrame(text: string): boolean {
  // At most 3 UTF-8 bytes per UTF-16 code unit: skip encoding small frames.
  if (text.length * 3 <= MAX_OUTBOUND_FRAME_BYTES) return true;
  if (text.length > MAX_OUTBOUND_FRAME_BYTES) return false;
  return utf8.encode(text).byteLength <= MAX_OUTBOUND_FRAME_BYTES;
}

/**
 * Serialize an `rpc` response frame. One over the frame limit becomes an
 * error response for the same call, so the caller is answered instead of
 * waiting for a frame that never arrives; `replaced` says so, and a
 * streaming producer must stop, since the error ends the call.
 *
 * @internal
 */
export function serializeRpcResponse(response: { readonly id: string }): {
  text: string;
  replaced: boolean;
} {
  const text = JSON.stringify(response);
  if (fitsOutboundFrame(text)) return { text, replaced: false };
  return {
    text: JSON.stringify({
      type: "rpc",
      id: response.id,
      success: false,
      error: `RPC response is larger than the ${MAX_OUTBOUND_FRAME_BYTES}-byte WebSocket message limit`
    }),
    replaced: true
  };
}
