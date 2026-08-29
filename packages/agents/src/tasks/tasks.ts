/**
 * Durable replayable execution for Lifecycle Objects. `Tasks` owns the
 * `cf_agents_task_runs` and `cf_agents_task_steps` tables, the definitions registry, run
 * acceptance, generation-fenced claiming, and due-run processing.
 *
 * Tasks consumes only the standard capability services: storage, the job
 * queue, the host invocation boundary, and events. Every non-terminal run's
 * deadline is mirrored as one Lifecycle queue job while Lifecycle owns the
 * physical alarm, and definition handlers run through Lifecycle's host
 * invocation boundary. Interrupted work replays: completed steps return
 * journaled results and handlers resume from durable evidence.
 */

import { nanoid } from "nanoid";
import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { SqlError } from "../sql-error";
import { TaskStore } from "./store";
import { createTaskStepEngine } from "./engine-port";
import { parseTaskDuration } from "./duration";
import { MissingTaskDefinitionError } from "./errors";
import type { TaskEventType, TasksOptions } from "./options";
import {
  AttemptSupersededError,
  TaskCancellation,
  isTaskCancellation,
  isTaskSuspension,
  ReplayStep,
  toErrorSummary,
  type TaskStepEngine,
  type ResolvedStepPolicy
} from "./replay";
import { deserializeTaskValue, serializeTaskValue } from "./serialization";
import type {
  Task,
  TaskCallbacks,
  TaskHandlers,
  TaskInput,
  TaskOutput,
  TaskReceipt,
  TaskRunOptions,
  TaskRunRow,
  TaskRunSnapshot,
  TaskRunState,
  TaskValue
} from "./types";

/**
 * A composition-root fallback for definition names outside the declared
 * map. The value type is the input-erased handler form (`TaskCallbacks`),
 * so a host resolving concretely-typed definitions casts once, here, and
 * nowhere else.
 */
export type TaskDefinitionResolver = (
  name: string
) => TaskCallbacks[string] | undefined;

const taskDefinitionResolvers = new WeakMap<object, TaskDefinitionResolver>();

/**
 * @internal Supply a composition-root fallback for definition names outside
 * the declared map. Frameworks use this to attach internal definitions (for
 * example a future Agent compatibility layer) without occupying the host's
 * constructor map; resolved handlers still run inside the Lifecycle host
 * boundary. The resolver must return the same definition for a name on
 * every Durable Object wake, or that name's in-flight runs cannot resume.
 */
export function setTaskDefinitionResolver(
  tasks: Tasks<never>,
  resolver: TaskDefinitionResolver
): void {
  taskDefinitionResolvers.set(tasks, resolver);
}

const FIBER_SCHEMA_VERSION_KEY = "cf_agents:tasks_schema_version";
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

const DEFAULT_LIST_LIMIT = 100;
const MAX_DEFINITION_NAME_LENGTH = 256;
/**
 * Queue-job id prefix for run wakes. Run IDs are caller-selectable, so the
 * job id namespaces them instead of exposing them verbatim to the shared
 * job id space.
 */
const WAKE_JOB_PREFIX = "task:";

