import { Agent, getCurrentAgent } from "../../index.ts";
import type { Tasks } from "../../tasks/tasks";
import { importLegacyFibers } from "../../fiber-runs";
import { createLegacyFiberTables, OPEN_FIBER_RUNS_SQL } from "./legacy-fibers";
import type {
  FiberInspection,
  FiberRecoveryContext,
  FiberRecoveryResult,
  FiberStatus,
  ListFibersOptions,
  StartFiberResult
} from "../../index.ts";

export class TestRunFiberAgent extends Agent {
  static options = { keepAliveIntervalMs: 2_000 };
  // Stands in for a chat host's turn-fiber name, whose recovery owns its
  // own budget.
  static readonly CHAT_FIBER_NAME = "__cf_internal_probe";

  executionLog: string[] = [];
  recoveredFibers: FiberRecoveryContext[] = [];
  internalRecovered: string[] = [];

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    if (!ctx.name.startsWith("__cf_internal_probe")) return false;
    this.internalRecovered.push(ctx.id);
    return true;
  }

  /** Resolves the in-flight `holdFiber` callback's pending promise. */
  private _releaseHeldFiber?: () => void;
  private _releaseHeldManagedFiber?: () => void;
  private _releaseWaitedManagedFiber?: () => void;
  private _releaseIgnoredCancelManagedFiber?: () => void;
  private _releaseBlockedRecovery?: () => void;

  /** MCP connection ids visible at the moment each fiber was recovered. */
  recoveryMcpConnections: Record<string, string[]> = {};

  override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this.recoveryMcpConnections[ctx.id] = Object.keys(this.mcp.mcpConnections);
    this.recoveredFibers.push(ctx);
    if (ctx.name === "managed-recovery-block") {
      await new Promise<void>((resolve) => {
        this._releaseBlockedRecovery = resolve;
      });
    }
    if (ctx.name === "managed-recovery-complete") {
      return {
        status: "completed",
        snapshot: { recovered: true },
        metadata: { recovered: true }
      };
    }
    if (ctx.name === "managed-resolves-itself") {
      // As Think's messenger recovery does: record a stage, then complete.
      await this.resolveFiber(ctx.id, {
        status: "interrupted",
        snapshot: { stage: "posting" }
      });
      await this.resolveFiber(ctx.id, {
        status: "completed",
        snapshot: { stage: "done" }
      });
      return;
    }
    if (ctx.name === "managed-stage-then-throws") {
      await this.resolveFiber(ctx.id, {
        status: "interrupted",
        snapshot: { stage: "posting" }
      });
      throw new Error("Delivery failed");
    }
    if (ctx.name === "managed-resolves-then-throws") {
      await this.resolveFiber(ctx.id, { status: "completed" });
      throw new Error("after resolving");
    }
    if (ctx.name === "managed-recovery-throws") {
      throw new Error("Recovery failed");
    }
    if (ctx.name === "unmanaged-recovery-throws") {
      throw new Error("Unmanaged recovery failed");
    }
  }

  // ── Test methods exposed via RPC ──────────────────────────────

  async runSimple(value: string): Promise<string> {
    return this.runFiber("simple", async () => {
      this.executionLog.push(`executed:${value}`);
      return value;
    });
  }

  async runWithFailingCleanup(value: string): Promise<string> {
    this.sql`
      CREATE TRIGGER fail_run_fiber_cleanup
      BEFORE DELETE ON cf_agents_task_runs
      WHEN json_extract(OLD.input, '$.name') = 'cleanup-failure'
      BEGIN
        SELECT RAISE(FAIL, 'simulated fiber cleanup failure');
      END
    `;

    try {
      return await this.runFiber("cleanup-failure", async () => value);
    } finally {
      this.sql`DROP TRIGGER fail_run_fiber_cleanup`;
    }
  }

  /** Returns the body's error message, caught here so it does not cross RPC. */
  async runFailingWithFailingCleanup(
    syncThrow = false
  ): Promise<string | null> {
    this.sql`
      CREATE TRIGGER fail_run_fiber_cleanup
      BEFORE DELETE ON cf_agents_task_runs
      WHEN json_extract(OLD.input, '$.name') = 'cleanup-failure-after-error'
      BEGIN
        SELECT RAISE(FAIL, 'simulated fiber cleanup failure');
      END
    `;

    try {
      await this.runFiber(
        "cleanup-failure-after-error",
        syncThrow
          ? (): Promise<void> => {
              throw new Error("body failed synchronously");
            }
          : async () => {
              throw new Error("body failed");
            }
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      this.sql`DROP TRIGGER fail_run_fiber_cleanup`;
    }
  }

  async runWithCheckpoint(steps: string[]): Promise<string[]> {
    return this.runFiber("checkpoint", async (ctx) => {
      const completed: string[] = [];
      for (const step of steps) {
        completed.push(step);
        ctx.stash({ completedSteps: [...completed], currentStep: step });
        this.executionLog.push(`step:${step}`);
      }
      return completed;
    });
  }

  async runWithThisStash(value: string): Promise<string> {
    return this.runFiber("this-stash", async () => {
      this.stash({ value });
      return value;
    });
  }

  async runSlow(durationMs: number): Promise<string> {
    return this.runFiber("slow", async (ctx) => {
      this.executionLog.push("slow-start");
      ctx.stash({ started: true });
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      this.executionLog.push("slow-end");
      return "done";
    });
  }

  async runFailing(): Promise<string> {
    try {
      await this.runFiber("failing", async () => {
        this.executionLog.push("failing");
        throw new Error("Intentional error");
      });
      return "no-error";
    } catch (e) {
      return `error:${(e as Error).message}`;
    }
  }

  async fireAndForget(value: string): Promise<string> {
    const id = await new Promise<string>((resolve) => {
      void this.runFiber("background", async (ctx) => {
        resolve(ctx.id);
        this.executionLog.push(`background:${value}`);
        await new Promise((r) => setTimeout(r, 500));
        this.executionLog.push(`background-done:${value}`);
      }).catch(console.error);
    });
    return id;
  }

  async startManaged(
    value: string,
    options?: { fiberId?: string; idempotencyKey?: string }
  ): Promise<StartFiberResult> {
    return this.startFiber(
      "managed",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed:${value}`);
      },
      {
        fiberId: options?.fiberId,
        idempotencyKey: options?.idempotencyKey,
        metadata: { value }
      }
    );
  }

  async startManagedForError(
    value: string,
    options?: { fiberId?: string; idempotencyKey?: string }
  ): Promise<string> {
    try {
      await this.startFiber(
        "managed",
        async (ctx) => {
          ctx.stash({ value });
        },
        {
          fiberId: options?.fiberId,
          idempotencyKey: options?.idempotencyKey,
          metadata: { value }
        }
      );
      return "no-error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async startManagedFailing(idempotencyKey: string): Promise<StartFiberResult> {
    return this.startFiber(
      "managed-failing",
      async () => {
        this.executionLog.push("managed-failing");
        throw new Error("Managed failure");
      },
      { idempotencyKey }
    );
  }

  /** Start a managed fiber under the id of a plain fiber's run; returns the error. */
  async startManagedWithRunCollision(fiberId: string): Promise<string> {
    await this.insertInterruptedFiber(fiberId, "preexisting-run");
    await importLegacyFibers(
      this.tasks,
      this.ctx.storage,
      false,
      async () => {}
    );
    return this.startFiber(
      "managed-setup-failure",
      async () => {
        this.executionLog.push("should-not-run");
      },
      { fiberId }
    ).then(
      () => "accepted",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    );
  }

  async holdManaged(value: string, idempotencyKey: string): Promise<string> {
    const result = await this.startFiber(
      "managed-held",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-held:${value}`);
        await new Promise<void>((resolve, reject) => {
          this._releaseHeldManagedFiber = resolve;
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("managed cancelled")),
            { once: true }
          );
        });
        this.executionLog.push(`managed-held-done:${value}`);
      },
      { idempotencyKey }
    );
    return result.fiberId;
  }

  async startManagedAndWait(
    value: string,
    idempotencyKey: string
  ): Promise<{
    accepted: boolean;
    status: string;
    fiberId: string;
  }> {
    const result = await this.startFiber(
      "managed-wait",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-wait:${value}`);
      },
      { idempotencyKey, waitForCompletion: true }
    );
    return {
      accepted: result.accepted,
      status: result.status,
      fiberId: result.fiberId
    };
  }

  async holdManagedAndWait(
    value: string,
    idempotencyKey: string
  ): Promise<{
    accepted: boolean;
    status: string;
    fiberId: string;
  }> {
    const result = await this.startFiber(
      "managed-wait-held",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-wait-held:${value}`);
        await new Promise<void>((resolve) => {
          this._releaseWaitedManagedFiber = resolve;
        });
      },
      { idempotencyKey, waitForCompletion: true }
    );
    return {
      accepted: result.accepted,
      status: result.status,
      fiberId: result.fiberId
    };
  }

  async holdManagedIgnoringCancelAndWait(
    value: string,
    idempotencyKey: string
  ): Promise<{
    accepted: boolean;
    status: string;
    fiberId: string;
  }> {
    const result = await this.startFiber(
      "managed-wait-ignore-cancel",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-wait-ignore-cancel:${value}`);
        await new Promise<void>((resolve) => {
          this._releaseIgnoredCancelManagedFiber = resolve;
        });
        this.executionLog.push(`managed-wait-ignore-cancel-done:${value}`);
      },
      { idempotencyKey, waitForCompletion: true }
    );
    return {
      accepted: result.accepted,
      status: result.status,
      fiberId: result.fiberId
    };
  }

  async startManagedFailingAndWait(idempotencyKey: string): Promise<{
    accepted: boolean;
    status: string;
    fiberId: string;
    error?: string;
  }> {
    const result = await this.startFiber(
      "managed-wait-failing",
      async () => {
        this.executionLog.push("managed-wait-failing");
        throw new Error("Managed wait failure");
      },
      { idempotencyKey, waitForCompletion: true }
    );
    return {
      accepted: result.accepted,
      status: result.status,
      fiberId: result.fiberId,
      error: result.error
    };
  }

  async releaseWaitedManagedFiber(): Promise<void> {
    const release = this._releaseWaitedManagedFiber;
    this._releaseWaitedManagedFiber = undefined;
    release?.();
  }

  async releaseIgnoredCancelManagedFiber(): Promise<void> {
    const release = this._releaseIgnoredCancelManagedFiber;
    this._releaseIgnoredCancelManagedFiber = undefined;
    release?.();
  }

  async releaseBlockedRecovery(): Promise<void> {
    const release = this._releaseBlockedRecovery;
    this._releaseBlockedRecovery = undefined;
    release?.();
  }

  async releaseManagedFiber(): Promise<void> {
    const release = this._releaseHeldManagedFiber;
    this._releaseHeldManagedFiber = undefined;
    release?.();
  }

  /**
   * Like `fireAndForget`, but the fiber's callback awaits an explicit
   * `releaseFiber()` signal instead of a wall-clock timer. Lets tests assert
   * "keepAlive ref is held during fiber execution" deterministically without
   * racing a 500ms `setTimeout`.
   */
  async holdFiber(value: string): Promise<string> {
    const id = await new Promise<string>((resolve) => {
      void this.runFiber("held", async (ctx) => {
        resolve(ctx.id);
        this.executionLog.push(`held:${value}`);
        await new Promise<void>((r) => {
          this._releaseHeldFiber = r;
        });
        this.executionLog.push(`held-done:${value}`);
      }).catch(console.error);
    });
    return id;
  }

  async releaseFiber(): Promise<void> {
    const release = this._releaseHeldFiber;
    this._releaseHeldFiber = undefined;
    release?.();
  }

  async inspectManagedFiber(fiberId: string): Promise<FiberInspection | null> {
    return this.inspectFiber(fiberId);
  }

  async inspectManagedFiberByKey(
    idempotencyKey: string
  ): Promise<FiberInspection | null> {
    return this.inspectFiberByKey(idempotencyKey);
  }

  async listManagedFibers(
    options?: ListFibersOptions
  ): Promise<FiberInspection[]> {
    return this.listFibers(options);
  }

  async cancelManagedFiber(fiberId: string, reason?: string): Promise<boolean> {
    return this.cancelFiber(fiberId, reason);
  }

  async cancelManagedFiberByKey(
    idempotencyKey: string,
    reason?: string
  ): Promise<boolean> {
    return this.cancelFiberByKey(idempotencyKey, reason);
  }

  async deleteManagedFibers(): Promise<number> {
    return this.deleteFibers();
  }

  /** A ledger row an older release marked `interrupted` at `interruptedAt`. */
  async insertInterruptedLedgerFiber(
    id: string,
    createdAt: number,
    interruptedAt: number,
    reason: string | null = null
  ): Promise<void> {
    this._legacyFiberTables();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${id}, ${`key:${id}`}, ${"managed"}, 'interrupted', NULL, NULL, ${reason},
         ${createdAt}, ${createdAt}, ${interruptedAt})
    `;
  }

  /** A managed fiber's run accepted and not yet claimed (its wake far off). */
  async insertPendingManagedRun(id: string): Promise<void> {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, status, retain, attempt, next_at,
         cancel_requested, created_at, updated_at)
      VALUES (${id}, '__cf_managed_fiber', ${JSON.stringify({ name: "later" })},
        'pending', 1, 0, ${now + 3_600_000}, 0, ${now}, ${now})
    `;
  }

  /**
   * A managed fiber whose recovery hook resolved it and then lost its
   * isolate before the attempt ended: its run is still `running`.
   */
  async insertResolvedThenResetManagedRun(id: string): Promise<void> {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, status, retain, attempt, generation,
         next_at, cancel_requested, created_at, updated_at)
      VALUES (${id}, '__cf_managed_fiber', ${JSON.stringify({ name: "managed" })},
        'running', 1, 2, 'dead', ${now}, 0, ${now}, ${now})
    `;
    for (const [key, value] of [
      ["crashes", 1],
      ["snapshot", { stage: "done" }],
      ["resolved", { status: "completed" }]
    ] as const) {
      this.sql`
        INSERT INTO cf_agents_task_checkpoint (run_id, key, value)
        VALUES (${id}, ${key}, ${JSON.stringify(value)})
      `;
    }
  }

  /** A run of another definition holding `key` in Tasks' one key space. */
  async insertOtherTaskWithKey(key: string): Promise<void> {
    await this.tasks.importRun({
      runId: `other-${key}`,
      definition: "other",
      status: "completed",
      attempt: 1,
      idempotencyKey: key,
      createdAt: Date.now()
    });
  }

  /** Two starts of the same key racing each other. */
  async startManagedTwice(
    key: string
  ): Promise<Array<{ accepted: boolean; fiberId: string }>> {
    const start = () =>
      this.startFiber("raced", async () => {}, { idempotencyKey: key });
    const results = await Promise.all([start(), start()]);
    return results.map(({ accepted, fiberId }) => ({ accepted, fiberId }));
  }

  /** Start and complete a managed fiber, then return its inspection. */
  async completeManaged(key: string): Promise<FiberInspection | null> {
    const result = await this.startFiber("done", async () => {}, {
      idempotencyKey: key,
      waitForCompletion: true
    });
    return this.inspectFiber(result.fiberId);
  }

  async listFibersFor(
    status: FiberStatus | FiberStatus[],
    limit: number
  ): Promise<string[]> {
    return (await this.listFibers({ status, limit })).map((f) => f.fiberId);
  }

  async deleteFibersFor(status: FiberStatus[], limit: number): Promise<number> {
    return this.deleteFibers({ status, limit });
  }

  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/fiber-context")) {
      const seen = await this.runFiber(
        "context",
        async () => getCurrentAgent().request?.url ?? null
      );
      return Response.json({ seen });
    }
    return new Response("not found", { status: 404 });
  }

  async deleteInterruptedFibersBefore(time: number): Promise<number> {
    return this.deleteFibers({
      status: "interrupted",
      settledBefore: new Date(time)
    });
  }

  /** Deliver a fiber run's wake job now, as a late alarm or routed dispatch does. */
  async dispatchFiberWake(fiberId: string): Promise<void> {
    await this.tasks.onJob({
      job: { id: `task:${fiberId}`, fn: "wake", payload: { runId: fiberId } }
    } as unknown as Parameters<Tasks["onJob"]>[0]);
  }

  async deleteInterruptedManagedFibers(): Promise<number> {
    return this.deleteFibers({ status: "interrupted" });
  }

  async resolveManagedFiber(fiberId: string): Promise<boolean> {
    return this.resolveFiber(fiberId, {
      status: "completed",
      snapshot: { resolved: true }
    });
  }

  async runConcurrent(): Promise<void> {
    void this.runFiber("concurrent-a", async (ctx) => {
      ctx.stash({ task: "a" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("a-done");
    }).catch(console.error);

    void this.runFiber("concurrent-b", async (ctx) => {
      ctx.stash({ task: "b" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("b-done");
    }).catch(console.error);
  }

  async runConcurrentWithThisStash(): Promise<void> {
    void this.runFiber("concurrent-this-a", async () => {
      this.stash({ task: "a" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("this-a-done");
    }).catch(console.error);

    void this.runFiber("concurrent-this-b", async () => {
      this.stash({ task: "b" });
      await new Promise((r) => setTimeout(r, 100));
      this.executionLog.push("this-b-done");
    }).catch(console.error);
  }

  async runWithInternalStashWrapper(): Promise<{
    initialSnapshot: unknown;
    stashedSnapshot: unknown;
  }> {
    let initialSnapshot: unknown = null;
    let stashedSnapshot: unknown = null;

    await this._runFiberWithStashWrapper(
      "internal-wrapped",
      async (ctx) => {
        initialSnapshot = this._readRunSnapshot(ctx.id);
        this.stash({ user: "checkpoint" });
        stashedSnapshot = this._readRunSnapshot(ctx.id);
      },
      {
        initialSnapshot: {
          __testFiberSnapshot: { requestId: "initial" },
          user: null
        },
        wrapStash: (data) => ({
          __testFiberSnapshot: { requestId: "wrapped" },
          user: data
        })
      }
    );

    return { initialSnapshot, stashedSnapshot };
  }

  async runWrappedAndPlainConcurrentStash(): Promise<{
    wrappedSnapshot: unknown;
    plainSnapshot: unknown;
  }> {
    let wrappedSnapshot: unknown = null;
    let plainSnapshot: unknown = null;

    await Promise.all([
      this._runFiberWithStashWrapper(
        "internal-wrapped-concurrent",
        async (ctx) => {
          await new Promise((r) => setTimeout(r, 10));
          this.stash({ task: "wrapped" });
          wrappedSnapshot = this._readRunSnapshot(ctx.id);
          await new Promise((r) => setTimeout(r, 50));
        },
        {
          initialSnapshot: {
            __testFiberSnapshot: { requestId: "initial" },
            user: null
          },
          wrapStash: (data) => ({
            __testFiberSnapshot: { requestId: "wrapped" },
            user: data
          })
        }
      ),
      this.runFiber("plain-concurrent", async (ctx) => {
        await new Promise((r) => setTimeout(r, 20));
        this.stash({ task: "plain" });
        plainSnapshot = this._readRunSnapshot(ctx.id);
      })
    ]);

    return { wrappedSnapshot, plainSnapshot };
  }

  async runWithInitialSnapshotThenThrow(): Promise<{
    threw: boolean;
    runningFiberCount: number;
  }> {
    let threw = false;

    await this._runFiberWithStashWrapper(
      "internal-wrapper-initial-then-throw",
      async () => {
        this.executionLog.push("initial-then-throw");
        throw new Error("simulated fiber failure");
      },
      {
        initialSnapshot: {
          __testFiberSnapshot: { requestId: "initial" },
          user: null
        }
      }
    ).catch(() => {
      threw = true;
    });

    return {
      threw,
      runningFiberCount: await this.getRunningFiberCount()
    };
  }

  async stashOutsideFiber(): Promise<string> {
    try {
      this.stash({ bad: true });
      return "no-error";
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ── Query methods ─────────────────────────────────────────────

  async getExecutionLog(): Promise<string[]> {
    return this.executionLog;
  }

  async getRecoveredFibers(): Promise<FiberRecoveryContext[]> {
    return this.recoveredFibers;
  }

  async getKeepAliveRefCount(): Promise<number> {
    return this._keepAlive.holds;
  }

  /** Fiber runs not yet settled or parked (a body running or awaiting recovery). */
  async getRunningFiberCount(): Promise<number> {
    return Number(this.ctx.storage.sql.exec(OPEN_FIBER_RUNS_SQL).one().count);
  }

  private _readRunSnapshot(id: string): unknown {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM cf_agents_task_checkpoint
      WHERE run_id = ${id} AND key = 'snapshot' LIMIT 1
    `;
    return rows[0] ? JSON.parse(rows[0].value) : null;
  }

  private _legacyFiberTables(): void {
    createLegacyFiberTables(this.ctx.storage.sql);
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Eviction simulation ───────────────────────────────────────

  /**
   * Insert a stored MCP server pending OAuth (never dials out on restore)
   * and reset the manager so the next wake restores it again. Clears the
   * in-memory connections so any connection seen later provably came from
   * that wake's restore.
   */
  async seedMcpServerRow(id: string): Promise<void> {
    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers
        (id, name, server_url, client_id, auth_url, callback_url, server_options)
      VALUES (${id}, ${"seeded"}, ${"http://mcp.invalid/mcp"}, NULL,
              ${"http://mcp.invalid/authorize"}, ${"http://mcp.invalid/callback"},
              ${JSON.stringify({ capabilities: { elicitation: { form: {}, url: {} } } })})
    `;
    for (const connectionId of Object.keys(this.mcp.mcpConnections)) {
      delete this.mcp.mcpConnections[connectionId];
    }
    // @ts-expect-error - accessing private field for testing
    this.mcp._isRestored = false;
  }

  async getRecoveryMcpConnections(): Promise<Record<string, string[]>> {
    return this.recoveryMcpConnections;
  }

  async insertInterruptedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    this._legacyFiberTables();
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  /** An interrupted fiber row in the oldest released table shape (no outcome columns). */
  async insertOldestShapeInterruptedFiber(
    id: string,
    name: string
  ): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_runs (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, ${JSON.stringify({ step: 1 })}, ${Date.now()})
    `;
  }

  /** Insert an unmanaged interrupted fiber row that already crashed recovery `crashes` times. */
  async insertCrashedRecoveryFiber(
    id: string,
    name: string,
    crashes: number
  ): Promise<void> {
    this._legacyFiberTables();
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at, recovery_crashes)
      VALUES (${id}, ${name}, NULL, ${Date.now()}, ${crashes})
    `;
  }

  async runNamedFiber(name: string): Promise<string> {
    await this.runFiber(name, async () => {});
    return "ran";
  }

  async internalRecoveredFibers(): Promise<string[]> {
    return this.internalRecovered;
  }

  /** Insert an unmanaged interrupted fiber row with a backdated created_at. */
  async insertAgedInterruptedFiber(
    id: string,
    name: string,
    ageMs: number
  ): Promise<void> {
    this._legacyFiberTables();
    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, NULL, ${Date.now() - ageMs})
    `;
  }

  async insertInterruptedManagedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    this._legacyFiberTables();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${id}, ${`key:${id}`}, ${name}, 'running',
         ${snapshot ? JSON.stringify(snapshot) : null},
         ${JSON.stringify({ inserted: true })}, NULL, ${now}, ${now}, NULL)
    `;
    await this.insertInterruptedFiber(id, name, snapshot);
  }

  async insertManagedLedgerOnlyFiber(
    id: string,
    name: string,
    status: "pending" | "running",
    snapshot?: unknown
  ): Promise<void> {
    this._legacyFiberTables();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${id}, ${`key:${id}`}, ${name}, ${status},
         ${snapshot ? JSON.stringify(snapshot) : null},
         ${JSON.stringify({ ledgerOnly: true })}, NULL, ${now},
         ${status === "running" ? now : null}, NULL)
    `;
  }

  async insertAbortedManagedFiberWithRun(
    id: string,
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    this._legacyFiberTables();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${id}, ${`key:${id}`}, ${name}, 'aborted',
         ${snapshot ? JSON.stringify(snapshot) : null},
         ${JSON.stringify({ inserted: true })}, ${"cancelled"}, ${now}, ${now}, ${now})
    `;
    await this.insertInterruptedFiber(id, name, snapshot);
  }

  /**
   * A managed fiber whose body settled (`completed_at` on the run row) but
   * whose ledger settle and run-row delete both failed.
   */
  async insertSettledManagedFiberWithRun(
    id: string,
    name: string
  ): Promise<void> {
    this._legacyFiberTables();
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${id}, ${`key:${id}`}, ${name}, 'running', NULL, NULL, NULL,
         ${now}, ${now}, NULL)
    `;
    this.sql`
      INSERT INTO cf_agents_runs
        (id, name, snapshot, created_at, completed_at, outcome)
      VALUES (${id}, ${name}, NULL, ${now}, ${now}, 'completed')
    `;
  }

  /**
   * Runs a managed fiber whose body throws while its settle write fails, so
   * its run stays `running` as if the isolate had died.
   */
  async runManagedFailingWithFailedSettle(fiberId: string): Promise<void> {
    this.sql`
      CREATE TRIGGER fail_managed_fiber_settle
      BEFORE UPDATE OF status ON cf_agents_task_runs
      WHEN json_extract(OLD.input, '$.name') = 'managed-settle-failure'
        AND NEW.status = 'error'
      BEGIN
        SELECT RAISE(FAIL, 'simulated settle failure');
      END
    `;
    try {
      await this.startFiber(
        "managed-settle-failure",
        async () => {
          throw new Error("managed body failed");
        },
        { fiberId, waitForCompletion: true }
      ).catch(() => {});
    } finally {
      this.sql`DROP TRIGGER fail_managed_fiber_settle`;
    }
    // Due now, as the next start's reconcile makes a run left `running`.
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${Date.now()}
      WHERE run_id = ${fiberId} AND status = 'running'
    `;
  }

  async triggerRecoveryCheck(): Promise<void> {
    await (
      this as unknown as { _recoverFibers(): Promise<void> }
    )._recoverFibers();
  }

  /** Read the physical DO alarm (epoch ms) or null when none is armed. */
  async getCurrentAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** The earliest wake of a fiber run (epoch ms), or null when none is armed. */
  async getFiberWakeTime(): Promise<number | null> {
    const rows = this.sql<{ time: number | null }>`
      SELECT min(next_at) AS time FROM cf_agents_task_runs
      WHERE definition IN ('__cf_fiber', '__cf_managed_fiber')
        AND status IN ('pending', 'running')
    `;
    return rows[0]?.time ?? null;
  }

  /**
   * Run one recovery pass and return the armed alarm time (epoch ms) or
   * null. Lets tests drive multi-pass recovery deterministically without
   * spawning a real process or waiting on timers.
   */
  async simulateAlarmCycle(): Promise<number | null> {
    // A retry waits out its backoff; this cycle stands in for that wake.
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${Date.now()}
      WHERE definition IN ('__cf_fiber', '__cf_managed_fiber')
        AND status = 'pending' AND next_at IS NOT NULL
    `;
    await (
      this as unknown as { _recoverFibers(): Promise<void> }
    )._recoverFibers();
    return this.ctx.storage.getAlarm();
  }
}
