/**
 * Fibers as Task runs. A fiber is a one-step Task: attempt 1 runs the
 * caller's closure, which lives only in memory (the run's `local`); a later
 * attempt, after the isolate died, has no closure and hands the last
 * checkpoint to the host's recovery hook instead. The closure never runs
 * twice.
 *
 * Plain fibers (`runFiber`) are `__cf_fiber` runs that are deleted when they
 * settle. Managed fibers (`startFiber`) are `__cf_managed_fiber` runs that
 * stay, with their checkpoint, until `deleteFibers()`. A managed fiber whose
 * recovery decided nothing is parked (`interrupted`) until `resolveFiber()`
 * settles it from outside. This module owns no storage: rows, wakes and
 * retries are Tasks'. `importLegacyFibers` carries rows from releases
 * before this forward.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import type {
  DeleteFibersOptions,
  FiberContext,
  FiberInspection,
  FiberLedgerRow,
  FiberRecoveryContext,
  FiberRecoveryResult,
  FiberRunRow,
  FiberStashContext,
  FiberStatus,
  InternalFiberOptions,
  ListFibersOptions,
  StartFiberOptions,
  StartFiberResult
} from "./fiber-types";
import type { LifecycleRouteAddress } from "./lifecycle/capability";
import type { Tasks } from "./tasks/tasks";
import { TaskSettlement } from "./tasks/settlement";
import type {
  TaskFrameworkDefinition,
  TaskJson,
  TaskRecord,
  TaskStatus,
  TaskStep
} from "./tasks/types";

/** @internal Task definition of a plain fiber (`runFiber`). */
export const FIBER_TASK = "__cf_fiber";
/** @internal Task definition of a managed fiber (`startFiber`). */
export const MANAGED_FIBER_TASK = "__cf_managed_fiber";

const SNAPSHOT = "snapshot";
/** Recovery attempts that ended the isolate before the hook returned. */
const CRASHES = "crashes";
/** Consecutive recovery attempts whose hook threw. */
const FAILURES = "failures";
// A plain fiber's recovery that killed the isolate this many times is given
// up on without running the hook again (RUNTIME-FACTS). A managed fiber's
// recovery runs at most once: after one crash it is parked `interrupted`.
const MAX_RECOVERY_CRASHES = 3;
// Ceiling of the retry backoff for a recovery hook that keeps throwing.
const MAX_BACKOFF_MS = 5 * 60_000;
const BACKOFF_MAX_EXP = 20;

type FiberInput = { name: string };

type FiberLocal = {
  fn: (ctx: FiberContext) => Promise<unknown>;
  internal?: InternalFiberOptions;
  /** Resolved when the closure starts. */
  started?: () => void;
  outcome?: { ok: true; value: unknown } | { ok: false; error: unknown };
};

const fiberStash = new AsyncLocalStorage<FiberStashContext>();

/**
 * Run `fn` with `context` as the current fiber for `stashCurrentFiber()`.
 *
 * @internal
 */
export function withFiberStash<T>(
  context: FiberStashContext,
  fn: () => Promise<T>
): Promise<T> {
  return fiberStash.run(context, fn);
}

/**
 * Checkpoint data for the fiber running in the current async context.
 * Throws outside a fiber.
 *
 * @internal
 */
export function stashCurrentFiber(data: unknown): void {
  const context = fiberStash.getStore();
  if (!context) {
    throw new Error("stash() called outside a fiber");
  }
  context.stash(data);
}

