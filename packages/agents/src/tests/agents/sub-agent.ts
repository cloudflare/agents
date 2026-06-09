import { Agent, getCurrentAgent } from "../../index.ts";
import type {
  FiberInspection,
  FiberRecoveryContext,
  FiberRecoveryResult
} from "../../index.ts";
import { RpcTarget } from "cloudflare:workers";

// ── SubAgent: Counter ───────────────────────────────────────────────
// A SubAgent with its own SQLite counter table.

export class CounterSubAgent extends Agent {
  private _heldKeepAliveDisposers: Array<() => void> = [];
  private _constructorName = this.name;

  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS counter (
        id TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS schedule_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        current_agent_name TEXT,
        parent_class TEXT,
        schedule_id TEXT NOT NULL,
        callback TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS fiber_recovery_log (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        snapshot TEXT,
        created_at INTEGER NOT NULL
      )
    `;
  }

  private _releaseHeldFiber?: () => void;

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    if (ctx.name !== "__test_internal_chat") return false;

    await this.schedule(
      0,
      "scheduledCallback",
      { value: `recovered:${ctx.id}` },
      { idempotent: true }
    );
    return true;
  }

  override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this.sql`
      INSERT OR REPLACE INTO fiber_recovery_log
        (id, name, snapshot, created_at)
      VALUES
        (${ctx.id}, ${ctx.name}, ${JSON.stringify(ctx.snapshot)}, ${ctx.createdAt})
    `;
    if (ctx.name === "managed-recovery-complete") {
      return { status: "completed", snapshot: { recovered: true } };
    }
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

  scheduledCallback(
    payload: { value: string },
    schedule: { id: string; callback: string }
  ): void {
    const { agent } = getCurrentAgent();
    this.sql`
      INSERT INTO schedule_log
        (value, agent_name, current_agent_name, parent_class, schedule_id, callback)
      VALUES
        (${payload.value}, ${this.name}, ${agent?.name ?? null}, ${this.parentPath.at(-1)?.className ?? ""}, ${schedule.id}, ${schedule.callback})
    `;
  }

  async scheduleDelayedCallback(
    delaySeconds: number,
    value: string,
    options?: { idempotent?: boolean }
  ): Promise<string> {
    const schedule = await this.schedule(
      delaySeconds,
      "scheduledCallback",
      { value },
      options
    );
    return schedule.id;
  }

  async scheduleIntervalCallback(
    intervalSeconds: number,
    value: string
  ): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "scheduledCallback",
      { value }
    );
    return schedule.id;
  }

  async scheduleCronCallback(cronExpr: string, value: string): Promise<string> {
    const schedule = await this.schedule(cronExpr, "scheduledCallback", {
      value
    });
    return schedule.id;
  }

  async cancelOwnSchedule(id: string): Promise<boolean> {
    return this.cancelSchedule(id);
  }

  async selfDestruct(): Promise<void> {
    await this.destroy();
  }

  async scheduleSelfCancellingCallback(
    delaySeconds: number,
    value: string
  ): Promise<string> {
    const schedule = await this.schedule(
      delaySeconds,
      "selfCancellingCallback",
      { value }
    );
    return schedule.id;
  }

  /**
   * A scheduled callback that cancels its own (one-shot) row from
   * inside the running callback. Tests that re-entrant
   * cancelSchedule from within a dispatched callback does not
   * deadlock with the alarm RPC frame.
   */
  async selfCancellingCallback(
    payload: { value: string },
    schedule: { id: string; callback: string }
  ): Promise<void> {
    // Cancel ourselves before recording the log entry. The row is
    // already in the middle of being dispatched, so the cancel is a
    // no-op for the in-flight dispatch but proves the round-trip
    // didn't deadlock.
    await this.cancelSchedule(schedule.id);
    this.sql`
      INSERT INTO schedule_log
        (value, agent_name, current_agent_name, parent_class, schedule_id, callback)
      VALUES
        (${payload.value}, ${this.name}, null, ${this.parentPath.at(-1)?.className ?? ""}, ${schedule.id}, ${schedule.callback})
    `;
  }

  async getOwnSchedule(id: string) {
    return this.getScheduleById(id);
  }

  async getOwnSchedulesByType(
    type: "scheduled" | "delayed" | "cron" | "interval"
  ) {
    return this.listSchedules({ type });
  }

  async getOwnScheduleKeysByType(
    type: "scheduled" | "delayed" | "cron" | "interval"
  ): Promise<string[][]> {
    return (await this.listSchedules({ type })).map((schedule) =>
      Object.keys(schedule).sort()
    );
  }

  trySyncGetSchedule(id: string): string {
    try {
      this.getSchedule(id);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  trySyncGetSchedules(): string {
    try {
      this.getSchedules();
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  getScheduleLog(): Array<{
    value: string;
    agentName: string;
    currentAgentName: string | null;
    parentClass: string;
    scheduleId: string;
    callback: string;
  }> {
    return this.sql<{
      value: string;
      agent_name: string;
      current_agent_name: string | null;
      parent_class: string;
      schedule_id: string;
      callback: string;
    }>`
      SELECT value, agent_name, current_agent_name, parent_class, schedule_id, callback
      FROM schedule_log
      ORDER BY id
    `.map((row) => ({
      value: row.value,
      agentName: row.agent_name,
      currentAgentName: row.current_agent_name,
      parentClass: row.parent_class,
      scheduleId: row.schedule_id,
      callback: row.callback
    }));
  }

  getName(): string {
    return this.name;
  }

  getConstructorName(): string {
    return this._constructorName;
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

  async callCustomBoundParentName(): Promise<string> {
    const parent = await this.parentAgent(CustomBoundSubAgentParent);
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

  async tryKeepAliveWhileError(): Promise<string> {
    try {
      await this.keepAliveWhile(async () => {
        throw new Error("keepalive failure");
      });
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async acquireHeldKeepAlive(): Promise<void> {
    this._heldKeepAliveDisposers.push(await this.keepAlive());
  }

  releaseHeldKeepAlives(): void {
    const disposers = this._heldKeepAliveDisposers.splice(0);
    for (const dispose of disposers) {
      dispose();
    }
  }

  async holdFiber(value: string): Promise<string> {
    const id = await new Promise<string>((resolve) => {
      void this.runFiber("held", async (ctx) => {
        resolve(ctx.id);
        this.sql`
          INSERT INTO schedule_log
            (value, agent_name, current_agent_name, parent_class, schedule_id, callback)
          VALUES
            (${value}, ${this.name}, null, ${this.parentPath.at(-1)?.className ?? ""}, ${ctx.id}, ${"holdFiber"})
        `;
        await new Promise<void>((r) => {
          this._releaseHeldFiber = r;
        });
      }).catch(console.error);
    });
    return id;
  }

  async holdManagedFiber(value: string, key: string): Promise<string> {
    const result = await this.startFiber(
      "managed-held",
      async (ctx) => {
        ctx.stash({ value });
        this.sql`
          INSERT INTO schedule_log
            (value, agent_name, current_agent_name, parent_class, schedule_id, callback)
          VALUES
            (${value}, ${this.name}, null, ${this.parentPath.at(-1)?.className ?? ""}, ${ctx.id}, ${"holdManagedFiber"})
        `;
        await new Promise<void>((resolve, reject) => {
          this._releaseHeldFiber = resolve;
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("managed sub-agent cancelled")),
            { once: true }
          );
        });
      },
      { idempotencyKey: key }
    );
    return result.fiberId;
  }

  async releaseHeldFiber(): Promise<void> {
    const release = this._releaseHeldFiber;
    this._releaseHeldFiber = undefined;
    release?.();
  }

  async insertInterruptedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  async insertInterruptedManagedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${id}, ${`key:${id}`}, ${name}, 'running',
         ${snapshot ? JSON.stringify(snapshot) : null},
         NULL, NULL, ${now}, ${now}, NULL)
    `;
    await this.insertInterruptedFiber(id, name, snapshot);
  }

