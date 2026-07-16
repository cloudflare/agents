/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/msg-ordering.test.ts
 * - port date: 2026-07-15 (P12)
 * Modifications:
 * - Single test dropped as no-equivalent: it overrides the original's raw
 *   `onConnect`/`onMessage` hooks to tag the connection and echo custom
 *   (non-`cf_agent_*`) "ping" text frames, asserting onMessage never runs
 *   before onConnect. The rebuild has no raw per-connection onConnect /
 *   onMessage override surface — `AgentDurableObject.webSocketMessage`
 *   routes exclusively to the composed ChatTransport's `cf_agent_*`
 *   vocabulary (src/adapters/cloudflare/shell.ts) and the agent class never
 *   sees raw sockets. Same finding as P10's sub-agent.test.ts drops
 *   ("no-equivalent: raw onMessage, broadcast(), getConnections()").
 * - The ordering property itself (connect-time work completes before the
 *   first inbound frame is processed) is enforced structurally by the shell:
 *   `fetch` awaits `transport.onConnect(...)` before returning 101, and
 *   workerd delivers webSocketMessage only after the upgrade response.
 */
import { describe, it } from "vitest";

describe("WebSocket ordering / races (ported)", () => {
  it.skip("onMessage never runs before onConnect has tagged the connection", () => {});
  // dropped: no-equivalent — no raw onConnect/onMessage override surface for
  // custom message types in the rebuild (P10 sub-agent.test.ts precedent);
  // connect-before-message ordering is structural in the shell (see header).
});
