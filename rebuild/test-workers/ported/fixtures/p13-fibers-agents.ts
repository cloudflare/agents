// @ts-nocheck
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Think,
  callable,
  hostAgent,
  type ModelChunk,
  type ModelClient
} from "../compat.js";

type FiberStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "interrupted";

type StartResult = {
  fiberId: string;
  accepted: boolean;
  status: FiberStatus;
  error?: string;
};

type FiberInspection = {
  fiberId: string;
  name: string;
  status: FiberStatus;
  idempotencyKey?: string;
  metadata?: Record<string, unknown> | null;
  snapshot: unknown | null;
  error?: string;
  createdAt: number;
  settledAt?: number;
};

type FiberRecoveryContext = Omit<FiberInspection, "status"> & {
  status?: FiberStatus;
  recoveryReason: "interrupted";
};

type FiberRecoveryResult = {
  status: "completed" | "error" | "aborted";
  error?: string;
  snapshot?: unknown;
};

type RunRow = {
  id: string;
  name: string;
  managed: boolean;
  snapshot: unknown | null;
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string;
  createdAt: number;
  detected?: boolean;
  recoveryAttempts?: number;
};

type LedgerRow = {
  fiberId: string;
  name: string;
  status: FiberStatus;
  idempotencyKey?: string;
  metadata?: Record<string, unknown> | null;
  snapshot: unknown | null;
  error?: string;
  createdAt: number;
  settledAt?: number;
};

class TestRunFiberAgentImpl extends Think {
  executionLog: string[] = [];
  recoveredFibers: FiberRecoveryContext[] = [];
  recoveryEvents: string[] = [];

  private readonly stashWrappers = new AsyncLocalStorage<
    (data: unknown) => unknown
  >();
  private releaseHeldFiber?: () => void;
  private releaseHeldManagedFiber?: () => void;
  private releaseWaitedManagedFiberFn?: () => void;
  private releaseIgnoredCancelManagedFiberFn?: () => void;
  private releaseBlockedRecoveryFn?: () => void;

  constructor(host) {
    super(host);
    this.bus.subscribe("fiber", (event) => this.recoveryEvents.push(event.type));
  }

  protected override getModel(): ModelClient {
    return {
      async *stream(): AsyncIterable<ModelChunk> {
        yield { type: "finish", finishReason: "stop" };
      }
    };
  }

  override stash(data: unknown): void {
    const wrap = this.stashWrappers.getStore();
    super.stash(wrap ? wrap(data) : data);
  }