/** @internal What fiber runs need from the Agent that hosts them. */
export type FiberHost = {
  readonly tasks: Tasks;
  /** Commit the writes so far (`storage.sync()`). */
  sync(): Promise<void>;
  emit(type: string, payload: Record<string, unknown>): void;
  /** Framework recovery; true when it handled the fiber. */
  handleInternalRecovery(ctx: FiberRecoveryContext): Promise<boolean>;
  /** Whether the host's internal recovery keeps this fiber's crash budget. */
  ownsRecoveryBudget(name: string): boolean;
  onRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult>;
  /** Keep-alive heartbeat of a running fiber, and base of the retry backoff. */
  readonly heartbeatMs: number;
  /** Bound on `handleInternalRecovery`; 0 disables it. */
  readonly recoveryHookTimeoutMs: number;
  /** Age after which a plain fiber whose hook keeps failing is dropped; 0 keeps it. */
  readonly maxAgeMs: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJson(value: unknown): TaskJson {
  // SAFETY: stored with JSON.stringify, as `stash()` always was.
  return value as TaskJson;
}

/** @internal The Task definition of plain and managed fibers. */
export function createFiberTaskDefinition(
  host: FiberHost,
  managed: boolean
): TaskFrameworkDefinition {
  return async (input, step) => {
    const { name } = input as FiberInput;
    const local = step.local as FiberLocal | undefined;
    return local
      ? runBody(host, step, name, managed, local)
      : recover(host, step, name, managed);
  };
}

async function runBody(
  host: FiberHost,
  step: TaskStep,
  name: string,
  managed: boolean,
  local: FiberLocal
): Promise<null | TaskSettlement> {
  const { id, signal } = step;
  const write = (data: unknown) => step.checkpoint.set(SNAPSHOT, toJson(data));
  if (local.internal && "initialSnapshot" in local.internal) {
    write(local.internal.initialSnapshot);
  }
  const wrap = local.internal?.wrapStash;
  const stash = (data: unknown) => write(wrap ? wrap(data) : data);
  const startedAt = Date.now();
  host.emit("fiber:run:started", { fiberId: id, fiberName: name, managed });
  local.started?.();
  try {
    // The run's claim wake, renewed every heartbeat while this runs, keeps
    // the object alive.
    const value = await fiberStash.run({ id, signal, stash }, () =>
      local.fn({ id, signal, stash, snapshot: null })
    );
    local.outcome = { ok: true, value };
    host.emit("fiber:run:completed", {
      fiberId: id,
      fiberName: name,
      managed,
      elapsedMs: Date.now() - startedAt
    });
    return null;
  } catch (error) {
    local.outcome = { ok: false, error };
    host.emit("fiber:run:failed", {
      fiberId: id,
      fiberName: name,
      managed,
      error: errorMessage(error),
      elapsedMs: Date.now() - startedAt
    });
    return signal.aborted
      ? TaskSettlement.aborted(errorMessage(error))
      : TaskSettlement.failed(error);
  }
}

async function recover(
  host: FiberHost,
  step: TaskStep,
  name: string,
  managed: boolean
): Promise<null | TaskSettlement> {
  const { id } = step;
  const record = host.tasks.peek(id);
  const ctx: FiberRecoveryContext = {
    id,
    name,
    snapshot: step.checkpoint.get(SNAPSHOT) ?? null,
    createdAt: step.createdAt,
    recoveryReason: "interrupted"
  };
  if (managed) {
    ctx.idempotencyKey = record?.idempotencyKey;
    ctx.metadata = record?.metadata ?? null;
    ctx.status = "interrupted";
  }
  // A hook that ends the isolate before its first I/O rolls back every
  // write since the last commit (RUNTIME-FACTS), so the attempt is counted
  // and committed before the hook runs, and taken back when it returns or
  // throws. A managed fiber's recovery runs at most once (after that it
  // stays `interrupted`); a plain one is given up on after
  // MAX_RECOVERY_CRASHES; a host-owned one (a legacy chat turn) keeps its
  // own budget.
  const counted = managed || !host.ownsRecoveryBudget(name);
  const crashes = step.checkpoint.get<number>(CRASHES) ?? 0;
  if (managed && crashes >= 1) return TaskSettlement.park();
  const payload = { fiberId: id, fiberName: name, managed };
  const elapsedMs = Date.now() - ctx.createdAt;
  host.emit("fiber:recovery:detected", {
    ...payload,
    recoveryReason: "interrupted",
    elapsedMs
  });
  host.emit("fiber:run:interrupted", {
    ...payload,
    recoveryReason: "interrupted",
    elapsedMs
  });
  if (counted) {
    if (crashes >= MAX_RECOVERY_CRASHES) {
      host.emit("fiber:recovery:skipped", {
        ...payload,
        reason: "recovery_crashed",
        elapsedMs
      });
      return TaskSettlement.aborted("recovery_crashed");
    }
    step.checkpoint.set(CRASHES, crashes + 1);
  }
  await host.sync();

  const startedAt = Date.now();
  host.emit("fiber:recovery:attempt", {
    ...payload,
    recoveryReason: "interrupted"
  });
  let result: void | FiberRecoveryResult = undefined;
  let handled: boolean;
  try {
    handled = await withTimeout(host, ctx, () =>
      host.handleInternalRecovery(ctx)
    );
    if (!handled) result = await host.onRecovered(ctx);
  } catch (error) {
    if (counted) step.checkpoint.set(CRASHES, crashes);
    host.emit("fiber:recovery:failed", {
      ...payload,
      recoveryReason: "interrupted",
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error),
      reason: "handler_error"
    });
    console.error(
      `[Agent] Fiber recovery failed for "${name}" (${id}):`,
      error
    );
    if (managed) return TaskSettlement.failed(error);
    if (host.maxAgeMs > 0 && Date.now() - ctx.createdAt > host.maxAgeMs) {
      host.emit("fiber:recovery:skipped", {
        ...payload,
        reason: "max_age_exceeded",
        elapsedMs: Date.now() - ctx.createdAt
      });
      return TaskSettlement.aborted("max_age_exceeded");
    }
    // Retried later, backing off while it keeps throwing (#1707).
    const failures = (step.checkpoint.get<number>(FAILURES) ?? 0) + 1;
    step.checkpoint.set(FAILURES, failures);
    const exp = Math.min(failures, BACKOFF_MAX_EXP);
    await step.sleep(
      `retry:${failures}`,
      Math.min(MAX_BACKOFF_MS, host.heartbeatMs * 2 ** exp)
    );
    return null;
  }
  host.emit("fiber:recovery:handled", {
    ...payload,
    recoveryReason: "interrupted",
    elapsedMs: Date.now() - startedAt,
    status: handled ? "internal" : managed ? "managed" : "user"
  });
  if (!managed) return null;
  if (counted) step.checkpoint.set(CRASHES, crashes);
  if (!result) return TaskSettlement.park();
  if (result.snapshot !== undefined) {
    step.checkpoint.set(SNAPSHOT, toJson(result.snapshot));
  }
  return settlementOf(host.tasks, id, result);
}

