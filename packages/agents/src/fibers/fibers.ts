/**
 * Durable replayable execution for Lifecycle Objects. `Fibers` owns the
 * `cf_fiber_runs` and `cf_fiber_steps` tables, the definitions registry, run
 * acceptance, generation-fenced claiming, and due-run processing.
 *
 * Fibers consumes only the standard capability services: storage, alarm
 * coordination, the host invocation boundary, and events. It contributes its
 * earliest run deadline while Lifecycle owns the physical alarm, and it runs
 * definition handlers through Lifecycle's host invocation boundary.
 */

import { nanoid } from "nanoid";
import { LifecycleCapability } from "../lifecycle/capability";
import { SqlError } from "../sql-error";
import { parseFiberDuration } from "./duration";
import { MissingFiberDefinitionError } from "./errors";
import type { FiberEventType, FibersOptions } from "./options";
import {
  AttemptSupersededError,
  FiberCancellation,
  isFiberCancellation,
  isFiberSuspension,
  ReplayStep,
  toErrorSummary,
  type FiberStepEngine,
  type ResolvedStepPolicy
} from "./replay";
import { deserializeFiberValue, serializeFiberValue } from "./serialization";
import type {
  Fiber,
  FiberCallbacks,
  FiberHandlers,
  FiberInput,
  FiberInterruption,
  FiberJson,
  FiberOutput,
  FiberReceipt,
  FiberRecoveryDecision,
  FiberRunOptions,
  FiberRunRow,
  FiberRunSnapshot,
  FiberRunState,
  FiberStep,
  FiberStepRow,
  FiberValue
} from "./types";

/** A resolved run handler for a definition name. */
type ResolvedFiberHandler = (input: unknown, step: FiberStep) => unknown;

/** A resolved definition: its run handler plus optional recovery callback. */
type ResolvedFiberEntry = {
  readonly run: ResolvedFiberHandler;
  readonly recover?: (
    interruption: FiberInterruption<unknown>
  ) => FiberRecoveryDecision | Promise<FiberRecoveryDecision>;
};

const fiberDefinitionResolvers = new WeakMap<
  object,
  (name: string) => ResolvedFiberHandler | ResolvedFiberEntry | undefined
>();

/**
 * @internal Supply a composition-root fallback for definition names outside
 * the declared map. Frameworks use this to attach internal definitions (for
 * example a future Agent compatibility layer) without occupying the host's
 * constructor map; resolved handlers still run inside the Lifecycle host
 * boundary, and an entry may pair its handler with a recovery callback. The
 * resolver must return the same definition for a name on every Durable
 * Object wake, or that name's in-flight runs cannot resume.
 */
export function setFiberDefinitionResolver(
  fibers: Fibers<never>,
  resolver: (
    name: string
  ) => ResolvedFiberHandler | ResolvedFiberEntry | undefined
): void {
  fiberDefinitionResolvers.set(fibers, resolver);
}

const FIBER_SCHEMA_VERSION_KEY = "cf_agents:fibers_schema_version";
const CURRENT_FIBER_SCHEMA_VERSION = 1;

const DEFAULT_STEP_POLICY: ResolvedStepPolicy = {
  retryLimit: 5,
  retryDelayMs: 1000,
  backoff: "exponential",
  timeoutMs: 5 * 60 * 1000
};

/**
 * Slack added to the default step timeout to form the claim deadline — the
 * durable recovery backstop that wakes the object when a claimed attempt's
 * isolate disappears.
 */
const CLAIM_SLACK_MS = 30_000;

const DEFAULT_MAX_RUNS_PER_ALARM = 10;

/** Recovery-callback failures tolerated per run before it fails. */
const RECOVERY_MAX_ATTEMPTS = 5;

/** Backoff before retrying a throwing recovery callback, capped at 5 min. */
function recoveryBackoffMs(failedAttempt: number): number {
  return Math.min(5000 * 2 ** (failedAttempt - 1), 5 * 60 * 1000);
}
const DEFAULT_LIST_LIMIT = 100;
const MAX_DEFINITION_NAME_LENGTH = 256;

const TERMINAL_STATES: ReadonlySet<FiberRunState> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

/** One live execution attempt in this isolate. */
type ActiveAttempt = {
  readonly generation: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
};

/** Filters accepted by {@link Fibers.list}. */
export type FiberListOptions = {
  definition?: string;
  status?: FiberRunState | FiberRunState[];
  limit?: number;
};

/** Filters accepted by {@link Fibers.delete}. */
export type FiberDeleteOptions = {
  status?: Array<"completed" | "failed" | "cancelled">;
  settledBefore?: Date;
  limit?: number;
};

