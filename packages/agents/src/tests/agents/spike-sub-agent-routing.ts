/**
 * Spike: prove that a facet sub-agent is reachable over WebSocket
 * via a double-hop `fetch()` chain (Worker → parent DO → facet Fetcher),
 * and that after upgrade the parent is **not** touched for subsequent
 * frames.
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
 *   3. Parent's `fetchCount` is exactly 1 per connection, no matter how
 *      many frames the client sends. Confirms the WS is terminated at
 *      the child and subsequent frames don't round-trip through the
 *      parent.
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

  async onConnect(_connection: Connection): Promise<void> {
    this.bump("connect");
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    this.bump("message");
    if (typeof message === "string") {
      // Echo back the child's name + sequence to prove it actually came
      // from us (not a cached response somewhere up the chain).
      connection.send(`pong:${this.name}:${message}`);
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

  /**
   * Overrides the Agent base fetch handler to intercept
   * `/sub/{class}/{name}/...` paths and forward them into a facet.
   * Any other path falls through to the Agent default.
   */
  async fetch(request: Request): Promise<Response> {
    this.bump("fetch_total");

    const url = new URL(request.url);
    const match = url.pathname.match(/^(?:.*?)\/sub\/([^/]+)\/([^/]+)(\/.*)?$/);

    if (!match) {
      this.bump("fetch_passthrough");
      return super.fetch(request);
    }

    const [, childClass, childName, rest] = match;

    if (childClass !== "SpikeSubChild") {
      this.bump("fetch_unknown_class");
      return new Response(`Unknown child class: ${childClass}`, {
        status: 404
      });
    }

    this.bump("fetch_forwarded");

    // Seed the child (runs its onStart on first call, idempotent).
    await this.subAgent(SpikeSubChild, childName);

    // Re-resolve the facet Fetcher so we can call `.fetch()` on it —
    // `subAgent()` returns the typed RPC stub, which hides the
    // underlying Fetcher surface.
    const ctx = this.ctx as unknown as {
      facets: {
        get: (
          key: string,
          opts: () => { class: unknown }
        ) => { fetch: (req: Request) => Promise<Response> };
      };
      exports: Record<string, unknown>;
    };
    const facetKey = `${SpikeSubChild.name}\0${childName}`;
    const fetcher = ctx.facets.get(facetKey, () => ({
      class: ctx.exports[SpikeSubChild.name]
    }));

    // Rewrite URL: strip the `/…/sub/{class}/{name}` prefix so the
    // child sees a clean path. The child Agent routes based on
    // pathname (e.g. it uses `/` for WS upgrade and `/*` for HTTP).
    const stripped = new URL(url.toString());
    stripped.pathname = rest && rest.length > 0 ? rest : "/";
    const forwarded = new Request(stripped, request);

    return fetcher.fetch(forwarded);
  }
}