/** What a recovery result settles a managed fiber's run with. */
function settlementOf(
  tasks: Tasks,
  id: string,
  result: FiberRecoveryResult
): null | TaskSettlement {
  switch (result.status) {
    case "completed":
      if (result.metadata !== undefined) {
        const metadata = toJson(result.metadata) as Record<string, TaskJson>;
        tasks.updateMetadata(id, () => metadata);
      }
      return null;
    case "error":
      return TaskSettlement.failed(
        result.error === undefined ? "Fiber failed" : result.error
      );
    case "aborted":
      return TaskSettlement.aborted(result.reason);
    case "interrupted":
      return TaskSettlement.park(result.reason);
  }
}

async function withTimeout<T>(
  host: FiberHost,
  ctx: FiberRecoveryContext,
  operation: () => Promise<T>
): Promise<T> {
  const timeoutMs = host.recoveryHookTimeoutMs;
  if (timeoutMs <= 0) return operation();
  // Bounds the wait, not the work: internal framework recovery is
  // idempotent and safe to abandon mid-flight.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Fiber recovery hook timed out after ${timeoutMs}ms for "${ctx.name}" (${ctx.id})`
            )
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── Running and inspecting fibers ──────────────────────────────────────────

/**
 * @internal Run `fn` as a plain fiber and return its result, or throw what
 * it threw.
 */
