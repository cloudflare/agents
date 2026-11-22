/**
 * Fibers: closures that run once, checkpoint with `stash()`, and hand an
 * interruption to a recovery hook.
 *
 * A fiber's closure lives only in memory. Its durable trace is a run row in
 * `cf_agents_runs`, written when the body starts and deleted when it settles,
 * plus, for managed fibers (`start()`), a ledger row in `cf_agents_fibers`
 * that keeps the id, idempotency key, status, snapshot and metadata until
 * `delete()` removes it. A run row that outlives its isolate is an
 * interruption: the recovery scan hands it to the host's recovery hook with
 * the last snapshot. The body itself never runs again.
 *
 * One Lifecycle job (`recover`) wakes the object for that scan. While a
 * fiber runs in this isolate the job re-arms every `heartbeatMs`, which also
 * keeps the object alive; while orphaned rows remain and a scan made no
 * progress it backs off. On a facet the job is mirrored on the root, which
 * owns the physical alarm, and its dispatch routes back here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type LifecycleRouteAddress,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { SqlError } from "../sql-error";
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
} from "./types";

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

/** @internal */
export type FibersOptions = {
  /**
   * Framework recovery for its own fibers. Returns true when it handled the
   * fiber, so the user hook is skipped. Bounded by `recoveryHookTimeoutMs`.
   */
  handleInternalRecovery: (ctx: FiberRecoveryContext) => Promise<boolean>;
  /** The user's recovery hook; a result settles a managed ledger row. */
  onRecovered: (
    ctx: FiberRecoveryContext
  ) => Promise<void | FiberRecoveryResult>;
  /** Wake interval while a fiber runs, and the base of the recovery backoff. */
  heartbeatMs: number;
  /** Bound on `handleInternalRecovery`; 0 disables it. */
  recoveryHookTimeoutMs: number;
  /** Time budget of one recovery scan; 0 disables it. */
  scanDeadlineMs: number;
  /** Age after which an unmanaged row whose hook keeps failing is dropped; 0 keeps it. */
  maxAgeMs: number;
};

const SCHEMA_VERSION_KEY = "cf_agents:fibers_schema_version";
const CURRENT_SCHEMA_VERSION = 1;

const WAKE_JOB_ID = "fibers:recover";
const WAKE_JOB_FN = "recover";
const MIRROR_JOB_PREFIX = "fibers:recover:";
// The root-side index of facet fibers before the wake was routed.
const LEGACY_FACET_INDEX_TABLE = "cf_agents_facet_runs";

// Ceiling for the recovery backoff. A scan that makes no progress (every
// orphan's recovery hook threw) while work is still pending backs off, so a
// poison fiber does not wake the object every heartbeat forever (#1707). A
// scan that made progress resets it.
const MAX_BACKOFF_MS = 5 * 60_000;
// Keeps `heartbeatMs * 2 ** n` finite before the clamp applies.
const BACKOFF_MAX_EXP = 20;

const LEDGER_COLUMNS = `fiber_id, idempotency_key, name, status, snapshot,
  metadata_json, error_message, created_at, started_at, completed_at`;

type MirrorJobPayload = {
  readonly owner_path: string;
  readonly owner_path_key: string;
};

type FibersRouteMessage =
  | { readonly type: "syncWake"; readonly next: number | null }
  | { readonly type: "recover" };

type SqlValue = string | number | boolean | null;

function isMirrorJobPayload(value: unknown): value is MirrorJobPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MirrorJobPayload).owner_path === "string" &&
    typeof (value as MirrorJobPayload).owner_path_key === "string"
  );
}

function isTerminal(status: FiberStatus): boolean {
  return (
    status === "completed" ||
    status === "aborted" ||
    status === "interrupted" ||
    status === "error"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid metadata should not prevent inspection.
  }
  return null;
}

function parseSnapshot(value: string | null): unknown | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stringifySnapshot(snapshot: unknown): string | null {
  return snapshot === undefined ? null : JSON.stringify(snapshot);
}

function recoveryErrorMessage(result: FiberRecoveryResult): string | null {
  if (result.status === "error") {
    return result.error === undefined ? null : errorMessage(result.error);
  }
  if (result.status === "aborted" || result.status === "interrupted") {
    return result.reason ?? null;
  }
  return null;
}

