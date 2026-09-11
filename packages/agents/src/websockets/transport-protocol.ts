/**
 * Isomorphic wire contract for the Cap'n Web connection transport.
 *
 * Imported by browser bundles and by the Worker runtime, so it must not
 * import `cloudflare:workers`.
 */

/** Wire a `useAgent` / `AgentClient` connection travels on. */
export type AgentTransport = "cf-websocket" | "capnweb";

/** Query parameter selecting the Cap'n Web connection transport. */
export const CAPNWEB_TRANSPORT_QUERY = "__agents_transport";
export const CAPNWEB_TRANSPORT_VALUE = "capnweb";

/**
 * The single method on the host's session root: the frame pipe from the
 * client to the host. Every Agent protocol frame travels through it.
 */
export const CAPNWEB_TRANSPORT_SEND = "__cf_agent_send";

export type TransportMessage = string | ArrayBuffer | ArrayBufferView;

/** Root the client exposes; the host delivers frames through it. */
export type TransportClientEvents = {
  message(value: TransportMessage): void | Promise<void>;
};

/** Root the host exposes; the client sends frames through it. */
export type TransportHostPipe = {
  [CAPNWEB_TRANSPORT_SEND](message: TransportMessage): Promise<void>;
};

/** Rewrite a host URL to select the Cap'n Web transport over `ws(s)`. */
export function capnWebTransportUrl(url: string | URL): string {
  const resolved = new URL(url);
  if (resolved.protocol === "http:") resolved.protocol = "ws:";
  if (resolved.protocol === "https:") resolved.protocol = "wss:";
  resolved.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
  return resolved.toString();
}

/** Whether a request is a WebSocket upgrade selecting the transport. */
export function isCapnWebTransportUpgrade(request: Request): boolean {
  return (
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    new URL(request.url).searchParams.get(CAPNWEB_TRANSPORT_QUERY) ===
      CAPNWEB_TRANSPORT_VALUE
  );
}
