import { Agent } from "../../index.ts";
import { RpcTarget } from "cloudflare:workers";

// ── SubAgent: Counter ───────────────────────────────────────────────
// A SubAgent with its own SQLite counter table.

export class CounterSubAgent extends Agent {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS counter (
        id TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      )
    `;
  }

  increment(id: string): number {
    const rows = this.sql<{ value: number }>`
      SELECT value FROM counter WHERE id = ${id}
    `;
    const current = rows.length > 0 ? rows[0].value : 0;
    const next = current + 1;

    if (rows.length > 0) {
      this.sql`UPDATE counter SET value = ${next} WHERE id = ${id}`;
    } else {
      this.sql`INSERT INTO counter (id, value) VALUES (${id}, ${next})`;
    }
    return next;
  }

  get(id: string): number {
    const rows = this.sql<{ value: number }>`
      SELECT value FROM counter WHERE id = ${id}
    `;
    return rows.length > 0 ? rows[0].value : 0;
  }

  ping(): string {
    return "pong";
  }

  getName(): string {
    return this.name;
  }

  async trySchedule(): Promise<string> {
    try {
      await this.schedule(1, "ping" as keyof this);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async tryKeepAlive(): Promise<string> {
    try {
      await this.keepAlive();
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async tryCancelSchedule(): Promise<string> {
    try {
      await this.cancelSchedule("nonexistent");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}

// ── SubAgent: Inner (for nesting tests) ─────────────────────────────
// A SubAgent that itself spawns a child SubAgent.

export class InnerSubAgent extends Agent {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
  }

  set(key: string, value: string): void {
    this.sql`
      INSERT OR REPLACE INTO kv (key, value) VALUES (${key}, ${value})
    `;
  }

  getVal(key: string): string | null {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM kv WHERE key = ${key}
    `;
    return rows.length > 0 ? rows[0].value : null;
  }
}

export class OuterSubAgent extends Agent {
  async getInnerValue(innerName: string, key: string): Promise<string | null> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.getVal(key);
  }

  async setInnerValue(
    innerName: string,
    key: string,
    value: string
  ): Promise<void> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    await inner.set(key, value);
  }

  ping(): string {
    return "outer-pong";
  }
}

// ── SubAgent: Callback streaming ─────────────────────────────────
// A SubAgent that accepts an RpcTarget callback and calls it
// multiple times to simulate streaming.