function inspectionFromRow(row: FiberLedgerRow): FiberInspection {
  const snapshot = parseSnapshot(row.snapshot);
  const inspection: FiberInspection = {
    fiberId: row.fiber_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at
  };
  if (row.idempotency_key !== null) {
    inspection.idempotencyKey = row.idempotency_key;
  }
  if (snapshot !== undefined) inspection.snapshot = snapshot;
  if (row.error_message !== null) inspection.error = row.error_message;
  const metadata = parseJsonObject(row.metadata_json);
  if (metadata !== null) inspection.metadata = metadata;
  if (row.started_at !== null) inspection.startedAt = row.started_at;
  if (row.completed_at !== null) inspection.settledAt = row.completed_at;
  return inspection;
}

/** @internal */
export class Fibers extends LifecycleCapability {
  readonly #options: FibersOptions;
  #tablesReady = false;

  /** Fiber ids whose bodies run in this isolate. */
  readonly #active = new Set<string>();
  readonly #abortControllers = new Map<string, AbortController>();
  /** Accepted managed executions, for callers that wait on them. */
  readonly #executions = new Map<string, Promise<void>>();
  readonly #terminalWaiters = new Map<string, Set<() => void>>();
  #scanning: Promise<void> | undefined;
  /** Consecutive scans that made no progress while work was pending. */
  #noProgressScans = 0;
  /**
   * The wake this isolate last armed. A facet reads it instead of the
   * root's mirror, so it can skip routing a no-op.
   */
  #armedAt: number | null = null;

  constructor(options: FibersOptions) {
    super("fibers");
    this.#options = options;
  }

  // ── Running fibers ───────────────────────────────────────────────────────

  /**
   * Run `fn` as a fiber and return its result. `internal` is for framework
   * hosts that compose their own recovery data with user checkpoints.
   */
  run<T>(
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    internal?: Pick<InternalFiberOptions, "initialSnapshot" | "wrapStash">
  ): Promise<T> {
    return this.#run(nanoid(), name, fn, internal);
  }

