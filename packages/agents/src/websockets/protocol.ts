/**
 * Isomorphic pieces of the callables RPC wire contract.
 *
 * Imported from browser bundles (via the client) and from the Worker
 * runtime, so it must not import `cloudflare:workers`.
 */

/** Query parameter selecting the callables Cap'n Web RPC endpoint. */
export const CALLABLES_RPC_QUERY = "__agents_rpc";
export const CALLABLES_RPC_VALUE = "capnweb";

/** Whether a request is a WebSocket upgrade addressed to callables RPC. */
export function isCallablesRpcUpgrade(request: Request): boolean {
  return (
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    new URL(request.url).searchParams.get(CALLABLES_RPC_QUERY) ===
      CALLABLES_RPC_VALUE
  );
}

/**
 * Derive the callables RPC socket URL from a host route. Accepts http(s)
 * or ws(s) URLs and returns a ws(s) URL with the RPC query parameter set.
 */
export function callablesRpcUrl(url: string | URL): string {
  const resolved = new URL(url);
  if (resolved.protocol === "http:") resolved.protocol = "ws:";
  if (resolved.protocol === "https:") resolved.protocol = "wss:";
  resolved.searchParams.set(CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE);
  return resolved.toString();
}