export async function runFiber<T>(
  tasks: Tasks,
  name: string,
  fn: (ctx: FiberContext) => Promise<T>,
  internal?: InternalFiberOptions
): Promise<T> {
  const local: FiberLocal = { fn, internal };
  const runId = nanoid();
  try {
    await tasks.run(FIBER_TASK, { name } satisfies FiberInput, {
      runId,
      retain: false,
      start: "now",
      local
    });
  } catch (error) {
    // Accepting failed (its wake could not be written) before the closure
    // ran: the caller gets the throw, so no recovery may run it later.
    if (!local.outcome) await tasks.cancel(runId).catch(() => {});
    throw error;
  }
  const outcome = local.outcome;
  if (!outcome) throw new Error(`Fiber "${name}" did not run`);
  if (!outcome.ok) throw outcome.error;
  // SAFETY: the closure's own result, kept in memory.
  return outcome.value as T;
}

/** @internal Accept a managed fiber, deduplicated by id or idempotency key. */
export async function startFiber(
  tasks: Tasks,
  name: string,
  fn: (ctx: FiberContext) => Promise<void>,
  options: StartFiberOptions = {}
): Promise<StartFiberResult> {
  const { fiberId, idempotencyKey } = options;
  if (fiberId !== undefined && fiberId.trim() === "") {
    throw new Error("fiberId must not be blank");
  }
  if (idempotencyKey !== undefined && idempotencyKey.trim() === "") {
    throw new Error("idempotencyKey must not be blank");
  }
  const byId = fiberId === undefined ? undefined : tasks.peek(fiberId);
  const byKey =
    idempotencyKey === undefined
      ? undefined
      : tasks.peekByIdempotencyKey(idempotencyKey);
  if (byKey && fiberId !== undefined && byKey.runId !== fiberId) {
    throw new Error("fiberId and idempotencyKey refer to different fibers");
  }
  if (byId && byId.definition !== MANAGED_FIBER_TASK) {
    throw new Error(`fiberId "${fiberId}" is not a managed fiber`);
  }
  const existing = byId ?? byKey;
  if (existing) {
    if (options.waitForCompletion && !isFiberTerminal(tasks, existing)) {
      const waited = await waitForFiber(tasks, existing.runId);
      if (!waited) throw new Error(`Fiber ${existing.runId} no longer exists`);
      return { ...waited, accepted: false };
    }
    return { ...inspection(tasks, existing), accepted: false };
  }

  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const local: FiberLocal = { fn, started };
  const runId = fiberId ?? nanoid();
  const run = tasks
    .run(MANAGED_FIBER_TASK, { name } satisfies FiberInput, {
      runId,
      idempotencyKey,
      metadata: options.metadata as Record<string, TaskJson> | undefined,
      start: "now",
      local
    })
    .then((receipt) => {
      if (local.outcome && !local.outcome.ok) {
        console.error(
          `[Agent] Managed fiber "${name}" (${runId}) failed:`,
          local.outcome.error
        );
      }
      return receipt;
    });
  if (options.waitForCompletion) {
    // A cancel settles the run even while a body that ignores its signal
    // still runs.
    await Promise.race([run, tasks.wait(runId)]);
  } else {
    await Promise.race([startedPromise, run]);
    void run.catch(() => {});
  }
  const record = tasks.peek(runId);
  if (!record) throw new Error(`Fiber ${runId} no longer exists`);
  const accepted = inspection(tasks, record);
  if (!options.waitForCompletion && accepted.status === "running") {
    // The fiber as it was accepted, before its closure started.
    accepted.status = "pending";
    delete accepted.startedAt;
  }
  return { ...accepted, accepted: true };
}