export class CallbackSubAgent extends Agent {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL
      )
    `;
  }

  /** Simulate streaming: sends chunks to the callback, stores the result. */
  async streamToCallback(
    chunks: string[],
    callback: { onChunk(text: string): void; onDone(full: string): void }
  ): Promise<void> {
    let accumulated = "";
    for (const chunk of chunks) {
      accumulated += chunk;
      await callback.onChunk(accumulated);
    }
    // Store the final result in this sub-agent's isolated storage
    this.sql`INSERT INTO log (message) VALUES (${accumulated})`;
    await callback.onDone(accumulated);
  }

  /** Get all logged messages. */
  getLog(): string[] {
    return this.sql<{ message: string }>`
      SELECT message FROM log ORDER BY id
    `.map((r) => r.message);
  }
}

// Not exported from worker.ts → not in ctx.exports.
// Used to test the missing-export error guard.
class UnexportedSubAgent extends Agent {
  ping(): string {
    return "unreachable";
  }
}

// ── Parent Agent that manages sub-agents ────────────────────────────

export class TestSubAgentParent extends Agent {
  async subAgentPing(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.ping();
  }

  async subAgentIncrement(
    subAgentName: string,
    counterId: string
  ): Promise<number> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.increment(counterId);
  }

  async subAgentGet(subAgentName: string, counterId: string): Promise<number> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.get(counterId);
  }

  async subAgentAbort(subAgentName: string): Promise<void> {
    this.abortSubAgent(CounterSubAgent, subAgentName, new Error("test abort"));
  }

  async subAgentDelete(subAgentName: string): Promise<void> {
    this.deleteSubAgent(CounterSubAgent, subAgentName);
  }

  async subAgentIncrementMultiple(
    subAgentNames: string[],
    counterId: string
  ): Promise<number[]> {
    const results = await Promise.all(
      subAgentNames.map(async (n) => {
        const child = await this.subAgent(CounterSubAgent, n);
        return child.increment(counterId);
      })
    );
    return results;
  }

  // ── Name tests ────────────────────────────────────────────────

  async subAgentGetName(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getName();
  }

  // ── Error tests ───────────────────────────────────────────────

  async subAgentMissingExport(): Promise<{ error: string }> {
    try {
      await this.subAgent(UnexportedSubAgent, "should-fail");
      return { error: "" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  async subAgentSameNameDifferentClass(
    name: string
  ): Promise<{ counterPing: string; callbackLog: string[] }> {
    const counter = await this.subAgent(CounterSubAgent, name);
    const callback = await this.subAgent(CallbackSubAgent, name);
    const counterPing = await counter.ping();
    const callbackLog = await callback.getLog();
    return { counterPing, callbackLog };
  }

  // ── Parent storage isolation tests ────────────────────────────

  async writeParentStorage(key: string, value: string): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS parent_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    this.sql`
      INSERT OR REPLACE INTO parent_kv (key, value)
      VALUES (${key}, ${value})
    `;
  }

  async readParentStorage(key: string): Promise<string | null> {
    this.sql`
      CREATE TABLE IF NOT EXISTS parent_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    const rows = this.sql<{ value: string }>`
      SELECT value FROM parent_kv WHERE key = ${key}
    `;
    return rows.length > 0 ? rows[0].value : null;
  }

  // ── Nested sub-agent tests ──────────────────────────────────────

  async nestedSetValue(
    outerName: string,
    innerName: string,
    key: string,
    value: string
  ): Promise<void> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    await outer.setInnerValue(innerName, key, value);
  }

  async nestedGetValue(
    outerName: string,
    innerName: string,
    key: string
  ): Promise<string | null> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.getInnerValue(innerName, key);
  }

  async nestedPing(outerName: string): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.ping();
  }

  // ── Scheduling guard tests ─────────────────────────────────────────

  async subAgentTrySchedule(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.trySchedule();
  }

  async subAgentTryKeepAlive(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.tryKeepAlive();
  }

  async subAgentTryCancelSchedule(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.tryCancelSchedule();
  }

  async subAgentTryScheduleAfterAbort(subAgentName: string): Promise<string> {
    // Create the sub-agent and let it be marked as a facet
    await this.subAgent(CounterSubAgent, subAgentName);

    // Abort the sub-agent (simulates hibernation — kills the instance)
    this.abortSubAgent(CounterSubAgent, subAgentName);

    // Re-access: the child restarts fresh. The _isFacet flag must
    // be restored from storage, not from the in-memory default.
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.trySchedule();
  }

  // ── Callback streaming tests ──────────────────────────────────────

  /**
   * Pass an RpcTarget callback to a sub-agent. The sub-agent calls
   * onChunk/onDone on the callback. The parent collects the chunks
   * and returns them.
   */

  async subAgentStreamViaCallback(
    subAgentName: string,
    chunks: string[]
  ): Promise<{ received: string[]; done: string }> {
    const child = await this.subAgent(CallbackSubAgent, subAgentName);

    const received: string[] = [];
    let doneText = "";

    class ChunkCollector extends RpcTarget {
      onChunk(text: string) {
        received.push(text);
      }
      onDone(full: string) {
        doneText = full;
      }
    }

    const collector = new ChunkCollector();
    await child.streamToCallback(chunks, collector);
    return { received, done: doneText };
  }

  /** Verify the sub-agent persisted the streamed data in its own storage. */

  async subAgentGetStreamLog(subAgentName: string): Promise<string[]> {
    const child = await this.subAgent(CallbackSubAgent, subAgentName);
    return child.getLog();
  }
}
