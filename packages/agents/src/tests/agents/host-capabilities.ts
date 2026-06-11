import { Agent } from "../../index.ts";
import type {
  AgentContext,
  FiberRecoveryContext,
  FiberRecoveryResult
} from "../../index.ts";

/**
 * JSON-serializable value (bounded depth — a fully recursive type makes
 * the RPC stub's type mapping infinitely deep). RPC helper return types
 * use this instead of `unknown` because the stub's mapping collapses
 * `unknown` (not assignable to Serializable) to `never`.
 */
type JsonLeaf = string | number | boolean | null;
type JsonObj = { [k: string]: JsonLeaf };
type Json = JsonLeaf | JsonObj | Array<JsonLeaf | JsonObj>;

/**
 * Exercises the Layer-0 host capabilities (src/core/host.ts):
 * registerMigrations, kv, named timers, the fiber recovery registry,
 * and diagnostics.
 */
export class TestHostCapabilitiesAgent extends Agent {
  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);

    // Two timer handlers with overlapping prefixes — the longest match wins.
    this.onTimer("test:", async (key, payload) => {
      await this._recordTimerFire(`generic|${key}`, payload);
      if (key === "test:rearm") {
        // Re-arm the same key from inside the handler; the guarded delete
        // must not remove the re-armed row.
        await this.setTimer("test:rearm", Date.now() + 60_000, {
          rearmed: true
        });
      }
    });
    this.onTimer("test:specific:", async (key, payload) => {
      await this._recordTimerFire(`specific|${key}`, payload);
    });
    this.onTimer("test:throws:", async () => {
      throw new Error("timer handler failure");
    });

    // Two recovery handlers with overlapping namespaces — longest match wins.
    this.onRecovery("test-ns:", async (rctx) => {
      await this.ctx.storage.put("recoveredBy", `generic:${rctx.name}`);
      return { status: "completed" };
    });
    this.onRecovery("test-ns:special:", async (rctx) => {
      await this.ctx.storage.put("recoveredBy", `special:${rctx.name}`);
      return { status: "completed" };
    });

    this.registerInspector("test:view", async () => ({ hello: "world" }));
    this.registerInspector("test:throws", async () => {
      throw new Error("inspector failure");
    });
  }

  /** Fibers with no registered namespace land here (back-compat path). */
  override async onFiberRecovered(
    rctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    await this.ctx.storage.put("recoveredBy", `fallback:${rctx.name}`);
  }

  private async _recordTimerFire(key: string, payload: unknown) {
    const fires =
      (await this.ctx.storage.get<Array<{ key: string; payload: unknown }>>(
        "timerFires"
      )) ?? [];
    fires.push({ key, payload });
    await this.ctx.storage.put("timerFires", fires);
  }

  async getTimerFires(): Promise<
    Array<{ key: string; payload: Json | undefined }>
  > {
    return (
      (await this.ctx.storage.get<
        Array<{ key: string; payload: Json | undefined }>
      >("timerFires")) ?? []
    );
  }

  // ── Migrations ───────────────────────────────────────────────

  async applyTestMigrations(): Promise<string> {
    this.registerMigrations("test:mod", [
      {
        id: "001-create-table",
        apply: (sql) => {
          sql`CREATE TABLE IF NOT EXISTS test_mod_items (id TEXT PRIMARY KEY, n INTEGER)`;
        }
      },
      {
        // Deliberately NOT idempotent SQL — proves the ledger gates re-runs.
        id: "002-seed-row",
        apply: (sql) => {
          sql`INSERT INTO test_mod_items (id, n) VALUES ('seed', 1)`;
        }
      }
    ]);
    return "applied";
  }

  async getMigrationState(): Promise<{
    ledgerRows: number;
    seedRows: number;
  }> {
    const ledger = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_host_migrations
      WHERE namespace = ${"test:mod"}
    `;
    const seeds = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM test_mod_items
    `;
    return { ledgerRows: ledger[0].count, seedRows: seeds[0].count };
  }

  // ── KV ───────────────────────────────────────────────────────

  async kvRoundtrip(): Promise<{
    value: Json | undefined;
    listed: Array<[string, Json]>;
    afterDelete: Json | undefined;
  }> {
    await this.kv.put("test-kv:a", { n: 1 });
    await this.kv.put("test-kv:b", "two");
    await this.kv.put("other:c", true);
    const value = (await this.kv.get("test-kv:a")) as Json | undefined;
    const listed = [...(await this.kv.list("test-kv:"))] as Array<
      [string, Json]
    >;
    await this.kv.delete("test-kv:a");
    const afterDelete = (await this.kv.get("test-kv:a")) as Json | undefined;
    return { value, listed, afterDelete };
  }

  // ── Timers ───────────────────────────────────────────────────

  async armTimer(
    key: string,
    delayMs: number,
    payload?: unknown
  ): Promise<string> {
    await this.setTimer(key, Date.now() + delayMs, payload);
    return "armed";
  }

  async disarmTimer(key: string): Promise<string> {
    await this.cancelTimer(key);
    return "disarmed";
  }

  async getTimerRows(): Promise<Array<{ key: string; fire_at: number }>> {
    return this.sql<{ key: string; fire_at: number }>`
      SELECT key, fire_at FROM cf_agents_host_timers ORDER BY fire_at ASC
    `;
  }

  async getStoredAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  // ── Fiber recovery registry ──────────────────────────────────

  /** Insert an orphaned (unmanaged) fiber row, as if the isolate died. */
  async insertInterruptedFiber(id: string, name: string): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, NULL, ${Date.now()})
    `;
  }

  async triggerFiberRecovery(): Promise<void> {
    await (
      this as unknown as { _checkRunFibers(): Promise<void> }
    )._checkRunFibers();
  }

  async getRecoveredBy(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("recoveredBy")) ?? null;
  }

  async clearRecoveredBy(): Promise<void> {
    await this.ctx.storage.delete("recoveredBy");
  }

  async getOrphanRowCount(): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count;
  }

  // ── Diagnostics ──────────────────────────────────────────────

  async getDiagnostics(scrub?: boolean): Promise<{
    generatedAt: number;
    views: Record<string, Json>;
  }> {
    const bundle = await this.diagnostics(
      scrub === undefined ? undefined : { scrub }
    );
    return {
      generatedAt: bundle.generatedAt,
      views: bundle.views as Record<string, Json>
    };
  }
}