/** @internal A managed fiber's inspection, or null. */
export function inspectFiber(
  tasks: Tasks,
  record: TaskRecord | undefined
): FiberInspection | null {
  return record?.definition === MANAGED_FIBER_TASK
    ? inspection(tasks, record)
    : null;
}

const STATUS_TO_TASK: Record<FiberStatus, TaskStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  aborted: "aborted",
  error: "error",
  interrupted: "pending"
};

/** @internal Managed fibers, newest first. An empty status list matches nothing. */
export function listFibers(
  tasks: Tasks,
  options: ListFibersOptions = {}
): FiberInspection[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const statuses = options.status
    ? new Set(Array.isArray(options.status) ? options.status : [options.status])
    : undefined;
  if (statuses?.size === 0) return [];
  return tasks
    .peekList({
      definition: MANAGED_FIBER_TASK,
      status: statuses && [
        ...new Set([...statuses].map((s) => STATUS_TO_TASK[s]))
      ],
      input: options.name === undefined ? undefined : { name: options.name },
      order: "newest",
      limit
    })
    .map((record) => inspection(tasks, record))
    .filter((fiber) => !statuses || statuses.has(fiber.status));
}

/** @internal Abort a pending or running managed fiber. */
export async function cancelFiber(
  tasks: Tasks,
  record: TaskRecord | undefined,
  reason?: string
): Promise<boolean> {
  if (record?.definition !== MANAGED_FIBER_TASK) return false;
  if (isFiberTerminal(tasks, record)) return false;
  return tasks.cancel(record.runId, reason);
}

/** @internal Settle an `interrupted` managed fiber from outside recovery. */
export async function resolveFiber(
  tasks: Tasks,
  fiberId: string,
  result: FiberRecoveryResult
): Promise<boolean> {
  const record = tasks.peek(fiberId);
  if (record?.definition !== MANAGED_FIBER_TASK) return false;
  if (!isParked(record)) return false;
  if (result.status === "interrupted") return false;
  return tasks.settle(
    fiberId,
    settlementOf(tasks, fiberId, result),
    result.snapshot === undefined
      ? {}
      : { checkpoint: { [SNAPSHOT]: toJson(result.snapshot) } }
  );
}

/** @internal Delete settled managed fibers, oldest settled first. */
export async function deleteFibers(
  tasks: Tasks,
  options: DeleteFibersOptions = {}
): Promise<number> {
  const requested = options.status
    ? Array.isArray(options.status)
      ? options.status
      : [options.status]
    : (["completed", "aborted", "error"] as FiberStatus[]);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const settled = [...new Set(requested)].filter(
    (status): status is "completed" | "aborted" | "error" =>
      status === "completed" || status === "aborted" || status === "error"
  );
  let deleted =
    settled.length === 0
      ? 0
      : await tasks.delete({
          definition: MANAGED_FIBER_TASK,
          status: settled,
          settledBefore: options.settledBefore,
          limit
        });
  if (requested.includes("interrupted") && deleted < limit) {
    const before = options.settledBefore?.getTime();
    for (const record of tasks.peekList({
      definition: MANAGED_FIBER_TASK,
      status: ["pending"],
      order: "oldest",
      limit: limit - deleted
    })) {
      if (!isParked(record)) continue;
      if (before !== undefined && record.createdAt >= before) continue;
      if (!(await tasks.settle(record.runId, TaskSettlement.aborted()))) {
        continue;
      }
      if (tasks.deleteRun(record.runId)) deleted++;
    }
  }
  return deleted;
}

function isParked(record: TaskRecord): boolean {
  return record.status === "pending" && record.waitReason === "park";
}

function isFiberTerminal(tasks: Tasks, record: TaskRecord): boolean {
  return isParked(record) || tasks.isSettled(record.runId);
}