const TERMINAL_STATES: ReadonlySet<TaskRunState> = new Set([
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

/** Filters accepted by {@link Tasks.list}. */
export type TaskListOptions = {
  definition?: string;
  status?: TaskRunState | TaskRunState[];
  limit?: number;
};

/** Filters accepted by {@link Tasks.delete}. */
export type TaskDeleteOptions = {
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
export class Tasks<
  Handlers extends TaskHandlers = TaskCallbacks
> extends LifecycleCapability {
  readonly #definitions: TaskHandlers;
  readonly #active = new Map<string, ActiveAttempt>();
  #storeInstance: TaskStore | undefined;
  readonly #stepDefaults: ResolvedStepPolicy;
  readonly #onError: ((error: unknown) => void | Promise<void>) | undefined;

  /**
   * Create a Tasks capability.
   *
   * @param options - Named definitions plus default step retry/timeout
   * policy and alarm batching. Declaring `definitions` types {@link run} and
   * {@link handle} against the map — names and inputs are checked where the
   * handlers are declared and where runs start. Names outside the map are
   * rejected unless a composition-root resolver supplies them.
   */
  constructor(options: TasksOptions<Handlers> = {}) {
    super("tasks");
    this.#definitions = options.definitions ?? {};
    this.#stepDefaults = {
      retryLimit: options.retries?.limit ?? DEFAULT_STEP_POLICY.retryLimit,
      retryDelayMs:
        options.retries?.delay !== undefined
          ? parseTaskDuration(options.retries.delay, "retries.delay")
          : DEFAULT_STEP_POLICY.retryDelayMs,
      backoff: options.retries?.backoff ?? DEFAULT_STEP_POLICY.backoff,
      timeoutMs:
        options.stepTimeout !== undefined
          ? parseTaskDuration(options.stepTimeout, "stepTimeout")
          : DEFAULT_STEP_POLICY.timeoutMs
    };
    this.#onError = options.onError;
  }

  #claimTimeoutMs(): number {
    return this.#stepDefaults.timeoutMs + CLAIM_SLACK_MS;
  }

  /** The SQL store over this Lifecycle's storage (see `store.ts`). */
  get #store(): TaskStore {
    this.#storeInstance ??= new TaskStore(this.lifecycle.storage);
    return this.#storeInstance;
  }

  // ── Definitions ──────────────────────────────────────────────────────────

  /** Resolve a name to its declared or composition-root-supplied handler. */
  #resolveDefinition(name: string): TaskCallbacks[string] | undefined {
    // SAFETY: declared definitions are constrained with `never` parameters
    // so concrete definition types satisfy the map under contravariance; the
    // values passed at dispatch were parsed from rows this definition's name
    // was persisted with.
    return (this.#definitions[name] ??
      taskDefinitionResolvers.get(this)?.(name)) as
      | TaskCallbacks[string]
      | undefined;
  }

  /** True when a name resolves to a runnable definition. */
  #hasDefinition(name: string): boolean {
    return this.#resolveDefinition(name) !== undefined;
  }

  #validateDefinitionName(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Task definition names must be non-empty strings");
    }
    if (name.length > MAX_DEFINITION_NAME_LENGTH) {
      throw new Error(
        `Task definition name exceeds ${MAX_DEFINITION_NAME_LENGTH} characters`
      );
    }
    if (name.startsWith("__cf")) {
      throw new Error(
        `Task definition names must not use the reserved "__cf" prefix`
      );
    }
    if (!this.#hasDefinition(name)) {
      throw new Error(
        `Unknown Task definition "${name}": not declared on this Tasks`
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
    input?: TaskInput<Handlers[Name]>,
    options?: TaskRunOptions
  ): Promise<TaskReceipt> {
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
  ): Task<TaskInput<Handlers[Name]>, TaskOutput<Handlers[Name]>> {
    this.#validateDefinitionName(definition);
    return {
      name: definition,
      run: (input, options) => this.run(definition, input, options),
      get: (runId) => this.#snapshot(runId, definition),
      getByIdempotencyKey: (idempotencyKey) =>
        this.#snapshotByKey(idempotencyKey, definition),
      cancel: (runId, reason) => this.#cancelScoped(runId, definition, reason)
    };
  }

  /** Cancel through a handle: another definition's run is not visible. */
  async #cancelScoped(
    runId: string,
    definition: string,
    reason?: string
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || row.definition !== definition) return false;
    return this.cancel(runId, reason);
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate storage and reconcile run deadlines during Lifecycle startup. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(FIBER_SCHEMA_VERSION_KEY)) ?? 0;
    if (version < CURRENT_FIBER_SCHEMA_VERSION) {
      this.#store.ensureTables();
      await storage.put(FIBER_SCHEMA_VERSION_KEY, CURRENT_FIBER_SCHEMA_VERSION);
    }
    this.#reconcile();
    await this.#syncAllWakes();
  }

  /** Drive one due run's wake dispatched by the Lifecycle event loop. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const runId = context.job.id.slice(WAKE_JOB_PREFIX.length);
    if (this.#active.has(runId)) {
      // A live attempt in this isolate; push the claim backstop forward so
      // the due job does not hot-loop the alarm while it works.
      this.#store.sql`
        UPDATE cf_agents_task_runs
        SET next_at = ${Date.now() + this.#claimTimeoutMs()}, updated_at = ${Date.now()}
        WHERE run_id = ${runId} AND state = 'running'
      `;
      return this.#wakeOutcome(runId);
    }
    await this.#executeRun(runId);
    return this.#wakeOutcome(runId);
  }

  /**
   * @internal Framework aperture: durably accept one run — reserved
   * (`__cf`-prefixed) definition names included, which the public `run()`
   * refuses so users cannot start framework runs — and execute it to its
   * next durable boundary before returning. The receipt's run may already be
   * terminal when this resolves; callers that need the outcome read it from
   * their own channel (the run handler settles it) or from the snapshot.
   */
  async __DO_NOT_USE_WILL_BREAK__runAttached(
    definition: string,
    input: unknown,
    options?: TaskRunOptions
  ): Promise<TaskReceipt> {
    if (!this.#hasDefinition(definition)) {
      throw new Error(
        `Unknown Task definition "${definition}": not declared on this Tasks`
      );
    }
    const receipt = await this.#accept(definition, input, options);
    if (receipt.accepted) await this.#executeRun(receipt.runId);
    return receipt;
  }

  /**
   * The queue outcome for one run's wake job, derived from the run row's
   * authoritative `next_at` after dispatch. A same-id `#syncWake` push made
   * mid-drive supersedes this return at the queue (newer pushes win over
   * drive results), but both are computed from the same row, so the row is
   * the single source of truth for whether — and when — the run wakes
   * again either way.
   */
  #wakeOutcome(runId: string): LifecycleJobOutcome {
    const rows = this.#store.sql<{ next_at: number | null }>`
      SELECT next_at FROM cf_agents_task_runs
      WHERE run_id = ${runId}
        AND state IN ('pending', 'waiting', 'running')
    `;
    const next = rows[0]?.next_at;
    return typeof next === "number" ? { rescheduleAt: next } : undefined;
  }

  /**
   * Mirror one run's authoritative deadline into the Lifecycle job queue:
   * a non-terminal run with a `next_at` gets one job (id = `task:` plus the
   * run id, so a retime is a same-id replace); anything else cancels the
   * mirror. The prefix keeps caller-selected run IDs inside Tasks' own job
   * namespace. Every durable mutation of a run's deadline or state funnels
   * through here.
   */
  async #syncWake(runId: string): Promise<void> {
    const rows = this.#store.sql<{ next_at: number | null }>`
      SELECT next_at FROM cf_agents_task_runs
      WHERE run_id = ${runId}
        AND state IN ('pending', 'waiting', 'running')
    `;
    const next = rows[0]?.next_at;
    const jobId = `${WAKE_JOB_PREFIX}${runId}`;
    if (typeof next === "number") {
      await this.lifecycle.jobs.push({ id: jobId, fn: "wake", time: next });
    } else {
      await this.lifecycle.jobs.cancel(jobId);
    }
  }

  /** Mirror every non-terminal run into the queue (startup reconcile). */
  async #syncAllWakes(): Promise<void> {
    const rows = this.#store.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agents_task_runs
      WHERE state IN ('pending', 'waiting', 'running')
        AND next_at IS NOT NULL
    `;
    for (const { run_id } of rows) {
      await this.#syncWake(run_id);
    }
  }

  // ── Inspection and control ───────────────────────────────────────────────

  /** Read one run by ID across all definitions. */
  async get(runId: string): Promise<TaskRunSnapshot<TaskValue> | null> {
    return this.#snapshot(runId);
  }

  /** Read one run by idempotency key across all definitions. */
  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<TaskRunSnapshot<TaskValue> | null> {
    return this.#snapshotByKey(idempotencyKey);
  }

  /** List runs, newest first. */
  async list(
    options: TaskListOptions = {}
  ): Promise<TaskRunSnapshot<TaskValue>[]> {
    await this.lifecycle.ready();
    let query = "SELECT * FROM cf_agents_task_runs WHERE 1 = 1";
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
    // SAFETY: the query selects * from Tasks' own schema.
    return (rows as TaskRunRow[]).map((row) => this.#store.rowToSnapshot(row));
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
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return false;

    const now = Date.now();
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET cancel_requested = 1, cancel_reason = ${reason ?? null},
          next_at = ${now}, updated_at = ${now}
      WHERE run_id = ${runId}
    `;
    const active = this.#active.get(runId);
    if (active) {
      active.controller.abort(new TaskCancellation(reason));
      await this.#syncWake(runId);
      return true;
    }
    await this.#settleCancelled(runId, null, reason);
    return true;
  }

  /**
   * Delete retained terminal runs and their step journals.
   *
   * @returns The number of runs deleted.
   */
  async delete(options: TaskDeleteOptions = {}): Promise<number> {
    await this.lifecycle.ready();
    const states = options.status ?? ["completed", "failed", "cancelled"];
    if (states.length === 0) return 0;
    let query = `SELECT run_id, definition FROM cf_agents_task_runs WHERE state IN (${states.map(() => "?").join(", ")})`;
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
      this.#store.deleteRun(row.run_id);
      this.#emit("task:deleted", {
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
    options: TaskRunOptions = {}
  ): Promise<TaskReceipt> {
    await this.lifecycle.ready();
    if (this.lifecycle.routes.source) {
      throw new Error(
        "Tasks is not yet supported on routed sub-agents: runs must be " +
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

    const inputJson = serializeTaskValue(
      input,
      `input for Task definition "${definition}"`
    );
    const metadataJson = serializeTaskValue(
      options.metadata,
      `metadata for Task definition "${definition}"`
    );

    const existing =
      (options.runId !== undefined
        ? this.#store.getRun(options.runId)
        : undefined) ??
      (options.idempotencyKey !== undefined
        ? this.#store.getRunByKey(options.idempotencyKey)
        : undefined);
    if (existing) {
      if (existing.definition !== definition) {
        throw new Error(
          `Task run "${existing.run_id}" already belongs to definition ` +
            `"${existing.definition}"; refusing to reuse its ` +
            `${options.runId !== undefined ? "run ID" : "idempotency key"} for ` +
            `"${definition}"`
        );
      }
      // When both identifiers are provided they must name the same run:
      // joining by one while the other points elsewhere would silently hand
      // the caller an unrelated run.
      if (
        options.idempotencyKey !== undefined &&
        existing.idempotency_key !== options.idempotencyKey
      ) {
        throw new Error(
          `Task run "${existing.run_id}" carries idempotency key ` +
            `${existing.idempotency_key === null ? "none" : `"${existing.idempotency_key}"`}; ` +
            `refusing to join it with conflicting key "${options.idempotencyKey}"`
        );
      }
      if (options.runId !== undefined && existing.run_id !== options.runId) {
        throw new Error(
          `Idempotency key "${options.idempotencyKey}" already names run ` +
            `"${existing.run_id}"; refusing to join it as "${options.runId}"`
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

    const runId = options.runId ?? `task_${nanoid()}`;
    const now = Date.now();
    this.#store.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, state, metadata, idempotency_key, retain,
         attempt, next_at, cancel_requested, created_at, updated_at)
      VALUES
        (${runId}, ${definition}, ${inputJson}, 'pending', ${metadataJson},
         ${options.idempotencyKey ?? null}, ${options.retain === false ? 0 : 1},
         0, ${now}, 0, ${now}, ${now})
    `;
    await this.#syncWake(runId);
    this.#emit("task:accepted", { runId, definition, accepted: true });

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
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return;

    const now = Date.now();
    if (row.cancel_requested === 1) {
      await this.#settleCancelled(runId, null, row.cancel_reason ?? undefined);
      return;
    }
    if (row.next_at !== null && row.next_at > now) return;

    const handler = this.#resolveDefinition(row.definition);
    if (!handler) {
      const error = new MissingTaskDefinitionError(row.definition);
      console.error(error.message);
      await this.#settleFailed(runId, null, toErrorSummary(error));
      await this.#observeError(error);
      return;
    }

    // Unclean interruption: the previous attempt's isolate is gone. The
    // claim below replays the handler; completed steps return journaled
    // results, and the interrupted step rides `step.interrupted` as the
    // durable evidence the handler branches on.
    const interrupted =
      row.state === "running" ? this.#interruptedStep(runId) : null;
    if (row.state === "running") {
      this.#emit("task:attempt:interrupted", {
        runId,
        definition: row.definition,
        attempt: row.attempt,
        step: interrupted?.name ?? null
      });
    }

    const generation = nanoid();
    const attempt = row.attempt + 1;
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET state = 'running', attempt = ${attempt}, generation = ${generation},
          started_at = coalesce(started_at, ${now}),
          next_at = ${now + this.#claimTimeoutMs()}, wait_reason = NULL,
          updated_at = ${now}
      WHERE run_id = ${runId}
        AND state IN ('pending', 'waiting', 'running')
    `;

    const controller = new AbortController();
    // Emitted before the handler starts: invocation is synchronous up to the
    // first await, so the first step event would otherwise precede this one.
    this.#emit("task:attempt:started", {
      runId,
      definition: row.definition,
      attempt
    });
    const promise = this.#runAttempt(
      row,
      handler,
      generation,
      attempt,
      controller,
      interrupted
    );
    this.#active.set(runId, { generation, controller, promise });
    try {
      await promise;
    } finally {
      this.#active.delete(runId);
    }
  }

  /** Run one claimed attempt and persist its outcome, generation-fenced. */
  async #runAttempt(
    row: TaskRunRow,
    handler: TaskCallbacks[string],
    generation: string,
    attempt: number,
    controller: AbortController,
    interrupted: { name: string; attempt: number } | null
  ): Promise<void> {
    const runId = row.run_id;
    const input = deserializeTaskValue(row.input);
    const engine = this.#createEngine(
      runId,
      row.definition,
      generation,
      controller
    );
    const step = new ReplayStep(engine, {
      startsLive: attempt === 1,
      interrupted
    });

    try {
      const output = await this.lifecycle.runInHostContext(() =>
        handler(input, step)
      );
      const resultJson = serializeTaskValue(
        output,
        `result of Task definition "${row.definition}"`
      );
      const settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET state = 'completed', result = ?, generation = NULL, next_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [resultJson, Date.now(), Date.now()]
      );
      if (settled) {
        this.#emit("task:completed", { runId, definition: row.definition });
        if (row.retain === 0) this.#store.deleteRun(runId);
      }
      await this.#syncWake(runId);
    } catch (thrown) {
      await this.#settleThrown(row, generation, thrown);
    }
  }

  /** Persist a non-completed attempt outcome. */
  async #settleThrown(
    row: TaskRunRow,
    generation: string,
    thrown: unknown
  ): Promise<void> {
    const runId = row.run_id;

    if (thrown instanceof AttemptSupersededError) {
      // A newer attempt owns the run; this one unwinds without settling.
      return;
    }

    if (isTaskCancellation(thrown)) {
      await this.#settleCancelled(runId, generation, thrown.reason);
      return;
    }

    if (isTaskSuspension(thrown)) {
      // A cancel requested mid-attempt wins over parking the run.
      const current = this.#store.getRun(runId);
      if (current?.cancel_requested === 1) {
        await this.#settleCancelled(
          runId,
          generation,
          current.cancel_reason ?? undefined
        );
        return;
      }
      const suspended = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET state = 'waiting', wait_reason = ?, next_at = ?, generation = NULL,
             updated_at = ?
         WHERE run_id = ? AND generation = ? AND state = 'running'`,
        [thrown.reason, thrown.wakeAt, Date.now()]
      );
      if (suspended) {
        this.#emit("task:waiting", {
          runId,
          definition: row.definition,
          reason: thrown.reason,
          wakeAt: thrown.wakeAt
        });
      }
      await this.#syncWake(runId);
      return;
    }

    const summary = toErrorSummary(thrown);
    const failed = await this.#settleFailed(runId, generation, summary);
    if (failed) {
      console.error(
        `Task run "${runId}" (definition "${row.definition}") failed: ${summary.name}: ${summary.message}`
      );
    }
    await this.#observeError(thrown);
  }

  async #observeError(error: unknown): Promise<void> {
    if (!this.#onError) return;
    try {
      // Observing terminal failures is host-facing user code: run it inside
      // the host invocation boundary, like definition handlers.
      await this.lifecycle.runInHostContext(() => this.#onError?.(error));
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
  ): TaskStepEngine {
    return createTaskStepEngine({
      store: this.#store,
      runId,
      generation,
      signal: controller.signal,
      claimTimeoutMs: () => this.#claimTimeoutMs(),
      defaults: this.#stepDefaults,
      emit: (type, payload) =>
        this.#emit(type as TaskEventType, { runId, definition, ...payload })
    });
  }

  /** The step a lost attempt left mid-execution — replay-entry evidence. */
  #interruptedStep(runId: string): { name: string; attempt: number } | null {
    const rows = this.#store.sql<{ step_name: string; attempt: number }>`
      SELECT step_name, attempt FROM cf_agents_task_steps
      WHERE run_id = ${runId} AND state = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return rows[0]
      ? { name: rows[0].step_name, attempt: rows[0].attempt }
      : null;
  }

  /**
   * Settle one run as cancelled and sync its queue mirror. Fenced when a
   * generation is supplied.
   */
  async #settleCancelled(
    runId: string,
    generation: string | null,
    reason: string | undefined
  ): Promise<void> {
    const now = Date.now();
    let settled: boolean;
    if (generation !== null) {
      settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET state = 'cancelled', cancel_requested = 1, cancel_reason = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND state = 'running'`,
        [reason ?? null, now, now]
      );
    } else {
      const written = this.#store.write(
        `UPDATE cf_agents_task_runs
         SET state = 'cancelled', cancel_requested = 1, cancel_reason = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND state IN ('pending', 'waiting', 'running')`,
        [reason ?? null, now, now, runId]
      );
      settled = written > 0;
    }
    if (settled) {
      const row = this.#store.getRun(runId);
      this.#emit("task:cancelled", {
        runId,
        definition: row?.definition ?? null,
        reason: reason ?? null
      });
    }
    await this.#syncWake(runId);
  }

  /**
   * Settle one run as failed and sync its queue mirror. Fenced when a
   * generation is supplied.
   */
  async #settleFailed(
    runId: string,
    generation: string | null,
    error: { name: string; message: string }
  ): Promise<boolean> {
    const now = Date.now();
    let settled: boolean;
    if (generation !== null) {
      settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET state = 'failed', error_name = ?, error_message = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND state = 'running'`,
        [error.name, error.message, now, now]
      );
    } else {
      const written = this.#store.write(
        `UPDATE cf_agents_task_runs
         SET state = 'failed', error_name = ?, error_message = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND state IN ('pending', 'waiting', 'running')`,
        [error.name, error.message, now, now, runId]
      );
      settled = written > 0;
    }
    if (settled) {
      const row = this.#store.getRun(runId);
      this.#emit("task:failed", {
        runId,
        definition: row?.definition ?? null,
        error: error.name
      });
    }
    await this.#syncWake(runId);
    return settled;
  }

  /** Make deadlines sane after a fresh isolate: interrupted work wakes now. */
  #reconcile(): void {
    const now = Date.now();
    // A fresh isolate has no live attempts, so every claimed row is an
    // interrupted attempt: make it due immediately for reclaim and replay.
    this.#store.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now}, updated_at = ${now}
      WHERE state = 'running' AND generation IS NOT NULL
    `;
    // Non-terminal rows must always carry a deadline; repair any without one.
    this.#store.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now}, updated_at = ${now}
      WHERE state IN ('pending', 'waiting') AND next_at IS NULL
    `;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────

  async #snapshot<Output extends TaskValue>(
    runId: string,
    definition?: string
  ): Promise<TaskRunSnapshot<Output> | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#store.rowToSnapshot<Output>(row);
  }

  async #snapshotByKey<Output extends TaskValue>(
    idempotencyKey: string,
    definition?: string
  ): Promise<TaskRunSnapshot<Output> | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRunByKey(idempotencyKey);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#store.rowToSnapshot<Output>(row);
  }

  #emit(type: TaskEventType | string, payload: Record<string, unknown>): void {
    this.lifecycle.events.emit(type, payload);
  }
}
