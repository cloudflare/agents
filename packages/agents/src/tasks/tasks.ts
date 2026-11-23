/**
 * Durable replayable execution for Lifecycle Objects. `Tasks` owns the
 * `cf_agents_task_runs` and `cf_agents_task_steps` tables, the definitions registry, run
 * acceptance, generation-fenced claiming, and due-run processing.
 *
 * Tasks consumes only the standard capability services: storage, the job
 * queue, the host invocation boundary, events, and routing. A run's storage
 * and step journal always live where it was accepted; only its deadline
 * mirrors as one Lifecycle queue job, routed to the root Lifecycle when
 * accepted on a routed sub-agent, since only the root owns the physical
 * alarm. Definition handlers run through Lifecycle's host invocation
 * boundary. Interrupted work replays: completed steps return journaled
 * results and handlers resume from durable evidence.
 */

import { nanoid } from "nanoid";
import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleRouteAddress,
  LifecycleRouteContext
} from "../lifecycle/capability";
import type { MemoryLimitContext } from "../lifecycle/capability-runner";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { isPlatformFailure } from "../retries";
import { SqlError } from "../sql-error";
import { TaskStore } from "./store";
import { createTaskStepEngine } from "./engine-port";
import { parseTaskDuration } from "./duration";
import { MissingTaskDefinitionError } from "./errors";
import { TaskSettlement } from "./settlement";
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
import {
  deserializeTaskValue,
  MAX_FRAMEWORK_METADATA_BYTES,
  MAX_PARTED_INPUT_BYTES,
  MAX_SERIALIZED_BYTES,
  serializeTaskValue
} from "./serialization";
import type {
  Task,
  TaskCallbacks,
  TaskHandlers,
  TaskInput,
  TaskJson,
  TaskOutput,
  TaskRegisterOptions,
  TaskRecord,
  TaskFrameworkDefinition,
  TaskReceipt,
  TaskRunOptions,
  TaskRunRow,
  TaskRunSnapshot,
  TaskStatus,
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

const taskRoutedMemoryLimitHandlers = new WeakMap<
  object,
  (context: MemoryLimitContext) => void | Promise<void>
>();

/**
 * @internal Supply a composition-root bridge from a routed run's sealed
 * strike to the owning host's own `onAlarmMemoryLimit` hook. A root's own
 * local runs already reach that hook through Lifecycle's alarm dispatch on
 * the same Durable Object; a routed run's owner is a different instance,
 * whose Lifecycle never observes the root's alarm directly.
 */
export function setTaskRoutedMemoryLimitHandler(
  tasks: Tasks<never>,
  handler: (context: MemoryLimitContext) => void | Promise<void>
): void {
  taskRoutedMemoryLimitHandlers.set(tasks, handler);
}

const FIBER_SCHEMA_VERSION_KEY = "cf_agents:tasks_schema_version";
/**
 * 2 renames the run statuses and adds `cf_agents_task_checkpoint`; 3 adds
 * lanes and `skipped`.
 */
const CURRENT_FIBER_SCHEMA_VERSION = 3;

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
/** The job that delivers terminal reports a reset or a throw cut short. */
const REPORT_JOB_ID = "tasks:reports";
const REPORT_JOB_FN = "reports";
/** Terminal reports one report job delivers before it hands on to the next. */
const REPORT_BATCH = 100;

/** Wait before delivering again a report whose `onStatus` threw. */
const REPORT_RETRY_MS = 30_000;
/** Normal Task deadline dispatch. */
const WAKE_JOB_FN = "wake";
/**
 * A platform failure that escapes an attempt (ReplayStep rethrows once the
 * step's own retry budget is spent) leaves the run claimed with a future
 * `next_at`. An in-driver retry would not re-run the step — `#executeRun`
 * returns at its claim guard — it would only read the claim back as a clean
 * `{ rescheduleAt }`, hiding the failure from the alarm boundary. One
 * attempt keeps JobDriver's platform-failure contract: the wake rejects, the
 * job row is preserved, and the platform re-runs the alarm on a fresh
 * invocation while the claim deadline stays the durable wake.
 */
const WAKE_JOB_RETRY = { maxAttempts: 1 } as const;
/**
 * How long one queue-driven attempt may hold the serial dispatch loop
 * before detaching. Correctness never depends on the inline await — the
 * claim backstop owns the durable wake — so this only trades a prompt
 * inline settle for queue liveness.
 */
const DISPATCH_BUDGET_MS = 5_000;

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "error",
  "aborted",
  "skipped"
]);

/**
 * A wake job's payload. Owner fields are set only for a routed run's mirror
 * on the root Lifecycle — the run row and step journal stay on the owning
 * facet, which is where `dispatch` and `memoryLimit` route back to.
 */
type TaskWakeJobPayload = {
  readonly runId: string;
  readonly owner_path?: string | null;
  readonly owner_path_key?: string | null;
  /**
   * A routed run backing off after a memory-limit strike: its deadline is
   * the breaker's, and waking it early would only read as a clean pass.
   */
  readonly struck?: true;
};

function isTaskWakeJobPayload(value: unknown): value is TaskWakeJobPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TaskWakeJobPayload).runId === "string"
  );
}

/** Tasks protocol messages routed between a facet and the root Lifecycle. */
type TaskRouteMessage =
  | {
      readonly type: "syncWake";
      readonly runId: string;
      readonly next: number | null;
      readonly struck?: true;
    }
  | { readonly type: "dispatch"; readonly runId: string }
  | {
      readonly type: "memoryLimit";
      readonly runId: string;
      readonly context: MemoryLimitContext;
    };

/**
 * Who drives an accepted run's first attempt (`TaskRunOptions.start`):
 * `warm` starts it detached in the caller's invocation, `queued` leaves it
 * to the durable wake, and `attached` lets the caller drive and await it.
 */
type TaskStartMode = "warm" | "queued" | "attached";

/** One live execution attempt in this isolate. */
type ActiveAttempt = {
  readonly generation: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
};

/** Filters accepted by {@link Tasks.list}. */
export type TaskListOptions = {
  definition?: string;
  status?: TaskStatus | TaskStatus[];
  limit?: number;
};