function fiberStatus(record: TaskRecord): FiberStatus {
  if (isParked(record)) return "interrupted";
  if (record.status === "skipped") return "aborted";
  return record.status;
}

function inspection(tasks: Tasks, record: TaskRecord): FiberInspection {
  const status = fiberStatus(record);
  const fiber: FiberInspection = {
    fiberId: record.runId,
    name: tasks.inputOf<FiberInput>(record.runId)?.name ?? "",
    status,
    createdAt: record.createdAt
  };
  if (record.idempotencyKey !== undefined) {
    fiber.idempotencyKey = record.idempotencyKey;
  }
  const snapshot = tasks.checkpointOf(record.runId, SNAPSHOT);
  if (snapshot !== undefined) fiber.snapshot = snapshot;
  const error = status === "error" ? record.error?.message : record.reason;
  if (error !== undefined && status !== "completed") fiber.error = error;
  if (record.metadata !== undefined) fiber.metadata = record.metadata;
  if (record.startedAt !== undefined) fiber.startedAt = record.startedAt;
  if (record.settledAt !== undefined) fiber.settledAt = record.settledAt;
  return fiber;
}

/**
 * Wait until a managed fiber is terminal or `interrupted`. Its run may be
 * in this isolate or waiting for its recovery attempt, which may park it
 * instead of settling it, so this re-reads it every second.
 */
async function waitForFiber(
  tasks: Tasks,
  fiberId: string
): Promise<FiberInspection | null> {
  for (;;) {
    const record = tasks.peek(fiberId);
    if (!record) return null;
    if (isFiberTerminal(tasks, record)) return inspection(tasks, record);
    await tasks.runDue(MANAGED_FIBER_TASK);
    await tasks.wait(fiberId, { timeoutMs: 1000 });
  }
}

// ── Rows from releases before fibers ran on Tasks ──────────────────────────

const LEGACY_SCHEMA_KEY = "cf_agents:fibers_schema_version";
const LEGACY_FACET_INDEX = "cf_agents_facet_runs";

