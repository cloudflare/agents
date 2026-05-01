/**
 * Spike: prove that a facet sub-agent is reachable over WebSocket
 * via the public `/sub/{class}/{name}` URL while the parent owns the
 * browser transport and forwards events to the child over RPC.
 *
 * Architecture under test:
 *
 *   Client
 *     │ WS upgrade: /spike-sub/{parent}/sub/SpikeSubChild/{child}
 *     ▼
 *   Worker.fetch  →  env.SpikeSubParent.get(idFromName(parent)).fetch(req)
 *                            ▼
 *                          SpikeSubParent.fetch(req)
 *                            │  — /sub/SpikeSubChild/{child}
 *                            │  — bumps fetchCount
 *                            │  — this.subAgent(SpikeSubChild, name)
 *                            │  — return (ctx.facets.get(...)).fetch(newReq)
 *                            ▼
 *                          SpikeSubChild  (facet)
 *                            │  — Agent base handles upgrade
 *                            │  — onConnect / onMessage — echoes "pong"
 *                            ▼
 *                          101 Switching Protocols  (propagates back up)
 *
 * Success criteria:
 *   1. WS upgrade succeeds through the double hop.
 *   2. Messages sent by the client reach the child and pongs come back.
 *   3. Parent's `onBeforeSubAgent` gate runs exactly once per connection,
 *      no matter how many frames the client sends.
 *   4. HTTP requests forwarded the same way also work end-to-end
 *      without the parent seeing per-request round-trips after initial
 *      dispatch.
 */

import { Agent } from "../../index.ts";
import type { Connection, WSMessage } from "../../index.ts";

// ── Child ─────────────────────────────────────────────────────────────

export class SpikeSubChild extends Agent {
  // Count messages received — exposed via RPC so the test can verify
  // the child really received them (and not a phantom echo from the
  // parent or some proxy).
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS spike_counts (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )`;
  }

  private bump(key: string): void {
    this.sql`
      INSERT INTO spike_counts (key, value) VALUES (${key}, 1)
      ON CONFLICT(key) DO UPDATE SET value = value + 1
    `;
  }

  async getCount(key: string): Promise<number> {
    const rows = this.sql<{ value: number }>`
      SELECT value FROM spike_counts WHERE key = ${key}
    `;
    return rows[0]?.value ?? 0;
  }

  async resetCounts(): Promise<void> {
    this.sql`DELETE FROM spike_counts`;
  }

  async broadcastFromChild(message: string): Promise<void> {
    this.broadcast(`child:${this.name}:${message}`);
  }

  override getConnectionTags(
    _connection: Connection,
    ctx: { request: Request }
  ): string[] {
    const tag = new URL(ctx.request.url).searchParams.get("tag");
    return tag ? [tag] : [];
  }

  override shouldConnectionBeReadonly(
    _connection: Connection,
    ctx: { request: Request }
  ): boolean {
    return new URL(ctx.request.url).searchParams.get("readonly") === "1";
  }

  override shouldSendProtocolMessages(
    _connection: Connection,
    ctx: { request: Request }
  ): boolean {
    return new URL(ctx.request.url).searchParams.get("protocol") !== "0";
  }

  connectionSnapshot(tag?: string) {
    const all = [...this.getConnections()].map((connection) => ({
      id: connection.id,
      tags: [...connection.tags],
      state: connection.state,
      readonly: this.isConnectionReadonly(connection),
      protocol: this.isConnectionProtocolEnabled(connection)
    }));
    const tagged = tag
      ? [...this.getConnections(tag)].map((connection) => connection.id)
      : [];
    return { all, tagged };
  }

  async onConnect(_connection: Connection): Promise<void> {
    this.bump("connect");
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    this.bump("message");
    if (typeof message === "string") {
      if (message === "snapshot") {
        connection.send(
          `snapshot:${JSON.stringify(this.connectionSnapshot("child-tag"))}`
        );
        return;
      }
      if (message.startsWith("broadcast:")) {
        // Use `this.broadcast(...)` — the path
        // `AIChatAgent._broadcastChatMessage` exercises for streaming
        // chunks. This is the code path that was silently no-op'd on
        // facets by an over-cautious guard, breaking real-time UI
        // updates for any facet-backed chat agent.
        this.broadcast(`pong:${this.name}:${message}`);
      } else {
        // Echo back the child's name + sequence to prove it actually
        // came from us (not a cached response somewhere up the chain).
        connection.send(`pong:${this.name}:${message}`);
      }
    }
  }

  async onRequest(request: Request): Promise<Response> {
    this.bump("http");
    const url = new URL(request.url);
    return Response.json({
      kind: "child-http",
      child: this.name,
      path: url.pathname
    });
  }
}

// ── Parent ────────────────────────────────────────────────────────────
//
// Originally this class hand-rolled `/sub/{class}/{name}` detection
// and facet forwarding inside its own `fetch()` override, and exposed
// an `invokeSubAgent` method for cross-DO RPC. After phase 2 landed,
// both responsibilities moved into the `Agent` base class (the `fetch`
// arm + `_cf_invokeSubAgent`). The spike parent is now a thin Agent
// that overrides `onBeforeSubAgent` purely so the "parent is on the
// hot path at connect time, and only at connect time" invariant can
// be confirmed by counting hook invocations.

export class SpikeSubParent extends Agent {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS spike_parent_counts (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )`;
  }

  private bump(key: string): void {
    this.sql`
      INSERT INTO spike_parent_counts (key, value) VALUES (${key}, 1)
      ON CONFLICT(key) DO UPDATE SET value = value + 1
    `;
  }

  async getCount(key: string): Promise<number> {
    const rows = this.sql<{ value: number }>`
      SELECT value FROM spike_parent_counts WHERE key = ${key}
    `;
    return rows[0]?.value ?? 0;
  }

  async resetCounts(): Promise<void> {
    this.sql`DELETE FROM spike_parent_counts`;
  }

  async broadcastFromParent(message: string): Promise<void> {
    this.broadcast(`parent:${message}`);
  }

  async onBeforeSubAgent(): Promise<Request | Response | void> {
    this.bump("on_before");
    // Returning void means "forward the request unchanged."
  }
}