  getRecoveredFibers(): Array<{
    id: string;
    name: string;
    snapshot: { value?: string } | null;
    createdAt: number;
  }> {
    return this.sql<{
      id: string;
      name: string;
      snapshot: string | null;
      created_at: number;
    }>`
      SELECT id, name, snapshot, created_at
      FROM fiber_recovery_log
      ORDER BY created_at
    `.map((row) => ({
      id: row.id,
      name: row.name,
      snapshot: row.snapshot
        ? (JSON.parse(row.snapshot) as { value?: string })
        : null,
      createdAt: row.created_at
    }));
  }

  getRunningFiberCount(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0]?.count ?? 0;
  }

  async inspectManagedFiber(fiberId: string): Promise<FiberInspection | null> {
    return this.inspectFiber(fiberId);
  }

  async tryCancelSchedule(): Promise<string> {
    try {
      await this.cancelSchedule("nonexistent");
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Install an in-memory observability recorder that persists events
   * to the facet's own SQLite. Used by tests to assert which DO
   * emits which observability events.
   */
  installObservabilityRecorder(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS obs_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    this.observability = {
      emit: (event) => {
        this.sql`
          INSERT INTO obs_log (type, agent, agent_name, payload)
          VALUES (
            ${event.type},
            ${event.agent ?? ""},
            ${event.name ?? ""},
            ${JSON.stringify(event.payload)}
          )
        `;
      }
    };
  }

  getObservabilityLog(): Array<{
    type: string;
    agent: string;
    agentName: string;
    payload: { callback?: string; id?: string };
  }> {
    this.sql`
      CREATE TABLE IF NOT EXISTS obs_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    return this.sql<{
      type: string;
      agent: string;
      agent_name: string;
      payload: string;
    }>`
      SELECT type, agent, agent_name, payload FROM obs_log ORDER BY id
    `.map((row) => ({
      type: row.type,
      agent: row.agent,
      agentName: row.agent_name,
      payload: JSON.parse(row.payload) as { callback?: string; id?: string }
    }));
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
    this.sql`
      CREATE TABLE IF NOT EXISTS fiber_recovery_log (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        snapshot TEXT,
        created_at INTEGER NOT NULL
      )
    `;
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    this.sql`
      INSERT OR REPLACE INTO fiber_recovery_log
        (id, name, snapshot, created_at)
      VALUES
        (${ctx.id}, ${ctx.name}, ${JSON.stringify(ctx.snapshot)}, ${ctx.createdAt})
    `;
  }

  set(key: string, value: string): void {
    this.sql`
      INSERT OR REPLACE INTO kv (key, value) VALUES (${key}, ${value})
    `;
  }

  scheduledSet(payload: { key: string; value: string }): void {
    this.set(payload.key, payload.value);
  }

  async scheduleSet(
    delaySeconds: number,
    key: string,
    value: string
  ): Promise<string> {
    const schedule = await this.schedule(delaySeconds, "scheduledSet", {
      key,
      value
    });
    return schedule.id;
  }

  async insertInterruptedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  getRecoveredFibers(): Array<{
    id: string;
    name: string;
    snapshot: { value?: string } | null;
  }> {
    return this.sql<{
      id: string;
      name: string;
      snapshot: string | null;
    }>`
      SELECT id, name, snapshot
      FROM fiber_recovery_log
      ORDER BY created_at
    `.map((row) => ({
      id: row.id,
      name: row.name,
      snapshot: row.snapshot
        ? (JSON.parse(row.snapshot) as { value?: string })
        : null
    }));
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

  getSelfPath(): Array<{ className: string; name: string }> {
    return this.selfPath.map((step) => ({ ...step }));
  }

  async innerPing(): Promise<string> {
    return `inner:${this.name}`;
  }

  override async onRequest(request: Request): Promise<Response> {
    return Response.json(await describeFacetFetch(this.name, request));
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

  // parentAgent() fixture methods: Inner -> Outer.
  async callFacetParentPing(): Promise<string> {
    const parent = await this.parentAgent(OuterSubAgent);
    return await parent.outerPing();
  }

  async fetchFacetParent(path: string): Promise<FacetFetchDescription> {
    const parent = await this.parentAgent(OuterSubAgent);
    const response = await parent.fetch(`https://example.com${path}`, {
      body: "hello from inner",
      headers: { "x-parent-agent-test": "yes" },
      method: "POST"
    });
    return (await response.json()) as FacetFetchDescription;
  }

  async fetchFacetParentWithRequest(
    path: string
  ): Promise<FacetFetchDescription> {
    const parent = await this.parentAgent(OuterSubAgent);
    const request = new Request(`https://example.com${path}`, {
      body: "hello from request",
      headers: { "x-parent-agent-test": "request" },
      method: "POST"
    });
    const response = await parent.fetch(request);
    return (await response.json()) as FacetFetchDescription;
  }

  async callDeepFacetParentPing(leafName: string): Promise<string> {
    const leaf = await this.subAgent(LeafSubAgent, leafName);
    return leaf.callFacetParentPing();
  }

  async fetchDeepFacetParent(
    leafName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const leaf = await this.subAgent(LeafSubAgent, leafName);
    return leaf.fetchFacetParent(path);
  }

  async tryFetchDeepFacetParentWebSocket(leafName: string): Promise<string> {
    const leaf = await this.subAgent(LeafSubAgent, leafName);
    return leaf.tryFetchFacetParentWebSocket();
  }
}