  /** Accept a managed fiber, deduplicated by id or idempotency key. */
  async start(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult> {
    const fiberId = options?.fiberId ?? nanoid();
    const idempotencyKey = options?.idempotencyKey;
    if (options?.fiberId !== undefined && options.fiberId.trim() === "") {
      throw new Error("fiberId must not be blank");
    }
    if (
      options?.idempotencyKey !== undefined &&
      options.idempotencyKey.trim() === ""
    ) {
      throw new Error("idempotencyKey must not be blank");
    }
    const existingById = this.#readFiber(fiberId);
    const existingByKey = idempotencyKey
      ? this.#readFiberByKey(idempotencyKey)
      : null;

    if (
      existingById &&
      existingByKey &&
      existingById.fiber_id !== existingByKey.fiber_id
    ) {
      throw new Error("fiberId and idempotencyKey refer to different fibers");
    }
    if (
      existingByKey &&
      options?.fiberId &&
      existingByKey.fiber_id !== fiberId
    ) {
      throw new Error("fiberId and idempotencyKey refer to different fibers");
    }

    const existing = existingById ?? existingByKey;
    if (existing) {
      if (options?.waitForCompletion && !isTerminal(existing.status)) {
        const waited = await this.#waitForManaged(existing.fiber_id);
        if (waited) return { ...waited, accepted: false };
        throw new Error(`Fiber ${existing.fiber_id} no longer exists`);
      }
      return { ...inspectionFromRow(existing), accepted: false };
    }

    this.#sql`
      INSERT INTO cf_agents_fibers
        (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
         error_message, created_at, started_at, completed_at)
      VALUES
        (${fiberId}, ${idempotencyKey ?? null}, ${name}, 'pending', NULL,
         ${options?.metadata ? JSON.stringify(options.metadata) : null}, NULL,
         ${Date.now()}, NULL, NULL)
    `;

    const row = this.#readFiber(fiberId);
    if (!row) {
      throw new Error(`Failed to create fiber ${fiberId}`);
    }

    const execution = this.#executeManaged(fiberId, name, fn)
      .catch((error) => {
        console.error(
          `[Agent] Managed fiber "${name}" (${fiberId}) failed:`,
          error
        );
      })
      .finally(() => {
        if (this.#executions.get(fiberId) === execution) {
          this.#executions.delete(fiberId);
        }
      });
    this.#executions.set(fiberId, execution);

    if (options?.waitForCompletion) {
      const completed = await this.#waitForManaged(fiberId);
      if (!completed) {
        throw new Error(`Fiber ${fiberId} no longer exists`);
      }
      return { ...completed, accepted: true };
    }

    return { ...inspectionFromRow(row), accepted: true };
  }

  async #executeManaged(
    fiberId: string,
    name: string,
    fn: (ctx: FiberContext) => Promise<void>
  ): Promise<void> {
    const row = this.#readFiber(fiberId);
    if (!row || row.status !== "pending") return;

    const controller = new AbortController();
    this.#abortControllers.set(fiberId, controller);
    this.#sql`
      UPDATE cf_agents_fibers
      SET status = 'running', started_at = ${Date.now()}
      WHERE fiber_id = ${fiberId} AND status = 'pending'
    `;

    const updated = this.#readFiber(fiberId);
    if (!updated || updated.status !== "running") {
      this.#abortControllers.delete(fiberId);
      return;
    }

    let settled = false;
    try {
      await this.#run(fiberId, name, fn, {
        signal: controller.signal,
        managed: true,
        beforeRunCleanup: (outcome) => {
          settled = true;
          this.#settleManaged(fiberId, outcome, controller.signal);
        }
      });
    } catch (error) {
      if (!settled) {
        this.#settleManaged(fiberId, { ok: false, error }, controller.signal);
      }
    } finally {
      this.#abortControllers.delete(fiberId);
    }
  }

  async #run<T>(
    id: string,
    name: string,
    fn: (ctx: FiberContext) => Promise<T>,
    options?: InternalFiberOptions
  ): Promise<T> {
    const signal = options?.signal ?? new AbortController().signal;
    const managed = options?.managed === true;
    this.#sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${id}, ${name}, NULL, ${Date.now()})
    `;
    const startedAt = Date.now();
    this.#emit("fiber:run:started", { fiberId: id, fiberName: name, managed });
    this.#active.add(id);

    const writeSnapshot = (data: unknown) => {
      const snapshot = JSON.stringify(data);
      this.#sql`UPDATE cf_agents_runs SET snapshot = ${snapshot} WHERE id = ${id}`;
      if (managed) {
        this.#sql`
          UPDATE cf_agents_fibers SET snapshot = ${snapshot}
          WHERE fiber_id = ${id}
        `;
      }
    };

    let bodyOutcome:
      | { status: "completed" | "error" | "aborted"; error: string | null }
      | undefined;
    try {
      if (options && "initialSnapshot" in options) {
        writeSnapshot(options.initialSnapshot);
      }

      // The wake doubles as this fiber's keep-alive heartbeat.
      await this.#syncWake();
      const stash = (data: unknown) => {
        writeSnapshot(options?.wrapStash ? options.wrapStash(data) : data);
      };

      try {
        let result: T;
        try {
          result = await fiberStash.run({ id, signal, stash }, () =>
            fn({ id, signal, stash, snapshot: null })
          );
        } catch (error) {
          bodyOutcome = {
            status: signal.aborted ? "aborted" : "error",
            error: errorMessage(error)
          };
          throw error;
        }
        bodyOutcome = { status: "completed", error: null };
        options?.beforeRunCleanup?.({ ok: true });
        this.#emit("fiber:run:completed", {
          fiberId: id,
          fiberName: name,
          managed,
          elapsedMs: Date.now() - startedAt
        });
        return result;
      } catch (error) {
        options?.beforeRunCleanup?.({ ok: false, error });
        this.#emit("fiber:run:failed", {
          fiberId: id,
          fiberName: name,
          managed,
          error: errorMessage(error),
          elapsedMs: Date.now() - startedAt
        });
        throw error;
      }
    } finally {
      this.#active.delete(id);
      try {
        if (bodyOutcome) {
          try {
            this.#sql`
              UPDATE cf_agents_runs
              SET completed_at = ${Date.now()},
                  outcome = ${bodyOutcome.status},
                  error_message = ${bodyOutcome.error}
              WHERE id = ${id}
            `;
          } catch {
            // The delete below is still worth attempting.
          }
        }
        this.#sql`DELETE FROM cf_agents_runs WHERE id = ${id}`;
      } catch (error) {
        console.error(
          `[Agent] Failed to finalize fiber "${name}" (${id}); leaving run row for recovery:`,
          error
        );
      }
      try {
        await this.#syncWake();
      } catch (error) {
        console.error("[Agent] Failed to update the fiber wake:", error);
      }
    }
  }

  /** Checkpoint data for the fiber running in the current async context. */
  stash(data: unknown): void {
    stashCurrentFiber(data);
  }

  // ── Inspection and control ───────────────────────────────────────────────

  inspect(fiberId: string): FiberInspection | null {
    const row = this.#readFiber(fiberId);
    return row ? inspectionFromRow(row) : null;
  }

  inspectByKey(idempotencyKey: string): FiberInspection | null {
    const row = this.#readFiberByKey(idempotencyKey);
    return row ? inspectionFromRow(row) : null;
  }

  list(options?: ListFibersOptions): FiberInspection[] {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const statuses = options?.status
      ? [
          ...new Set(
            Array.isArray(options.status) ? options.status : [options.status]
          )
        ]
      : [];
    let query = `SELECT ${LEDGER_COLUMNS} FROM cf_agents_fibers WHERE 1 = 1`;
    const params: SqlValue[] = [];
    if (statuses.length > 0) {
      query += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
      params.push(...statuses);
    }
    if (options?.name) {
      query += " AND name = ?";
      params.push(options.name);
    }
    query += " ORDER BY created_at DESC, fiber_id DESC LIMIT ?";
    params.push(limit);
    return this.#query<FiberLedgerRow>(query, params).map(inspectionFromRow);
  }

  /** Abort a pending or running managed fiber. False when already terminal. */
  cancel(fiberId: string, reason?: string): boolean {
    const row = this.#readFiber(fiberId);
    if (!row || isTerminal(row.status)) return false;

    this.#sql`
      UPDATE cf_agents_fibers
      SET status = 'aborted',
          error_message = ${reason ?? null},
          completed_at = ${Date.now()}
      WHERE fiber_id = ${fiberId}
        AND status IN ('pending', 'running')
    `;
    this.#abortControllers.get(fiberId)?.abort(reason);
    this.#notifyTerminal(fiberId);
    return true;
  }

  cancelByKey(idempotencyKey: string, reason?: string): boolean {
    const row = this.#readFiberByKey(idempotencyKey);
    return row ? this.cancel(row.fiber_id, reason) : false;
  }

  /** Settle an `interrupted` managed fiber from outside recovery. */
  resolve(fiberId: string, result: FiberRecoveryResult): boolean {
    const row = this.#readFiber(fiberId);
    if (!row || row.status !== "interrupted") return false;
    this.#applyRecoveryResult(fiberId, result);
    return true;
  }

  /** Delete settled managed fibers, oldest settled first. */
  delete(options?: DeleteFibersOptions): number {
    const requested = options?.status
      ? Array.isArray(options.status)
        ? options.status
        : [options.status]
      : (["completed", "aborted", "error"] as FiberStatus[]);
    const statuses = [...new Set(requested)].filter(isTerminal);
    if (statuses.length === 0) return 0;

    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    let query = `SELECT fiber_id FROM cf_agents_fibers
      WHERE status IN (${statuses.map(() => "?").join(", ")})`;
    const params: SqlValue[] = [...statuses];
    const settledBefore = options?.settledBefore?.getTime();
    if (settledBefore !== undefined) {
      query += " AND completed_at IS NOT NULL AND completed_at < ?";
      params.push(settledBefore);
    }
    query += " ORDER BY completed_at ASC, created_at ASC LIMIT ?";
    params.push(limit);

    const rows = this.#query<{ fiber_id: string }>(query, params);
    for (const row of rows) {
      this.#sql`
        DELETE FROM cf_agents_fibers
        WHERE fiber_id = ${row.fiber_id}
          AND status IN ('completed', 'aborted', 'interrupted', 'error')
      `;
    }
    return rows.length;
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  /**
   * Hand every fiber left by a dead isolate to the recovery hook, then
   * re-arm the wake. Hosts call this during startup, before user code runs.
   */
  async recover(): Promise<void> {
    await this.#scan();
    await this.#syncWake();
  }

  /** One recovery pass; a caller during a pass joins it. */
  #scan(): Promise<void> {
    this.#scanning ??= this.#runScan().finally(() => {
      this.#scanning = undefined;
    });
    return this.#scanning;
  }

  async #runScan(): Promise<void> {
    const scanStartedAt = Date.now();
    const { scanDeadlineMs, maxAgeMs } = this.#options;
    const pastDeadline = () =>
      scanDeadlineMs > 0 && Date.now() - scanStartedAt > scanDeadlineMs;
    // Progress: at least one fiber resolved. Drives the wake backoff.
    let madeProgress = false;

    try {
      const rows = this.#sql<FiberRunRow>`
        SELECT id, name, snapshot, created_at, completed_at, outcome,
               error_message
        FROM cf_agents_runs
      `;

      for (const row of rows) {
        if (pastDeadline()) {
          this.#emit("fiber:recovery:skipped", {
            fiberId: row.id,
            fiberName: row.name,
            reason: "scan_deadline_exceeded",
            elapsedMs: Date.now() - scanStartedAt
          });
          break;
        }
        if (this.#active.has(row.id)) continue;

        const managedRow = this.#readFiber(row.id);
        // A managed row needs the recorded outcome; without it the ledger
        // can't be settled truthfully, so it falls through to recovery.
        if (
          row.completed_at !== null &&
          (!managedRow || row.outcome !== null)
        ) {
          // The body settled and only its cleanup failed: nothing to recover.
          // A managed ledger still non-terminal here means its settle write
          // failed too, so record the body's own outcome.
          if (managedRow) {
            this.#sql`
              UPDATE cf_agents_fibers
              SET status = ${row.outcome},
                  error_message = ${row.error_message},
                  completed_at = ${row.completed_at}
              WHERE fiber_id = ${row.id}
                AND status IN ('pending', 'running')
            `;
          }
          this.#sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
          madeProgress = true;
          if (managedRow) this.#notifyTerminal(row.id);
          continue;
        }
        if (managedRow && isTerminal(managedRow.status)) {
          this.#sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
          madeProgress = true;
          this.#notifyTerminal(row.id);
          continue;
        }

        const ctx: FiberRecoveryContext = {
          id: row.id,
          name: row.name,
          snapshot: this.#parseRecoverySnapshot(row.id, row.snapshot),
          createdAt: row.created_at,
          recoveryReason: "interrupted"
        };
        this.#emitDetected(ctx, managedRow);
        if (managedRow) {
          this.#sql`
            UPDATE cf_agents_fibers
            SET status = 'interrupted',
                snapshot = ${row.snapshot},
                completed_at = ${Date.now()}
            WHERE fiber_id = ${row.id}
              AND status IN ('pending', 'running')
          `;
          ctx.idempotencyKey = managedRow.idempotency_key ?? undefined;
          ctx.metadata = parseJsonObject(managedRow.metadata_json);
          ctx.status = "interrupted";
        }

        const recovered = await this.#runRecoveryHook(ctx, managedRow);
        // Managed rows are always cleaned up (the ledger keeps the terminal
        // status). Unmanaged rows stay when recovery fails so a later scan
        // retries, until they exceed the max age.
        const tooOld = maxAgeMs > 0 && Date.now() - row.created_at > maxAgeMs;
        if (recovered || managedRow || tooOld) {
          if (!recovered && !managedRow && tooOld) {
            this.#emit("fiber:recovery:skipped", {
              fiberId: row.id,
              fiberName: row.name,
              reason: "max_age_exceeded",
              elapsedMs: Date.now() - row.created_at
            });
          }
          this.#sql`DELETE FROM cf_agents_runs WHERE id = ${row.id}`;
          madeProgress = true;
        }
        if (managedRow) this.#notifyTerminal(row.id);
      }

      // Managed fibers accepted but never started (or whose run row is gone).
      const ledgerOnlyRows = this.#sql<FiberLedgerRow>`
        SELECT f.fiber_id, f.idempotency_key, f.name, f.status, f.snapshot,
               f.metadata_json, f.error_message, f.created_at, f.started_at,
               f.completed_at
        FROM cf_agents_fibers f
        LEFT JOIN cf_agents_runs r ON r.id = f.fiber_id
        WHERE f.status IN ('pending', 'running')
          AND r.id IS NULL
      `;

      for (const row of ledgerOnlyRows) {
        if (pastDeadline()) {
          this.#emit("fiber:recovery:skipped", {
            fiberId: row.fiber_id,
            fiberName: row.name,
            reason: "scan_deadline_exceeded",
            elapsedMs: Date.now() - scanStartedAt,
            managed: true
          });
          break;
        }
        if (this.#active.has(row.fiber_id)) continue;

        this.#sql`
          UPDATE cf_agents_fibers
          SET status = 'interrupted',
              completed_at = ${Date.now()}
          WHERE fiber_id = ${row.fiber_id}
            AND status IN ('pending', 'running')
        `;
        const ctx: FiberRecoveryContext = {
          id: row.fiber_id,
          name: row.name,
          snapshot: this.#parseRecoverySnapshot(row.fiber_id, row.snapshot),
          createdAt: row.created_at,
          idempotencyKey: row.idempotency_key ?? undefined,
          metadata: parseJsonObject(row.metadata_json),
          status: "interrupted",
          recoveryReason: "interrupted"
        };
        this.#emitDetected(ctx, row);

        await this.#runRecoveryHook(ctx, row);
        // Finalized this pass whatever the hook did: that is progress.
        madeProgress = true;
        this.#notifyTerminal(row.fiber_id);
      }
    } finally {
      if (madeProgress) {
        this.#noProgressScans = 0;
      } else {
        this.#noProgressScans = this.#hasPendingRecovery()
          ? this.#noProgressScans + 1
          : 0;
      }
    }
  }

  /** Scan, then the wake this object needs next. */
  async #scanForWake(): Promise<number | null> {
    await this.#scan();
    const next = this.#nextWakeMs(Date.now());
    this.#armedAt = next;
    return next;
  }

  #emitDetected(ctx: FiberRecoveryContext, managedRow: FiberLedgerRow | null) {
    const elapsedMs = Date.now() - ctx.createdAt;
    this.#emit("fiber:recovery:detected", {
      ...this.#recoveryPayload(ctx, managedRow),
      elapsedMs
    });
    this.#emit("fiber:run:interrupted", {
      fiberId: ctx.id,
      fiberName: ctx.name,
      managed: managedRow !== null,
      recoveryReason: "interrupted",
      elapsedMs
    });
  }

  async #runRecoveryHook(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null
  ): Promise<boolean> {
    const startedAt = Date.now();
    this.#emit(
      "fiber:recovery:attempt",
      this.#recoveryPayload(ctx, managedRow)
    );
    try {
      const handled = await this.#withRecoveryTimeout(ctx, () =>
        this.#inHost(() => this.#options.handleInternalRecovery(ctx))
      );
      if (!handled) {
        const result = await this.#inHost(() => this.#options.onRecovered(ctx));
        if (managedRow && result) {
          this.#applyRecoveryResult(ctx.id, result);
        }
      }
      this.#emit("fiber:recovery:handled", {
        ...this.#recoveryPayload(ctx, managedRow, startedAt),
        status: handled ? "internal" : managedRow ? "managed" : "user"
      });
      return true;
    } catch (error) {
      const message = errorMessage(error);
      if (managedRow) {
        this.#sql`
          UPDATE cf_agents_fibers
          SET status = 'error',
              error_message = ${message},
              completed_at = ${Date.now()}
          WHERE fiber_id = ${ctx.id}
            AND status = 'interrupted'
        `;
        this.#notifyTerminal(ctx.id);
      }
      this.#emit("fiber:recovery:failed", {
        ...this.#recoveryPayload(ctx, managedRow, startedAt),
        error: message,
        reason: "handler_error"
      });
      console.error(
        `[Agent] Fiber recovery failed for "${ctx.name}" (${ctx.id}):`,
        error
      );
      return false;
    }
  }

  /** Run a host callback inside the host invocation context. */
  async #inHost<T>(fn: () => Promise<T>): Promise<T> {
    return (await this.lifecycle.runInHostContext(fn)) as T;
  }

  async #withRecoveryTimeout<T>(
    ctx: FiberRecoveryContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const timeoutMs = this.#options.recoveryHookTimeoutMs;
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

  #recoveryPayload(
    ctx: FiberRecoveryContext,
    managedRow: FiberLedgerRow | null,
    startedAt?: number
  ): Record<string, unknown> {
    return {
      fiberId: ctx.id,
      fiberName: ctx.name,
      managed: managedRow !== null,
      recoveryReason: ctx.recoveryReason,
      elapsedMs: startedAt === undefined ? undefined : Date.now() - startedAt
    };
  }

  #parseRecoverySnapshot(fiberId: string, text: string | null): unknown | null {
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      console.warn(
        `[Agent] Corrupted snapshot for fiber ${fiberId}, treating as null`
      );
      return null;
    }
  }

  /**
   * Whether recovery work is outstanding: run rows not executing here, or
   * managed fibers stuck non-terminal with no run row.
   */
  #hasPendingRecovery(): boolean {
    for (const row of this.#sql<{
      id: string;
    }>`SELECT id FROM cf_agents_runs`) {
      if (!this.#active.has(row.id)) return true;
    }
    const ledgerOnly = this.#sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM cf_agents_fibers f
      LEFT JOIN cf_agents_runs r ON r.id = f.fiber_id
      WHERE f.status IN ('pending', 'running')
        AND r.id IS NULL
    `;
    return (ledgerOnly[0]?.count ?? 0) > 0;
  }

  // ── Managed ledger ───────────────────────────────────────────────────────

  #settleManaged(
    fiberId: string,
    outcome: { ok: true } | { ok: false; error: unknown },
    signal: AbortSignal
  ): void {
    const completedAt = Date.now();
    if (outcome.ok) {
      this.#sql`
        UPDATE cf_agents_fibers
        SET status = 'completed', completed_at = ${completedAt}
        WHERE fiber_id = ${fiberId} AND status = 'running'
      `;
    } else {
      const status: FiberStatus = signal.aborted ? "aborted" : "error";
      this.#sql`
        UPDATE cf_agents_fibers
        SET status = ${status},
            error_message = ${errorMessage(outcome.error)},
            completed_at = ${completedAt}
        WHERE fiber_id = ${fiberId} AND status = 'running'
      `;
    }
    this.#notifyTerminal(fiberId);
  }

  #applyRecoveryResult(fiberId: string, result: FiberRecoveryResult): void {
    const snapshot = stringifySnapshot(result.snapshot);
    const message = recoveryErrorMessage(result);
    const metadata =
      result.status === "completed" && result.metadata !== undefined
        ? JSON.stringify(result.metadata)
        : null;
    this.#sql`
      UPDATE cf_agents_fibers
      SET status = ${result.status},
          snapshot = COALESCE(${snapshot}, snapshot),
          metadata_json = COALESCE(${metadata}, metadata_json),
          error_message = ${message},
          completed_at = ${Date.now()}
      WHERE fiber_id = ${fiberId}
        AND status = 'interrupted'
    `;
    this.#notifyTerminal(fiberId);
  }

  #notifyTerminal(fiberId: string): void {
    const row = this.#readFiber(fiberId);
    if (row && !isTerminal(row.status)) return;
    const waiters = this.#terminalWaiters.get(fiberId);
    if (!waiters) return;
    this.#terminalWaiters.delete(fiberId);
    for (const resolve of waiters) resolve();
  }

  #waitForTerminal(fiberId: string): Promise<void> {
    const row = this.#readFiber(fiberId);
    if (!row || isTerminal(row.status)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let waiters = this.#terminalWaiters.get(fiberId);
      if (!waiters) {
        waiters = new Set();
        this.#terminalWaiters.set(fiberId, waiters);
      }
      waiters.add(resolve);
    });
  }

  async #waitForManaged(fiberId: string): Promise<FiberInspection | null> {
    const row = this.#readFiber(fiberId);
    if (!row || isTerminal(row.status)) {
      return row ? inspectionFromRow(row) : null;
    }
    // Not running here: a dead isolate left it, so recover it first.
    if (!this.#executions.has(fiberId)) await this.recover();
    await this.#waitForTerminal(fiberId);
    return this.inspect(fiberId);
  }

  #readFiber(fiberId: string): FiberLedgerRow | null {
    return (
      this.#query<FiberLedgerRow>(
        `SELECT ${LEDGER_COLUMNS} FROM cf_agents_fibers WHERE fiber_id = ? LIMIT 1`,
        [fiberId]
      )[0] ?? null
    );
  }

  #readFiberByKey(idempotencyKey: string): FiberLedgerRow | null {
    return (
      this.#query<FiberLedgerRow>(
        `SELECT ${LEDGER_COLUMNS} FROM cf_agents_fibers WHERE idempotency_key = ? LIMIT 1`,
        [idempotencyKey]
      )[0] ?? null
    );
  }

  // ── The wake ─────────────────────────────────────────────────────────────

  /**
   * When this object next needs a recovery wake, or null. A running fiber
   * needs a heartbeat; orphaned rows need a scan now, or after a backoff
   * that doubles with each scan that made no progress.
   */
  #nextWakeMs(now: number): number | null {
    const { heartbeatMs } = this.#options;
    if (this.#active.size > 0) return now + heartbeatMs;
    if (!this.#hasPendingRecovery()) return null;
    if (this.#noProgressScans === 0) return now;
    const exp = Math.min(this.#noProgressScans, BACKOFF_MAX_EXP);
    return now + Math.min(MAX_BACKOFF_MS, heartbeatMs * 2 ** exp);
  }

  /** Push, re-time, or cancel this object's wake (mirrored on the root for a facet). */
  async #syncWake(): Promise<void> {
    const now = Date.now();
    const next = this.#nextWakeMs(now);
    const armed = this.lifecycle.routes.source
      ? this.#armedAt
      : (this.lifecycle.jobs.get(WAKE_JOB_ID)?.time ?? null);
    // A running fiber only needs some wake within a heartbeat.
    if (
      this.#active.size > 0 &&
      next !== null &&
      armed !== null &&
      armed > now &&
      armed <= next
    ) {
      return;
    }
    if (next === null && armed === null) return;
    this.#armedAt = next;
    if (this.lifecycle.routes.source) {
      await this.lifecycle.routes.toRoot({
        type: "syncWake",
        next
      } satisfies FibersRouteMessage);
      return;
    }
    if (next === null) {
      await this.lifecycle.jobs.cancel(WAKE_JOB_ID);
      return;
    }
    await this.lifecycle.jobs.push({
      id: WAKE_JOB_ID,
      fn: WAKE_JOB_FN,
      time: next
    });
  }

  async #pushMirror(owner: LifecycleRouteAddress, time: number): Promise<void> {
    await this.lifecycle.jobs.push({
      id: `${MIRROR_JOB_PREFIX}${owner.key}`,
      fn: WAKE_JOB_FN,
      time,
      payload: {
        owner_path: owner.data,
        owner_path_key: owner.key
      } satisfies MirrorJobPayload
    });
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Move the root's old facet fiber index onto mirrored wakes. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const hasLegacyIndex =
      storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          LEGACY_FACET_INDEX_TABLE
        )
        .toArray().length > 0;
    if (!hasLegacyIndex) return;
    const owners = storage.sql
      .exec(
        `SELECT DISTINCT owner_path, owner_path_key FROM ${LEGACY_FACET_INDEX_TABLE}`
      )
      .toArray() as MirrorJobPayload[];
    for (const owner of owners) {
      await this.#pushMirror(
        { key: owner.owner_path_key, data: owner.owner_path },
        Date.now()
      );
    }
    storage.sql.exec(`DROP TABLE ${LEGACY_FACET_INDEX_TABLE}`);
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const payload = context.job.payload;
    if (isMirrorJobPayload(payload)) {
      // The fibers live on a facet; its scan runs there.
      try {
        const outcome = await this.lifecycle.routes.to(
          { key: payload.owner_path_key, data: payload.owner_path },
          { type: "recover" } satisfies FibersRouteMessage
        );
        // `false`: the facet is gone and the route cleaned up after it.
        if (outcome === false || outcome === null) return undefined;
        return typeof outcome === "number"
          ? { rescheduleAt: outcome }
          : undefined;
      } catch (error) {
        // Keep the wake so a transient failure (a facet init error) retries.
        console.error(
          `[Agent] Facet fiber recovery failed for ${payload.owner_path_key}:`,
          error
        );
        return { rescheduleAt: Date.now() + this.#options.heartbeatMs };
      }
    }
    const next = await this.#scanForWake();
    return next === null ? undefined : { rescheduleAt: next };
  }

  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as FibersRouteMessage;
    switch (message.type) {
      case "syncWake": {
        const owner = context.source;
        if (!owner) throw new Error("Routed Fibers message missing source");
        if (message.next === null) {
          await this.lifecycle.jobs.cancel(`${MIRROR_JOB_PREFIX}${owner.key}`);
        } else {
          await this.#pushMirror(owner, message.next);
        }
        return true;
      }
      case "recover":
        return this.#scanForWake();
      default:
        throw new Error("Unknown routed Fibers message");
    }
  }

  /**
   * @internal Cancel this root's mirrored wakes for a deleted facet subtree.
   * The facets' fiber rows are wiped with their storage.
   */
  async __DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
    prefix: string
  ): Promise<void> {
    for (const job of this.lifecycle.jobs.list()) {
      if (!isMirrorJobPayload(job.payload)) continue;
      const key = job.payload.owner_path_key;
      if (key !== prefix && !key.startsWith(`${prefix}/`)) continue;
      await this.lifecycle.jobs.cancel(job.id);
    }
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #ensureTables(): void {
    if (this.#tablesReady) return;
    const storage = this.lifecycle.storage;
    const version = storage.kv.get<number>(SCHEMA_VERSION_KEY) ?? 0;
    if (version < CURRENT_SCHEMA_VERSION) {
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS cf_agents_runs (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          snapshot TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          outcome TEXT,
          error_message TEXT
        )
      `);
      // Tables from before these columns existed.
      for (const column of [
        "completed_at INTEGER",
        "outcome TEXT",
        "error_message TEXT"
      ]) {
        try {
          storage.sql.exec(`ALTER TABLE cf_agents_runs ADD COLUMN ${column}`);
        } catch (error) {
          if (!errorMessage(error).toLowerCase().includes("duplicate column")) {
            throw error;
          }
        }
      }
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS cf_agents_fibers (
          fiber_id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          snapshot TEXT,
          metadata_json TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        )
      `);
      storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_fibers_status_created
        ON cf_agents_fibers(status, created_at, fiber_id)
      `);
      storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_fibers_name_status_created
        ON cf_agents_fibers(name, status, created_at, fiber_id)
      `);
      storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_fibers_status_completed
        ON cf_agents_fibers(status, completed_at, created_at)
      `);
      storage.kv.put(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
    }
    this.#tablesReady = true;
  }

  #query<T>(query: string, params: SqlValue[]): T[] {
    this.#ensureTables();
    try {
      return [...this.lifecycle.storage.sql.exec(query, ...params)] as T[];
    } catch (error) {
      throw new SqlError(query, error);
    }
  }

  #sql<T = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    return this.#query<T>(strings.join("?"), values);
  }

  #emit(type: string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
