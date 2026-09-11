/**
 * Isomorphic pieces of the Cap'n Web connection-transport wire contract.
 *
 * Imported from browser bundles (via the client) and from the Worker
 * runtime, so it must not import `cloudflare:workers`.
 */

/** Query value selecting the Cap'n Web connection transport. */
export const CAPNWEB_TRANSPORT_QUERY = "__agents_transport";
export const CAPNWEB_TRANSPORT_VALUE = "capnweb";

/** Framework method reserved on the Cap'n Web transport session root. */
export const CAPNWEB_TRANSPORT_SEND = "__cf_agent_send";

/** Marker on a native result adapting a legacy callback-style stream. */
export const CAPNWEB_STREAMING_RESULT = "__cf_agent_streaming_result";

export type TransportMessage = string | ArrayBuffer | ArrayBufferView;

/** One event from a legacy `StreamingResponse` projected as a native stream. */
export type CapnWebStreamingEvent =
  | { readonly type: "chunk"; readonly value: unknown }
  | { readonly type: "done"; readonly value: unknown };

/** Native result returned for a legacy callback-style streaming callable. */
export type CapnWebStreamingResult = {
  readonly [CAPNWEB_STREAMING_RESULT]: true;
  readonly stream: ReadableStream<CapnWebStreamingEvent>;
};

/** Whether a native result wraps a legacy callback-style stream. */
export function isCapnWebStreamingResult(
  value: unknown
): value is CapnWebStreamingResult {
  return (
    typeof value === "object" &&
    value !== null &&
    CAPNWEB_STREAMING_RESULT in value &&
    value[CAPNWEB_STREAMING_RESULT] === true &&
    "stream" in value &&
    value.stream instanceof ReadableStream
  );
}

/** Browser callback target used by the server to deliver frames. */
export type TransportClientEvents = {
  message(value: TransportMessage): void | Promise<void>;
};

/** Whether a request is a WebSocket upgrade selecting the transport. */
export function isCapnWebTransportUpgrade(request: Request): boolean {
  return (
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    new URL(request.url).searchParams.get(CAPNWEB_TRANSPORT_QUERY) ===
      CAPNWEB_TRANSPORT_VALUE
  );
}