  protected override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    this.recoveredFibers.push(ctx);
    if (ctx.name === "managed-recovery-block") {
      await new Promise<void>((resolve) => {
        this.releaseBlockedRecoveryFn = resolve;
      });
    }
    if (ctx.name === "managed-recovery-complete") {
      return {
        status: "completed",
        snapshot: { recovered: true }
      };
    }
    if (ctx.name === "managed-recovery-throws") {
      throw new Error("Recovery failed");
    }
    if (ctx.name === "unmanaged-recovery-throws") {
      throw new Error("Unmanaged recovery failed");
    }
  }

  @callable()
  async runSimple(value: string): Promise<string> {
    return this.runFiber("simple", async () => {
      this.executionLog.push(`executed:${value}`);
      return value;
    });
  }

  @callable()
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

  @callable()
  async runWithThisStash(value: string): Promise<string> {
    return this.runFiber("this-stash", async () => {
      this.stash({ value });
      return value;
    });
  }

  @callable()
  async runFailing(): Promise<string> {
    try {
      await this.runFiber("failing", async () => {
        this.executionLog.push("failing");
        throw new Error("Intentional error");
      });
      return "no-error";
    } catch (error) {
      return `error:${error instanceof Error ? error.message : String(error)}`;
    }
  }

  @callable()
  async holdFiber(value: string): Promise<string> {
    return new Promise<string>((resolve) => {
      void this.runFiber("held", async (ctx) => {
        resolve(ctx.id);
        this.executionLog.push(`held:${value}`);
        await new Promise<void>((r) => {
          this.releaseHeldFiber = r;
        });
        this.executionLog.push(`held-done:${value}`);
      }).catch(console.error);
    });
  }

  @callable()
  releaseFiber(): void {
    const release = this.releaseHeldFiber;
    this.releaseHeldFiber = undefined;
    release?.();
  }

  @callable()
  async fireAndForget(value: string): Promise<string> {
    return new Promise<string>((resolve) => {
      void this.runFiber("background", async (ctx) => {
        resolve(ctx.id);
        this.executionLog.push(`background:${value}`);
        await new Promise((r) => setTimeout(r, 500));
        this.executionLog.push(`background-done:${value}`);
      }).catch(console.error);
    });
  }

  @callable()
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

  @callable()
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

  @callable()
  async runWithInternalStashWrapper(): Promise<{
    initialSnapshot: unknown;
    stashedSnapshot: unknown;
  }> {
    let initialSnapshot: unknown = null;
    let stashedSnapshot: unknown = null;
    await this.runFiber("internal-wrapped", async (ctx) => {
      ctx.stash({
        __testFiberSnapshot: { requestId: "initial" },
        user: null
      });
      initialSnapshot = this.readRunSnapshot(ctx.id);
      await this.stashWrappers.run(
        (data) => ({
          __testFiberSnapshot: { requestId: "wrapped" },
          user: data
        }),
        async () => {
          this.stash({ user: "checkpoint" });
          stashedSnapshot = this.readRunSnapshot(ctx.id);
        }
      );
    });
    return { initialSnapshot, stashedSnapshot };
  }

  @callable()
  async runWrappedAndPlainConcurrentStash(): Promise<{
    wrappedSnapshot: unknown;
    plainSnapshot: unknown;
  }> {
    let wrappedSnapshot: unknown = null;
    let plainSnapshot: unknown = null;
    await Promise.all([
      this.runFiber("internal-wrapped-concurrent", async (ctx) => {
        await new Promise((r) => setTimeout(r, 10));
        await this.stashWrappers.run(
          (data) => ({
            __testFiberSnapshot: { requestId: "wrapped" },
            user: data
          }),
          async () => {
            this.stash({ task: "wrapped" });
            wrappedSnapshot = this.readRunSnapshot(ctx.id);
          }
        );
        await new Promise((r) => setTimeout(r, 50));
      }),
      this.runFiber("plain-concurrent", async (ctx) => {
        await new Promise((r) => setTimeout(r, 20));
        this.stash({ task: "plain" });
        plainSnapshot = this.readRunSnapshot(ctx.id);
      })
    ]);
    return { wrappedSnapshot, plainSnapshot };
  }

  @callable()
  async runWithInitialSnapshotThenThrow(): Promise<{
    threw: boolean;
    runningFiberCount: number;
  }> {
    let threw = false;
    await this.runFiber("internal-wrapper-initial-then-throw", async (ctx) => {
      ctx.stash({
        __testFiberSnapshot: { requestId: "initial" },
        user: null
      });
      this.executionLog.push("initial-then-throw");
      throw new Error("simulated fiber failure");
    }).catch(() => {
      threw = true;
    });
    return { threw, runningFiberCount: this.getRunningFiberCount() };
  }

  @callable()
  stashOutsideFiber(): string {
    try {
      this.stash({ bad: true });
      return "no-error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  @callable()
  async startManaged(
    value: string,
    options?: { idempotencyKey?: string }
  ): Promise<StartResult> {
    return this.startFiber(
      "managed",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed:${value}`);
      },
      { idempotencyKey: options?.idempotencyKey, metadata: { value } }
    );
  }

  @callable()
  async startManagedForError(
    value: string,
    options?: { idempotencyKey?: string }
  ): Promise<string> {
    try {
      await this.startManaged(value, options);
      return "no-error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  @callable()
  async startManagedFailing(idempotencyKey: string): Promise<StartResult> {
    return this.startFiber(
      "managed-failing",
      async () => {
        this.executionLog.push("managed-failing");
        throw new Error("Managed failure");
      },
      { idempotencyKey }
    );
  }

  @callable()
  async startManagedAndWait(
    value: string,
    idempotencyKey: string
  ): Promise<StartResult> {
    return this.startFiber(
      "managed-wait",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-wait:${value}`);
      },
      { idempotencyKey, waitForCompletion: true }
    );
  }

  @callable()
  async holdManaged(value: string, idempotencyKey: string): Promise<string> {
    const result = await this.startFiber(
      "managed-held",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-held:${value}`);
        await new Promise<void>((resolve, reject) => {
          this.releaseHeldManagedFiber = resolve;
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

  @callable()
  async holdManagedAndWait(
    value: string,
    idempotencyKey: string
  ): Promise<StartResult> {
    return this.startFiber(
      "managed-wait-held",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-wait-held:${value}`);
        await new Promise<void>((resolve) => {
          this.releaseWaitedManagedFiberFn = resolve;
        });
      },
      { idempotencyKey, waitForCompletion: true }
    );
  }

  @callable()
  async holdManagedIgnoringCancelAndWait(
    value: string,
    idempotencyKey: string
  ): Promise<StartResult> {
    return this.startFiber(
      "managed-wait-ignore-cancel",
      async (ctx) => {
        ctx.stash({ value });
        this.executionLog.push(`managed-wait-ignore-cancel:${value}`);
        await new Promise<void>((resolve) => {
          this.releaseIgnoredCancelManagedFiberFn = resolve;
        });
        this.executionLog.push(`managed-wait-ignore-cancel-done:${value}`);
      },
      { idempotencyKey, waitForCompletion: true }
    );
  }

  @callable()
  async startManagedFailingAndWait(
    idempotencyKey: string
  ): Promise<StartResult> {
    return this.startFiber(
      "managed-wait-failing",
      async () => {
        this.executionLog.push("managed-wait-failing");
        throw new Error("Managed wait failure");
      },
      { idempotencyKey, waitForCompletion: true }
    );
  }

  @callable()
  releaseManagedFiber(): void {
    const release = this.releaseHeldManagedFiber;
    this.releaseHeldManagedFiber = undefined;
    release?.();
  }

  @callable()
  releaseWaitedManagedFiber(): void {
    const release = this.releaseWaitedManagedFiberFn;
    this.releaseWaitedManagedFiberFn = undefined;
    release?.();
  }

  @callable()
  releaseIgnoredCancelManagedFiber(): void {
    const release = this.releaseIgnoredCancelManagedFiberFn;
    this.releaseIgnoredCancelManagedFiberFn = undefined;
    release?.();
  }

  @callable()
  releaseBlockedRecovery(): void {
    const release = this.releaseBlockedRecoveryFn;
    this.releaseBlockedRecoveryFn = undefined;
    release?.();
  }

  @callable()
  inspectManagedFiber(fiberId: string): FiberInspection | null {
    return this.inspectFiber(fiberId);
  }

  @callable()
  inspectManagedFiberByKey(idempotencyKey: string): FiberInspection | null {
    return this.inspectFiberByKey(idempotencyKey);
  }

  @callable()
  listManagedFibers(options?: {
    status?: FiberStatus[];
    name?: string;
  }): FiberInspection[] {
    return this.listFibers(options);
  }

  @callable()
  cancelManagedFiber(fiberId: string, reason?: string): boolean {
    return this.cancelFiber(fiberId, reason);
  }

  @callable()
  cancelManagedFiberByKey(idempotencyKey: string, reason?: string): boolean {
    return this.cancelFiberByKey(idempotencyKey, reason);
  }

  @callable()
  deleteManagedFibers(): number {
    return this.deleteFibers();
  }

  @callable()
  deleteInterruptedManagedFibers(): number {
    return this.deleteFibers({ status: ["interrupted"] });
  }

  @callable()
  resolveManagedFiber(fiberId: string): boolean {
    return this.resolveFiber(fiberId, {
      status: "completed",
      snapshot: { resolved: true }
    });
  }

  @callable()
  async triggerRecoveryCheck(): Promise<void> {
    await this.fiberService.checkInterrupted();
  }

  @callable()
  insertInterruptedFiber(id: string, name: string, snapshot?: unknown): void {
    this.putRun({
      id,
      name,
      managed: false,
      snapshot: snapshot ?? null,
      createdAt: Date.now()
    });
  }

  @callable()
  insertAgedInterruptedFiber(id: string, name: string, ageMs: number): void {
    this.putRun({
      id,
      name,
      managed: false,
      snapshot: null,
      createdAt: Date.now() - ageMs
    });
  }

  @callable()
  insertInterruptedManagedFiber(
    id: string,
    name: string,
    snapshot?: unknown
  ): void {
    const now = Date.now();
    this.putLedger({
      fiberId: id,
      idempotencyKey: `key:${id}`,
      name,
      status: "running",
      snapshot: snapshot ?? null,
      metadata: { inserted: true },
      createdAt: now
    });
    this.putRun({
      id,
      name,
      managed: true,
      snapshot: snapshot ?? null,
      metadata: { inserted: true },
      idempotencyKey: `key:${id}`,
      createdAt: now
    });
  }

  @callable()
  insertManagedLedgerOnlyFiber(
    id: string,
    name: string,
    status: "pending" | "running",
    snapshot?: unknown
  ): void {
    this.putLedger({
      fiberId: id,
      idempotencyKey: `key:${id}`,
      name,
      status,
      snapshot: snapshot ?? null,
      metadata: { ledgerOnly: true },
      createdAt: Date.now()
    });
  }

  @callable()
  insertAbortedManagedFiberWithRun(
    id: string,
    name: string,
    snapshot?: unknown
  ): void {
    const now = Date.now();
    this.putLedger({
      fiberId: id,
      idempotencyKey: `key:${id}`,
      name,
      status: "aborted",
      snapshot: snapshot ?? null,
      metadata: { inserted: true },
      error: "cancelled",
      createdAt: now,
      settledAt: now
    });
    this.putRun({
      id,
      name,
      managed: true,
      snapshot: snapshot ?? null,
      metadata: { inserted: true },
      idempotencyKey: `key:${id}`,
      createdAt: now
    });
  }

  @callable()
  getExecutionLog(): string[] {
    return this.executionLog;
  }

  @callable()
  getRecoveredFibers(): FiberRecoveryContext[] {
    return this.recoveredFibers;
  }

  @callable()
  getRecoveryEventTypes(): string[] {
    return this.recoveryEvents;
  }

  @callable()
  getKeepAliveRefCount(): number {
    return this.keepAliveService.activeRefs();
  }

  @callable()
  getRunningFiberCount(): number {
    return this.host.store.list({ prefix: "fiber:run:" }).size;
  }

  @callable()
  waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private putRun(row: RunRow): void {
    this.host.store.put(`fiber:run:${row.id}`, row);
  }

  private putLedger(row: LedgerRow): void {
    this.host.store.put(`fiber:ledger:${row.fiberId}`, row);
  }

  private readRunSnapshot(id: string): unknown {
    return this.host.store.get<RunRow>(`fiber:run:${id}`)?.snapshot ?? null;
  }
}

