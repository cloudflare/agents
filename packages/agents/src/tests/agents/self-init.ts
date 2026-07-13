import { Agent } from "../../index.ts";
import type { AgentEmail } from "../../email.ts";

// Test agents that exercise the RPC-entry self-initialization guarantee:
// every RPC entry surface runs `onStart()` before executing, so a stub
// resolved WITHOUT the `getAgentByName` → `setName` round-trip (e.g. a raw
// `env.NS.get(idFromName(...))` cold stub, or an internal zero-RTT
// resolution) still observes a fully initialized agent.

/**
 * Records how many times `onStart()` ran and creates a table there (not in
 * the constructor's schema step) so a user method can prove `onStart()`
 * completed before it executed. Also calls one of its own wrapped methods
 * during `onStart()` to exercise the re-entrancy fast path.
 */
export class SelfInitAgent extends Agent<Cloudflare.Env> {
  onStartCount = 0;
  reentrantResult: number | null = null;

  async onStart() {
    this.onStartCount++;
    // Created in onStart (not _ensureSchema): a method that reads it only
    // succeeds if onStart ran first.
    this
      .sql`CREATE TABLE IF NOT EXISTS self_init_probe (k TEXT PRIMARY KEY, v TEXT)`;
    this
      .sql`INSERT OR REPLACE INTO self_init_probe (k, v) VALUES ('name', ${this.name})`;
    // Re-entrancy: call our own wrapped method locally during onStart. This
    // must take the synchronous agent-context fast path — no deadlock and no
    // second onStart run.
    this.reentrantResult = this.syncDouble(41) + 1;
  }

  // User-defined RPC method that depends on onStart having created the table.
  probe(): {
    onStartCount: number;
    storedName: string | undefined;
    name: string;
    reentrantResult: number | null;
  } {
    const rows = this.sql<{
      v: string;
    }>`SELECT v FROM self_init_probe WHERE k = 'name'`;
    return {
      onStartCount: this.onStartCount,
      storedName: rows.at(0)?.v,
      name: this.name,
      reentrantResult: this.reentrantResult
    };
  }

  // Synchronous wrapped method — used for the sync-return-preservation check
  // and for the re-entrant call inside onStart.
  syncDouble(n: number): number {
    return n * 2;
  }

  // Calls a synchronous wrapped method locally and does arithmetic on the
  // result. If the inner call had started returning a promise post-init,
  // `typeof value` would be "object" and the arithmetic would break.
  callSyncLocally(): { value: number; innerWasNumber: boolean } {
    const value = this.syncDouble(21);
    return { value: value + 1, innerWasNumber: typeof value === "number" };
  }

  override onError(error: unknown): void {
    throw error;
  }
}

/**
 * `onEmail` writes into a table created by `onStart()`. If `_onEmail` did not
 * self-initialize, the insert would fail because the table would not exist.
 */
export class SelfInitEmailAgent extends Agent<Cloudflare.Env> {
  onStartCount = 0;

  async onStart() {
    this.onStartCount++;
    this
      .sql`CREATE TABLE IF NOT EXISTS self_init_email (k TEXT PRIMARY KEY, v TEXT)`;
  }

  async onEmail(email: AgentEmail) {
    // Depends on the onStart-created table existing.
    this
      .sql`INSERT OR REPLACE INTO self_init_email (k, v) VALUES ('from', ${email.from})`;
  }

  emailProbe(): {
    onStartCount: number;
    storedFrom: string | undefined;
  } {
    const rows = this.sql<{
      v: string;
    }>`SELECT v FROM self_init_email WHERE k = 'from'`;
    return { onStartCount: this.onStartCount, storedFrom: rows.at(0)?.v };
  }

  override onError(error: unknown): void {
    throw error;
  }
}