export class OuterSubAgent extends Agent {
  async outerPing(): Promise<string> {
    return `outer:${this.name}`;
  }

  override async onRequest(request: Request): Promise<Response> {
    return Response.json(await describeFacetFetch(this.name, request));
  }

  async spawnInnerWithOwnNamespaceHelperHidden(
    innerName: string
  ): Promise<string> {
    const exports = (
      this.ctx as unknown as {
        exports?: Record<string, { idFromName?: unknown } | undefined>;
      }
    ).exports;
    const ownExport = exports?.OuterSubAgent;
    const originalIdFromName = ownExport?.idFromName;

    try {
      if (ownExport) {
        ownExport.idFromName = undefined;
      }
      await this.subAgent(InnerSubAgent, innerName);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      if (ownExport) {
        ownExport.idFromName = originalIdFromName;
      }
    }
  }

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

  // parentAgent() fixture methods: delegate from Outer into Inner/Leaf.
  async innerCallFacetParentPing(innerName: string): Promise<string> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.callFacetParentPing();
  }

  async innerFetchFacetParent(
    innerName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.fetchFacetParent(path);
  }

  async innerFetchFacetParentWithRequest(
    innerName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.fetchFacetParentWithRequest(path);
  }

  async innerCallDeepFacetParent(
    innerName: string,
    leafName: string
  ): Promise<string> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.callDeepFacetParentPing(leafName);
  }

  async innerFetchDeepFacetParent(
    innerName: string,
    leafName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.fetchDeepFacetParent(leafName, path);
  }

  async innerTryFetchDeepFacetParentWebSocket(
    innerName: string,
    leafName: string
  ): Promise<string> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.tryFetchDeepFacetParentWebSocket(leafName);
  }

  async scheduleInnerSet(
    innerName: string,
    delaySeconds: number,
    key: string,
    value: string
  ): Promise<string> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.scheduleSet(delaySeconds, key, value);
  }

  async insertInnerInterruptedFiber(
    innerName: string,
    id: string,
    name: string,
    snapshot?: { value?: string }
  ): Promise<Array<{ className: string; name: string }>> {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    await inner.insertInterruptedFiber(id, name, snapshot);
    return inner.getSelfPath();
  }

  async getInnerRecoveredFibers(innerName: string): Promise<
    Array<{
      id: string;
      name: string;
      snapshot: { value?: string } | null;
    }>
  > {
    const inner = await this.subAgent(InnerSubAgent, innerName);
    return inner.getRecoveredFibers();
  }

  /** Have the outer facet self-destruct. Used for destroy() coverage. */
  async selfDestruct(): Promise<void> {
    await this.destroy();
  }

  /** Spawn the inner without scheduling anything. */
  async spawnInner(innerName: string): Promise<void> {
    await this.subAgent(InnerSubAgent, innerName);
  }

  ping(): string {
    return "outer-pong";
  }
}