/** Which of the old fiber tables exist, in one read of the schema. */
function legacyTables(storage: DurableObjectStorage): Set<string> {
  return new Set(
    storage.sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
          ('cf_agents_runs', 'cf_agents_fibers', '${LEGACY_FACET_INDEX}')`
      )
      .toArray()
      .map((row) => String(row.name))
  );
}

function parseJson(text: string | null): TaskJson | undefined {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as TaskJson;
  } catch {
    return undefined;
  }
}

/**
 * @internal Carry `cf_agents_runs` and `cf_agents_fibers` rows from a
 * release before fibers ran on Tasks into fiber runs, once, then drop both
 * tables and the old capability's wake jobs. An unsettled body comes back
 * interrupted, so its next attempt is its recovery.
 */
export async function importLegacyFibers(
  tasks: Tasks,
  storage: DurableObjectStorage,
  armFacetWake: (address: LifecycleRouteAddress, time: number) => Promise<void>
): Promise<void> {
  const tables = legacyTables(storage);
  if (tables.has(LEGACY_FACET_INDEX)) {
    await moveLegacyFacetWakes(storage, armFacetWake);
  }
  const hasRuns = tables.has("cf_agents_runs");
  const hasLedger = tables.has("cf_agents_fibers");
  if (!hasRuns && !hasLedger) return;
  const runs = hasRuns
    ? (storage.sql
        .exec("SELECT * FROM cf_agents_runs")
        .toArray() as FiberRunRow[])
    : [];
  const ledger = new Map<string, FiberLedgerRow>();
  if (hasLedger) {
    for (const row of storage.sql
      .exec("SELECT * FROM cf_agents_fibers")
      .toArray() as FiberLedgerRow[]) {
      ledger.set(row.fiber_id, row);
    }
  }

  for (const run of runs) {
    const managed = ledger.get(run.id);
    ledger.delete(run.id);
    const snapshot = parseJson(run.snapshot ?? managed?.snapshot ?? null);
    const checkpoint: Record<string, TaskJson> = {};
    if (snapshot !== undefined) checkpoint[SNAPSHOT] = snapshot;
    if (run.recovery_crashes) checkpoint[CRASHES] = run.recovery_crashes;
    // A body that settled and whose cleanup failed (#2305) is not recovered.
    // Rows from releases before these columns existed lack them.
    const completedAt = run.completed_at ?? null;
    const outcome = run.outcome ?? null;
    const settledBody = completedAt !== null && outcome !== null;
    if (!managed) {
      if (completedAt !== null) continue;
      await tasks.importRun({
        runId: run.id,
        definition: FIBER_TASK,
        status: "running",
        attempt: 1,
        input: { name: run.name },
        retain: false,
        checkpoint,
        createdAt: run.created_at
      });
      continue;
    }
    const terminal =
      managed.status !== "pending" && managed.status !== "running";
    await importManaged(tasks, managed, checkpoint, {
      status: terminal
        ? managed.status
        : settledBody
          ? (outcome ?? "completed")
          : "running",
      error: terminal ? managed.error_message : (run.error_message ?? null),
      settledAt: terminal ? managed.completed_at : completedAt
    });
  }
  for (const managed of ledger.values()) {
    const snapshot = parseJson(managed.snapshot);
    const checkpoint: Record<string, TaskJson> =
      snapshot === undefined ? {} : { [SNAPSHOT]: snapshot };
    await importManaged(tasks, managed, checkpoint, {
      status: managed.status,
      error: managed.error_message,
      settledAt: managed.completed_at
    });
  }

  storage.sql.exec("DROP TABLE IF EXISTS cf_agents_runs");
  storage.sql.exec("DROP TABLE IF EXISTS cf_agents_fibers");
  storage.kv.delete(LEGACY_SCHEMA_KEY);
}

/**
 * At a root: the index an older release kept of its facets' fibers moves
 * onto the Lifecycle's facet wake, one wake per facet, due now. The
 * facet's own start carries its rows forward.
 */
async function moveLegacyFacetWakes(
  storage: DurableObjectStorage,
  armFacetWake: (address: LifecycleRouteAddress, time: number) => Promise<void>
): Promise<void> {
  const owners = storage.sql
    .exec(
      `SELECT DISTINCT owner_path, owner_path_key FROM ${LEGACY_FACET_INDEX}`
    )
    .toArray() as { owner_path: string; owner_path_key: string }[];
  for (const owner of owners) {
    await armFacetWake(
      { key: owner.owner_path_key, data: owner.owner_path },
      Date.now()
    );
  }
  storage.sql.exec(`DROP TABLE ${LEGACY_FACET_INDEX}`);
}

async function importManaged(
  tasks: Tasks,
  row: FiberLedgerRow,
  checkpoint: Record<string, TaskJson>,
  state: {
    status: FiberStatus;
    error: string | null;
    settledAt: number | null;
  }
): Promise<void> {
  const interrupted = state.status === "interrupted";
  // A ledger row with no live body (`pending`/`running` and no run row)
  // was interrupted before it ran: its next attempt is its recovery.
  const status: TaskStatus =
    state.status === "interrupted" || state.status === "pending"
      ? "running"
      : state.status;
  // An `interrupted` row already had its one recovery: it stays parked.
  if (interrupted) checkpoint[CRASHES] = 1;
  await tasks.importRun({
    runId: row.fiber_id,
    definition: MANAGED_FIBER_TASK,
    status,
    attempt: 1,
    input: { name: row.name },
    metadata: parseJson(row.metadata_json) as
      | Record<string, TaskJson>
      | undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    error: state.error ?? undefined,
    checkpoint,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    settledAt: state.settledAt ?? undefined
  });
}
