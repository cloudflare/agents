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

  /** Return the facet's own `parentPath` (root-first ancestor chain). */
  getParentPath(): Array<{ className: string; name: string }> {
    return this.parentPath.map((step) => ({ ...step }));
  }

  /** Return the facet's own `selfPath` (ancestors + self). */
  getSelfPath(): Array<{ className: string; name: string }> {
    return this.selfPath.map((step) => ({ ...step }));
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

  /** Return the facet's own `parentPath`. Used for nested-parentPath tests. */
  getParentPath(): Array<{ className: string; name: string }> {
    return this.parentPath.map((step) => ({ ...step }));
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

  async getInnerParentPath(
    innerName: string
  ): Promise<Array<{ className: string; name: string }>> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.getParentPath();
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

// ── SubAgent: Broadcast/state regression cases ─────────────────────
// Exercises the broadcast paths that used to throw cross-DO I/O
// before `_isFacet` guards were added to `_broadcastProtocol()` and
// `broadcast()`. On a facet these calls should no-op, not throw.

type BroadcastState = { count: number; lastMsg: string };

export class BroadcastSubAgent extends Agent<Cloudflare.Env, BroadcastState> {
  initialState: BroadcastState = { count: 0, lastMsg: "" };

  /** Calls `this.broadcast(...)` directly from a facet RPC. */
  tryBroadcast(msg: string): string {
    try {
      this.broadcast(msg);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Calls `this.setState(...)` from a facet RPC. `setState` drives
   * `_broadcastProtocol()` internally, so this exercises the
   * `_isFacet` early-return guard there.
   */
  trySetState(count: number, msg: string): string {
    try {
      this.setState({ count, lastMsg: msg });
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  getCount(): number {
    return this.state.count;
  }

  getLastMsg(): string {
    return this.state.lastMsg;
  }

  /**
   * A dummy onStart observation: the base Agent's wrapped `onStart`
   * calls `broadcastMcpServers()` before the user's `onStart` runs.
   * If the `_isFacet` flag isn't set in time, that call would throw
   * when the facet's first init fires. Reaching this method at all
   * proves init completed cleanly.
   */
  initializedOk(): boolean {
    return true;
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

  // ── Broadcast / setState regression tests ────────────────────────

  async subAgentTryBroadcast(
    subAgentName: string,
    msg: string
  ): Promise<string> {
    const child = await this.subAgent(BroadcastSubAgent, subAgentName);
    return child.tryBroadcast(msg);
  }

  async subAgentTrySetState(
    subAgentName: string,
    count: number,
    msg: string
  ): Promise<{ error: string; persistedCount: number; persistedMsg: string }> {
    const child = await this.subAgent(BroadcastSubAgent, subAgentName);
    const error = await child.trySetState(count, msg);
    const persistedCount = await child.getCount();
    const persistedMsg = await child.getLastMsg();
    return { error, persistedCount, persistedMsg };
  }

  async subAgentInitOk(subAgentName: string): Promise<boolean> {
    const child = await this.subAgent(BroadcastSubAgent, subAgentName);
    return child.initializedOk();
  }

  // ── parentPath / registry exposure for Phase-1 tests ──────────────

  async subAgentParentPath(
    subAgentName: string
  ): Promise<Array<{ className: string; name: string }>> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getParentPath();
  }

  async subAgentSelfPath(
    subAgentName: string
  ): Promise<Array<{ className: string; name: string }>> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getSelfPath();
  }

  async subAgentNestedParentPath(
    outerName: string,
    innerName: string
  ): Promise<Array<{ className: string; name: string }>> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.getInnerParentPath(innerName);
  }

  has(className: string, name: string): boolean {
    return this.hasSubAgent(className, name);
  }

  list(
    className?: string
  ): Array<{ className: string; name: string; createdAt: number }> {
    return this.listSubAgents(className);
  }

  async subAgentWithNullChar(): Promise<string> {
    try {
      await this.subAgent(CounterSubAgent, "bad\0name");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Call deleteSubAgent for a child that was never spawned. This
   * exercises the idempotent-delete contract — the registry row is
   * missing and the facet store has nothing to remove, so the call
   * should succeed silently.
   */
  async deleteUnknownSubAgent(
    name: string
  ): Promise<{ error: string; has: boolean }> {
    try {
      this.deleteSubAgent(CounterSubAgent, name);
      return { error: "", has: this.hasSubAgent(CounterSubAgent, name) };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        has: this.hasSubAgent(CounterSubAgent, name)
      };
    }
  }

  /**
   * Call deleteSubAgent twice for the same child. The second call
   * must not throw.
   */
  async doubleDeleteSubAgent(name: string): Promise<{ error: string }> {
    await this.subAgent(CounterSubAgent, name);
    this.deleteSubAgent(CounterSubAgent, name);
    try {
      this.deleteSubAgent(CounterSubAgent, name);
      return { error: "" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * hasSubAgent / listSubAgents accept both a class constructor and
   * a CamelCase class name string. Exercise both forms.
   */
  async introspectByBothForms(name: string): Promise<{
    hasByCls: boolean;
    hasByStr: boolean;
    listByCls: number;
    listByStr: number;
  }> {
    await this.subAgent(CounterSubAgent, name);
    return {
      hasByCls: this.hasSubAgent(CounterSubAgent, name),
      hasByStr: this.hasSubAgent("CounterSubAgent", name),
      listByCls: this.listSubAgents(CounterSubAgent).length,
      listByStr: this.listSubAgents("CounterSubAgent").length
    };
  }
}

// ── Reserved class name tests ──────────────────────────────────────
// Any class whose kebab-cased name equals `"sub"` collides with the
// reserved URL separator. That's every class that kebab-cases to
// "sub": `Sub`, `SUB` (all-uppercase branch in camelCaseToKebabCase),
// `Sub_` (trailing-dash stripped), etc. Spawn-time guard must catch
// all of them, not just the titlecase spelling.

// eslint-disable-next-line @typescript-eslint/naming-convention
export class Sub extends Agent {
  ping(): string {
    return "reserved";
  }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export class SUB extends Agent {
  ping(): string {
    return "reserved-upper";
  }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export class Sub_ extends Agent {
  ping(): string {
    return "reserved-trailing-underscore";
  }
}

export class ReservedClassParent extends Agent {
  /** Return the error string rather than throwing so tests can assert on it. */
  async trySpawnReserved(): Promise<string> {
    try {
      await this.subAgent(Sub, "x");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async trySpawnReservedUpper(): Promise<string> {
    try {
      await this.subAgent(SUB, "x");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async trySpawnReservedTrailing(): Promise<string> {
    try {
      await this.subAgent(Sub_, "x");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}

// ── Parent with onBeforeSubAgent hook variants ───────────────────────
// Exercised by the routing tests to pin the three return shapes
// (void, Request, Response) the hook supports.

export class HookingSubAgentParent extends Agent {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS hook_counts (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS hook_mode (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    )`;
    this.sql`INSERT OR IGNORE INTO hook_mode (id, value) VALUES (1, 'allow')`;
  }

  private bump(key: string): void {
    this.sql`
      INSERT INTO hook_counts (key, value) VALUES (${key}, 1)
      ON CONFLICT(key) DO UPDATE SET value = value + 1
    `;
  }

  async setHookMode(
    mode: "allow" | "deny-404" | "deny-401" | "mutate" | "strict-registry"
  ): Promise<void> {
    this.sql`UPDATE hook_mode SET value = ${mode} WHERE id = 1`;
  }

  private currentMode(): string {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM hook_mode WHERE id = 1
    `;
    return rows[0]?.value ?? "allow";
  }

  async hookCount(key: string): Promise<number> {
    const rows = this.sql<{ value: number }>`
      SELECT value FROM hook_counts WHERE key = ${key}
    `;
    return rows[0]?.value ?? 0;
  }

  override async onBeforeSubAgent(
    req: Request,
    child: { className: string; name: string }
  ): Promise<Request | Response | void> {
    this.bump("called");
    this.bump(`class:${child.className}`);

    const mode = this.currentMode();

    if (mode === "deny-404") {
      return new Response("not found", { status: 404 });
    }

    if (mode === "deny-401") {
      return new Response("unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" }
      });
    }

    if (mode === "mutate") {
      // Inject a header and pass through.
      const headers = new Headers(req.headers);
      headers.set("x-hook-annotated", "yes");
      return new Request(req, { headers });
    }

    if (mode === "strict-registry") {
      // Only allow if the child is already registered. Exercises
      // `hasSubAgent` as a strict gate.
      if (!this.hasSubAgent(child.className, child.name)) {
        return new Response("child not pre-registered", { status: 404 });
      }
    }

    // allow: fall through, framework lazy-creates.
  }

  // Expose RPC so tests can pre-register children for strict-mode.
  async prespawn(name: string): Promise<void> {
    await this.subAgent(CounterSubAgent, name);
  }
}