type FacetFetchDescription = {
  agentName: string;
  body: string;
  header: string | null;
  method: string;
  path: string;
  search: string;
};

async function describeFacetFetch(
  agentName: string,
  request: Request
): Promise<FacetFetchDescription> {
  const url = new URL(request.url);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.text();
  return {
    agentName,
    body,
    header: request.headers.get("x-parent-agent-test"),
    method: request.method,
    path: url.pathname,
    search: url.search
  };
}

export class LeafSubAgent extends Agent {
  async callFacetParentPing(): Promise<string> {
    const parent = await this.parentAgent(InnerSubAgent);
    return parent.innerPing();
  }

  async fetchFacetParent(path: string): Promise<FacetFetchDescription> {
    const parent = await this.parentAgent(InnerSubAgent);
    const response = await parent.fetch(`https://example.com${path}`, {
      body: "hello from leaf",
      headers: { "x-parent-agent-test": "yes" },
      method: "POST"
    });
    return (await response.json()) as FacetFetchDescription;
  }

  async tryFetchFacetParentWebSocket(): Promise<string> {
    try {
      const parent = await this.parentAgent(InnerSubAgent);
      await parent.fetch("https://example.com/ws-from-leaf", {
        headers: { Upgrade: "websocket" }
      });
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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
// Exercises broadcast paths on facets. Startup protocol broadcasts are
// suppressed during bootstrap to avoid parent-owned WebSocket handles,
// but normal facet broadcasts after bootstrap must still reach the
// facet's own WebSocket clients.

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
   * `_broadcastProtocol()` internally, so this exercises facet state
   * sync after bootstrap.
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
   * Returns the ids of the connections this facet sees via
   * `this.getConnections()`. A facet must only ever see its own (virtual)
   * sub-agent connections — never the ROOT DO's direct connections. Touching
   * the root's hibernatable WebSockets from a facet's I/O context throws
   * "Cannot perform I/O on behalf of a different Durable Object (Native)" in
   * production. See issue #1677.
   */
  connectionIds(): string[] {
    return [...this.getConnections()].map((connection) => connection.id);
  }

  /** Count of connections visible to this facet (see `connectionIds`). */
  connectionCount(): number {
    return [...this.getConnections()].length;
  }

  /** Resolve a connection by id through the facet's `getConnection()`. */
  hasConnection(id: string): boolean {
    return this.getConnection(id) !== undefined;
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

export class CustomBoundSubAgentParent extends Agent {
  async getOwnName(): Promise<string> {
    return this.name;
  }

  async subAgentCallParentName(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.callCustomBoundParentName();
  }
}

// ── Parent Agent that manages sub-agents ────────────────────────────

export class TestSubAgentParent extends Agent {
  async onMessage(
    connection: { send(message: string): void },
    message: string | ArrayBuffer
  ): Promise<void> {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text !== "spawn-sub-agent") return;

    try {
      const result = await this.subAgentPing(`ws-${crypto.randomUUID()}`);
      connection.send(
        JSON.stringify({
          type: "sub-agent-result",
          ok: true,
          result
        })
      );
    } catch (error) {
      connection.send(
        JSON.stringify({
          type: "sub-agent-result",
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

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

  async seedLegacyCounterSubAgentRegistry(subAgentName: string): Promise<void> {
    this.hasSubAgent("CounterSubAgent", subAgentName);
    this.sql`
      INSERT OR IGNORE INTO cf_agents_sub_agents (class, name, created_at)
      VALUES (${"CounterSubAgent"}, ${subAgentName}, ${Date.now()})
    `;
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
    await this.deleteSubAgent(CounterSubAgent, subAgentName);
  }

  async subAgentScheduleDelayed(
    subAgentName: string,
    delaySeconds: number,
    value: string,
    options?: { idempotent?: boolean }
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.scheduleDelayedCallback(delaySeconds, value, options);
  }

  async subAgentScheduleInterval(
    subAgentName: string,
    intervalSeconds: number,
    value: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.scheduleIntervalCallback(intervalSeconds, value);
  }

  async subAgentScheduleCron(
    subAgentName: string,
    cronExpr: string,
    value: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.scheduleCronCallback(cronExpr, value);
  }

  async subAgentScheduleSelfCancellingCallback(
    subAgentName: string,
    delaySeconds: number,
    value: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.scheduleSelfCancellingCallback(delaySeconds, value);
  }

  async subAgentSelfDestruct(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    try {
      await child.selfDestruct();
      return "";
    } catch (e) {
      // The selfDestruct RPC frame is killed when ctx.facets.delete
      // aborts the facet's isolate, so the await may surface an
      // abort error. Either is acceptable — what matters is that the
      // teardown actually happened, asserted by the caller.
      return e instanceof Error ? e.message : String(e);
    }
  }

  async subAgentCancelSchedule(
    subAgentName: string,
    id: string
  ): Promise<boolean> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.cancelOwnSchedule(id);
  }

  /** Try to cancel a schedule from a *different* sub-agent (sibling). */
  async subAgentCancelSiblingSchedule(
    subAgentName: string,
    siblingScheduleId: string
  ): Promise<boolean> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.cancelOwnSchedule(siblingScheduleId);
  }

  /**
   * Cancel by id from the top-level parent. With the owner-key
   * isolation, this should NEVER match a facet-owned row.
   */
  async parentCancelByIdNoFacet(id: string): Promise<boolean> {
    return this.cancelSchedule(id);
  }

  async parentGetScheduleById(
    id: string
  ): Promise<{ id: string; callback: string } | null> {
    const schedule = await this.getScheduleById(id);
    return schedule ? { id: schedule.id, callback: schedule.callback } : null;
  }

  async parentListSchedules(): Promise<string[]> {
    return (await this.listSchedules()).map((s) => s.id);
  }

  async subAgentScheduleLog(subAgentName: string): Promise<
    Array<{
      value: string;
      agentName: string;
      currentAgentName: string | null;
      parentClass: string;
      scheduleId: string;
      callback: string;
    }>
  > {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getScheduleLog();
  }

  async subAgentGetSchedule(
    subAgentName: string,
    id: string
  ): Promise<{ id: string; callback: string } | null> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    const schedule = await child.getOwnSchedule(id);
    return schedule ? { id: schedule.id, callback: schedule.callback } : null;
  }

  async subAgentGetSchedulesByType(
    subAgentName: string,
    type: "scheduled" | "delayed" | "cron" | "interval"
  ): Promise<string[]> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return (await child.getOwnSchedulesByType(type)).map(
      (schedule) => schedule.id
    );
  }

  async subAgentGetScheduleKeysByType(
    subAgentName: string,
    type: "scheduled" | "delayed" | "cron" | "interval"
  ): Promise<string[][]> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getOwnScheduleKeysByType(type);
  }

  async subAgentTrySyncGetSchedule(
    subAgentName: string,
    id: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.trySyncGetSchedule(id);
  }

  async subAgentTrySyncGetSchedules(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.trySyncGetSchedules();
  }

  async backdateSchedule(id: string): Promise<void> {
    const past = Math.floor(Date.now() / 1000) - 1;
    this.sql`UPDATE cf_agents_schedules SET time = ${past} WHERE id = ${id}`;
  }

  async forgetCounterSubAgentRegistry(subAgentName: string): Promise<void> {
    this.sql`
      DELETE FROM cf_agents_sub_agents
      WHERE class = ${"CounterSubAgent"} AND name = ${subAgentName}
    `;
  }

  async rootScheduleRows(): Promise<
    Array<{
      id: string;
      callback: string;
      ownerPath: string | null;
      ownerPathKey: string | null;
      type: string;
      running: number;
    }>
  > {
    return this.sql<{
      id: string;
      callback: string;
      owner_path: string | null;
      owner_path_key: string | null;
      type: string;
      running: number | null;
    }>`
      SELECT id, callback, owner_path, owner_path_key, type, COALESCE(running, 0) AS running
      FROM cf_agents_schedules
      ORDER BY id
    `.map((row) => ({
      id: row.id,
      callback: row.callback,
      ownerPath: row.owner_path,
      ownerPathKey: row.owner_path_key,
      type: row.type,
      running: row.running ?? 0
    }));
  }

  async subAgentRegistryRows(): Promise<
    Array<{ class: string; name: string }>
  > {
    return this.sql<{ class: string; name: string }>`
      SELECT class, name FROM cf_agents_sub_agents
      ORDER BY class, name
    `.map((row) => ({ class: row.class, name: row.name }));
  }

  /**
   * Install observability recorders on this top-level agent and on
   * a named CounterSubAgent facet. Used to verify that
   * `schedule:create` / `schedule:cancel` events fire on the facet
   * (not on the alarm-owning root).
   */
  async installRecordersOn(subAgentName: string): Promise<void> {
    this.installObservabilityRecorder();
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    child.installObservabilityRecorder();
  }

  installObservabilityRecorder(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS obs_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    this.observability = {
      emit: (event) => {
        this.sql`
          INSERT INTO obs_log (type, agent, agent_name, payload)
          VALUES (
            ${event.type},
            ${event.agent ?? ""},
            ${event.name ?? ""},
            ${JSON.stringify(event.payload)}
          )
        `;
      }
    };
  }

  getObservabilityLog(): Array<{
    type: string;
    agent: string;
    agentName: string;
    payload: { callback?: string; id?: string };
  }> {
    this.sql`
      CREATE TABLE IF NOT EXISTS obs_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    return this.sql<{
      type: string;
      agent: string;
      agent_name: string;
      payload: string;
    }>`
      SELECT type, agent, agent_name, payload FROM obs_log ORDER BY id
    `.map((row) => ({
      type: row.type,
      agent: row.agent,
      agentName: row.agent_name,
      payload: JSON.parse(row.payload) as { callback?: string; id?: string }
    }));
  }

  async subAgentObservabilityLog(subAgentName: string): Promise<
    Array<{
      type: string;
      agent: string;
      agentName: string;
      payload: { callback?: string; id?: string };
    }>
  > {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getObservabilityLog();
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

  async subAgentGetConstructorName(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getConstructorName();
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

  async nestedScheduleSet(
    outerName: string,
    innerName: string,
    delaySeconds: number,
    key: string,
    value: string
  ): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.scheduleInnerSet(innerName, delaySeconds, key, value);
  }

  async nestedPing(outerName: string): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.ping();
  }

  /**
   * Drive the doubly-nested destroy() path: have the OUTER facet
   * self-destruct from the inside. Validates that schedules owned
   * by the inner descendant are cleaned up too.
   */
  async outerSelfDestruct(outerName: string): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    try {
      await outer.selfDestruct();
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async ensureNested(outerName: string, innerName: string): Promise<void> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    await outer.spawnInner(innerName);
  }

  async nestedSpawnWithFacetParentNamespaceHidden(
    outerName: string,
    innerName: string
  ): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.spawnInnerWithOwnNamespaceHelperHidden(innerName);
  }

  async insertNestedInterruptedFiber(
    outerName: string,
    innerName: string,
    id: string,
    name: string,
    snapshot?: { value?: string }
  ): Promise<void> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    const innerSelfPath = await outer.insertInnerInterruptedFiber(
      innerName,
      id,
      name,
      snapshot
    );
    await this._cf_registerFacetRun(innerSelfPath, id);
  }

  async nestedRecoveredFibers(
    outerName: string,
    innerName: string
  ): Promise<
    Array<{
      id: string;
      name: string;
      snapshot: { value?: string } | null;
    }>
  > {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.getInnerRecoveredFibers(innerName);
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

  async subAgentTryKeepAliveWhileError(subAgentName: string): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.tryKeepAliveWhileError();
  }

  async subAgentAcquireHeldKeepAlive(subAgentName: string): Promise<void> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    await child.acquireHeldKeepAlive();
  }

  async subAgentReleaseHeldKeepAlives(subAgentName: string): Promise<void> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    child.releaseHeldKeepAlives();
  }

  getRootKeepAliveRefCount(): number {
    return this._keepAliveRefs;
  }

  async subAgentHoldFiber(
    subAgentName: string,
    value: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.holdFiber(value);
  }

  async subAgentHoldManagedFiber(
    subAgentName: string,
    value: string,
    key: string
  ): Promise<string> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.holdManagedFiber(value, key);
  }

  async subAgentReleaseHeldFiber(subAgentName: string): Promise<void> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    await child.releaseHeldFiber();
  }

  async subAgentManagedFiber(
    subAgentName: string,
    fiberId: string
  ): Promise<FiberInspection | null> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.inspectManagedFiber(fiberId);
  }

  async subAgentRunningFiberCount(subAgentName: string): Promise<number> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getRunningFiberCount();
  }

  async subAgentRecoveredFibers(subAgentName: string): Promise<
    Array<{
      id: string;
      name: string;
      snapshot: { value?: string } | null;
      createdAt: number;
    }>
  > {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    return child.getRecoveredFibers();
  }

  async insertSubAgentInterruptedFiber(
    subAgentName: string,
    id: string,
    name: string,
    snapshot?: { value?: string }
  ): Promise<void> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    await child.insertInterruptedFiber(id, name, snapshot);
    await this._cf_registerFacetRun(await child.getSelfPath(), id);
  }

  async insertSubAgentInterruptedManagedFiber(
    subAgentName: string,
    id: string,
    name: string,
    snapshot?: { value?: string }
  ): Promise<void> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    await child.insertInterruptedManagedFiber(id, name, snapshot);
    await this._cf_registerFacetRun(await child.getSelfPath(), id);
  }

  async registerSubAgentFacetRunLeaseOnly(
    subAgentName: string,
    id: string
  ): Promise<void> {
    const child = await this.subAgent(CounterSubAgent, subAgentName);
    await this._cf_registerFacetRun(await child.getSelfPath(), id);
  }

  facetRunRows(): Array<{
    ownerPath: string;
    ownerPathKey: string;
    runId: string;
  }> {
    return this.sql<{
      owner_path: string;
      owner_path_key: string;
      run_id: string;
    }>`
      SELECT owner_path, owner_path_key, run_id
      FROM cf_agents_facet_runs
      ORDER BY owner_path_key, run_id
    `.map((row) => ({
      ownerPath: row.owner_path,
      ownerPathKey: row.owner_path_key,
      runId: row.run_id
    }));
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

  /** Count of connections the ROOT itself sees (its own direct connections). */
  connectionCount(): number {
    return [...this.getConnections()].length;
  }

  /** Connection ids visible to a freshly-resolved facet child (issue #1677). */
  async subAgentConnectionIds(subAgentName: string): Promise<string[]> {
    const child = await this.subAgent(BroadcastSubAgent, subAgentName);
    return child.connectionIds();
  }

  /** Connection count visible to a freshly-resolved facet child (#1677). */
  async subAgentConnectionCount(subAgentName: string): Promise<number> {
    const child = await this.subAgent(BroadcastSubAgent, subAgentName);
    return child.connectionCount();
  }

  /** Whether a facet child resolves the ROOT's connection id (#1677). */
  async subAgentHasConnection(
    subAgentName: string,
    connectionId: string
  ): Promise<boolean> {
    const child = await this.subAgent(BroadcastSubAgent, subAgentName);
    return child.hasConnection(connectionId);
  }

  /** A connection id the ROOT currently sees, or null. */
  firstConnectionId(): string | null {
    const [connection] = [...this.getConnections()];
    return connection ? connection.id : null;
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

  // parentAgent() regression fixtures exposed from the root test parent.
  async subAgentNestedCallFacetParent(
    outerName: string,
    innerName: string
  ): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerCallFacetParentPing(innerName);
  }

  async subAgentNestedFetchFacetParent(
    outerName: string,
    innerName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerFetchFacetParent(innerName, path);
  }

  async subAgentNestedFetchFacetParentWithRequest(
    outerName: string,
    innerName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerFetchFacetParentWithRequest(innerName, path);
  }

  async subAgentDeepCallFacetParent(
    outerName: string,
    innerName: string,
    leafName: string
  ): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerCallDeepFacetParent(innerName, leafName);
  }

  async subAgentDeepFetchFacetParent(
    outerName: string,
    innerName: string,
    leafName: string,
    path: string
  ): Promise<FacetFetchDescription> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerFetchDeepFacetParent(innerName, leafName, path);
  }

  async subAgentDeepTryFetchFacetParentWebSocket(
    outerName: string,
    innerName: string,
    leafName: string
  ): Promise<string> {
    const outer = await this.subAgent(OuterSubAgent, outerName);
    return outer.innerTryFetchDeepFacetParentWebSocket(innerName, leafName);
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
      await this.deleteSubAgent(CounterSubAgent, name);
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
    await this.deleteSubAgent(CounterSubAgent, name);
    try {
      await this.deleteSubAgent(CounterSubAgent, name);
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

// ── Root export-name fixtures ───────────────────────────────────────
//
// These root agents deliberately have class identifiers that differ
// from their export names. Sub-agent bootstrap still needs the root
// namespace to construct named facet ids, so these fixtures exercise
// the descriptive error path.

/** Class identifier `_UnboundParent`, exported as `TestUnboundParentAgent`. */
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

/** Class identifier `_a`, exported as `TestMinifiedNameParentAgent`. */
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
