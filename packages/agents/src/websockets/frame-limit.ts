import { WEBSOCKET_MESSAGE_BYTES } from "../internal/platform-limits";

const utf8 = new TextEncoder();

/**
 * Whether a text frame is small enough to reach the peer. A larger one is
 * dropped silently: `send()` returns normally and the peer gets nothing,
 * not even a close (see the WebSockets section of
 * design/durable-object-lifecycle.md).
 *
 * @internal
 */
export function fitsOutboundFrame(text: string): boolean {
  // At most 3 UTF-8 bytes per UTF-16 code unit: skip encoding small frames.
  if (text.length * 3 <= WEBSOCKET_MESSAGE_BYTES) return true;
  if (text.length > WEBSOCKET_MESSAGE_BYTES) return false;
  return utf8.encode(text).byteLength <= WEBSOCKET_MESSAGE_BYTES;
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
      error: `RPC response is larger than the ${WEBSOCKET_MESSAGE_BYTES}-byte WebSocket message limit`
    }),
    replaced: true
  };
}
