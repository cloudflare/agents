import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJob,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../lifecycle";
import type {
  DurableToolError,
  DurableToolInspection,
  DurableToolOwner,
  DurableToolRun,
  DurableToolRunsOptions,
  DurableToolStartResult
} from "./tool-types";

const DRIVE_TOOL = "drive-tool";

interface ToolRunRow {
  [key: string]: string | number | null;
  coordinator_id: string;
  run_id: string;
  owner_json: string;
  input_json: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
}

function decodeRun<Input, Result>(
  row: ToolRunRow
): DurableToolRun<Input, Result> {
  return {
    runId: row.run_id,
    coordinatorId: row.coordinator_id,
    owner: JSON.parse(row.owner_json) as DurableToolOwner,
    input: JSON.parse(row.input_json) as Input,
    status: row.status,
    result:
      row.result_json === null ? null : (JSON.parse(row.result_json) as Result),
    error:
      row.error_json === null
        ? null
        : (JSON.parse(row.error_json) as DurableToolError),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function durableToolRunId(owner: DurableToolOwner): string {
  return [owner.driverId, owner.scope, owner.operationId, owner.toolCallId]
    .map((value) => `${value.length}:${value}`)
    .join(":");
}

export class DurableToolRuns<Input, Result> extends LifecycleCapability {
  readonly #id: string;
  readonly #runtime: DurableToolRunsOptions<Input, Result>["runtime"];
  readonly #wake: DurableToolRunsOptions<Input, Result>["wake"];
  readonly #heartbeatMs: number;
  readonly #waiters = new Map<
    string,
    Set<{
      readonly resolve: (result: Result) => void;
      readonly reject: (error: unknown) => void;
    }>
  >();
  #ready = false;

  constructor(options: DurableToolRunsOptions<Input, Result>) {
    if (options.id.trim() === "") throw new Error("id must not be empty");
    super(`durable-tools:${options.id}`);
    this.#id = options.id;
    this.#runtime = options.runtime;
    this.#wake = options.wake;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    this.#ensureTable();
    for (const run of this.#active()) this.#pushJob(run.runId, Date.now());
    await this.lifecycle.jobs.rearm();
  }

  async start(
    runId: string,
    owner: DurableToolOwner,
    input: Input
  ): Promise<DurableToolStartResult<Input, Result>> {
    await this.lifecycle.ready();
    if (runId.trim() === "") throw new Error("runId must not be empty");
    this.#validateOwner(owner);
    const existing = this.#get(runId);
    if (existing) {
      if (JSON.stringify(existing.owner) !== JSON.stringify(owner)) {
        throw new Error(`Tool run ${runId} already has a different owner`);
      }
      return { accepted: false, run: existing };
    }
    const inputJSON = JSON.stringify(input);
    if (inputJSON === undefined) {
      throw new Error("input must be JSON-serializable");
    }
    const now = Date.now();
    const run = this.lifecycle.storage.transactionSync(() => {
      this.#ensureTable();
      this.lifecycle.storage.sql.exec(
        `INSERT INTO cf_agents_tool_runs
          (coordinator_id, run_id, owner_json, input_json, status,
           result_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        this.#id,
        runId,
        JSON.stringify(owner),
        inputJSON,
        now,
        now
      );
      this.#pushJob(runId, now);
      return this.#get(runId);
    });
    if (!run) throw new Error(`Failed to persist tool run ${runId}`);
    await this.lifecycle.jobs.rearm();
    return { accepted: true, run };
  }

  async get(runId: string): Promise<DurableToolRun<Input, Result> | undefined> {
    await this.lifecycle.ready();
    return this.#get(runId);
  }

  async result(runId: string): Promise<Result | undefined> {
    const run = await this.get(runId);
    return run?.status === "completed" ? (run.result ?? undefined) : undefined;
  }

  async wait(runId: string, signal?: AbortSignal): Promise<Result> {
    const run = await this.get(runId);
    if (!run) throw new Error(`Unknown tool run ${runId}`);
    if (this.#terminal(run.status)) return this.#outcome(run);
    return new Promise<Result>((resolve, reject) => {
      const waiter = { resolve, reject };
      let waiters = this.#waiters.get(runId);
      if (!waiters) {
        waiters = new Set();
        this.#waiters.set(runId, waiters);
      }
      waiters.add(waiter);
      const abort = () => {
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.#waiters.delete(runId);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  jobs(): LifecycleJob[] {
    return this.lifecycle.jobs.list();
  }

  async cancel(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const run = this.#get(runId);
    if (!run || this.#terminal(run.status)) return false;
    await this.#runtime.cancel(runId, run.owner);
    this.#settle(runId, { status: "cancelled" });
    await this.lifecycle.jobs.cancel(this.#jobId(runId));
    await this.#wake(run.owner);
    return true;
  }

  async cancelByOperation(operationId: string): Promise<number> {
    await this.lifecycle.ready();
    const runs = this.#active().filter(
      (run) =>
        run.owner.operationId === operationId &&
        run.owner.cancellation === "with-parent"
    );
    let cancelled = 0;
    for (const run of runs) {
      if (await this.cancel(run.runId)) cancelled += 1;
    }
    return cancelled;
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== DRIVE_TOOL) return;
    const runId = this.#runId(context.job.payload);
    let run = this.#get(runId);
    if (!run || this.#terminal(run.status)) {
      await this.lifecycle.jobs.cancel(this.#jobId(runId));
      return;
    }
    let inspection = await this.#runtime.inspect(runId, run.owner);
    if (inspection.status === "not-started") {
      await this.#runtime.start(runId, run.input, run.owner);
      this.#markRunning(runId);
      run = this.#get(runId) ?? run;
      inspection = await this.#runtime.inspect(runId, run.owner);
    }
    if (inspection.status === "not-started") {
      const time = Date.now() + this.#heartbeatMs;
      await this.lifecycle.jobs.reschedule(this.#jobId(runId), time);
      return { rescheduleAt: time };
    }
    if (inspection.status === "running") {
      this.#markRunning(runId);
      const time = inspection.notBefore ?? Date.now() + this.#heartbeatMs;
      await this.lifecycle.jobs.reschedule(this.#jobId(runId), time);
      return { rescheduleAt: time };
    }
    this.#settle(runId, inspection);
    await this.lifecycle.jobs.cancel(this.#jobId(runId));
    await this.#wake(run.owner);
  }

  #ensureTable(): void {
    if (this.#ready) return;
    this.lifecycle.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_tool_runs (
        coordinator_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        owner_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
        ),
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (coordinator_id, run_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS cf_agents_tool_runs_operation
        ON cf_agents_tool_runs (coordinator_id, status);
    `);
    this.#ready = true;
  }

  #get(runId: string): DurableToolRun<Input, Result> | undefined {
    this.#ensureTable();
    const row = this.lifecycle.storage.sql
      .exec<ToolRunRow>(
        `SELECT coordinator_id, run_id, owner_json, input_json, status,
                result_json, error_json, created_at, updated_at
         FROM cf_agents_tool_runs
         WHERE coordinator_id = ? AND run_id = ?`,
        this.#id,
        runId
      )
      .toArray()[0];
    return row ? decodeRun<Input, Result>(row) : undefined;
  }

  #active(): DurableToolRun<Input, Result>[] {
    this.#ensureTable();
    return this.lifecycle.storage.sql
      .exec<ToolRunRow>(
        `SELECT coordinator_id, run_id, owner_json, input_json, status,
                result_json, error_json, created_at, updated_at
         FROM cf_agents_tool_runs
         WHERE coordinator_id = ? AND status IN ('pending', 'running')
         ORDER BY created_at ASC`,
        this.#id
      )
      .toArray()
      .map((row) => decodeRun<Input, Result>(row));
  }

  #markRunning(runId: string): void {
    this.#ensureTable();
    this.lifecycle.storage.sql.exec(
      `UPDATE cf_agents_tool_runs
       SET status = 'running', updated_at = ?
       WHERE coordinator_id = ? AND run_id = ?
         AND status IN ('pending', 'running')`,
      Date.now(),
      this.#id,
      runId
    );
  }

  #settle(
    runId: string,
    inspection: Exclude<
      DurableToolInspection<Result>,
      { readonly status: "not-started" | "running" }
    >
  ): void {
    this.#ensureTable();
    this.lifecycle.storage.sql.exec(
      `UPDATE cf_agents_tool_runs
       SET status = ?, result_json = ?, error_json = ?, updated_at = ?
       WHERE coordinator_id = ? AND run_id = ?`,
      inspection.status,
      inspection.status === "completed"
        ? JSON.stringify(inspection.result)
        : null,
      inspection.status === "failed" ? JSON.stringify(inspection.error) : null,
      Date.now(),
      this.#id,
      runId
    );
    const run = this.#get(runId);
    if (run) this.#notify(run);
  }

  #notify(run: DurableToolRun<Input, Result>): void {
    const waiters = this.#waiters.get(run.runId);
    if (!waiters) return;
    this.#waiters.delete(run.runId);
    for (const waiter of waiters) {
      try {
        waiter.resolve(this.#outcome(run));
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  #outcome(run: DurableToolRun<Input, Result>): Result {
    if (run.status === "completed") return run.result as Result;
    if (run.status === "failed") {
      const error = new Error(run.error?.message ?? "Durable tool failed");
      error.name = run.error?.name ?? "Error";
      throw error;
    }
    if (run.status === "cancelled") {
      throw new DOMException("Durable tool was cancelled", "AbortError");
    }
    throw new Error(`Tool run ${run.runId} has not settled`);
  }

  #pushJob(runId: string, time: number): void {
    this.lifecycle.jobs.pushSync({
      id: this.#jobId(runId),
      fn: DRIVE_TOOL,
      time,
      payload: { runId },
      singleflight: true,
      recoveryLoop: true
    });
  }

  #jobId(runId: string): string {
    return `tool:${this.#id.length}:${this.#id}:${runId}`;
  }

  #runId(payload: unknown): string {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("runId" in payload) ||
      typeof payload.runId !== "string"
    ) {
      throw new Error("Invalid durable tool job payload");
    }
    return payload.runId;
  }

  #terminal(status: DurableToolRun<Input, Result>["status"]): boolean {
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }

  #validateOwner(owner: DurableToolOwner): void {
    for (const [name, value] of Object.entries(owner)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${name} must not be empty`);
      }
    }
  }
}
