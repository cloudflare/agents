/**
 * Builds the custom `@tanstack/ai` `SubscribeConnectionAdapter` (the
 * {@link RecoveryBridgeConnection}) pointed at a `TanStackAgent` WebSocket
 * endpoint. Used by both the React demo and the headless e2e client.
 *
 * @internal Validation fixture, not a published package.
 */

import { RecoveryBridgeConnection } from "./ws-bridge";

/** The agents WS route for `TanStackAgent` (class name kebab-cased). */
export function agentWebSocketUrl(origin: string, session: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/agents/tan-stack-agent/${session}`;
  return url.toString();
}

/** Construct a recovery bridge connection for a session at `origin`. */
export function createRecoveryConnection(
  origin: string,
  session: string
): RecoveryBridgeConnection {
  return new RecoveryBridgeConnection(agentWebSocketUrl(origin, session));
}
