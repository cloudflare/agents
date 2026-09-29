/**
 * Set by `useAgent` on the socket it returns: `true` while the hook's options
 * address a different agent than the socket it is still holding.
 * `usePartySocket` replaces the socket in an effect, so for at least one
 * render after `name` (or the host, path, or sub-agent chain) changes the
 * returned socket still points at the previous agent, with the previous
 * credentials in its URL.
 *
 * A registered symbol, so a separately bundled `useAgentChat` still sees it.
 */
export const SOCKET_ADDRESS_PENDING: unique symbol = Symbol.for(
  "cloudflare.agents.socketAddressPending"
);

export function isSocketAddressPending(socket: object): boolean {
  return (
    (socket as { [SOCKET_ADDRESS_PENDING]?: boolean })[
      SOCKET_ADDRESS_PENDING
    ] === true
  );
}
