import { Agent, callable, routeAgentRequest } from "agents";

/**
 * What facets are FOR: running dynamically-supplied code under a
 * supervisor, with durable storage the supervisor controls.
 *
 * The `Supervisor` agent stores user-submitted JavaScript that defines
 * a Durable Object class. Each "gadget" runs as a facet: its own
 * isolate, its own SQLite database, supervised by this agent. The
 * supervisor can abort a misbehaving gadget, swap in a new code
 * version over the SAME storage, and delete a gadget's storage — none
 * of which a plain Durable Object namespace can offer, and none of
 * which is possible at all for code that has no wrangler binding.
 *
 * For statically-known Agent child classes, the same supervision is
 * available through `this.dynamicAgents` (see `examples/agents-as-tools`).
 * For many independent peers like chats, do NOT use this pattern —
 * see `examples/next/chats`.
 */

import { DEFAULT_GADGET_CODE } from "./shared";

type GadgetRow = {
  name: string;
  code: string;
  version: number;
};

/** Narrow view of `ctx.facets` — enough for supervised gadget control. */
type FacetControls = {
  get<T>(name: string, init: () => { class: unknown }): T;
  abort(name: string, reason: Error): void;
  delete(name: string): void;
};

export class Supervisor extends Agent<Env> {
  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS gadgets (
        name TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        version INTEGER NOT NULL
      )
    `;
  }

  #facets(): FacetControls {
    const facets = (this.ctx as unknown as { facets?: FacetControls }).facets;
    if (!facets) {
      throw new Error(
        "Facets are unavailable in this runtime — update compatibility_date."
      );
    }
    return facets;
  }

  #gadget(name: string): GadgetRow {
    const [row] = this.sql<GadgetRow>`
      SELECT name, code, version FROM gadgets WHERE name = ${name}
    `;
    if (!row) throw new Error(`No gadget named "${name}".`);
    return row;
  }

  /** Facet names are storage keys — stable per gadget, never per version. */
  #facetName(name: string): string {
    return `gadget:${name}`;
  }

  @callable()
  createGadget(name: string, code?: string): { name: string; version: number } {
    this.sql`
      INSERT INTO gadgets (name, code, version)
      VALUES (${name}, ${code ?? DEFAULT_GADGET_CODE}, 1)
      ON CONFLICT (name) DO NOTHING
    `;
    const row = this.#gadget(name);
    return { name: row.name, version: row.version };
  }

  /**
   * Swap in new code for a gadget. The facet is aborted so the next
   * invocation loads the new class — over the same facet storage.
   * This restart-with-a-different-class move is the facet superpower:
   * a code upgrade on stable state.
   */
  @callable()
  updateGadgetCode(name: string, code: string): { version: number } {
    const row = this.#gadget(name);
    this.sql`
      UPDATE gadgets SET code = ${code}, version = ${row.version + 1}
      WHERE name = ${name}
    `;
    try {
      this.#facets().abort(
        this.#facetName(name),
        new Error(`Reloading gadget "${name}" at v${row.version + 1}`)
      );
    } catch {
      // Not running — the next invoke simply loads the new code.
    }
    return { version: row.version + 1 };
  }

  /**
   * Invoke a gadget: load its stored source as a dynamic Worker, mount
   * the exported `Sandbox` class as a facet of this agent, and forward
   * one request into it. All the gadget's I/O lands in the facet's own
   * SQLite — the supervisor's tables are invisible to it.
   */
  @callable()
  async invokeGadget(name: string, path = "/"): Promise<unknown> {
    const row = this.#gadget(name);
    // The loader caches by id; including the version makes each code
    // revision its own cached Worker.
    const worker = this.env.LOADER.get(
      `gadget:${this.name}:${name}:v${row.version}`,
      () => ({
        compatibilityDate: "2026-06-11",
        mainModule: "gadget.js",
        modules: { "gadget.js": row.code },
        // The gadget gets no network: the supervisor decides what
        // capabilities dynamic code holds.
        globalOutbound: null
      })
    );

    const fetcher = this.#facets().get<Fetcher>(this.#facetName(name), () => ({
      class: worker.getDurableObjectClass("Sandbox")
    }));
    const response = await fetcher.fetch(new Request(`https://gadget${path}`));
    return response.json();
  }

  /** Stop a misbehaving gadget immediately; its storage survives. */
  @callable()
  abortGadget(name: string, reason = "aborted by supervisor"): void {
    this.#facets().abort(this.#facetName(name), new Error(reason));
  }

  /** Tear a gadget down completely: code row and facet storage. */
  @callable()
  deleteGadget(name: string): void {
    try {
      this.#facets().delete(this.#facetName(name));
    } catch {
      // Never ran — nothing to delete beyond the code row.
    }
    this.sql`DELETE FROM gadgets WHERE name = ${name}`;
  }

  /** Load one gadget's source into the browser editor. */
  @callable()
  getGadget(name: string): GadgetRow {
    return this.#gadget(name);
  }

  @callable()
  listGadgets(): Array<{ name: string; version: number }> {
    return this.sql<{ name: string; version: number }>`
      SELECT name, version FROM gadgets ORDER BY name ASC
    `;
  }

  /** The supervisor's own tables — gadget code, never gadget data. */
  @callable()
  supervisorTables(): string[] {
    return this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `.map((r) => r.name);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
