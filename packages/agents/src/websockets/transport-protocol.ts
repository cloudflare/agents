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

export type TransportMessage = string | ArrayBuffer | ArrayBufferView;

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