/** Filters accepted by {@link Tasks.delete}. */
export type TaskDeleteOptions = {
  /** Only runs of this definition. */
  definition?: string;
  status?: Array<"completed" | "error" | "aborted" | "skipped">;
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
  readonly #registered = new Map<string, TaskFrameworkDefinition>();
  readonly #active = new Map<string, ActiveAttempt>();
  /**
   * `local` of each run accepted in this isolate whose caller still waits
   * for its first attempt; removed when that caller's `run()` (or the warm
   * attempt) ends.
   */
  readonly #locals = new Map<string, unknown>();
  /** Options of definitions registered with any. */
  readonly #registeredOptions = new Map<string, TaskRegisterOptions>();
  /** Callers of {@link wait}, by run id; removed when they resolve. */
  readonly #waiters = new Map<
    string,
    Set<{ createdAt: number; resolve: (record: TaskRecord) => void }>
  >();
  /** Runs whose terminal report is being delivered in this isolate. */
  readonly #reporting = new Set<string>();
  /** Lanes {@link holdLane} holds in this isolate. */
  readonly #heldLanes = new Set<string>();
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
      this.#registered.get(name) ??
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

  /**
   * @internal Framework aperture: register one reserved (`__cf`-prefixed)
   * Task definition directly on this instance, bypassing the constructor's
   * `definitions` map so a host's own subclass layers can each declare their
   * own `definitions` / `taskDefinitions` field without colliding with — or
   * being silently clobbered by — a framework's internal names. Call once per
   * name from the owning host's own constructor, unconditionally, so the
   * definition is rebuilt identically on every Durable Object wake: an
   * in-flight run resolves the same handler for its persisted definition name
   * every time, or it cannot resume.
   *
   * Throws if `name` does not carry the reserved `__cf` prefix — this is not
   * a general-purpose registration path; declare ordinary definitions in the
   * constructor's `definitions` map instead — or if `name` is already
   * registered, which is always a real conflict: this method runs exactly
   * once per name per Tasks construction.
   */
  register(
    name: string,
    definition: TaskFrameworkDefinition,
    options: TaskRegisterOptions = {}
  ): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Task definition names must be non-empty strings");
    }
    if (name.length > MAX_DEFINITION_NAME_LENGTH) {
      throw new Error(
        `Task definition name exceeds ${MAX_DEFINITION_NAME_LENGTH} characters`
      );
    }
    if (!name.startsWith("__cf")) {
      throw new Error(
        `register() requires a "__cf"-prefixed reserved definition name, got "${name}"`
      );
    }
    if (Object.hasOwn(this.#definitions, name) || this.#registered.has(name)) {
      throw new Error(
        `Task definition "${name}" is already registered on this Tasks capability`
      );
    }
    this.#registered.set(name, definition);
    if (options.onStatus || options.maxAttempts !== undefined) {
      this.#registeredOptions.set(name, options);
    }
  }

  // ── Starting runs ────────────────────────────────────────────────────────

  /**
   * Durably accept one run and return a receipt. The same `idempotencyKey`
   * or `runId` joins the existing run (`accepted: false`) instead of
   * creating a second. A reused one with a different input throws an error
   * named `TaskInputConflictError`; object key order does not count as
   * different. A framework definition (`register()`) joins whatever the
   * input: its callers key a run by what it is for, not by its data.
   */
  async run<Name extends keyof Handlers & string>(
    definition: Name,
    input?: TaskInput<Handlers[Name]>,
    options?: TaskRunOptions
  ): Promise<TaskReceipt> {
    const framework = this.#registered.has(definition);
    if (!framework) this.#validateDefinitionName(definition);
    const start = options?.start;
    const receipt = await this.#accept(
      definition,
      input,
      options,
      start === "alarm" ? "queued" : start === "now" ? "attached" : "warm",
      !framework
    );
    if (start === "now" && receipt.accepted) {
      try {
        await this.#executeRun(receipt.runId);
      } finally {
        this.#locals.delete(receipt.runId);
      }
    }
    return receipt;
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
      if (version >= 1) this.#store.rebuildRuns();
      this.#store.ensureTables();
      await storage.put(FIBER_SCHEMA_VERSION_KEY, CURRENT_FIBER_SCHEMA_VERSION);
    }
    this.#reconcile();
    await this.#syncAllWakes();
    await this.#reviveRoutedWakes();
    if (this.#hasUnreported()) await this.#pushReportJob();
  }

  /**
   * Make this root's mirrors of routed facet runs due now. A facet's runs
   * live in its own storage, where `#reconcile` cannot reach them, and a
   * facet starts only when something calls it. A root that restarts after a
   * reset took its facets down with it, so an attempt that was running there
   * would otherwise wait for its claim deadline (minutes) before anything
   * woke the facet. The dispatch starts the facet, whose own reconcile
   * reclaims an interrupted attempt; a run that is not due answers with its
   * real deadline, and the mirror moves back to it.
   */
  async #reviveRoutedWakes(): Promise<void> {
    const now = Date.now();
    for (const job of this.lifecycle.jobs.list()) {
      if (
        job.time > now &&
        isTaskWakeJobPayload(job.payload) &&
        job.payload.owner_path &&
        // A struck run waits out the breaker's backoff: waking it early
        // retries nothing and would read as a clean pass, which clears the
        // strikes that are to seal it.
        !job.payload.struck
      ) {
        await this.lifecycle.jobs.reschedule(job.id, now);
      }
    }
  }

  /** Drive one due run's wake dispatched by the Lifecycle event loop. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn === REPORT_JOB_FN) {
      await this.#replayReports();
      return undefined;
    }
    const timing = isTaskWakeJobPayload(context.job.payload)
      ? context.job.payload
      : undefined;
    const runId = timing?.runId ?? context.job.id.slice(WAKE_JOB_PREFIX.length);

    if (timing?.owner_path) {
      // This root mirrors a routed facet's wake; the run and its step
      // journal live on the owning facet, so dispatch routes back there.
      // The facet fully awaits its own dispatch — no local budget to race,
      // since this root now races its own await of the call and, on
      // budget, keeps the still-pending call tracked against this alarm's
      // memory-limit breaker domain instead of discarding it. Verified
      // against a deployed repro: a callee's real memory-limit reset mid
      // RPC rejects the caller's pending call with the platform's own
      // "exceeded its memory limit" text, exactly what the breaker already
      // matches on — so a late failure on the facet is attributed here
      // just like a local detached attempt would be.
      const target = {
        key: timing.owner_path_key ?? timing.owner_path,
        data: timing.owner_path
      };
      const call = this.lifecycle.routes.to(target, {
        type: "dispatch",
        runId
      } satisfies TaskRouteMessage);
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<"budget">((resolve) => {
        budgetTimer = setTimeout(() => resolve("budget"), DISPATCH_BUDGET_MS);
      });
      try {
        const winner = await Promise.race([
          call.then((outcome) => ({ outcome })),
          budget
        ]);
        if (winner === "budget") {
          this.lifecycle.trackAlarmWork(call);
          // The facet's own routed #syncWake, made whenever it eventually
          // settles, supersedes whatever this returns (newer pushes win
          // over drive results), same as the local path below.
          return undefined;
        }
        // `false` means the owner facet is gone: the route already cleaned
        // up its prefix, so drop this mirrored wake instead of handing the
        // queue an outcome it rejects.
        if (winner.outcome === false) return undefined;
        return winner.outcome as LifecycleJobOutcome;
      } catch (error) {
        if (isPlatformFailure(error)) throw error;
        console.error(`error dispatching routed Task run "${runId}"`, error);
        return "yield";
      } finally {
        clearTimeout(budgetTimer);
      }
    }

    return this.#dispatchRun(runId);
  }

  /** Push a live attempt's durable claim deadline forward one claim window. */
  #refreshClaim(runId: string): void {
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET next_at = ${Date.now() + this.#claimTimeoutMs()}, updated_at = ${Date.now()}
      WHERE run_id = ${runId} AND status = 'running'
    `;
  }

  /**
   * Drive one local due run to its next durable boundary, bounded by the
   * dispatch budget, and return the wake outcome for this capability's own
   * queue job.
   */
  async #dispatchRun(runId: string): Promise<LifecycleJobOutcome> {
    // A held lane's run (or one queued behind its head) waits for
    // releaseLane() or its head's settle to wake it again.
    const row = this.#store.getRun(runId);
    if (row && TERMINAL_STATUSES.has(row.status)) {
      // A wake kept for a terminal report a reset cut short.
      if (this.#reporting.has(runId)) {
        return { rescheduleAt: Date.now() + REPORT_RETRY_MS };
      }
      await this.#deliverTerminal(runId, row.retain !== 0);
      return undefined;
    }
    if (!this.#laneAllows(row)) return undefined;
    const active = this.#liveAttempt(runId);
    if (active) {
      // A live attempt in this isolate; push the claim backstop forward so
      // the due job does not hot-loop the alarm while it works.
      this.#refreshClaim(runId);
      this.lifecycle.trackAlarmWork(active.promise);
      return this.#wakeOutcome(runId);
    }
    // Dispatch is bounded: the queue drives jobs serially, so this attempt
    // may not hold the loop for its full step budget. Short attempts (the
    // common case — memoized replays, quick steps) settle inline; a longer
    // one detaches at the budget and keeps executing while this isolate
    // lives. Durability does not depend on the await: the claim backstop in
    // the run row is the wake that survives isolate death, and a detached
    // settle re-syncs the wake mirror, superseding the outcome returned
    // below (newer pushes win over drive results).
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      budgetTimer = setTimeout(() => resolve("budget"), DISPATCH_BUDGET_MS);
    });
    const runAttempt = this.#executeRun(runId, true);
    const attempt = runAttempt.then(() => "settled" as const);
    try {
      // A platform failure inside the budget rejects the race and re-enters
      // the driver's deferral path unchanged.
      const winner = await Promise.race([attempt, budget]);
      if (winner === "budget") {
        // Hand off the attempt's canonical promise — the one a later
        // claim-backstop wake finds in #active — so re-tracking is the
        // driver's documented no-op. The wrapper only unwinds it.
        this.lifecycle.trackAlarmWork(
          this.#active.get(runId)?.promise ?? runAttempt
        );
        return this.#wakeOutcome(runId);
      }
    } finally {
      clearTimeout(budgetTimer);
    }
    return this.#wakeOutcome(runId);
  }

  /**
   * Drive one routed dispatch to completion on this owning facet. There is
   * no local budget to race here: the root that sent this message races
   * its own await of the call instead, so a full await is safe regardless
   * of how long the attempt takes — the call keeps running on this facet
   * either way. An already-active attempt only needs its claim refreshed:
   * it is already tracked against whichever alarm's breaker domain
   * originally dispatched it (a root's pending routed call, or this
   * facet's own local alarm).
   */
  async #dispatchRoutedRun(runId: string): Promise<LifecycleJobOutcome> {
    const active = this.#liveAttempt(runId);
    if (active) {
      this.#refreshClaim(runId);
      return this.#wakeOutcome(runId);
    }
    await this.#executeRun(runId);
    return this.#wakeOutcome(runId);
  }

  /**
   * Alarm memory-limit breaker policy (#1825) for the run whose wake struck.
   *
   * The run row is the durable source of truth: startup reconciliation
   * re-derives due-now wakes from it, so the breaker's queue-row backoff
   * and purge alone cannot contain a run whose attempt deterministically
   * exhausts memory — a fresh isolate would resurrect it immediately. On a
   * strike the run's claim is stripped and its deadline pushed to the
   * backoff wake: the row keeps its state, so a struck `running` row still
   * reads as an interrupted attempt (`step.interrupted`) when it is
   * reclaimed, while reconciliation leaves the claimless row alone instead
   * of flooring its deadline to now. When the breaker seals, the run
   * terminally fails with an observable `task:failed` outcome.
   */
  async onMemoryLimit(context: MemoryLimitContext): Promise<void> {
    const job = context.executing;
    if (job?.capability !== this.capabilityId) return;
    const timing = isTaskWakeJobPayload(job.payload) ? job.payload : undefined;
    const runId = timing?.runId ?? job.id.slice(WAKE_JOB_PREFIX.length);

    if (timing?.owner_path) {
      // The struck job was this root's mirror of a routed facet's wake; the
      // run row and its claim live on the facet, so the strike is forwarded
      // there to apply the same policy locally — clearing the claim and
      // backing off (or terminally failing, when sealed). Forwarding a
      // non-sealed strike too matters: this root's own mirror job backs off
      // on its own, but the facet's run row would otherwise keep its old
      // claim, and any facet startup before the backoff elapses would read
      // that claim as an interrupted attempt and reconcile it due again now
      // — resurrecting the run through the breaker.
      try {
        await this.lifecycle.routes.to(
          {
            key: timing.owner_path_key ?? timing.owner_path,
            data: timing.owner_path
          },
          { type: "memoryLimit", runId, context } satisfies TaskRouteMessage
        );
      } catch (error) {
        console.error(
          `Failed to route memory-limit policy for Task run "${runId}"`,
          error
        );
      }
      return;
    }
    await this.#applyMemoryLimit(runId, context);
  }

  /**
   * Apply the alarm memory-limit breaker policy (#1825) to one run, local to
   * whichever Lifecycle owns its storage — the root for an unrouted run, or
   * the owning facet when {@link onMemoryLimit} forwarded a routed strike.
   */
  async #applyMemoryLimit(
    runId: string,
    context: MemoryLimitContext
  ): Promise<void> {
    if (context.sealed) {
      await this.#settleFailed(runId, null, {
        name: "TaskMemoryLimitSealed",
        message:
          "Sealed by the alarm memory-limit circuit breaker (#1825) after " +
          "consecutive Durable Object memory-limit resets."
      });
      return;
    }
    if (context.nextTime === undefined) return;
    const now = Date.now();
    this.#store.write(
      `UPDATE cf_agents_task_runs
       SET generation = NULL,
           next_at = CASE
             WHEN next_at IS NULL OR next_at < ? THEN ?
             ELSE next_at
           END,
           updated_at = ?
       WHERE run_id = ?
         AND status IN ('pending', 'running')`,
      [context.nextTime, context.nextTime, now, runId]
    );
    await this.#syncWake(runId, { struck: true });
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
        AND status IN ('pending', 'running')
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
   *
   * @returns False when the queue already carried exactly this wake and
   * nothing was written — a same-values upsert is still a billed row write.
   */
  async #syncWake(
    runId: string,
    options: { struck?: boolean } = {}
  ): Promise<boolean> {
    const rows = this.#store.sql<{ next_at: number | null }>`
      SELECT next_at FROM cf_agents_task_runs
      WHERE run_id = ${runId}
        AND status IN ('pending', 'running')
    `;
    const next = rows[0]?.next_at ?? null;

    if (this.lifecycle.routes.source) {
      // The run row stays here; only its deadline mirrors to the root that
      // owns the physical alarm.
      return (await this.lifecycle.routes.toRoot({
        type: "syncWake",
        runId,
        next,
        ...(options.struck && { struck: true })
      } satisfies TaskRouteMessage)) as boolean;
    }

    const jobId = `${WAKE_JOB_PREFIX}${runId}`;
    if (next === null) {
      await this.lifecycle.jobs.cancel(jobId);
      return true;
    }
    const existing = this.lifecycle.jobs.get(jobId);
    if (
      existing?.fn === WAKE_JOB_FN &&
      existing.time === next &&
      existing.retry?.maxAttempts === WAKE_JOB_RETRY.maxAttempts
    ) {
      return false;
    }
    await this.lifecycle.jobs.push({
      id: jobId,
      fn: WAKE_JOB_FN,
      time: next,
      payload: { runId } satisfies TaskWakeJobPayload,
      retry: WAKE_JOB_RETRY
    });
    return true;
  }

  /** Handle Tasks protocol messages routed by another Lifecycle. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as TaskRouteMessage;
    switch (message.type) {
      case "syncWake": {
        const owner = context.source;
        if (!owner) throw new Error("Routed Tasks message missing source");
        return this.#syncRoutedWake(
          owner,
          message.runId,
          message.next,
          message.struck === true
        );
      }
      case "dispatch":
        return this.#dispatchRoutedRun(message.runId);
      case "memoryLimit": {
        await this.#applyMemoryLimit(message.runId, message.context);
        // The owner's own Lifecycle never observes the root's alarm; this
        // is its only path to the same `onAlarmMemoryLimit` host hook a
        // root's own local strike reaches through Lifecycle's alarm
        // dispatch.
        const handler = taskRoutedMemoryLimitHandlers.get(this);
        if (handler) {
          await this.lifecycle.runInHostContext(() => handler(message.context));
        }
        return true;
      }
      default:
        throw new Error("Unknown routed Tasks message");
    }
  }

  /** Mirror a routed facet's run deadline into this root's job queue. */
  async #syncRoutedWake(
    owner: LifecycleRouteAddress,
    runId: string,
    next: number | null,
    struck = false
  ): Promise<boolean> {
    const jobId = `${WAKE_JOB_PREFIX}${owner.key}:${runId}`;
    if (next === null) {
      await this.lifecycle.jobs.cancel(jobId);
      return true;
    }
    const existing = this.lifecycle.jobs.get(jobId);
    // A struck wake stays struck while its deadline holds: the facet's own
    // startup re-sends that deadline without knowing of the strike.
    if (
      existing?.time === next &&
      isTaskWakeJobPayload(existing.payload) &&
      existing.payload.struck === true
    ) {
      struck = true;
    }
    if (
      existing?.fn === WAKE_JOB_FN &&
      existing.time === next &&
      existing.retry?.maxAttempts === WAKE_JOB_RETRY.maxAttempts &&
      isTaskWakeJobPayload(existing.payload) &&
      (existing.payload.struck === true) === struck
    ) {
      return false;
    }
    await this.lifecycle.jobs.push({
      id: jobId,
      fn: WAKE_JOB_FN,
      time: next,
      payload: {
        runId,
        owner_path: owner.data,
        owner_path_key: owner.key,
        ...(struck && { struck: true as const })
      } satisfies TaskWakeJobPayload,
      retry: WAKE_JOB_RETRY
    });
    return true;
  }

  /**
   * @internal Framework aperture: bulk-cancel this root's routed wake
   * mirrors for every run owned by a deleted facet subtree. The runs and
   * their step journals live on the deleted facets' own storage and are
   * wiped with them; only this root's mirror job needs an explicit cancel,
   * or it stays due forever, retrying a dispatch to a facet that is gone.
   */
  async __DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(
    prefix: string
  ): Promise<void> {
    for (const job of this.lifecycle.jobs.list()) {
      const timing = isTaskWakeJobPayload(job.payload)
        ? job.payload
        : undefined;
      const ownerKey = timing?.owner_path_key ?? timing?.owner_path;
      if (!timing?.owner_path || ownerKey === null || ownerKey === undefined) {
        continue;
      }
      if (ownerKey !== prefix && !ownerKey.startsWith(`${prefix}/`)) continue;
      await this.lifecycle.jobs.cancel(job.id);
    }
  }

  /** Mirror every non-terminal run into the queue (startup reconcile). */
  async #syncAllWakes(): Promise<void> {
    const rows = this.#store.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agents_task_runs
      WHERE status IN ('pending', 'running')
        AND next_at IS NOT NULL
    `;
    // On restart the mirror usually survived alongside the run row (same
    // storage), so most rows write nothing; wakes from before the one-attempt
    // policy are rewritten once.
    let pushed = false;
    for (const { run_id } of rows) {
      if (await this.#syncWake(run_id)) pushed = true;
    }
    // Pushes re-arm the physical alarm as a side effect; a reconcile that
    // wrote nothing must recover a lost alarm explicitly.
    if (rows.length > 0 && !pushed) await this.lifecycle.jobs.rearm();
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
      query += ` AND status IN (${states.map(() => "?").join(", ")})`;
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
   * Cancel one run.
   *
   * The run settles `aborted` at once; a live attempt's signal aborts, and
   * nothing it writes afterwards lands.
   *
   * @returns True when a non-terminal run accepted the request.
   */
  async cancel(runId: string, reason?: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATUSES.has(row.status)) return false;

    const active = this.#liveAttempt(runId);
    if (active) {
      // Settled now: the attempt's signal aborts, and nothing it writes
      // afterwards lands (its generation no longer owns the run).
      active.controller.abort(new TaskCancellation(reason));
      await this.#settleCancelled(runId, active.generation, reason);
      return true;
    }
    // A parked run settles in one write: #settleCancelled's UPDATE records
    // the request bits itself, so a separate request write would touch the
    // same row twice in the same synchronous block (one durable commit
    // either way — the split bought no crash evidence).
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
    const states = options.status ?? [
      "completed",
      "error",
      "aborted",
      "skipped"
    ];
    if (states.length === 0) return 0;
    let query = `SELECT run_id, definition FROM cf_agents_task_runs WHERE status IN (${states.map(() => "?").join(", ")})`;
    const params: (string | number)[] = [...states];
    if (options.definition !== undefined) {
      query += " AND definition = ?";
      params.push(options.definition);
    }
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
    options: TaskRunOptions = {},
    startMode: TaskStartMode = "warm",
    inputMustMatch = false
  ): Promise<TaskReceipt> {
    await this.lifecycle.ready();
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

    // A framework definition's input may outgrow one row (Think's
    // submissions carry whole message lists).
    const inputJson = serializeTaskValue(
      input,
      `input for Task definition "${definition}"`,
      this.#registered.has(definition)
        ? MAX_PARTED_INPUT_BYTES
        : MAX_SERIALIZED_BYTES
    );
    const metadataJson = serializeTaskValue(
      options.metadata,
      `metadata for Task definition "${definition}"`,
      this.#registered.has(definition)
        ? MAX_FRAMEWORK_METADATA_BYTES
        : MAX_SERIALIZED_BYTES
    );

    const byRunId =
      options.runId !== undefined
        ? this.#store.getRun(options.runId)
        : undefined;
    const existing =
      byRunId ??
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
      // The idempotency key is the deduplication authority: a run matched
      // by its key joins even when the caller requested a different (still
      // unused) runId — the receipt carries the real id. The reverse is a
      // conflict: a run matched by ID whose stored key differs from the
      // provided one would silently bind the caller's key to nothing.
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
      // Joining a run that was started with other input would drop the
      // caller's work without a word. The same data in another key order
      // is the same input.
      if (
        inputMustMatch &&
        existing.input !== inputJson &&
        canonicalJson(existing.input) !== canonicalJson(inputJson)
      ) {
        const error = new Error(
          `Task run "${existing.run_id}" was started with a different input; ` +
            `a reused ${byRunId ? "run ID" : "idempotency key"} ` +
            `must carry the same input`
        );
        error.name = "TaskInputConflictError";
        throw error;
      }
      // A prior accept can throw after already durably inserting this row —
      // most likely here, on the wake mirror, rather than on the insert
      // itself — so a caller retrying the same runId or idempotencyKey
      // after a failure needs this join to repair a missing or stale
      // mirror, not just report accepted:false against a row nothing will
      // ever wake.
      await this.#syncWake(existing.run_id);
      return {
        runId: existing.run_id,
        definition,
        accepted: false,
        status: existing.status,
        createdAt: existing.created_at
      };
    }

    const runId = options.runId ?? `task_${nanoid()}`;
    const now = Date.now();
    const lane = options.lane ?? null;
    const placed = this.#store.placeInput(runId, inputJson);
    // A run queued behind its lane's open run waits with no deadline (and
    // no wake job) until that run settles.
    const queued = lane !== null && this.#store.laneHead(lane) !== undefined;
    this.#store.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, status, metadata, idempotency_key, retain,
         attempt, next_at, cancel_requested, created_at, updated_at, lane, seq,
         input_parts)
      VALUES
        (${runId}, ${definition}, ${placed.input}, 'pending', ${metadataJson},
         ${options.idempotencyKey ?? null}, ${options.retain === false ? 0 : 1},
         0, ${queued ? null : now}, 0, ${now}, ${now}, ${lane},
         ${lane === null ? null : this.#store.nextLaneSeq(lane)},
         ${placed.parts})
    `;
    // Before the wake is published: an attempt this isolate starts from it
    // (the alarm can win the claim) still gets the caller's `local`.
    if (options.local !== undefined && startMode !== "queued") {
      this.#locals.set(runId, options.local);
    }
    // The run starts only once its `pending` report returned: its wake is
    // published after it (a reset in between leaves the row's deadline,
    // which the next start mirrors).
    await this.#report(runId);
    try {
      await this.#syncWake(runId);
    } catch (error) {
      // The caller gets the throw and owns its closure again.
      this.#locals.delete(runId);
      throw error;
    }
    this.#emit("task:accepted", { runId, definition, accepted: true });

    // Warm path: begin the first attempt immediately when the host is past
    // startup. The durable deadline above is authoritative either way.
    if (startMode === "warm") {
      if (this.lifecycle.status() === "starting") this.#locals.delete(runId);
      else {
        void this.#executeRun(runId)
          .catch(() => {})
          .finally(() => this.#locals.delete(runId));
      }
    }

    return {
      runId,
      definition,
      accepted: true,
      status: "pending",
      createdAt: now
    };
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /** Claim and drive one due run to its next durable boundary. */
  /**
   * @param byOwnWake - The run's own wake job is dispatching it: that job's
   *   outcome moves it to the claim deadline, so the claim needs no push.
   */
  async #executeRun(runId: string, byOwnWake = false): Promise<void> {
    if (this.#liveAttempt(runId)) return;
    // Read now: the caller that passed it may finish before the claim lands.
    const local = this.#locals.get(runId);
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATUSES.has(row.status)) return;
    if (!this.#laneAllows(row)) return;

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
      row.status === "running" ? this.#interruptedStep(runId) : null;
    if (row.status === "running") {
      this.#emit("task:attempt:interrupted", {
        runId,
        definition: row.definition,
        attempt: row.attempt,
        step: interrupted?.name ?? null
      });
    }

    const cap = this.#registeredOptions.get(row.definition)?.maxAttempts;
    if (cap !== undefined && row.attempt >= cap) {
      await this.#settleFailed(runId, null, {
        name: "TaskInterruptedError",
        message: `Interrupted ${row.attempt} times`
      });
      return;
    }
    const generation = nanoid();
    const attempt = row.attempt + 1;
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET status = 'running', attempt = ${attempt}, generation = ${generation},
          started_at = coalesce(started_at, ${now}),
          next_at = ${now + this.#claimTimeoutMs()}, wait_reason = NULL,
          updated_at = ${now}
      WHERE run_id = ${runId}
        AND status IN ('pending', 'running')
    `;
    // Mirror the claim deadline before the handler runs, not after: a
    // routed run's root has no other way to learn it, and a push here
    // clears the queue row's in-flight marker, so it durably wins over a
    // root dispatch that later returns a stale outcome past its own
    // budget (job-queue's own "newer pushes win" guard on that marker).
    // A local run its own wake dispatches needs none: the dispatch's
    // outcome is read from the row after the claim.
    if (!byOwnWake || this.lifecycle.routes.source) {
      await this.#syncWake(runId);
      // A cancel() that ran during that await found no live attempt and
      // settled the run itself. The claim is void then: start no handler.
      if (this.#store.getRun(runId)?.generation !== generation) return;
    }
    const capped = this.#registeredOptions.get(row.definition)?.maxAttempts;
    if (capped !== undefined) {
      // The attempt counts only once it is durable: a reset before the first
      // I/O would roll the claim back and the same attempt would run again.
      await this.lifecycle.storage.sync();
      if (this.#store.getRun(runId)?.generation !== generation) return;
    }
    await this.#report(runId);
    if (this.#store.getRun(runId)?.generation !== generation) return;

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
      interrupted,
      now,
      local
    );
    this.#active.set(runId, { generation, controller, promise });
    try {
      await promise;
    } finally {
      // A run reusing this id may have started its own attempt since.
      if (this.#active.get(runId)?.generation === generation) {
        this.#active.delete(runId);
      }
    }
  }

  /**
   * The attempt running `runId` in this isolate, if it still owns the run:
   * one left behind by a cancel, or by a delete and a new run under the
   * same id, does not count.
   */
  #liveAttempt(runId: string): ActiveAttempt | undefined {
    const active = this.#active.get(runId);
    if (!active) return undefined;
    if (this.#store.getRun(runId)?.generation === active.generation) {
      return active;
    }
    return undefined;
  }

  /** Run one claimed attempt and persist its outcome, generation-fenced. */
  async #runAttempt(
    row: TaskRunRow,
    handler: TaskCallbacks[string],
    generation: string,
    attempt: number,
    controller: AbortController,
    interrupted: { name: string; attempt: number } | null,
    claimedAtMs: number,
    local: unknown
  ): Promise<void> {
    const runId = row.run_id;
    const input = deserializeTaskValue(this.#store.inputJson(row));
    const engine = this.#createEngine(
      runId,
      row.definition,
      generation,
      controller,
      claimedAtMs
    );
    const store = this.#store;
    const step = new ReplayStep(engine, {
      startsLive: attempt === 1,
      interrupted,
      local,
      id: runId,
      attempt,
      signal: controller.signal,
      createdAt: row.created_at,
      checkpoint: {
        get: <T extends TaskJson>(key: string) =>
          store.getCheckpoint(runId, key) as T | undefined,
        set: (key, value) => store.setCheckpoint(runId, generation, key, value)
      }
    });

    try {
      const output = await this.lifecycle.runInHostContext(() =>
        handler(input, step)
      );
      if (output instanceof TaskSettlement) {
        await this.#settleReturned(row, generation, output);
        return;
      }
      const resultJson = serializeTaskValue(
        output,
        `result of Task definition "${row.definition}"`
      );
      const settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET status = 'completed', result = ?, generation = NULL, next_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ? AND status = 'running'
           AND cancel_requested = 0`,
        [resultJson, Date.now(), Date.now()]
      );
      if (settled) {
        this.#emit("task:completed", { runId, definition: row.definition });
        await this.#finishTerminalSettlement(runId, row);
      } else {
        // A cancel requested while the attempt ran wins over its result.
        await this.#settleRequestedCancel(runId, generation);
      }
      // Fence rejected: a newer generation owns the run, and every deadline
      // mutation it makes funnels through its own #syncWake — a push here
      // would be a redundant job-row write.
    } catch (thrown) {
      await this.#settleThrown(row, generation, thrown);
    }
  }

  /**
   * Settle a run `aborted` when a cancel was requested while the attempt
   * holding `generation` ran.
   *
   * @returns Whether it did.
   */
  async #settleRequestedCancel(
    runId: string,
    generation: string
  ): Promise<boolean> {
    const current = this.#store.getRun(runId);
    if (current?.cancel_requested !== 1 || current.generation !== generation) {
      return false;
    }
    await this.#settleCancelled(
      runId,
      generation,
      current.cancel_reason ?? undefined
    );
    return true;
  }

  /** Persist a settlement a handler returned. */
  async #settleReturned(
    row: TaskRunRow,
    generation: string,
    settlement: TaskSettlement
  ): Promise<void> {
    const runId = row.run_id;
    const now = Date.now();
    if (await this.#settleRequestedCancel(runId, generation)) return;
    if (settlement.kind === "failed") {
      await this.#settleFailed(
        runId,
        generation,
        toErrorSummary(settlement.error)
      );
      return;
    }
    if (settlement.kind === "aborted") {
      await this.#settleCancelled(runId, generation, settlement.reason);
      return;
    }
    if (settlement.kind === "skipped") {
      const settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET status = 'skipped', cancel_reason = ?, generation = NULL,
             next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ? AND status = 'running'`,
        [settlement.reason ?? null, now, now]
      );
      if (settled) {
        this.#emit("task:skipped", {
          runId,
          definition: row.definition,
          reason: settlement.reason ?? null
        });
        await this.#finishTerminalSettlement(runId, row);
      }
      return;
    }
    const parked = this.#store.fencedWrite(
      runId,
      generation,
      `UPDATE cf_agents_task_runs
       SET status = 'pending', wait_reason = 'park', cancel_reason = ?,
           generation = NULL, next_at = NULL, updated_at = ?
       WHERE run_id = ? AND generation = ? AND status = 'running'`,
      [settlement.reason ?? null, now]
    );
    if (parked) {
      this.#emit("task:waiting", {
        runId,
        definition: row.definition,
        reason: "park",
        wakeAt: null
      });
      await this.#syncWake(runId);
      await this.#report(runId);
    }
  }

  /**
   * @internal End a run that no attempt runs in this isolate (parked, or
   * left `running` by a reset) as `outcome` says: a returned settlement, or
   * a value that completes it. Two settles that race end it once.
   *
   * @returns False unless the run was parked or interrupted.
   */
  async settle(
    runId: string,
    outcome: TaskSettlement | TaskValue
  ): Promise<boolean> {
    await this.lifecycle.ready();
    if (this.#liveAttempt(runId)) return false;
    const row = this.#store.getRun(runId);
    if (!row) return false;
    const parked = row.status === "pending" && row.wait_reason === "park";
    if (!parked && row.status !== "running") return false;
    // Take the run as an attempt of this call, so the settle writes below
    // are fenced like an attempt's and a racing settle finds nothing.
    const generation = nanoid();
    const claimed = this.#store.write(
      `UPDATE cf_agents_task_runs
       SET status = 'running', generation = ?, wait_reason = NULL,
           updated_at = ?
       WHERE run_id = ? AND status = ? AND generation IS ?`,
      [generation, Date.now(), runId, row.status, row.generation]
    );
    if (claimed === 0) return false;
    if (outcome instanceof TaskSettlement) {
      await this.#settleReturned(row, generation, outcome);
      return true;
    }
    const now = Date.now();
    const settled = this.#store.fencedWrite(
      runId,
      generation,
      `UPDATE cf_agents_task_runs
       SET status = 'completed', result = ?, generation = NULL, next_at = NULL,
           settled_at = ?, updated_at = ?
       WHERE run_id = ? AND generation = ? AND status = 'running'`,
      [serializeTaskValue(outcome, `result of Task run "${runId}"`), now, now]
    );
    if (settled) {
      this.#emit("task:completed", { runId, definition: row.definition });
      await this.#finishTerminalSettlement(runId, row);
    }
    return true;
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

    if (isPlatformFailure(thrown)) {
      // Platform-class failure (superseded isolate, memory-limit reset,
      // storage transient): not an application outcome, so the run must not
      // settle. Unwind and rethrow — the claim backstop written at claim
      // time is the durable wake, and the next invocation reclaims and
      // replays the run; a queue-driven dispatch defers through the
      // driver's platform-failure path.
      throw thrown;
    }

    if (isTaskCancellation(thrown)) {
      await this.#settleCancelled(runId, generation, thrown.reason);
      return;
    }
    // The attempt failed because a requested cancel aborted it.
    if (await this.#settleRequestedCancel(runId, generation)) return;

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
         SET status = 'pending', wait_reason = ?, next_at = ?, generation = NULL,
             updated_at = ?
         WHERE run_id = ? AND generation = ? AND status = 'running'`,
        [thrown.reason, thrown.wakeAt, Date.now()]
      );
      if (suspended) {
        this.#emit("task:waiting", {
          runId,
          definition: row.definition,
          reason: thrown.reason,
          wakeAt: thrown.wakeAt
        });
        await this.#syncWake(runId);
      }
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
    controller: AbortController,
    claimedAtMs: number
  ): TaskStepEngine {
    return createTaskStepEngine({
      store: this.#store,
      runId,
      generation,
      signal: controller.signal,
      claimTimeoutMs: () => this.#claimTimeoutMs(),
      claimedAtMs,
      claimRefreshAfterMs: CLAIM_SLACK_MS / 2,
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
         SET status = 'aborted', cancel_requested = 1, cancel_reason = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND status = 'running'`,
        [reason ?? null, now, now]
      );
    } else {
      const written = this.#store.write(
        `UPDATE cf_agents_task_runs
         SET status = 'aborted', cancel_requested = 1, cancel_reason = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND status IN ('pending', 'running')`,
        [reason ?? null, now, now, runId]
      );
      settled = written > 0;
    }
    const row = settled ? this.#store.getRun(runId) : undefined;
    if (row) {
      this.#emit("task:cancelled", {
        runId,
        definition: row.definition,
        reason: reason ?? null
      });
      await this.#finishTerminalSettlement(runId, row);
    }
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
         SET status = 'error', error_name = ?, error_message = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND status = 'running'`,
        [error.name, error.message, now, now]
      );
    } else {
      const written = this.#store.write(
        `UPDATE cf_agents_task_runs
         SET status = 'error', error_name = ?, error_message = ?,
             generation = NULL, next_at = NULL, settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND status IN ('pending', 'running')`,
        [error.name, error.message, now, now, runId]
      );
      settled = written > 0;
    }
    const row = settled ? this.#store.getRun(runId) : undefined;
    if (row) {
      this.#emit("task:failed", {
        runId,
        definition: row.definition,
        error: error.name
      });
      await this.#finishTerminalSettlement(runId, row);
    }
    return settled;
  }

  /** Apply terminal retention policy, then remove the run's wake mirror. */
  async #finishTerminalSettlement(
    runId: string,
    row: TaskRunRow | undefined
  ): Promise<void> {
    // Nothing reads a settled run's checkpoint.
    this.#store.deleteCheckpoint(runId);
    const onStatus =
      row && this.#registeredOptions.get(row.definition)?.onStatus;
    if (onStatus && !this.lifecycle.routes.source) {
      // The terminal report must outlive a reset before it returns: the
      // run's wake stays until then (when due it delivers the report), and
      // a run with none (queued in a lane) gets the report job.
      if (!this.lifecycle.jobs.get(`${WAKE_JOB_PREFIX}${runId}`)) {
        await this.#pushReportJob(REPORT_RETRY_MS);
      }
    } else {
      await this.#syncWake(runId);
    }
    // Only the head settling moves its lane on: a run queued behind it that
    // ends (a cancel, a clear) leaves the head where it is.
    if (row?.lane != null && row.seq != null) {
      const head = this.#store.laneHead(row.lane);
      if (head?.seq != null && head.seq > row.seq) {
        await this.#wakeLane(row.lane);
      }
    }
    const reported =
      row !== undefined &&
      (this.#registeredOptions.get(row.definition)?.onStatus !== undefined ||
        this.#waiters.has(runId));
    if (!reported) {
      if (row?.retain === 0) this.#store.deleteRun(runId);
      return;
    }
    await this.#deliverTerminal(runId, row.retain !== 0);
    if (onStatus && !this.lifecycle.routes.source) await this.#syncWake(runId);
  }

  /**
   * Report a run's status to its definition's `onStatus`, in host context.
   * A throw is logged; a non-terminal report is not repeated.
   */
  async #report(runId: string): Promise<void> {
    if (this.#registeredOptions.size === 0) return;
    const row = this.#store.getRun(runId);
    const onStatus =
      row && this.#registeredOptions.get(row.definition)?.onStatus;
    if (!row || !onStatus) return;
    try {
      await this.lifecycle.runInHostContext(() =>
        onStatus(this.#store.rowToRecord(row))
      );
    } catch (error) {
      console.error(`[tasks] onStatus of "${row.definition}" failed`, error);
    }
  }

  /**
   * Report a terminal run at least once: `notified` takes its status after
   * `onStatus` returns. A throw (or a reset before the write) leaves it
   * unreported, and the report job delivers it again.
   *
   * @returns The reported snapshot, or null when it is still unreported.
   */
  async #reportTerminal(runId: string): Promise<TaskRecord | null> {
    const row = this.#store.getRun(runId);
    if (!row || !TERMINAL_STATUSES.has(row.status)) return null;
    const record = this.#store.rowToRecord(row);
    const onStatus = this.#registeredOptions.get(row.definition)?.onStatus;
    if (!onStatus || row.notified === row.status) return record;
    this.#reporting.add(runId);
    try {
      await this.lifecycle.runInHostContext(() => onStatus(record));
    } catch (error) {
      console.error(`[tasks] onStatus of "${row.definition}" failed`, error);
      await this.#pushReportJob(REPORT_RETRY_MS);
      return null;
    } finally {
      this.#reporting.delete(runId);
    }
    this.#store.sql`
      UPDATE cf_agents_task_runs SET notified = ${row.status}
      WHERE run_id = ${runId} AND status = ${row.status}
    `;
    return record;
  }

  #pushReportJob(delayMs = 0): Promise<unknown> {
    return this.lifecycle.jobs.push({
      id: REPORT_JOB_ID,
      fn: REPORT_JOB_FN,
      time: Date.now() + delayMs,
      retry: WAKE_JOB_RETRY
    });
  }

  /** Deliver the terminal reports a reset or a throw left undelivered. */
  async #replayReports(): Promise<void> {
    const names = [...this.#registeredOptions.keys()].filter(
      (name) => this.#registeredOptions.get(name)?.onStatus
    );
    if (names.length === 0) return;
    const rows = this.#store.sql<TaskRunRow>`
      SELECT * FROM cf_agents_task_runs
      WHERE status IN ('completed', 'error', 'aborted', 'skipped')
        AND (notified IS NULL OR notified != status)
        AND definition IN (SELECT value FROM json_each(${JSON.stringify(names)}))
      ORDER BY settled_at LIMIT ${REPORT_BATCH}
    `;
    for (const row of rows) {
      if (!(await this.#deliverTerminal(row.run_id, row.retain !== 0))) {
        return;
      }
    }
    // More may be waiting past this batch: the next one runs now.
    if (rows.length === REPORT_BATCH) await this.#pushReportJob();
  }

  /**
   * Report a terminal run, then drop it if it is not retained and answer
   * its waiters.
   *
   * @returns False when the report did not go through (it is retried).
   */
  async #deliverTerminal(runId: string, retain: boolean): Promise<boolean> {
    const record = await this.#reportTerminal(runId);
    if (!record) return false;
    if (!retain) this.#store.deleteRun(runId);
    this.#resolveWaiters(runId, record);
    return true;
  }

  /** Resolve the waiters of this run (not of an earlier one of its id). */
  #resolveWaiters(runId: string, record: TaskRecord): void {
    const waiters = this.#waiters.get(runId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.createdAt === record.createdAt) waiter.resolve(record);
    }
  }

  /**
   * @internal Whether a run is terminal and its terminal report (if its
   * definition has `onStatus`) returned.
   */
  isSettled(runId: string): boolean {
    const row = this.#store.getRun(runId);
    if (!row || !TERMINAL_STATUSES.has(row.status)) return false;
    const onStatus = this.#registeredOptions.get(row.definition)?.onStatus;
    return !onStatus || row.notified === row.status;
  }

  /**
   * @internal Resolve with a run's record once it is settled
   * ({@link isSettled}); at once for one that already is, with the record
   * as it is on `timeoutMs`, with the record it had when deleted, and with
   * `null` for an unknown id or when `signal` aborts. The wait lives in this
   * isolate's memory.
   */
  async wait(
    runId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<TaskRecord | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row) return null;
    if (this.isSettled(runId)) return this.#store.rowToRecord(row);
    if (options.signal?.aborted) return null;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        createdAt: row.created_at,
        resolve: (record: TaskRecord) => done(record)
      };
      const done = (record: TaskRecord | null) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        const set = this.#waiters.get(runId);
        set?.delete(waiter);
        if (set?.size === 0) this.#waiters.delete(runId);
        resolve(record);
      };
      const onAbort = () => done(null);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => done(this.peek(runId) ?? null),
          options.timeoutMs
        );
      }
      let set = this.#waiters.get(runId);
      if (!set) this.#waiters.set(runId, (set = new Set()));
      set.add(waiter);
    });
  }

  /**
   * Whether a run may start now: a run outside a lane always may; a lane
   * run only when it is its lane's head and the lane is not held.
   */
  #laneAllows(row: TaskRunRow | undefined): boolean {
    if (row?.lane == null) return true;
    if (this.#heldLanes.has(row.lane)) return false;
    return this.#store.laneHead(row.lane)?.run_id === row.run_id;
  }

  #hasUnreported(): boolean {
    const names = [...this.#registeredOptions.keys()].filter(
      (name) => this.#registeredOptions.get(name)?.onStatus
    );
    if (names.length === 0) return false;
    return (
      this.#store.sql`
        SELECT 1 FROM cf_agents_task_runs
        WHERE status IN ('completed', 'error', 'aborted', 'skipped')
          AND (notified IS NULL OR notified != status)
          AND definition IN (SELECT value FROM json_each(${JSON.stringify(names)}))
        LIMIT 1
      `.length > 0
    );
  }

  /** Give a lane's head a deadline of now if it waits without one. */
  async #wakeLane(lane: string): Promise<void> {
    if (this.#heldLanes.has(lane)) return;
    const head = this.#store.laneHead(lane);
    if (!head) return;
    if (
      head.status === "pending" &&
      head.next_at === null &&
      head.wait_reason !== "park"
    ) {
      const now = Date.now();
      this.#store.sql`
        UPDATE cf_agents_task_runs SET next_at = ${now}, updated_at = ${now}
        WHERE run_id = ${head.run_id} AND status = 'pending'
      `;
    }
    await this.#syncWake(head.run_id);
  }

  /**
   * @internal One run's record, read synchronously (Tasks must have
   * started), or `undefined` for an unknown run.
   */
  peek(runId: string): TaskRecord | undefined {
    const row = this.#store.getRun(runId);
    return row && this.#store.rowToRecord(row);
  }

  /** @internal The run holding an idempotency key, read synchronously. */
  peekByIdempotencyKey(idempotencyKey: string): TaskRecord | undefined {
    const row = this.#store.getRunByKey(idempotencyKey);
    return row && this.#store.rowToRecord(row);
  }

  /**
   * @internal Records of one definition, read synchronously, oldest or
   * newest first. An empty `status` list matches nothing.
   */
  peekList(options: {
    definition: string;
    status?: readonly TaskStatus[];
    /** Pending runs match only when parked (true) or only when not (false). */
    parked?: boolean;
    order?: "oldest" | "newest";
    limit?: number;
  }): TaskRecord[] {
    if (options.status?.length === 0) return [];
    const params: (string | number)[] = [options.definition];
    let query = "SELECT * FROM cf_agents_task_runs WHERE definition = ?";
    if (options.status) {
      query += ` AND status IN (${options.status.map(() => "?").join(", ")})`;
      params.push(...options.status);
    }
    if (options.parked !== undefined) {
      query += ` AND (status != 'pending' OR (coalesce(wait_reason, '') = 'park') = ?)`;
      params.push(options.parked ? 1 : 0);
    }
    const direction = options.order === "oldest" ? "ASC" : "DESC";
    query += ` ORDER BY created_at ${direction}, run_id ${direction} LIMIT ?`;
    params.push(options.limit ?? DEFAULT_LIST_LIMIT);
    let rows: unknown[];
    try {
      rows = this.lifecycle.storage.sql.exec(query, ...params).toArray();
    } catch (cause) {
      throw new SqlError(query, cause);
    }
    // SAFETY: the query selects * from Tasks' own schema.
    return (rows as TaskRunRow[]).map((row) => this.#store.rowToRecord(row));
  }

  /**
   * @internal Delete one terminal run and what it kept.
   *
   * @returns False when the run is unknown or still open.
   */
  deleteRun(runId: string): boolean {
    const row = this.#store.getRun(runId);
    if (!row || !TERMINAL_STATUSES.has(row.status)) return false;
    this.#store.deleteRun(runId);
    this.#emit("task:deleted", { runId, definition: row.definition });
    // A report in flight resolves its waiters when it returns.
    if (!this.#reporting.has(runId)) {
      this.#resolveWaiters(runId, this.#store.rowToRecord(row));
    }
    return true;
  }

  /**
   * @internal Write a run that an adopter carries forward from its own
   * older storage, once: a run already under `runId` is left alone. A
   * `running` one comes back as interrupted (its next attempt re-runs it);
   * terminal ones count as reported.
   *
   * @returns False when a run with this id exists.
   */
  async importRun(record: {
    runId: string;
    definition: string;
    status: TaskStatus;
    attempt: number;
    input?: TaskJson;
    metadata?: Record<string, TaskJson>;
    idempotencyKey?: string;
    lane?: string;
    error?: string;
    /** A completed run's result. */
    result?: TaskJson;
    retain?: boolean;
    createdAt: number;
    startedAt?: number;
    settledAt?: number;
  }): Promise<boolean> {
    await this.lifecycle.ready();
    if (this.#store.getRun(record.runId)) return false;
    const open = record.status === "pending" || record.status === "running";
    const lane = record.lane ?? null;
    const queued =
      open && lane !== null && this.#store.laneHead(lane) !== undefined;
    const now = Date.now();
    const importedInput = this.#store.placeInput(
      record.runId,
      serializeTaskValue(
        record.input,
        `input of imported run "${record.runId}"`,
        MAX_PARTED_INPUT_BYTES
      )
    );
    this.#store.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, status, metadata, idempotency_key, retain,
         attempt, generation, next_at, error_name, error_message,
         cancel_requested, cancel_reason, created_at, started_at, updated_at,
         settled_at, lane, seq, notified, input_parts, result)
      VALUES
        (${record.runId}, ${record.definition},
         ${importedInput.input},
         ${record.status},
         ${serializeTaskValue(record.metadata, `metadata of imported run "${record.runId}"`, MAX_FRAMEWORK_METADATA_BYTES)},
         ${record.idempotencyKey ?? null}, ${record.retain === false ? 0 : 1},
         ${record.attempt},
         ${record.status === "running" ? "imported" : null},
         ${open && !queued ? now : null},
         ${record.status === "error" ? "Error" : null},
         ${record.status === "error" ? (record.error ?? null) : null},
         0,
         ${record.status === "aborted" || record.status === "skipped" ? (record.error ?? null) : null},
         ${record.createdAt}, ${record.startedAt ?? null}, ${now},
         ${open ? null : (record.settledAt ?? now)}, ${lane},
         ${lane === null ? null : this.#store.nextLaneSeq(lane)},
         ${open ? null : record.status}, ${importedInput.parts},
         ${record.status === "completed" ? serializeTaskValue(record.result, `result of imported run "${record.runId}"`) : null})
    `;
    if (open && !queued) await this.#syncWake(record.runId);
    return true;
  }

  /** @internal Whether {@link holdLane} holds `lane` in this isolate. */
  isLaneHeld(lane: string): boolean {
    return this.#heldLanes.has(lane);
  }

  /** @internal A run's input as accepted, or `undefined` for an unknown run. */
  inputOf<T = unknown>(runId: string): T | undefined {
    const row = this.#store.getRun(runId);
    return row
      ? (deserializeTaskValue(this.#store.inputJson(row)) as T)
      : undefined;
  }

  /**
   * @internal Rewrite a run's metadata from host code (progress its caller
   * tracks): `update` gets the current metadata and returns the next.
   *
   * @returns False for an unknown run.
   */
  updateMetadata(
    runId: string,
    update: (metadata: Record<string, TaskJson>) => Record<string, TaskJson>
  ): boolean {
    const row = this.#store.getRun(runId);
    if (!row) return false;
    const current =
      row.metadata === null
        ? {}
        : (JSON.parse(row.metadata) as Record<string, TaskJson>);
    const json = serializeTaskValue(
      update(current),
      `metadata of Task run "${runId}"`,
      this.#registered.has(row.definition)
        ? MAX_FRAMEWORK_METADATA_BYTES
        : MAX_SERIALIZED_BYTES
    );
    this.#store.sql`
      UPDATE cf_agents_task_runs SET metadata = ${json}, updated_at = ${Date.now()}
      WHERE run_id = ${runId}
    `;
    return true;
  }

  /**
   * @internal End every open run of `lane` as `skipped`, a running attempt
   * included (its signal aborts; nothing it writes afterwards lands). The
   * writes happen before the first await, so a caller that reads the lane
   * right after the call sees them.
   */
  async clear(lane: string, reason?: string): Promise<void> {
    if (this.lifecycle.status() !== "started") await this.lifecycle.ready();
    const now = Date.now();
    const rows = this.#store.sql<TaskRunRow>`
      UPDATE cf_agents_task_runs
      SET status = 'skipped', cancel_reason = ${reason ?? null},
          generation = NULL, next_at = NULL, settled_at = ${now},
          updated_at = ${now}
      WHERE lane = ${lane} AND status IN ('pending', 'running')
      RETURNING *
    `;
    for (const row of rows) {
      this.#active
        .get(row.run_id)
        ?.controller.abort(new TaskCancellation(reason));
    }
    for (const row of rows) {
      this.#emit("task:skipped", {
        runId: row.run_id,
        definition: row.definition,
        reason: reason ?? null
      });
      await this.#finishTerminalSettlement(row.run_id, row);
    }
  }

  /**
   * @internal Keep a lane's runs from starting, in this isolate, until
   * {@link releaseLane}: runs an earlier isolate left wait while the host
   * decides who owns them.
   */
  holdLane(lane: string): void {
    this.#heldLanes.add(lane);
  }

  /** @internal Let a held lane run again. */
  async releaseLane(lane: string): Promise<void> {
    if (!this.#heldLanes.delete(lane)) return;
    await this.#wakeLane(lane);
  }

  /** Make deadlines sane after a fresh isolate: interrupted work wakes now. */
  #reconcile(): void {
    const now = Date.now();
    // A fresh isolate has no live attempts, so every claimed row is an
    // interrupted attempt: make it due immediately for reclaim and replay.
    this.#store.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now}, updated_at = ${now}
      WHERE status = 'running' AND generation IS NOT NULL
    `;
    // Non-terminal rows must always carry a deadline, except runs queued
    // behind their lane's head; repair any without one.
    this.#store.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now}, updated_at = ${now}
      WHERE status = 'pending' AND next_at IS NULL
        AND (wait_reason IS NULL OR wait_reason != 'park') AND (
        lane IS NULL OR run_id = (
          SELECT head.run_id FROM cf_agents_task_runs AS head
          WHERE head.lane = cf_agents_task_runs.lane
            AND head.status IN ('pending', 'running')
          ORDER BY head.seq LIMIT 1
        )
      )
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

/**
 * Stored JSON text in a form where object keys are sorted at every depth,
 * so two serializations of the same data compare equal.
 */
function canonicalJson(json: string | null): string | null {
  if (json === null) return null;
  // Deeply nested input can exhaust the stack while sorting; compare it as
  // stored instead.
  try {
    return sortedJson(json);
  } catch (error) {
    if (error instanceof RangeError) return json;
    throw error;
  }
}

function sortedJson(json: string): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sort((value as Record<string, unknown>)[key])])
      );
    }
    return value;
  };
  return JSON.stringify(sort(JSON.parse(json)));
}