const TestRunFiberAgentBase = hostAgent(TestRunFiberAgentImpl);

// `@callable()` on the wrapped Think instance only registers into the
// internal callable dispatch registry (websocket rpc / callables().dispatch()
// path) — it does NOT expose a same-named method on the exported Durable
// Object class for direct `stub.methodName(...)` RPC calls, which is how
// this ported test's fixture (mirroring the original `agents` Agent class)
// is driven. Bridge each test-only method explicitly, same pattern as
// agent-tools-agents.ts's `installRpcMethods`.
const rpcMethodNames = [
  "runSimple",
  "runWithCheckpoint",
  "runWithThisStash",
  "runFailing",
  "holdFiber",
  "releaseFiber",
  "fireAndForget",
  "runConcurrent",
  "runConcurrentWithThisStash",
  "runWithInternalStashWrapper",
  "runWrappedAndPlainConcurrentStash",
  "runWithInitialSnapshotThenThrow",
  "stashOutsideFiber",
  "startManaged",
  "startManagedForError",
  "startManagedFailing",
  "startManagedAndWait",
  "holdManaged",
  "holdManagedAndWait",
  "holdManagedIgnoringCancelAndWait",
  "startManagedFailingAndWait",
  "releaseManagedFiber",
  "releaseWaitedManagedFiber",
  "releaseIgnoredCancelManagedFiber",
  "releaseBlockedRecovery",
  "inspectManagedFiber",
  "inspectManagedFiberByKey",
  "listManagedFibers",
  "cancelManagedFiber",
  "cancelManagedFiberByKey",
  "deleteManagedFibers",
  "deleteInterruptedManagedFibers",
  "resolveManagedFiber",
  "triggerRecoveryCheck",
  "insertInterruptedFiber",
  "insertAgedInterruptedFiber",
  "insertInterruptedManagedFiber",
  "insertManagedLedgerOnlyFiber",
  "insertAbortedManagedFiberWithRun",
  "getExecutionLog",
  "getRecoveredFibers",
  "getRecoveryEventTypes",
  "getKeepAliveRefCount",
  "getRunningFiberCount",
  "waitFor"
] as const;

type ShellWithAgent = {
  withAgent<T>(fn: (agent: Record<string, unknown>) => T | Promise<T>): Promise<T>;
};

function installRpcMethods(target: { prototype: object }): void {
  for (const method of rpcMethodNames) {
    if (method in target.prototype) continue;
    Object.defineProperty(target.prototype, method, {
      value(this: ShellWithAgent, ...args: unknown[]) {
        return this.withAgent((agent) => (agent[method] as (...a: unknown[]) => unknown)(...args));
      }
    });
  }
}

export class TestRunFiberAgent extends TestRunFiberAgentBase {}
installRpcMethods(TestRunFiberAgent);
