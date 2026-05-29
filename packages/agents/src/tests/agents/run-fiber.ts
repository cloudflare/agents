import { Agent } from "../../index.ts";
import type {
  FiberInspection,
  FiberRecoveryContext,
  FiberRecoveryResult,
  ListFibersOptions,
  StartFiberResult
} from "../../index.ts";

export class TestRunFiberAgent extends Agent {
  static options = { keepAliveIntervalMs: 2_000 };

  executionLog: string[] = [];
  recoveredFibers: FiberRecoveryContext[] = [];

  /** Resolves the in-flight `holdFiber` callback's pending promise. */
  private _releaseHeldFiber?: () => void;
  private _releaseHeldManagedFiber?: () => void;
  private _releaseWaitedManagedFiber?: () => void;
  private _releaseIgnoredCancelManagedFiber?: () => void;
  private _releaseBlockedRecovery?: () => void;

  override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
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

  async startManagedWithRunCollision(
    fiberId: string
  ): Promise<StartFiberResult> {
    await this.insertInterruptedFiber(fiberId, "preexisting-run");
    return this.startFiber(
      "managed-setup-failure",
      async () => {
        this.executionLog.push("should-not-run");
      },
      { fiberId }
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
    return this._keepAliveRefs;
  }

  async getRunningFiberCount(): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count;
  }

  private _readRunSnapshot(id: string): unknown {
    const rows = this.sql<{ snapshot: string | null }>`
      SELECT snapshot FROM cf_agents_runs WHERE id = ${id} LIMIT 1
    `;
    const snapshot = rows[0]?.snapshot;
    return snapshot ? JSON.parse(snapshot) : null;
  }

  async waitFor(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Eviction simulation ───────────────────────────────────────

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

  /** Insert an unmanaged interrupted fiber row with a backdated created_at. */
  async insertAgedInterruptedFiber(
    id: string,
    name: string,
    ageMs: number
  ): Promise<void> {
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

  async triggerRecoveryCheck(): Promise<void> {
    await (
      this as unknown as { _checkRunFibers(): Promise<void> }
    )._checkRunFibers();
  }
}