/**
 * Durable replayable execution for a Lifecycle Object.
 *
 * Declare named definitions in the constructor and install the instance with
 * `Lifecycle.use()`. The constructor map is the registry: it is rebuilt on
 * every Durable Object wake, so in-flight runs always resolve their
 * persisted definition names. Each definition's handler replays from the
 * beginning on every execution attempt; completed steps return journaled
 * results, sleeps consult persisted deadlines, and interrupted work
 * continues from the first unfinished step after process loss.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Fibers<
  Handlers extends FiberHandlers = FiberCallbacks
> extends LifecycleCapability {
  readonly #definitions: FiberHandlers;
  readonly #active = new Map<string, ActiveAttempt>();
  readonly #stepDefaults: ResolvedStepPolicy;
  readonly #maxRunsPerAlarm: number;
  readonly #onError: ((error: unknown) => void | Promise<void>) | undefined;

  /**
   * Create a Fibers capability.
   *
   * @param options - Named definitions plus default step retry/timeout
   * policy and alarm batching. Declaring `definitions` types {@link run} and
   * {@link handle} against the map — names and inputs are checked where the
   * handlers are declared and where runs start. Names outside the map are
   * rejected unless a composition-root resolver supplies them.
   */
  constructor(options: FibersOptions<Handlers> = {}) {
    super("fibers");
    this.#definitions = options.definitions ?? {};
    this.#stepDefaults = {
      retryLimit: options.retries?.limit ?? DEFAULT_STEP_POLICY.retryLimit,
      retryDelayMs:
        options.retries?.delay !== undefined
          ? parseFiberDuration(options.retries.delay, "retries.delay")
          : DEFAULT_STEP_POLICY.retryDelayMs,
      backoff: options.retries?.backoff ?? DEFAULT_STEP_POLICY.backoff,
      timeoutMs:
        options.stepTimeout !== undefined
          ? parseFiberDuration(options.stepTimeout, "stepTimeout")
          : DEFAULT_STEP_POLICY.timeoutMs
    };
    this.#maxRunsPerAlarm =
      options.maxRunsPerAlarm ?? DEFAULT_MAX_RUNS_PER_ALARM;
    this.#onError = options.onError;
  }

  #claimTimeoutMs(): number {
    return this.#stepDefaults.timeoutMs + CLAIM_SLACK_MS;
  }

  // ── Definitions ──────────────────────────────────────────────────────────

  /** Resolve a name to its declared or composition-root-supplied entry. */
  #resolveDefinition(name: string): ResolvedFiberEntry | undefined {
    // SAFETY: declared definitions are constrained with `never` parameters
    // so concrete definition types satisfy the map under contravariance; the
    // values passed at dispatch were parsed from rows this definition's name
    // was persisted with.
    const supplied = (this.#definitions[name] ??
      fiberDefinitionResolvers.get(this)?.(name)) as
      | ResolvedFiberHandler
      | ResolvedFiberEntry
      | undefined;
    if (!supplied) return undefined;
    return typeof supplied === "function" ? { run: supplied } : supplied;
  }

  /** True when a name resolves to a runnable definition. */
  #hasDefinition(name: string): boolean {
    return this.#resolveDefinition(name) !== undefined;
  }

  #validateDefinitionName(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Fiber definition names must be non-empty strings");
    }
    if (name.length > MAX_DEFINITION_NAME_LENGTH) {
      throw new Error(
        `Fiber definition name exceeds ${MAX_DEFINITION_NAME_LENGTH} characters`
      );
    }
    if (name.startsWith("__cf")) {
      throw new Error(
        `Fiber definition names must not use the reserved "__cf" prefix`
      );
    }
    if (!this.#hasDefinition(name)) {
      throw new Error(
        `Unknown Fiber definition "${name}": not declared on this Fibers`
      );
    }
  }

  // ── Starting runs ────────────────────────────────────────────────────────

  /**
   * Durably accept one run of a declared definition and return a receipt
   * without waiting for terminal state. The same `idempotencyKey` or `runId`
   * joins the existing run (`accepted: false`) instead of creating a second.
   */
  async run<Name extends keyof Handlers & string>(
    definition: Name,
    input?: FiberInput<Handlers[Name]>,
    options?: FiberRunOptions
  ): Promise<FiberReceipt> {
    this.#validateDefinitionName(definition);
    return this.#accept(definition, input, options);
  }

  /**
   * A typed handle scoped to one declared definition: its `run`, `get`,
   * `getByIdempotencyKey`, and `cancel` see only that definition's runs. The
   * handle is a pure lens over this capability — it holds no state and may
   * be created at any time.
   */
  handle<Name extends keyof Handlers & string>(
    definition: Name
  ): Fiber<FiberInput<Handlers[Name]>, FiberOutput<Handlers[Name]>> {
    this.#validateDefinitionName(definition);
    return {
      name: definition,
      run: (input, options) => this.run(definition, input, options),
      get: (runId) => this.#snapshot(runId, definition),
      getByIdempotencyKey: (idempotencyKey) =>
        this.#snapshotByKey(idempotencyKey, definition),
      cancel: (runId, reason) => this.cancel(runId, reason)
    };
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate storage and reconcile run deadlines during Lifecycle startup. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(FIBER_SCHEMA_VERSION_KEY)) ?? 0;
    if (version < CURRENT_FIBER_SCHEMA_VERSION) {
      this.#ensureTables();
      await storage.put(FIBER_SCHEMA_VERSION_KEY, CURRENT_FIBER_SCHEMA_VERSION);
    }
    this.#reconcile();
  }

  /** Claim and execute due runs during the Lifecycle alarm phase. */
  async onAlarm(): Promise<void> {
    const now = Date.now();
    const due = this.#sql<{ run_id: string }>`
      SELECT run_id FROM cf_fiber_runs
      WHERE state IN ('pending', 'waiting', 'running', 'recovering')
        AND next_at <= ${now}
      ORDER BY next_at ASC
      LIMIT ${this.#maxRunsPerAlarm}
    `;
    for (const { run_id } of due) {
      if (this.lifecycle.alarms.disabled()) return;
      if (this.#active.has(run_id)) {
        // A live attempt in this isolate; push the claim backstop forward so
        // the due row does not hot-loop the alarm while it works.
        this.#sql`
          UPDATE cf_fiber_runs
          SET next_at = ${Date.now() + this.#claimTimeoutMs()}, updated_at = ${Date.now()}
          WHERE run_id = ${run_id} AND state IN ('running', 'recovering')
        `;
        continue;
      }
      await this.#executeRun(run_id);
    }
    // Rows beyond the batch limit keep past-due deadlines; Lifecycle's
    // post-alarm rearm clamps them to now + 1 for an immediate continuation.
  }

  /** Contribute the earliest run deadline to Lifecycle alarm selection. */
  getNextAlarm(): number | null {
    const rows = this.#sql<{ next: number | null }>`
      SELECT MIN(next_at) AS next FROM cf_fiber_runs
      WHERE state IN ('pending', 'waiting', 'running', 'recovering')
        AND next_at IS NOT NULL
    `;
    const next = rows[0]?.next;
    if (next === null || next === undefined) return null;
    return Math.max(next, Date.now() + 1);
  }

  // ── Inspection and control ───────────────────────────────────────────────

  /** Read one run by ID across all definitions. */
  async get(runId: string): Promise<FiberRunSnapshot<FiberValue> | null> {
    return this.#snapshot(runId);
  }

  /** Read one run by idempotency key across all definitions. */
  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<FiberRunSnapshot<FiberValue> | null> {
    return this.#snapshotByKey(idempotencyKey);
  }

  /** List runs, newest first. */
  async list(
    options: FiberListOptions = {}
  ): Promise<FiberRunSnapshot<FiberValue>[]> {
    await this.lifecycle.ready();
    let query = "SELECT * FROM cf_fiber_runs WHERE 1 = 1";
    const params: (string | number)[] = [];
    if (options.definition !== undefined) {
      query += " AND definition = ?";
      params.push(options.definition);
    }
    const states = Array.isArray(options.status)
      ? options.status
      : options.status !== undefined
        ? [options.status]
        : [];
    if (states.length > 0) {
      query += ` AND state IN (${states.map(() => "?").join(", ")})`;
      params.push(...states);
    }
    query += " ORDER BY created_at DESC, run_id DESC LIMIT ?";
    params.push(options.limit ?? DEFAULT_LIST_LIMIT);
    let rows: unknown[];
    try {
      rows = this.lifecycle.storage.sql.exec(query, ...params).toArray();
    } catch (cause) {
      throw new SqlError(query, cause);
    }
    // SAFETY: the query selects * from Fibers' own schema.
    return (rows as FiberRunRow[]).map((row) => this.#rowToSnapshot(row));
  }

  /**
   * Request cooperative cancellation of one run.
   *
   * A live attempt is aborted and settles as cancelled at its next step
   * boundary; a parked run settles immediately.
   *
   * @returns True when a non-terminal run accepted the request.
   */
  async cancel(runId: string, reason?: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return false;

    const now = Date.now();
    this.#sql`
      UPDATE cf_fiber_runs
      SET cancel_requested = 1, cancel_reason = ${reason ?? null},
          next_at = ${now}, updated_at = ${now}
      WHERE run_id = ${runId}
    `;
    const active = this.#active.get(runId);
    if (active) {
      active.controller.abort(new FiberCancellation(reason));
      await this.lifecycle.alarms.rearm();
      return true;
    }
    this.#settleCancelled(runId, null, reason);
    await this.lifecycle.alarms.rearm();
    return true;
  }

  /**
   * Delete retained terminal runs and their step journals.
   *
   * @returns The number of runs deleted.
   */
  async delete(options: FiberDeleteOptions = {}): Promise<number> {
    await this.lifecycle.ready();
    const states = options.status ?? ["completed", "failed", "cancelled"];
    if (states.length === 0) return 0;
    let query = `SELECT run_id, definition FROM cf_fiber_runs WHERE state IN (${states.map(() => "?").join(", ")})`;
    const params: (string | number)[] = [...states];
    if (options.settledBefore) {
      query += " AND settled_at < ?";
      params.push(options.settledBefore.getTime());
    }
    query += " ORDER BY settled_at ASC LIMIT ?";
    params.push(options.limit ?? DEFAULT_LIST_LIMIT);
    let rows: unknown[];
    try {
      rows = this.lifecycle.storage.sql.exec(query, ...params).toArray();
    } catch (cause) {
      throw new SqlError(query, cause);
    }
    for (const row of rows as Array<{ run_id: string; definition: string }>) {
      this.#deleteRun(row.run_id);
      this.#emit("fiber:deleted", {
        runId: row.run_id,
        definition: row.definition
      });
    }
    return rows.length;
  }

  // ── Acceptance ───────────────────────────────────────────────────────────

  async #accept(
    definition: string,
    input: unknown,
    options: FiberRunOptions = {}
  ): Promise<FiberReceipt> {
    await this.lifecycle.ready();
    if (this.lifecycle.routes.source) {
      throw new Error(
        "Fibers is not yet supported on routed sub-agents: runs must be " +
          "accepted by the Lifecycle that owns the physical alarm"
      );
    }
    if (options.runId !== undefined && options.runId.length === 0) {
      throw new Error("runId must be a non-empty string when provided");
    }
    if (
      options.idempotencyKey !== undefined &&
      options.idempotencyKey.length === 0
    ) {
      throw new Error(
        "idempotencyKey must be a non-empty string when provided"
      );
    }

    const inputJson = serializeFiberValue(
      input,
      `input for Fiber definition "${definition}"`
    );
    const metadataJson = serializeFiberValue(
      options.metadata,
      `metadata for Fiber definition "${definition}"`
    );

    const existing =
      (options.runId !== undefined ? this.#getRun(options.runId) : undefined) ??
      (options.idempotencyKey !== undefined
        ? this.#getRunByKey(options.idempotencyKey)
        : undefined);
    if (existing) {
      if (existing.definition !== definition) {
        throw new Error(
          `Fiber run "${existing.run_id}" already belongs to definition ` +
            `"${existing.definition}"; refusing to reuse its ` +
            `${options.runId !== undefined ? "run ID" : "idempotency key"} for ` +
            `"${definition}"`
        );
      }
      return {
        runId: existing.run_id,
        definition,
        accepted: false,
        state: existing.state,
        createdAt: existing.created_at
      };
    }

    const runId = options.runId ?? `fiber_${nanoid()}`;
    const now = Date.now();
    this.#sql`
      INSERT INTO cf_fiber_runs
        (run_id, definition, input, state, metadata, idempotency_key, retain,
         attempt, next_at, cancel_requested, created_at, updated_at)
      VALUES
        (${runId}, ${definition}, ${inputJson}, 'pending', ${metadataJson},
         ${options.idempotencyKey ?? null}, ${options.retain === false ? 0 : 1},
         0, ${now}, 0, ${now}, ${now})
    `;
    await this.lifecycle.alarms.rearm();
    this.#emit("fiber:accepted", { runId, definition, accepted: true });

    // Warm path: begin the first attempt immediately when the host is past
    // startup. The durable deadline above is authoritative either way.
    if (!this.lifecycle.starting()) {
      void this.#executeRun(runId).catch(() => {});
    }

    return {
      runId,
      definition,
      accepted: true,
      state: "pending",
      createdAt: now
    };
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /** Claim and drive one due run to its next durable boundary. */
  async #executeRun(runId: string): Promise<void> {
    if (this.#active.has(runId)) return;
    if (this.lifecycle.alarms.disabled()) return;
    const row = this.#getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return;

    const now = Date.now();
    if (row.cancel_requested === 1) {
      this.#settleCancelled(runId, null, row.cancel_reason ?? undefined);
      await this.lifecycle.alarms.rearm();
      return;
    }
    if (row.next_at !== null && row.next_at > now) return;

    const entry = this.#resolveDefinition(row.definition);
    if (!entry) {
      const error = new MissingFiberDefinitionError(row.definition);
      console.error(error.message);
      this.#settleFailed(runId, null, toErrorSummary(error));
      await this.lifecycle.alarms.rearm();
      await this.#observeError(error);
      return;
    }

    if (row.state === "running") {
      this.#emit("fiber:attempt:interrupted", {
        runId,
        definition: row.definition,
        attempt: row.attempt,
        step: this.#interruptedStepName(runId)
      });
    }

    // Unclean interruption with a recovery callback: the definition decides
    // what a lost attempt means. Without one, the claim below replays. A
    // 'recovering' row without a recovery callback (removed by a deploy)
    // also falls through to replay.
    if (
      (row.state === "running" || row.state === "recovering") &&
      entry.recover
    ) {
      await this.#runRecovery(row, entry.recover);
      return;
    }

    const generation = nanoid();
    const attempt = row.attempt + 1;
    this.#sql`
      UPDATE cf_fiber_runs
      SET state = 'running', attempt = ${attempt}, generation = ${generation},
          started_at = coalesce(started_at, ${now}),
          next_at = ${now + this.#claimTimeoutMs()}, wait_reason = NULL,
          updated_at = ${now}
      WHERE run_id = ${runId}
        AND state IN ('pending', 'waiting', 'running', 'recovering')
    `;

    const controller = new AbortController();
    // Emitted before the handler starts: invocation is synchronous up to the
    // first await, so the first step event would otherwise precede this one.
    this.#emit("fiber:attempt:started", {
      runId,
      definition: row.definition,
      attempt
    });
    const promise = this.#runAttempt(
      row,
      entry.run,
      generation,
      attempt,
      controller
    );
    this.#active.set(runId, { generation, controller, promise });
    try {
      await promise;
    } finally {
      this.#active.delete(runId);
    }
  }

  /** Claim an interrupted run for its definition's recovery callback. */
  async #runRecovery(
    row: FiberRunRow,
    recover: NonNullable<ResolvedFiberEntry["recover"]>
  ): Promise<void> {
    const runId = row.run_id;
    const generation = nanoid();
    const now = Date.now();
    this.#sql`
      UPDATE cf_fiber_runs
      SET state = 'recovering', generation = ${generation},
          next_at = ${now + this.#claimTimeoutMs()}, wait_reason = NULL,
          updated_at = ${now}
      WHERE run_id = ${runId} AND state IN ('running', 'recovering')
    `;
    this.#emit("fiber:recovery:started", {
      runId,
      definition: row.definition,
      attempt: row.attempt
    });

    const controller = new AbortController();
    let replayNow = false;
    const promise = this.#recoverAttempt(
      row,
      recover,
      generation,
      controller
    ).then((outcome) => {
      replayNow = outcome === "replay-now";
    });
    this.#active.set(runId, { generation, controller, promise });
    try {
      await promise;
    } finally {
      this.#active.delete(runId);
    }
    if (replayNow) await this.#executeRun(runId);
  }

  /** Invoke one recovery attempt and persist its decision, fenced. */
  async #recoverAttempt(
    row: FiberRunRow,
    recover: NonNullable<ResolvedFiberEntry["recover"]>,
    generation: string,
    controller: AbortController
  ): Promise<"replay-now" | undefined> {
    const runId = row.run_id;
    try {
      const interruption = this.#buildInterruption(row, controller.signal);
      const decision = (await this.lifecycle.runInHostContext(() =>
        recover(interruption)
      )) as FiberRecoveryDecision;
      const action = decision?.action;
      if (
        action !== "replay" &&
        action !== "complete" &&
        action !== "fail" &&
        action !== "cancel"
      ) {
        throw new Error(
          `Recovery for Fiber run "${runId}" returned an unknown decision; ` +
            `expected an action of replay, complete, fail, or cancel`
        );
      }
      this.#emit("fiber:recovery:decided", {
        runId,
        definition: row.definition,
        action
      });
      return await this.#applyRecoveryDecision(row, generation, decision);
    } catch (thrown) {
      if (thrown instanceof AttemptSupersededError) return undefined;
      if (isFiberCancellation(thrown)) {
        this.#settleCancelled(runId, generation, thrown.reason);
        await this.lifecycle.alarms.rearm();
        return undefined;
      }
      await this.#recoveryFailure(row, generation, thrown);
      return undefined;
    }
  }

  /** Apply one recovery decision under the recovery claim's fence. */
  async #applyRecoveryDecision(
    row: FiberRunRow,
    generation: string,
    decision: FiberRecoveryDecision
  ): Promise<"replay-now" | undefined> {
    const runId = row.run_id;
    switch (decision.action) {
      case "replay": {
        const at =
          decision.at instanceof Date ? decision.at.getTime() : decision.at;
        const later = at !== undefined && at > Date.now();
        const wakeAt = later ? (at as number) : Date.now();
        const parked = this.#fencedWrite(
          runId,
          generation,
          `UPDATE cf_fiber_runs
           SET state = 'waiting', wait_reason = 'recovery', next_at = ?,
               generation = NULL, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'recovering'`,
          [wakeAt, Date.now()]
        );
        if (parked && later) {
          this.#emit("fiber:waiting", {
            runId,
            definition: row.definition,
            reason: "recovery",
            wakeAt
          });
        }
        await this.lifecycle.alarms.rearm();
        return parked && !later ? "replay-now" : undefined;
      }
      case "complete": {
        const resultJson = serializeFiberValue(
          decision.result,
          `recovery result for Fiber definition "${row.definition}"`
        );
        const settled = this.#fencedWrite(
          runId,
          generation,
          `UPDATE cf_fiber_runs
           SET state = 'completed', result = ?, generation = NULL,
               next_at = NULL, settled_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'recovering'`,
          [resultJson, Date.now(), Date.now()]
        );
        if (settled) {
          this.#emit("fiber:completed", { runId, definition: row.definition });
          if (row.retain === 0) this.#deleteRun(runId);
        }
        await this.lifecycle.alarms.rearm();
        return undefined;
      }
      case "fail": {
        const summary = toErrorSummary(decision.error);
        const failed = this.#settleFailed(runId, generation, summary);
        if (failed) {
          console.error(
            `Fiber run "${runId}" (definition "${row.definition}") failed by ` +
              `recovery decision: ${summary.name}: ${summary.message}`
          );
        }
        await this.lifecycle.alarms.rearm();
        await this.#observeError(decision.error);
        return undefined;
      }
      case "cancel": {
        this.#settleCancelled(runId, generation, decision.reason);
        await this.lifecycle.alarms.rearm();
        return undefined;
      }
    }
  }

  /** Park a throwing recovery callback with backoff, or exhaust its budget. */
  async #recoveryFailure(
    row: FiberRunRow,
    generation: string,
    thrown: unknown
  ): Promise<void> {
    const runId = row.run_id;
    const recoveryAttempt = row.recovery_attempt + 1;
    const summary = toErrorSummary(thrown);
    if (recoveryAttempt >= RECOVERY_MAX_ATTEMPTS) {
      const failed = this.#settleFailed(runId, generation, summary);
      if (failed) {
        console.error(
          `Fiber run "${runId}" (definition "${row.definition}") failed ` +
            `after ${recoveryAttempt} recovery attempts: ${summary.name}: ${summary.message}`
        );
      }
      await this.lifecycle.alarms.rearm();
      await this.#observeError(thrown);
      return;
    }
    const wakeAt = Date.now() + recoveryBackoffMs(recoveryAttempt);
    const parked = this.#fencedWrite(
      runId,
      generation,
      `UPDATE cf_fiber_runs
       SET recovery_attempt = ?, next_at = ?, generation = NULL, updated_at = ?
       WHERE run_id = ? AND generation = ? AND state = 'recovering'`,
      [recoveryAttempt, wakeAt, Date.now()]
    );
    if (parked) {
      console.warn(
        `Recovery for Fiber run "${runId}" (definition "${row.definition}") ` +
          `threw (${summary.name}: ${summary.message}); retrying recovery at ` +
          `${new Date(wakeAt).toISOString()}`
      );
    }
    await this.lifecycle.alarms.rearm();
  }

  /** Assemble the recovery context from the pre-claim run row. */
  #buildInterruption(
    row: FiberRunRow,
    signal: AbortSignal
  ): FiberInterruption<unknown> {
    const stepRows = this.#sql<FiberStepRow>`
      SELECT * FROM cf_fiber_steps
      WHERE run_id = ${row.run_id} AND state = 'running' AND kind = 'do'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const stepRow = stepRows[0];
    return {
      runId: row.run_id,
      definition: row.definition,
      input: deserializeFiberValue(row.input) as Readonly<unknown>,
      attempt: row.attempt,
      createdAt: row.created_at,
      interruptedAt: row.updated_at,
      metadata:
        row.metadata !== null
          ? (JSON.parse(row.metadata) as Record<string, FiberJson>)
          : null,
      interruptedStep: stepRow
        ? {
            name: stepRow.step_name,
            kind: "do",
            attempt: stepRow.attempt,
            idempotencyKey: `${row.run_id}:${stepRow.step_name}`,
            checkpoint: deserializeFiberValue(stepRow.checkpoint) as FiberValue,
            startedAt: stepRow.started_at ?? stepRow.created_at
          }
        : null,
      signal
    };
  }

  /** Run one claimed attempt and persist its outcome, generation-fenced. */
  async #runAttempt(
    row: FiberRunRow,
    handler: ResolvedFiberHandler,
    generation: string,
    attempt: number,
    controller: AbortController
  ): Promise<void> {
    const runId = row.run_id;
    const input = deserializeFiberValue(row.input);
    const engine = this.#createEngine(
      runId,
      row.definition,
      generation,
      controller
    );
    const step = new ReplayStep(engine, { startsLive: attempt === 1 });

    try {
      const output = await this.lifecycle.runInHostContext(() =>
        handler(input, step)
      );
      const resultJson = serializeFiberValue(
        output,
        `result of Fiber definition "${row.definition}"`
      );
      const settled = this.#fencedWrite(
        runId,
        generation,
        `UPDATE cf_fiber_runs
         SET state = 'completed', result = ?, generation = NULL, next_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [resultJson, Date.now(), Date.now()]
      );
      if (settled) {
        this.#emit("fiber:completed", { runId, definition: row.definition });
        if (row.retain === 0) this.#deleteRun(runId);
      }
      await this.lifecycle.alarms.rearm();
    } catch (thrown) {
      await this.#settleThrown(row, generation, thrown);
    }
  }

  /** Persist a non-completed attempt outcome. */
  async #settleThrown(
    row: FiberRunRow,
    generation: string,
    thrown: unknown
  ): Promise<void> {
    const runId = row.run_id;

    if (thrown instanceof AttemptSupersededError) {
      // A newer attempt owns the run; this one unwinds without settling.
      return;
    }

    if (isFiberCancellation(thrown)) {
      this.#settleCancelled(runId, generation, thrown.reason);
      await this.lifecycle.alarms.rearm();
      return;
    }

    if (isFiberSuspension(thrown)) {
      // A cancel requested mid-attempt wins over parking the run.
      const current = this.#getRun(runId);
      if (current?.cancel_requested === 1) {
        this.#settleCancelled(
          runId,
          generation,
          current.cancel_reason ?? undefined
        );
        await this.lifecycle.alarms.rearm();
        return;
      }
      const suspended = this.#fencedWrite(
        runId,
        generation,
        `UPDATE cf_fiber_runs
         SET state = 'waiting', wait_reason = ?, next_at = ?, generation = NULL,
             updated_at = ?
         WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [thrown.reason, thrown.wakeAt, Date.now()]
      );
      if (suspended) {
        this.#emit("fiber:waiting", {
          runId,
          definition: row.definition,
          reason: thrown.reason,
          wakeAt: thrown.wakeAt
        });
      }
      await this.lifecycle.alarms.rearm();
      return;
    }

    const summary = toErrorSummary(thrown);
    const failed = this.#settleFailed(runId, generation, summary);
    if (failed) {
      console.error(
        `Fiber run "${runId}" (definition "${row.definition}") failed: ${summary.name}: ${summary.message}`
      );
    }
    await this.lifecycle.alarms.rearm();
    await this.#observeError(thrown);
  }

  async #observeError(error: unknown): Promise<void> {
    try {
      await this.#onError?.(error);
    } catch {
      // swallow onError errors
    }
  }

  // ── Step engine port ─────────────────────────────────────────────────────

  #createEngine(
    runId: string,
    definition: string,
    generation: string,
    controller: AbortController
  ): FiberStepEngine {
    const assertCurrent = (): void => {
      const row = this.#getRun(runId);
      if (!row || row.generation !== generation) {
        throw new AttemptSupersededError(runId);
      }
    };
    const emit = (type: string, payload: Record<string, unknown>): void => {
      this.#emit(type as FiberEventType, { runId, definition, ...payload });
    };

    return {
      readStep: (name) => {
        const rows = this.#sql<FiberStepRow>`
          SELECT * FROM cf_fiber_steps
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
        return rows[0];
      },
      countSteps: () => {
        const rows = this.#sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM cf_fiber_steps WHERE run_id = ${runId}
        `;
        return rows[0]?.count ?? 0;
      },
      insertStep: (name, kind, wakeAt) => {
        assertCurrent();
        const now = Date.now();
        this.#sql`
          INSERT INTO cf_fiber_steps
            (run_id, step_name, kind, state, attempt, next_at, created_at,
             started_at, updated_at)
          VALUES
            (${runId}, ${name}, ${kind},
             ${kind === "do" ? "running" : wakeAt === null ? "running" : "waiting"},
             ${kind === "do" ? 1 : 0}, ${wakeAt},
             ${now}, ${kind === "do" ? now : null}, ${now})
        `;
      },
      claimStepAttempt: (name) => {
        assertCurrent();
        const now = Date.now();
        this.#sql`
          UPDATE cf_fiber_steps
          SET state = 'running', attempt = attempt + 1, next_at = NULL,
              started_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
        const rows = this.#sql<{ attempt: number }>`
          SELECT attempt FROM cf_fiber_steps
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
        return rows[0]?.attempt ?? 1;
      },
      completeStep: (name, result) => {
        assertCurrent();
        const resultJson = serializeFiberValue(
          result,
          `result of step "${name}" in run "${runId}"`
        );
        const now = Date.now();
        this.#sql`
          UPDATE cf_fiber_steps
          SET state = 'completed', result = ${resultJson}, next_at = NULL,
              completed_at = ${now}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      },
      failStep: (name, error) => {
        assertCurrent();
        const now = Date.now();
        this.#sql`
          UPDATE cf_fiber_steps
          SET state = 'failed', error_name = ${error.name},
              error_message = ${error.message}, next_at = NULL, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      },
      waitStep: (name, wakeAt) => {
        assertCurrent();
        const now = Date.now();
        this.#sql`
          UPDATE cf_fiber_steps
          SET state = 'waiting', next_at = ${wakeAt}, updated_at = ${now}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      },
      writeCheckpoint: (name, value) => {
        assertCurrent();
        const checkpointJson = serializeFiberValue(
          value,
          `checkpoint for step "${name}" in run "${runId}"`
        );
        this.#sql`
          UPDATE cf_fiber_steps
          SET checkpoint = ${checkpointJson}, updated_at = ${Date.now()}
          WHERE run_id = ${runId} AND step_name = ${name}
        `;
      },
      refreshClaim: () => {
        this.#fencedWrite(
          runId,
          generation,
          `UPDATE cf_fiber_runs SET next_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'`,
          [Date.now() + this.#claimTimeoutMs(), Date.now()]
        );
      },
      writeStatus: (message) => {
        this.#fencedWrite(
          runId,
          generation,
          `UPDATE cf_fiber_runs SET status_message = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'`,
          [message, Date.now()]
        );
      },
      cancellationRequested: () => {
        const row = this.#getRun(runId);
        if (!row || row.cancel_requested !== 1) return null;
        return { reason: row.cancel_reason ?? undefined };
      },
      attemptSignal: controller.signal,
      emit,
      stepIdempotencyKey: (name) => `${runId}:${name}`,
      defaults: this.#stepDefaults
    };
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.reduce(
      (result, part, index) =>
        result + part + (index < values.length ? "?" : ""),
      ""
    );
    try {
      // SAFETY: Fibers queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      return [...this.lifecycle.storage.sql.exec(query, ...values)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  /**
   * Run one generation-fenced run mutation. Returns false when the fence
   * rejected it because another attempt superseded this one.
   */
  #fencedWrite(
    runId: string,
    generation: string,
    query: string,
    leadingParams: (string | number | null)[]
  ): boolean {
    try {
      const cursor = this.lifecycle.storage.sql.exec(
        query,
        ...leadingParams,
        runId,
        generation
      );
      return cursor.rowsWritten > 0;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #getRun(runId: string): FiberRunRow | undefined {
    const rows = this.#sql<FiberRunRow>`
      SELECT * FROM cf_fiber_runs WHERE run_id = ${runId}
    `;
    return rows[0];
  }

  #getRunByKey(idempotencyKey: string): FiberRunRow | undefined {
    const rows = this.#sql<FiberRunRow>`
      SELECT * FROM cf_fiber_runs WHERE idempotency_key = ${idempotencyKey}
    `;
    return rows[0];
  }

  /** The step a lost attempt left mid-execution, for interruption events. */
  #interruptedStepName(runId: string): string | null {
    const rows = this.#sql<{ step_name: string }>`
      SELECT step_name FROM cf_fiber_steps
      WHERE run_id = ${runId} AND state = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return rows[0]?.step_name ?? null;
  }

  /** Settle one run as cancelled. Fenced when a generation is supplied. */
  #settleCancelled(
    runId: string,
    generation: string | null,
    reason: string | undefined
  ): void {
    const now = Date.now();
    let settled: boolean;
    if (generation !== null) {
      settled = this.#fencedWrite(
        runId,
        generation,
        `UPDATE cf_fiber_runs
         SET state = 'cancelled', cancel_requested = 1, cancel_reason = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND state IN ('running', 'recovering')`,
        [reason ?? null, now, now]
      );
    } else {
      const written = this.#sqlWrite(
        `UPDATE cf_fiber_runs
         SET state = 'cancelled', cancel_requested = 1, cancel_reason = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND state IN ('pending', 'waiting', 'running', 'recovering')`,
        [reason ?? null, now, now, runId]
      );
      settled = written > 0;
    }
    if (settled) {
      const row = this.#getRun(runId);
      this.#emit("fiber:cancelled", {
        runId,
        definition: row?.definition ?? null,
        reason: reason ?? null
      });
    }
  }

  /** Settle one run as failed. Fenced when a generation is supplied. */
  #settleFailed(
    runId: string,
    generation: string | null,
    error: { name: string; message: string }
  ): boolean {
    const now = Date.now();
    let settled: boolean;
    if (generation !== null) {
      settled = this.#fencedWrite(
        runId,
        generation,
        `UPDATE cf_fiber_runs
         SET state = 'failed', error_name = ?, error_message = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND state IN ('running', 'recovering')`,
        [error.name, error.message, now, now]
      );
    } else {
      const written = this.#sqlWrite(
        `UPDATE cf_fiber_runs
         SET state = 'failed', error_name = ?, error_message = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND state IN ('pending', 'waiting', 'running', 'recovering')`,
        [error.name, error.message, now, now, runId]
      );
      settled = written > 0;
    }
    if (settled) {
      const row = this.#getRun(runId);
      this.#emit("fiber:failed", {
        runId,
        definition: row?.definition ?? null,
        error: error.name
      });
    }
    return settled;
  }

  #sqlWrite(query: string, params: (string | number | null)[]): number {
    try {
      return this.lifecycle.storage.sql.exec(query, ...params).rowsWritten;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #deleteRun(runId: string): void {
    this.#sql`DELETE FROM cf_fiber_steps WHERE run_id = ${runId}`;
    this.#sql`DELETE FROM cf_fiber_runs WHERE run_id = ${runId}`;
  }

  #ensureTables(): void {
    const rawSql = (query: string) => {
      try {
        this.lifecycle.storage.sql.exec(query);
      } catch (cause) {
        throw new SqlError(query, cause);
      }
    };
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_fiber_runs (
        run_id TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        input TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'running', 'waiting', 'recovering',
          'completed', 'failed', 'cancelled'
        )),
        result TEXT,
        error_name TEXT,
        error_message TEXT,
        status_message TEXT,
        metadata TEXT,
        idempotency_key TEXT UNIQUE,
        retain INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 0,
        recovery_attempt INTEGER NOT NULL DEFAULT 0,
        generation TEXT,
        next_at INTEGER,
        wait_reason TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER
      )
    `);
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_fiber_runs_due
      ON cf_fiber_runs (state, next_at)
    `);
    rawSql(`
      CREATE INDEX IF NOT EXISTS cf_fiber_runs_definition
      ON cf_fiber_runs (definition, created_at)
    `);
    rawSql(`
      CREATE TABLE IF NOT EXISTS cf_fiber_steps (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep')),
        state TEXT NOT NULL CHECK (state IN (
          'running', 'waiting', 'completed', 'failed'
        )),
        result TEXT,
        error_name TEXT,
        error_message TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        checkpoint TEXT,
        next_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (run_id, step_name)
      )
    `);
  }

  /** Make deadlines sane after a fresh isolate: interrupted work wakes now. */
  #reconcile(): void {
    const now = Date.now();
    // A fresh isolate has no live attempts, so every claimed row is an
    // interrupted attempt (or interrupted recovery): make it due immediately
    // for reclaim. Parked 'recovering' rows (generation NULL) keep their
    // recovery backoff deadlines.
    this.#sql`
      UPDATE cf_fiber_runs SET next_at = ${now}, updated_at = ${now}
      WHERE state IN ('running', 'recovering') AND generation IS NOT NULL
    `;
    // Non-terminal rows must always carry a deadline; repair any without one.
    this.#sql`
      UPDATE cf_fiber_runs SET next_at = ${now}, updated_at = ${now}
      WHERE state IN ('pending', 'waiting') AND next_at IS NULL
    `;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────

  async #snapshot<Output extends FiberValue>(
    runId: string,
    definition?: string
  ): Promise<FiberRunSnapshot<Output> | null> {
    await this.lifecycle.ready();
    const row = this.#getRun(runId);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#rowToSnapshot<Output>(row);
  }

  async #snapshotByKey<Output extends FiberValue>(
    idempotencyKey: string,
    definition?: string
  ): Promise<FiberRunSnapshot<Output> | null> {
    await this.lifecycle.ready();
    const row = this.#getRunByKey(idempotencyKey);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#rowToSnapshot<Output>(row);
  }

  #rowToSnapshot<Output extends FiberValue>(
    row: FiberRunRow
  ): FiberRunSnapshot<Output> {
    const metadata =
      row.metadata !== null
        ? (JSON.parse(row.metadata) as Record<string, FiberJson>)
        : undefined;
    const base = {
      runId: row.run_id,
      definition: row.definition,
      createdAt: row.created_at,
      ...(metadata !== undefined ? { metadata } : {})
    };
    switch (row.state) {
      case "pending":
        return { ...base, state: "pending" };
      case "running":
        return {
          ...base,
          state: "running",
          attempt: row.attempt,
          startedAt: row.started_at ?? row.created_at,
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {})
        };
      case "waiting":
        return {
          ...base,
          state: "waiting",
          reason: row.wait_reason ?? "sleep",
          wakeAt: row.next_at ?? row.updated_at,
          ...(row.status_message !== null
            ? { statusMessage: row.status_message }
            : {})
        };
      case "recovering":
        return {
          ...base,
          state: "recovering",
          interruptedStep: this.#interruptedStepName(row.run_id),
          attempt: row.attempt
        };
      case "completed":
        return {
          ...base,
          state: "completed",
          result: deserializeFiberValue(row.result) as Output,
          settledAt: row.settled_at ?? row.updated_at
        };
      case "failed":
        return {
          ...base,
          state: "failed",
          error: {
            name: row.error_name ?? "Error",
            message: row.error_message ?? "Fiber run failed"
          },
          settledAt: row.settled_at ?? row.updated_at
        };
      case "cancelled":
        return {
          ...base,
          state: "cancelled",
          ...(row.cancel_reason !== null ? { reason: row.cancel_reason } : {}),
          settledAt: row.settled_at ?? row.updated_at
        };
    }
  }

  #emit(type: FiberEventType | string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
