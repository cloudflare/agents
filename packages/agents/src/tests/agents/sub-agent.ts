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

  /**
   * Call `parentAgent()` on this facet and round-trip a method call
   * on the returned parent stub. Used by the integration test to
   * verify that the framework helper correctly resolves the parent.
   */
  async callParentName(): Promise<string> {
    const parent = await this.parentAgent(TestSubAgentParent);
    return await parent.getOwnName();
  }

  /**
   * Call `parentAgent()` and return the error message if the agent
   * isn't a facet. Exercises the guard on the helper.
   */
  async tryParentAgent(): Promise<string> {
    try {
      await this.parentAgent(TestSubAgentParent);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Call `parentAgent()` with a class that does NOT match the
   * recorded parent. Exercises the class-mismatch guard.
   */
  async tryParentAgentWithWrongClass(): Promise<string> {
    try {
      // The actual parent is TestSubAgentParent, but we pass a
      // sibling class — the runtime check should reject.
      await this.parentAgent(CallbackSubAgent);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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
      const dispose = await this.keepAlive();
      dispose();
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Mirror `AIChatAgent._reply`'s use of `keepAliveWhile` around a
   * brief async operation. Regression guard: before the fix,
   * keepAlive() threw on facets and every streaming chat turn
   * crashed inside a `Chat` facet.
   */
  async tryKeepAliveWhile(): Promise<string> {
    try {
      const result = await this.keepAliveWhile(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return "ok";
      });
      return result;
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

  /**
   * Regression: a doubly-nested facet's direct parent is the last
   * entry of `parentPath`, not the first.
   *
   * Before the fix, `parentAgent(cls)` destructured `parentPath[0]`
   * (the root ancestor) — so calling `parentAgent(TestSubAgentParent)`
   * from an `InnerSubAgent` would accidentally succeed against the
   * root, even though the real parent class is `OuterSubAgent`.
   *
   * With the fix, this must throw with the class-mismatch error and
   * name `OuterSubAgent` (the real direct parent, read from
   * `parentPath.at(-1)`) — not `TestSubAgentParent`.
   */
  async tryParentAgentWithRoot(): Promise<string> {
    try {
      await this.parentAgent(TestSubAgentParent);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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

  async innerTryParentAgentWithRoot(innerName: string): Promise<string> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.tryParentAgentWithRoot();
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
  /** Called by child facets via `parentAgent()` to verify the lookup works. */
  async getOwnName(): Promise<string> {
    return this.name;
  }

  /**
   * Exercises `parentAgent()` from a non-facet — a top-level agent
   * has no parent, so the helper must throw a clear error.
   */
  async tryParentAgent(): Promise<string> {
    try {
      await this.parentAgent(TestSubAgentParent);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async subAgentCallParentName(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.callParentName();
  }

  async subAgentTryParentAgentWithWrongClass(
    subAgentName: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.tryParentAgentWithWrongClass();
  }

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

  async subAgentTryKeepAliveWhile(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.tryKeepAliveWhile();
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

  async subAgentNestedTryParentAgentWithRoot(
    outerName: string,
    innerName: string
  ): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerTryParentAgentWithRoot(innerName);
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
    // Records the URL observed at `onBeforeSubAgent` — used to verify
    // that custom routing (`routeSubAgentRequest`) preserves query
    // params when `fromPath` is supplied.
    this.sql`CREATE TABLE IF NOT EXISTS last_url (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL
    )`;
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
    // Record the URL so tests can assert on query-param preservation.
    this.sql`
      INSERT INTO last_url (id, url) VALUES (1, ${req.url})
      ON CONFLICT(id) DO UPDATE SET url = excluded.url
    `;

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

  /** The URL observed at the most recent `onBeforeSubAgent` fire. */
  async lastObservedUrl(): Promise<string | null> {
    const rows = this.sql<{ url: string }>`
      SELECT url FROM last_url WHERE id = 1
    `;
    return rows[0]?.url ?? null;
  }
}

// ── Unbound-parent fixtures ─────────────────────────────────────────
//
// `_cf_resolveSubAgent` looks up the parent's namespace via
// `ctx.exports[this.constructor.name]`. If `this.constructor.name`
// doesn't match a key in `ctx.exports` (e.g. minification rewrote
// the class identifier, or the class was exported under a different
// name from its declaration), the throw fires with a helpful error.
//
// We exercise this path via two fixture parents whose class
// identifiers (left of the `as` in the export rename below)
// deliberately don't match their export names. `this.constructor.name`
// for instances of these classes is the original class identifier,
// but `ctx.exports[<class identifier>]` is undefined because the
// worker's exports register the class under the export alias.

/** Class identifier `_UnboundParent` (could happen if a bundler kept
 *  the leading underscore but `ctx.exports` indexes by the export
 *  alias). Not "minified-looking" enough to trigger the hint. */
class _UnboundParent extends Agent {
  async tryToSpawn(name: string): Promise<string> {
    try {
      await this.subAgent(CounterSubAgent, name);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}
export { _UnboundParent as TestUnboundParentAgent };

/** Class identifier `_a` — looks minified. The error message should
 *  include the minification hint. */
class _a extends Agent {
  async tryToSpawn(name: string): Promise<string> {
    try {
      await this.subAgent(CounterSubAgent, name);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}
export { _a as TestMinifiedNameParentAgent };
