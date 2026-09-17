/**
 * Durable replayable execution for Lifecycle Objects. `StateMachine` owns the
 * `cf_agents_task_runs`, `cf_agents_task_journal`, `cf_agents_task_mailbox`,
 * `cf_agents_task_asks` and `cf_agents_task_routes` tables, the definitions
 * registry, run acceptance, generation-fenced claiming, and due-run
 * processing.
 *
 * StateMachine consumes only the standard capability services: storage, the job
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
import type { Streams } from "../streams/streams";
import type { StreamState, StreamWriter } from "../streams/types";
import { StreamClosedError } from "../streams/errors";
import { SqlError } from "../sql-error";
import {
  JOURNAL_REBUILD_BATCH,
  JOURNAL_REBUILD_START,
  JOURNAL_REBUILD_WARN_ROWS,
  TaskStore,
  type TaskJournalCursor
} from "./store";
import { createTaskStepEngine } from "./engine-port";
import {
  CHILD_MAILBOX_KIND,
  childMailboxKey,
  COMPILED_CHECKPOINT,
  COMPILED_PHASE,
  isCompiledCheckpoint,
  phaseOf,
  parseDefinitionName,
  readTaskTerminal,
  type TaskTerminalSignal
} from "./machine";
import { parseTaskDuration } from "./duration";
import {
  StateMachineMailboxFullError,
  StateMachineCancelCannotParkError,
  StateMachineDeadlineExceededError,
  StateMachineInterruptionsExhaustedError,
  StateMachineMissingDefinitionError,
  StateMachineNoProgressError,
  StateMachineOrphanedDefinitionError,
  StateMachineTransitionBudgetError,
  StateMachineTurnDeadlineExceededError
} from "./errors";
import type {
  StateMachineEventType,
  StateMachineFailedRun,
  StateMachineOptions
} from "./options";
import {
  AttemptSupersededError,
  TaskCancellation,
  computeRetryDelayMs,
  isTaskCancellation,
  isTaskSuspension,
  ReplayStep,
  resolveRetryPolicy,
  toErrorSummary,
  type TaskStepEngine,
  type ResolvedRetryPolicy,
  type ResolvedStepPolicy
} from "./replay";
import {
  deserializeTaskValue,
  serializeTaskCheckpoint,
  serializeTaskValue
} from "./serialization";
import type {
  AnyStateMachineDefinition,
  AskKind,
  StateMachineAbortMark,
  StateMachineAnswerReceipt,
  StateMachineAskRecord,
  StateMachineAskState,
  StateMachineChange,
  StateMachineChangeType,
  StateMachineDefinitions,
  StateMachineHandle,
  StateMachineInput,
  StateMachineInternalHandle,
  StateMachineJson,
  StateMachineOutput,
  StateMachineReceipt,
  StateMachineRunHandle,
  StateMachineRunOptions,
  TaskRunRow,
  StateMachineRunSnapshot,
  StateMachineRunState,
  StateMachineRunView,
  StateMachineSendOptions,
  StateMachineSendReceipt,
  StateMachineSpawnOptions,
  StateMachineStreamOptions,
  StateMachineStartMode,
  StateMachineState,
  StateMachineValue,
  StateMachineWaitReason
} from "./types";

/**
 * A composition-root fallback for definition names outside the declared
 * map. The value type is the engine's machine form (`StateMachineDefinitions`),
 * so a host resolving concretely-typed definitions casts once, here, and
 * nowhere else.
 */
export type StateMachineDefinitionResolver = (
  name: string
) => AnyStateMachineDefinition | undefined;

/** A resolver plus the names it can currently resolve, for versioning. */
type ResolverEntry = {
  resolve: StateMachineDefinitionResolver;
  names: () => Iterable<string>;
};

const taskDefinitionResolvers = new WeakMap<object, ResolverEntry>();

/**
 * @internal Supply a composition-root fallback for definition names outside
 * the declared map. Frameworks use this to attach internal definitions (for
 * example a future Agent compatibility layer) without occupying the host's
 * constructor map; resolved handlers still run inside the Lifecycle host
 * boundary. The resolver must return the same definition for a name on
 * every Durable Object wake, or that name's in-flight runs cannot resume.
 */
export function setStateMachineDefinitionResolver(
  tasks: LifecycleCapability,
  resolver: StateMachineDefinitionResolver,
  names: () => Iterable<string> = () => []
): void {
  taskDefinitionResolvers.set(tasks, { resolve: resolver, names });
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
export function setStateMachineRoutedMemoryLimitHandler(
  tasks: LifecycleCapability,
  handler: (context: MemoryLimitContext) => void | Promise<void>
): void {
  taskRoutedMemoryLimitHandlers.set(tasks, handler);
}

/** A durable function definition, as the engine holds one for dispatch. */

const FIBER_SCHEMA_VERSION_KEY = "cf_agents:tasks_schema_version";
/**
 * 3: the checkpoint and its turn, the derived definition identity, the
 * progress and transition counters, the abort mark, the transition
 * watchdog, the ownership tree and the stream identity on run rows; the
 * turn-scoped journal replacing `cf_agents_task_steps`; and the mailbox,
 * ask and routed-owner tables.
 */
const CURRENT_FIBER_SCHEMA_VERSION = 3;
/**
 * The intermediate version the batched journal rebuild runs under. Rows
 * copy in bounded transactions, so a crash mid-rebuild resumes from the
 * cursor rather than restarting — and no definition dispatches until the
 * cursor completes, so a half-copied journal is never read by a replay.
 */
const JOURNAL_REBUILD_VERSION = 2.5;
/** How far the journal rebuild has copied: a `[runId, name]` pair. */
const JOURNAL_CURSOR_KEY = "cf_agents:tasks_journal_cursor";

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

/** Rule A: no-progress transitions tolerated before a run faults. */
const DEFAULT_STALL_LIMIT = 1;
/** Rule B: transitions since the last park before a run faults. */
const DEFAULT_TRANSITION_BUDGET = 1000;
/** The park a tolerated no-progress transition takes, per stall. */
const STALL_BACKOFF_MS = 1_000;
/** How many phases a transition-budget fault names. */
const BUDGET_TRAIL = 8;
/** The outcomes that keep a run row regardless of `retain`. */
const PRESERVED_OUTCOMES = new Set(["faulted", "orphaned"]);
/** Which abort-mark state a fenced write requires (§5.2). */
type MarkPredicate = "null" | "set" | "any";
/** Mailbox items a run may hold before `send` refuses (§7.4). */
const DEFAULT_MAILBOX_LIMIT = 1000;
/** The parks a mailbox write wakes. */
const MAILBOX_PARKS = ["mailbox", "event"] as const;
/** The parks whose `next_at` is a `within` deadline rather than a wake. */
const EVENT_DRIVEN_PARKS = new Set<StateMachineWaitReason>([
  "mailbox",
  "event",
  "ask",
  "child"
]);
/** The event types `watch` turns into a change, and which change. */
const CHANGE_OF: Record<string, StateMachineChangeType> = {
  "task:accepted": "accepted",
  "task:attempt:started": "claimed",
  "task:checkpoint": "checkpoint",
  "task:step:completed": "progress",
  "task:mailbox": "mailbox",
  "task:ask": "ask",
  "task:answer": "answer",
  "task:child": "child",
  "task:waiting": "waiting",
  "task:paused": "waiting",
  "task:completed": "settled",
  "task:failed": "settled",
  "task:cancelled": "settled"
};

const TERMINAL_STATES: ReadonlySet<StateMachineRunState> = new Set([
  "completed",
  "failed",
  "cancelled"
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
};

/** Where the journal rebuild left off, or the start when it has not run. */
function readJournalCursor(storage: DurableObjectStorage): TaskJournalCursor {
  const stored = storage.kv.get<string>(JOURNAL_CURSOR_KEY);
  if (typeof stored !== "string") return JOURNAL_REBUILD_START;
  // SAFETY: written by #rebuildJournal from a cursor of this shape.
  return JSON.parse(stored) as TaskJournalCursor;
}

/** The three machine verbs a definition lens carries, pending that engine. */
/** The names a run has streamed under, recorded on its row. */
function streamNames(row: TaskRunRow): string[] {
  if (row.stream_tag === null) return [];
  try {
    const parsed: unknown = JSON.parse(row.stream_tag);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

/** The id of one engine-owned stream: run, name, epoch (§9.1). */
function engineStreamId(runId: string, name: string, epoch: number): string {
  return `${runId}:${name}#${epoch}`;
}

/** True for a machine that opted into the fresh-invocation cancel. */
function declaresOnCancel(definition: AnyStateMachineDefinition): boolean {
  return (
    typeof definition.onCancel === "function" &&
    !isCompiledCheckpoint(definition.initial)
  );
}

/** The SQL fragment one mark predicate compiles to (§5.2). */
function markClause(mark: MarkPredicate): string {
  switch (mark) {
    case "null":
      return "abort_mark IS NULL";
    case "set":
      return "abort_mark IS NOT NULL";
    case "any":
      return "1 = 1";
  }
}

/** The start mode one set of run options asks for, `warm` when unset. */
function startMode(
  options: StateMachineRunOptions | undefined
): StateMachineStartMode {
  const start = options?.start;
  if (start === undefined) return "warm";
  if (start !== "warm" && start !== "queued" && start !== "attached") {
    throw new Error(
      `start must be "warm", "queued" or "attached", got "${String(start)}"`
    );
  }
  return start;
}

function isTaskWakeJobPayload(value: unknown): value is TaskWakeJobPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TaskWakeJobPayload).runId === "string"
  );
}

/** StateMachine protocol messages routed between a facet and the root Lifecycle. */
type TaskRouteMessage =
  | {
      readonly type: "syncWake";
      readonly runId: string;
      readonly next: number | null;
    }
  | { readonly type: "dispatch"; readonly runId: string }
  | {
      readonly type: "memoryLimit";
      readonly runId: string;
      readonly context: MemoryLimitContext;
    };

/** One live execution attempt in this isolate. */
type ActiveAttempt = {
  readonly generation: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
};

/** Filters accepted by {@link StateMachine.list}. */
export type StateMachineListOptions = {
  definition?: string;
  status?: StateMachineRunState | StateMachineRunState[];
  limit?: number;
};

/** Filters accepted by {@link StateMachine.delete}. */
export type StateMachineDeleteOptions = {
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
export class StateMachine<
  // Type-level only: the map's shapes drive `run()`, `handle()` and `at()`
  // through the extractors, which also read a durable function's shape for
  // the `agents/tasks` layer. Runtime registration accepts machines only.
  Definitions extends Record<string, unknown> = StateMachineDefinitions
> extends LifecycleCapability {
  readonly #definitions: StateMachineDefinitions;
  readonly #registered = new Map<string, AnyStateMachineDefinition>();
  readonly #active = new Map<string, ActiveAttempt>();
  #storeInstance: TaskStore | undefined;
  #schemaVersionCache: number | undefined;
  readonly #stepDefaults: ResolvedStepPolicy;
  readonly #stallLimit: number;
  readonly #transitionBudget: number;
  readonly #turnTimeoutMs: number | null;
  readonly #mailboxLimit: number;
  readonly #streams: Streams | undefined;
  readonly #watchers = new Map<
    string,
    Set<(change: StateMachineChange) => void>
  >();
  readonly #onError:
    | ((error: unknown, run: StateMachineFailedRun) => void | Promise<void>)
    | undefined;

  /**
   * Create a StateMachine capability.
   *
   * @param options - Named definitions plus default step retry/timeout
   * policy and alarm batching. Declaring `definitions` types {@link run} and
   * {@link handle} against the map — names and inputs are checked where the
   * handlers are declared and where runs start. Names outside the map are
   * rejected unless a composition-root resolver supplies them.
   */
  constructor(options: StateMachineOptions<Definitions> = {}) {
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
    this.#stallLimit = Math.max(1, options.stallLimit ?? DEFAULT_STALL_LIMIT);
    this.#transitionBudget = Math.max(
      1,
      options.transitionBudget ?? DEFAULT_TRANSITION_BUDGET
    );
    this.#turnTimeoutMs =
      options.turnTimeout === undefined
        ? null
        : parseTaskDuration(options.turnTimeout, "turnTimeout");
    this.#mailboxLimit = Math.max(
      1,
      options.mailboxLimit ?? DEFAULT_MAILBOX_LIMIT
    );
    this.#streams = options.streams;
  }

  #claimTimeoutMs(): number {
    return this.#stepDefaults.timeoutMs + CLAIM_SLACK_MS;
  }

  /** The SQL store over this Lifecycle's storage (see `store.ts`). */
  get #store(): TaskStore {
    this.#storeInstance ??= new TaskStore(this.lifecycle.storage);
    return this.#storeInstance;
  }

  /** The persisted schema version, read once and kept for this isolate. */
  #schemaVersion(): number {
    this.#schemaVersionCache ??=
      this.lifecycle.storage.kv.get<number>(FIBER_SCHEMA_VERSION_KEY) ?? 0;
    return this.#schemaVersionCache;
  }

  async #setSchemaVersion(version: number): Promise<void> {
    await this.lifecycle.storage.put(FIBER_SCHEMA_VERSION_KEY, version);
    this.#schemaVersionCache = version;
  }

  /**
   * True while storage is mid-migration. Nothing dispatches and no wake
   * mirror moves until the journal rebuild's cursor completes, so a
   * half-copied journal is never read by a replay.
   */
  #migrating(): boolean {
    return this.#schemaVersion() < CURRENT_FIBER_SCHEMA_VERSION;
  }

  // ── Definitions ──────────────────────────────────────────────────────────

  /** Resolve a name to its declared or composition-root-supplied definition. */
  #resolveDefinition(name: string): AnyStateMachineDefinition | undefined {
    return (
      this.#definitions[name] ??
      this.#registered.get(name) ??
      taskDefinitionResolvers.get(this)?.resolve(name)
    );
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
        `Unknown Task definition "${name}": not declared on this StateMachine`
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
   * once per name per StateMachine construction.
   *
   * @returns The one handle that can start runs of this reserved name:
   * public `run()` and `handle()` both refuse a `__cf` prefix.
   */
  register(
    name: string,
    definition: AnyStateMachineDefinition
  ): StateMachineInternalHandle {
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
        `Task definition "${name}" is already registered on this StateMachine capability`
      );
    }
    this.#registered.set(name, definition);
    return {
      name,
      run: (input?: unknown, options?: StateMachineRunOptions) =>
        this.#acceptReserved(name, input, options, startMode(options))
    };
  }

  // ── Starting runs ────────────────────────────────────────────────────────

  /**
   * Durably accept one run of a declared definition and return a receipt
   * without waiting for terminal state. The same `idempotencyKey` or `runId`
   * joins the existing run (`accepted: false`) instead of creating a second.
   *
   * `options.start` chooses who drives the first attempt: `warm` (the
   * default) begins it in this invocation without awaiting it, `queued`
   * leaves it to the durable wake, and `attached` drives it here and
   * resolves at its next durable boundary.
   */
  async run<Name extends keyof Definitions & string>(
    definition: Name,
    input?: StateMachineInput<Definitions[Name]>,
    options?: StateMachineRunOptions
  ): Promise<StateMachineReceipt> {
    this.#validateDefinitionName(definition);
    return this.#start(definition, input, options, startMode(options));
  }

  /**
   * A typed handle scoped to one declared definition: its `run`, `get`,
   * `getByIdempotencyKey`, and `cancel` see only that definition's runs. The
   * handle is a pure lens over this capability — it holds no state and may
   * be created at any time.
   */
  handle<Name extends keyof Definitions & string>(
    definition: Name
  ): StateMachineHandle<
    Definitions[Name],
    StateMachineInput<Definitions[Name]>,
    StateMachineState<Definitions[Name]>,
    StateMachineOutput<Definitions[Name]>
  > {
    this.#validateDefinitionName(definition);
    const lens = {
      name: definition,
      run: (
        input: StateMachineInput<Definitions[Name]>,
        options?: StateMachineRunOptions
      ) => this.run(definition, input, options),
      get: (runId: string) => this.#snapshot(runId, definition),
      getByIdempotencyKey: (idempotencyKey: string) =>
        this.#snapshotByKey(idempotencyKey, definition),
      cancel: (runId: string, reason?: string) =>
        this.#cancelScoped(runId, definition, reason),
      at: (runId: string) => this.at(definition, runId),
      // `send`, `view` and `watch` are conditional on the definition type —
      // `never`, and so uncallable, on a function definition.
      send: (
        runId: string,
        payload: StateMachineJson,
        options?: StateMachineSendOptions
      ) => this.send(runId, payload, options),
      view: (runId: string) => this.view(runId),
      watch: (runId: string, listener: (change: StateMachineChange) => void) =>
        this.watch(runId, listener)
    };
    // SAFETY: the three machine verbs are typed against `Definitions[Name]`,
    // a type parameter here, so no concrete value satisfies them inside this
    // body — the same reason `at()` casts.
    return lens as unknown as StateMachineHandle<
      Definitions[Name],
      StateMachineInput<Definitions[Name]>,
      StateMachineState<Definitions[Name]>,
      StateMachineOutput<Definitions[Name]>
    >;
  }

  /**
   * A typed handle on ONE run. It does not replace `run()`'s receipt:
   * `StateMachineReceipt.accepted` is the whole point of durable acceptance.
   */
  at<Name extends keyof Definitions & string>(
    definition: Name,
    runId: string
  ): StateMachineRunHandle<Definitions[Name]> {
    this.#validateDefinitionName(definition);
    const handle = {
      runId,
      definition,
      get: () => this.#snapshot(runId, definition),
      cancel: (reason?: string, options?: { wait?: boolean }) =>
        this.#cancelScoped(runId, definition, reason, options),
      send: (payload: StateMachineJson, options?: StateMachineSendOptions) =>
        this.send(runId, payload, options),
      sendEvent: (event: {
        type: string;
        payload: StateMachineJson;
        requestId?: string;
      }) => this.sendEvent(runId, event),
      answer: <Payload, Answer>(
        askId: string,
        kind: AskKind<Payload, Answer>,
        answer: Answer
      ) => this.answer(askId, kind, answer),
      withdraw: (key: string) => this.withdraw(runId, key),
      view: () => this.view(runId),
      watch: (listener: (change: StateMachineChange) => void) =>
        this.watch(runId, listener),
      terminate: (reason?: string) => this.terminate(runId, reason)
    };
    // SAFETY: every member of `StateMachineRunHandle` is typed against the
    // definition, which is a type parameter here, so the payload and output
    // positions cannot be satisfied concretely inside this body.
    return handle as unknown as StateMachineRunHandle<Definitions[Name]>;
  }

  /** Cancel through a handle: another definition's run is not visible. */
  async #cancelScoped(
    runId: string,
    definition: string,
    reason?: string,
    options?: { wait?: boolean }
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || row.definition !== definition) return false;
    return this.cancel(runId, reason, options);
  }

  // ── Mailbox and asks ─────────────────────────────────────────────────────

  /**
   * Append one item to a run's mailbox (§7). `requestId` dedupes before any
   * write; `policy` decides how the item meets unconsumed items of the same
   * kind and type. A terminal run takes nothing: a mailbox write never
   * resurrects a run. A parked reader is woken; a live one re-reads at its
   * next park boundary and needs no wake.
   */
  async send(
    runId: string,
    payload: StateMachineJson,
    options?: StateMachineSendOptions
  ): Promise<StateMachineSendReceipt> {
    await this.lifecycle.ready();
    const key = options?.requestId ?? nanoid();
    const row = this.#store.getRun(runId);
    if (!row) return { accepted: false, key, reason: "unknown" };
    if (TERMINAL_STATES.has(row.state)) {
      return { accepted: false, key, reason: "terminal" };
    }
    const kind = options?.kind ?? "message";
    const type = options?.type ?? null;
    const policy = options?.policy ?? "append";
    const now = Date.now();
    const count =
      this.#store.read<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_agents_task_mailbox WHERE run_id = ?",
        [runId]
      )[0]?.count ?? 0;
    if (count >= this.#mailboxLimit) {
      throw new StateMachineMailboxFullError(runId, this.#mailboxLimit);
    }
    const sameShape = `run_id = ? AND kind = ? AND ${
      type === null ? "type IS NULL" : "type = ?"
    }`;
    const shapeParams = type === null ? [runId, kind] : [runId, kind, type];
    let visibleAfter: number | null = null;
    let seq: number | null = null;
    switch (policy) {
      case "drop": {
        const existing =
          this.#store.read<{ count: number }>(
            `SELECT COUNT(*) AS count FROM cf_agents_task_mailbox WHERE ${sameShape}`,
            shapeParams
          )[0]?.count ?? 0;
        if (existing > 0) return { accepted: false, key, reason: "dropped" };
        break;
      }
      case "latest":
        this.#store.write(
          `DELETE FROM cf_agents_task_mailbox WHERE ${sameShape}`,
          shapeParams
        );
        break;
      case "debounce": {
        visibleAfter = now + Math.max(0, options?.debounceMs ?? 0);
        // The same key keeps its place: an upsert re-hides it without
        // moving its seq, so a debounced item is delivered in first-send
        // order.
        const previous = this.#store.read<{ seq: number }>(
          "SELECT seq FROM cf_agents_task_mailbox WHERE run_id = ? AND key = ?",
          [runId, key]
        )[0];
        if (previous !== undefined) {
          seq = previous.seq;
          this.#store.write(
            "DELETE FROM cf_agents_task_mailbox WHERE run_id = ? AND key = ?",
            [runId, key]
          );
        }
        break;
      }
      case "append":
        break;
    }
    seq ??=
      this.#store.read<{ next: number }>(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM cf_agents_task_mailbox WHERE run_id = ?",
        [runId]
      )[0]?.next ?? 0;
    const written = this.#store.write(
      `INSERT INTO cf_agents_task_mailbox
         (run_id, key, seq, kind, type, payload, visible_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, key) DO NOTHING`,
      [
        runId,
        key,
        seq,
        kind,
        type,
        serializeTaskValue(payload, `mailbox item "${key}" for run "${runId}"`),
        visibleAfter,
        now
      ]
    );
    if (written === 0) return { accepted: false, key, reason: "duplicate" };
    this.#emit("task:mailbox", {
      runId,
      definition: row.definition,
      key,
      kind
    });
    await this.#wakeParked(runId, MAILBOX_PARKS, visibleAfter ?? now);
    return { accepted: true, key };
  }

  /** The Workflows spelling of `send(runId, payload, { kind: "event", type })`. */
  sendEvent(
    runId: string,
    event: { type: string; payload: StateMachineJson; requestId?: string }
  ): Promise<StateMachineSendReceipt> {
    return this.send(runId, event.payload, {
      kind: "event",
      type: event.type,
      ...(event.requestId !== undefined ? { requestId: event.requestId } : {})
    });
  }

  /** Remove a still-queued mailbox item. False once it was consumed. */
  async withdraw(runId: string, key: string): Promise<boolean> {
    await this.lifecycle.ready();
    return (
      this.#store.write(
        "DELETE FROM cf_agents_task_mailbox WHERE run_id = ? AND key = ?",
        [runId, key]
      ) > 0
    );
  }

  /**
   * Answer one ask with only its id (§8.2): the run id is the prefix before
   * `#`. Applied exactly once — the write is conditional on `open` — and a
   * repeat, a lapsed ask, or an unknown one reads as a receipt, never an
   * error.
   */
  async answer<Payload, Answer>(
    askId: string,
    kind: AskKind<Payload, Answer>,
    answer: Answer
  ): Promise<StateMachineAnswerReceipt> {
    await this.lifecycle.ready();
    const ask = this.#store.getAsk(askId);
    if (ask === undefined || ask.name !== kind.name) {
      return { accepted: false, reason: "unknown" };
    }
    const run = this.#store.getRun(ask.run_id);
    if (!run || TERMINAL_STATES.has(run.state)) {
      return { accepted: false, reason: "terminal" };
    }
    const now = Date.now();
    if (
      ask.state === "open" &&
      ask.expires_at !== null &&
      ask.expires_at <= now
    ) {
      this.#settleAskRow(askId, "expired", null, now);
      return { accepted: false, reason: "expired" };
    }
    if (ask.state === "answered") {
      return { accepted: false, reason: "duplicate" };
    }
    if (ask.state !== "open") return { accepted: false, reason: ask.state };
    const answerJson = serializeTaskValue(
      answer as StateMachineValue,
      `answer to ask "${askId}"`
    );
    if (!this.#settleAskRow(askId, "answered", answerJson, now)) {
      return { accepted: false, reason: "duplicate" };
    }
    this.#emit("task:answer", {
      runId: run.run_id,
      definition: run.definition,
      askId,
      name: kind.name
    });
    await this.#wakeParked(run.run_id, ["ask"], now);
    return { accepted: true };
  }

  /** Withdraw an open ask; the row is kept for the UI. */
  async withdrawAsk(askId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const ask = this.#store.getAsk(askId);
    if (ask === undefined || ask.state !== "open") return false;
    const now = Date.now();
    if (!this.#settleAskRow(askId, "withdrawn", null, now)) return false;
    const run = this.#store.getRun(ask.run_id);
    if (run) {
      this.#emit("task:answer", {
        runId: run.run_id,
        definition: run.definition,
        askId,
        name: ask.name,
        withdrawn: true
      });
      await this.#wakeParked(run.run_id, ["ask"], now);
    }
    return true;
  }

  /** List asks, optionally for one run or one state. */
  async asks(options?: {
    runId?: string;
    state?: StateMachineAskState;
  }): Promise<StateMachineAskRecord[]> {
    await this.lifecycle.ready();
    return this.#store.queryAsks(options ?? {});
  }

  /** One conditional write on `open`: the loser of a race reads false. */
  #settleAskRow(
    askId: string,
    state: "answered" | "expired" | "withdrawn",
    answer: string | null,
    now: number
  ): boolean {
    return (
      this.#store.write(
        `UPDATE cf_agents_task_asks SET state = ?, answer = ?, answered_at = ?
         WHERE ask_id = ? AND state = 'open'`,
        [state, answer, now, askId]
      ) > 0
    );
  }

  /**
   * Wake a run parked on one of the given waits, no earlier than `at`. A
   * live attempt gets no wake: its parking member re-reads the table at the
   * boundary, inside the same synchronous block in which it would park.
   */
  async #wakeParked(
    runId: string,
    reasons: readonly StateMachineWaitReason[],
    at: number
  ): Promise<void> {
    const row = this.#store.getRun(runId);
    if (
      !row ||
      row.state !== "waiting" ||
      row.paused === 1 ||
      row.wait_reason === null ||
      !reasons.includes(row.wait_reason)
    ) {
      return;
    }
    await this.#syncWake(runId, at);
  }

  // ── Children and streams ─────────────────────────────────────────────────

  /**
   * Accept one child of `parentId` (§10.1). A background child is detached:
   * outside the cancel cascade, and silent unless `notify` is asked for.
   * Cross-facet ownership (`options.owner`) is not wired in this release.
   */
  async #spawn(
    parentId: string,
    definition: string,
    input: unknown,
    options: StateMachineSpawnOptions | undefined
  ): Promise<StateMachineReceipt> {
    if (options?.owner !== undefined) {
      throw new Error(
        "ctx.spawn(..., { owner }) is not supported yet: children run on the parent's Lifecycle"
      );
    }
    this.#validateDefinitionName(definition);
    const { notify, owner: _owner, ...runOptions } = options ?? {};
    void _owner;
    const background = runOptions.background === true;
    return this.#accept(definition, input, runOptions, startMode(runOptions), {
      runId: parentId,
      notify: notify ?? !background
    });
  }

  #requireStreams(): Streams {
    if (this.#streams === undefined) {
      throw new Error(
        "ctx.stream() needs the Streams capability: pass `streams` in the Tasks options and install it on the same Lifecycle"
      );
    }
    return this.#streams;
  }

  /**
   * Open this run's engine-owned stream `name` at the current epoch (§9.1),
   * rotating to the next epoch when that id has already settled — a
   * previous transition's commit closed it — so a stream is always live
   * when a handler holds it. The names a run has streamed are recorded on
   * the row, which is what lets a reclaim seal every live epoch.
   */
  async #openStream(
    runId: string,
    name: string,
    options: StateMachineStreamOptions | undefined
  ): Promise<StreamWriter> {
    const streams = this.#requireStreams();
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = this.#store.getRun(runId);
      if (!row || TERMINAL_STATES.has(row.state)) {
        throw new AttemptSupersededError(runId);
      }
      const names = streamNames(row);
      if (!names.includes(name)) {
        this.#store.write(
          "UPDATE cf_agents_task_runs SET stream_tag = ? WHERE run_id = ?",
          [JSON.stringify([...names, name]), runId]
        );
      }
      const streamId = engineStreamId(runId, name, row.stream_epoch);
      try {
        return await streams.open(streamId, {
          tag: options?.tag ?? `${runId}:${name}`,
          ...(options?.metadata !== undefined
            ? { metadata: options.metadata }
            : {})
        });
      } catch (error) {
        if (!(error instanceof StreamClosedError) || attempt === 1) throw error;
        // The epoch's stream settled with an earlier commit: fold its
        // cursor into the retired total and move every name to the next
        // epoch.
        const settled = await streams.status(streamId);
        this.#store.write(
          `UPDATE cf_agents_task_runs
           SET stream_epoch = stream_epoch + 1,
               stream_retired = stream_retired + ?
           WHERE run_id = ? AND stream_epoch = ?`,
          [settled?.cursor ?? 0, runId, row.stream_epoch]
        );
      }
    }
    throw new AttemptSupersededError(runId);
  }

  /**
   * A reclaim after an interruption seals every live engine-owned stream of
   * the lost attempt and rotates the epoch (§9.1): the replayed transition
   * opens the next one, and a UI following the tag sees continuous output.
   */
  async #rotateStreams(row: TaskRunRow): Promise<void> {
    const streams = this.#streams;
    const names = streamNames(row);
    if (streams === undefined || names.length === 0) return;
    let retired = 0;
    let rotated = false;
    for (const name of names) {
      const streamId = engineStreamId(row.run_id, name, row.stream_epoch);
      const status = await streams.status(streamId);
      if (status === null) continue;
      rotated = true;
      if (status.state === "streaming") {
        const writer = await streams.open(streamId);
        writer.error(`superseded by epoch ${row.stream_epoch + 1}`);
      }
      retired += (await streams.status(streamId))?.cursor ?? status.cursor;
    }
    if (!rotated) return;
    this.#store.write(
      `UPDATE cf_agents_task_runs
       SET stream_epoch = stream_epoch + 1, stream_retired = stream_retired + ?
       WHERE run_id = ? AND stream_epoch = ?`,
      [retired, row.run_id, row.stream_epoch]
    );
  }

  /** The engine-owned streams of one run, for `view()`. */
  async #streamViews(
    row: TaskRunRow
  ): Promise<NonNullable<StateMachineRunView<StateMachineValue>["streams"]>> {
    const streams = this.#streams;
    if (streams === undefined) return [];
    const views: {
      name: string;
      tag: string;
      streamId: string;
      epoch: number;
      cursor: number;
      state: StreamState;
    }[] = [];
    for (const name of streamNames(row)) {
      const streamId = engineStreamId(row.run_id, name, row.stream_epoch);
      const status = await streams.status(streamId);
      if (status === null) continue;
      views.push({
        name,
        tag: status.tag ?? `${row.run_id}:${name}`,
        streamId,
        epoch: row.stream_epoch,
        cursor: status.cursor,
        state: status.state
      });
    }
    return views;
  }

  /**
   * Deliver a settled child's note to its parent's mailbox (§10.2) and wake
   * the parent if it is parked on it. A terminal parent takes nothing.
   */
  async #notifyParent(child: TaskRunRow): Promise<void> {
    const parentId = child.parent_run_id;
    if (parentId === null || child.parent_notify !== 1) return;
    const parent = this.#store.getRun(parentId);
    if (!parent || TERMINAL_STATES.has(parent.state)) return;
    const now = Date.now();
    const seq =
      this.#store.read<{ next: number }>(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM cf_agents_task_mailbox WHERE run_id = ?",
        [parentId]
      )[0]?.next ?? 0;
    const note = {
      runId: child.run_id,
      definition: child.definition,
      state: child.state,
      ...(child.result !== null
        ? { result: deserializeTaskValue(child.result) as StateMachineJson }
        : {}),
      ...(child.error_name !== null
        ? {
            error: {
              name: child.error_name,
              message: child.error_message ?? ""
            }
          }
        : {}),
      ...(child.state === "cancelled" && child.cancel_reason !== null
        ? { reason: child.cancel_reason }
        : {}),
      ...(child.outcome !== null ? { outcome: child.outcome } : {})
    };
    const written = this.#store.write(
      `INSERT INTO cf_agents_task_mailbox
         (run_id, key, seq, kind, type, payload, visible_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (run_id, key) DO NOTHING`,
      [
        parentId,
        childMailboxKey(child.run_id),
        seq,
        CHILD_MAILBOX_KIND,
        child.definition,
        JSON.stringify(note),
        now
      ]
    );
    if (written === 0) return;
    this.#emit("task:child", {
      runId: parentId,
      definition: parent.definition,
      child: child.run_id,
      state: child.state
    });
    await this.#wakeParked(parentId, ["child", "mailbox"], now);
  }

  /**
   * The cancel cascade (§10.3): every in-tree child of `parentId` takes the
   * same mark, in the same synchronous block as its parent. Background
   * children are detached and run on.
   */
  async #cascadeAbort(
    parentId: string,
    mark: StateMachineAbortMark,
    reason: string | undefined
  ): Promise<void> {
    const children = this.#store.read<TaskRunRow>(
      `SELECT * FROM cf_agents_task_runs
       WHERE parent_run_id = ? AND background = 0
         AND state IN ('pending', 'waiting', 'running')`,
      [parentId]
    );
    for (const child of children) {
      await this.#requestAbort(child, mark, reason, false);
    }
  }

  /**
   * Set one mark on a run and drive the protocol from wherever the run is:
   * a live attempt is signalled and settles through #afterAttempt; a parked
   * machine with `onCancel` gets its cancel transition; everything else
   * takes the mark's inline default now.
   */
  async #requestAbort(
    row: TaskRunRow,
    mark: StateMachineAbortMark,
    reason: string | undefined,
    wait: boolean
  ): Promise<void> {
    const runId = row.run_id;
    const now = Date.now();
    if (mark === "cancel") {
      this.#store.sql`
        UPDATE cf_agents_task_runs
        SET cancel_requested = 1, cancel_reason = ${reason ?? null},
            abort_mark = coalesce(abort_mark, 'cancel'),
            abort_reason = coalesce(abort_reason, ${reason ?? null}),
            updated_at = ${now}
        WHERE run_id = ${runId} AND state IN ('pending', 'waiting', 'running')
      `;
    } else {
      this.#store.sql`
        UPDATE cf_agents_task_runs
        SET abort_mark = coalesce(abort_mark, ${mark}),
            abort_reason = coalesce(abort_reason, ${reason ?? null}),
            updated_at = ${now}
        WHERE run_id = ${runId} AND state IN ('pending', 'waiting', 'running')
      `;
    }
    await this.#cascadeAbort(runId, "parent", "parent aborted");
    const active = this.#active.get(runId);
    if (active) {
      active.controller.abort(new TaskCancellation(reason));
      await this.#syncWake(runId, now);
      if (wait) await this.#awaitSettled(runId, active);
      return;
    }
    const marked = this.#store.getRun(runId);
    if (!marked || TERMINAL_STATES.has(marked.state)) return;
    const definition = this.#resolveDefinition(marked.definition);
    if (
      definition !== undefined &&
      declaresOnCancel(definition) &&
      marked.checkpoint !== null
    ) {
      const transition = this.#runCancelTransition(marked, definition);
      if (wait) await transition;
      else void transition.catch(() => {});
      return;
    }
    await this.#settleByMark(marked, null);
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate storage and reconcile run deadlines during Lifecycle startup. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(FIBER_SCHEMA_VERSION_KEY)) ?? 0;
    this.#schemaVersionCache = version;
    if (version < 2) {
      this.#store.ensureTables();
      // Unconditional, not guarded on version 1: adding an existing column
      // is already a no-op (see the store), and a narrower guard would
      // strand any object whose table is at the version 1 shape while its
      // version key reads 0 — it would record itself migrated without ever
      // adding the columns every later acceptance names.
      this.#store.addRunBudgetColumns();
    }
    if (version < JOURNAL_REBUILD_VERSION) {
      this.#store.addMachineColumns();
      this.#store.ensureMachineTables();
      this.#store.backfillDefinitionIdentity();
      // A cancellation already requested becomes the abort mark, which is
      // the write barrier version 3 fences checkpoint writes on.
      this.#store.backfillAbortMark();
      // The intermediate version exists to make a rebuild resumable, so it
      // is only stamped when there are rows to rebuild. A fresh object —
      // whose tables `ensureTables` just created at the version 3 shape —
      // goes straight to 3 and bills one schema write rather than two.
      //
      // Which arm is taken is decided on the TABLE, not on its rows: an
      // object whose retained runs were all swept — by the very
      // `tasks.delete({ settledBefore })` the rebuild's warning asks for
      // before an upgrade — carries the old table with nothing in it, and
      // stamping 3 without dropping it would leave the table behind on an
      // object that reports itself fully migrated.
      const legacy = this.#store.hasLegacyStepJournal();
      if (legacy && this.#store.countLegacySteps() > 0) {
        await this.#setSchemaVersion(JOURNAL_REBUILD_VERSION);
      } else {
        if (legacy) this.#store.dropLegacyStepJournal();
        await this.#setSchemaVersion(CURRENT_FIBER_SCHEMA_VERSION);
      }
    }
    if (this.#schemaVersion() < CURRENT_FIBER_SCHEMA_VERSION) {
      await this.#rebuildJournal();
    }
    // Nothing dispatches and no mirror moves until the rebuild completes.
    if (this.#migrating()) return;
    this.#reconcile();
    await this.#syncAllWakes();
  }

  /**
   * Copy the pre-version-3 step journal into the turn-scoped journal at turn
   * 0, in bounded batches under a durable cursor, each batch in its own
   * transaction. A crash mid-rebuild leaves the intermediate version and the
   * cursor, and the next start resumes from it rather than restarting.
   *
   * Skipped entirely — zero work, zero writes — when the old table is absent
   * or empty, which is every fresh object.
   */
  async #rebuildJournal(): Promise<void> {
    const store = this.#store;
    const storage = this.lifecycle.storage;
    const remaining = this.#legacyStepCount();
    if (remaining > JOURNAL_REBUILD_WARN_ROWS) {
      console.warn(
        `StateMachine is rebuilding ${remaining} retained step rows into the ` +
          `turn-scoped journal. Call tasks.delete({ settledBefore }) before ` +
          `upgrading to avoid copying rows you no longer read.`
      );
    }
    if (remaining > 0) {
      let cursor = readJournalCursor(storage);
      for (;;) {
        const moved = store.transactionSync(() => {
          const next = store.rebuildJournalBatch(cursor, JOURNAL_REBUILD_BATCH);
          if (next !== null) {
            storage.kv.put(JOURNAL_CURSOR_KEY, JSON.stringify(next));
          }
          return next;
        });
        if (moved === null) break;
        cursor = moved;
      }
    }
    store.transactionSync(() => {
      store.dropLegacyStepJournal();
      storage.kv.delete(JOURNAL_CURSOR_KEY);
    });
    await this.#setSchemaVersion(CURRENT_FIBER_SCHEMA_VERSION);
  }

  /** Retained pre-version-3 step rows, or 0 when that table is long gone. */
  #legacyStepCount(): number {
    return this.#store.hasLegacyStepJournal()
      ? this.#store.countLegacySteps()
      : 0;
  }

  /** Drive one due run's wake dispatched by the Lifecycle event loop. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
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
      WHERE run_id = ${runId} AND state = 'running'
    `;
  }

  /**
   * Drive one local due run to its next durable boundary, bounded by the
   * dispatch budget, and return the wake outcome for this capability's own
   * queue job.
   */
  async #dispatchRun(runId: string): Promise<LifecycleJobOutcome> {
    const active = this.#active.get(runId);
    if (active) {
      // A live attempt in this isolate. Its deadline is the one wake a held
      // claim cannot push past: enforce it over the attempt, otherwise push
      // the claim backstop forward so the due job does not hot-loop the
      // alarm while it works.
      if (await this.#enforceDeadline(runId, active)) {
        return this.#wakeOutcome(runId);
      }
      if (await this.#enforceTurnDeadline(runId, active)) {
        return this.#wakeOutcome(runId);
      }
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
    const runAttempt = this.#executeRun(runId);
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
    const active = this.#active.get(runId);
    if (active) {
      if (!(await this.#enforceDeadline(runId, active))) {
        this.#refreshClaim(runId);
      }
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
      const row = this.#store.getRun(runId);
      if (!row) return;
      const error = new Error(
        "Sealed by the alarm memory-limit circuit breaker (#1825) after " +
          "consecutive Durable Object memory-limit resets."
      );
      error.name = "TaskMemoryLimitSealed";
      await this.#failWithoutAttempt(row, error);
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
         AND state IN ('pending', 'waiting', 'running')`,
      [context.nextTime, context.nextTime, now, runId]
    );
    await this.#syncWake(runId);
  }

  /** Accept a run of any resolvable definition, reserved names included. */
  async #acceptReserved(
    definition: string,
    input: unknown,
    options: StateMachineRunOptions | undefined,
    mode: StateMachineStartMode
  ): Promise<StateMachineReceipt> {
    if (!this.#hasDefinition(definition)) {
      throw new Error(
        `Unknown Task definition "${definition}": not declared on this StateMachine`
      );
    }
    return this.#start(definition, input, options, mode);
  }

  /**
   * The one start path every entry point shares. `warm` and `queued` are
   * decided inside `#accept` — a warm start dispatches without awaiting,
   * a queued one leaves the row to its durable wake. `attached` is the only
   * mode that owes the caller more than acceptance: it drives that first
   * attempt here and resolves when the attempt reaches its next durable
   * boundary, so the run may already be terminal when this returns.
   */
  async #start(
    definition: string,
    input: unknown,
    options: StateMachineRunOptions | undefined,
    mode: StateMachineStartMode
  ): Promise<StateMachineReceipt> {
    const receipt = await this.#accept(definition, input, options, mode);
    if (mode === "attached" && receipt.accepted) {
      await this.#executeRun(receipt.runId);
    }
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
    const next = this.#nextWake(runId);
    return next === null ? undefined : { rescheduleAt: next };
  }

  /**
   * The soonest instant this run needs a wake: its park or claim backstop,
   * its deadline, and — while a transition is live — its turn watchdog.
   */
  #nextWake(runId: string): number | null {
    const rows = this.#store.sql<{
      next_at: number | null;
      deadline_at: number | null;
      turn_deadline_at: number | null;
      state: StateMachineRunState;
    }>`
      SELECT next_at, deadline_at, turn_deadline_at, state
      FROM cf_agents_task_runs
      WHERE run_id = ${runId}
        AND state IN ('pending', 'waiting', 'running')
    `;
    const row = rows[0];
    if (!row) return null;
    const candidates = [
      row.next_at,
      row.deadline_at,
      row.state === "running" ? row.turn_deadline_at : null
    ].filter((at): at is number => at !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  /** The run deadline against a live attempt: the mark, then the protocol. */
  async #enforceDeadline(
    runId: string,
    active: ActiveAttempt
  ): Promise<boolean> {
    const row = this.#store.getRun(runId);
    if (!row || row.deadline_at === null || row.deadline_at > Date.now()) {
      return false;
    }
    const error = new StateMachineDeadlineExceededError(runId, row.deadline_at);
    await this.#abortLive(row, active, "deadline", error);
    return true;
  }

  /** The per-transition watchdog: the mark, then the protocol. */
  async #enforceTurnDeadline(
    runId: string,
    active: ActiveAttempt
  ): Promise<boolean> {
    const row = this.#store.getRun(runId);
    if (
      !row ||
      row.state !== "running" ||
      row.generation !== active.generation ||
      row.turn_deadline_at === null ||
      row.turn_deadline_at > Date.now()
    ) {
      return false;
    }
    const error = new StateMachineTurnDeadlineExceededError(
      runId,
      row.turn_deadline_at
    );
    await this.#abortLive(row, active, "turn-deadline", error);
    return true;
  }

  /**
   * The abort protocol against a live attempt (§6.2): one write sets the
   * mark, the invocation is signalled, and the run settles by its inline
   * default at once — or, for a machine that declared `onCancel`, the live
   * invocation is joined (bounded) and a fresh invocation runs the cancel
   * transition, fenced against the old one by the mark.
   */
  async #abortLive(
    row: TaskRunRow,
    active: ActiveAttempt,
    mark: StateMachineAbortMark,
    error: Error
  ): Promise<void> {
    const runId = row.run_id;
    const now = Date.now();
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET abort_mark = coalesce(abort_mark, ${mark}),
          abort_reason = coalesce(abort_reason, ${error.message}),
          updated_at = ${now}
      WHERE run_id = ${runId} AND state IN ('pending', 'waiting', 'running')
    `;
    await this.#cascadeAbort(runId, "parent", "parent aborted");
    const definition = this.#resolveDefinition(row.definition);
    if (definition !== undefined && declaresOnCancel(definition)) {
      active.controller.abort(error);
      await this.#joinAttempt(active);
      const current = this.#store.getRun(runId);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      await this.#runCancelTransition(current, definition);
      return;
    }
    const failed = await this.#settleFailed(
      runId,
      active.generation,
      toErrorSummary(error)
    );
    active.controller.abort(error);
    if (failed) await this.#observeError(error, row);
  }

  /**
   * Mirror one run's authoritative deadline into the Lifecycle job queue:
   * a non-terminal run with a `next_at` gets one job (id = `task:` plus the
   * run id, so a retime is a same-id replace); anything else cancels the
   * mirror. The prefix keeps caller-selected run IDs inside StateMachine' own job
   * namespace. Every durable mutation of a run's deadline or state funnels
   * through here.
   *
   * @returns False when the queue already carried exactly this wake and
   * nothing was written — a same-values upsert is still a billed row write.
   */
  async #syncWake(runId: string, earliest?: number): Promise<boolean> {
    // Mid-rebuild the mirror is left exactly as it stands: a wake that
    // dispatched now would read a half-copied journal.
    if (this.#migrating()) return false;
    let next = this.#nextWake(runId);
    // An early wake — a send or an answer to an event-driven park — moves
    // the mirror job without touching the row, so the park's own `within`
    // deadline stays what `next_at` says it is.
    if (earliest !== undefined) {
      const row = this.#store.getRun(runId);
      if (row && !TERMINAL_STATES.has(row.state)) {
        next = next === null ? earliest : Math.min(next, earliest);
      }
    }

    if (this.lifecycle.routes.source) {
      // The run row stays here; only its deadline mirrors to the root that
      // owns the physical alarm.
      return (await this.lifecycle.routes.toRoot({
        type: "syncWake",
        runId,
        next
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

  /** Handle StateMachine protocol messages routed by another Lifecycle. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload as TaskRouteMessage;
    switch (message.type) {
      case "syncWake": {
        const owner = context.source;
        if (!owner)
          throw new Error("Routed StateMachine message missing source");
        return this.#syncRoutedWake(owner, message.runId, message.next);
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
        throw new Error("Unknown routed StateMachine message");
    }
  }

  /** Mirror a routed facet's run deadline into this root's job queue. */
  async #syncRoutedWake(
    owner: LifecycleRouteAddress,
    runId: string,
    next: number | null
  ): Promise<boolean> {
    const jobId = `${WAKE_JOB_PREFIX}${owner.key}:${runId}`;
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
      payload: {
        runId,
        owner_path: owner.data,
        owner_path_key: owner.key
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
    // The owner index rows under the prefix go with the facets (§10.4).
    this.#store.write(
      `DELETE FROM cf_agents_task_routes
       WHERE owner_path_key = ? OR owner_path_key LIKE ?`,
      [prefix, `${prefix}/%`]
    );
  }

  /** Mirror every non-terminal run into the queue (startup reconcile). */
  async #syncAllWakes(): Promise<void> {
    const rows = this.#store.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agents_task_runs
      WHERE state IN ('pending', 'waiting', 'running')
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
  async get(
    runId: string
  ): Promise<StateMachineRunSnapshot<StateMachineValue> | null> {
    return this.#snapshot(runId);
  }

  /** Read one run by idempotency key across all definitions. */
  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<StateMachineRunSnapshot<StateMachineValue> | null> {
    return this.#snapshotByKey(idempotencyKey);
  }

  /** List runs, newest first. */
  async list(
    options: StateMachineListOptions = {}
  ): Promise<StateMachineRunSnapshot<StateMachineValue>[]> {
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
    // SAFETY: the query selects * from StateMachine' own schema.
    return (rows as TaskRunRow[]).map((row) => this.#store.rowToSnapshot(row));
  }

  /** The deep view: checkpoint, mailbox, asks, children, beside the snapshot. */
  async view(
    runId: string
  ): Promise<StateMachineRunView<StateMachineValue> | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row) return null;
    const view = this.#store.rowToView(row);
    const streams = await this.#streamViews(row);
    return streams.length === 0 ? view : { ...view, streams };
  }

  /**
   * Subscribe to one run's changes. Holds nothing durable: a subscriber that
   * dies with its isolate calls `view()` once and subscribes again.
   */
  watch(
    runId: string,
    listener: (change: StateMachineChange) => void
  ): () => void {
    let listeners = this.#watchers.get(runId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#watchers.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#watchers.get(runId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#watchers.delete(runId);
    };
  }

  /**
   * Request cooperative cancellation (§6.3). True when a non-terminal run
   * took the mark. A definition without `onCancel` is terminal when this
   * resolves; one with `onCancel` settles when its cancel transition does —
   * pass `{ wait: true }` to await that.
   */
  async cancel(
    runId: string,
    reason?: string,
    options?: { wait?: boolean }
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return false;
    await this.#requestAbort(row, "cancel", reason, options?.wait === true);
    return true;
  }

  /** Resolve once the run is terminal, or once the protocol gave up. */
  async #awaitSettled(runId: string, active: ActiveAttempt): Promise<void> {
    let joined = active;
    for (;;) {
      await this.#joinAttempt(joined);
      const row = this.#store.getRun(runId);
      if (!row || TERMINAL_STATES.has(row.state)) return;
      const next = this.#active.get(runId);
      if (!next || next === joined) return;
      joined = next;
    }
  }

  /**
   * Join one aborted attempt for `cancel({ wait: true })`, bounded by the
   * claim slack — the same slack a claim is written ahead by, so waiting
   * longer than it would mean waiting for an attempt the queue is already
   * entitled to reclaim.
   */
  async #joinAttempt(active: ActiveAttempt): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLAIM_SLACK_MS);
    });
    try {
      // The attempt's own rejection is its run's outcome, already persisted
      // by the driver; the caller asked about terminality, not about it.
      await Promise.race([active.promise.catch(() => {}), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Force a run terminal without running `onCancel`. */
  async terminate(runId: string, reason?: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return false;
    const active = this.#active.get(runId);
    active?.controller.abort(new TaskCancellation(reason));
    await this.#settleCancelled(runId, null, reason);
    const children = this.#store.read<{ run_id: string }>(
      `SELECT run_id FROM cf_agents_task_runs
       WHERE parent_run_id = ? AND background = 0
         AND state IN ('pending', 'waiting', 'running')`,
      [runId]
    );
    for (const child of children) await this.terminate(child.run_id, reason);
    return true;
  }

  /** Stop dispatching a run. A live transition is not interrupted. */
  async pause(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state) || row.paused === 1) {
      return false;
    }
    const now = Date.now();
    if (this.#active.has(runId)) {
      // Takes effect at the transition boundary the loop reaches next.
      this.#store.sql`
        UPDATE cf_agents_task_runs SET paused = 1, updated_at = ${now}
        WHERE run_id = ${runId}
      `;
      return true;
    }
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET paused = 1, state = 'waiting', wait_reason = 'paused', next_at = NULL,
          generation = NULL, updated_at = ${now}
      WHERE run_id = ${runId} AND state IN ('pending', 'waiting', 'running')
    `;
    this.#emit("task:paused", { runId, definition: row.definition });
    await this.#syncWake(runId);
    return true;
  }

  /** Resume a paused run. False when it was not paused. */
  async resume(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state) || row.paused !== 1) {
      return false;
    }
    const now = Date.now();
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET paused = 0,
          next_at = CASE WHEN wait_reason = 'paused' THEN ${now} ELSE next_at END,
          wait_reason = CASE WHEN wait_reason = 'paused' THEN NULL ELSE wait_reason END,
          updated_at = ${now}
      WHERE run_id = ${runId}
    `;
    this.#emit("task:resumed", { runId, definition: row.definition });
    await this.#syncWake(runId);
    return true;
  }

  /**
   * Bring a `faulted` or `orphaned` run back: it re-enters `pending` at its
   * preserved checkpoint and is re-resolved against the definitions now
   * registered. False for any other run.
   */
  async reopen(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (
      !row ||
      row.state !== "failed" ||
      row.outcome === null ||
      !PRESERVED_OUTCOMES.has(row.outcome)
    ) {
      return false;
    }
    const now = Date.now();
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET state = 'pending', outcome = NULL, error_name = NULL,
          error_message = NULL, settled_at = NULL, stall = 0, transitions = 0,
          generation = NULL, next_at = ${now}, wait_reason = NULL,
          abort_mark = NULL, abort_reason = NULL, cancel_requested = 0,
          cancel_reason = NULL, updated_at = ${now}
      WHERE run_id = ${runId} AND state = 'failed'
    `;
    await this.#syncWake(runId);
    return true;
  }

  /**
   * Delete retained terminal runs and their step journals.
   *
   * @returns The number of runs deleted.
   */
  async delete(options: StateMachineDeleteOptions = {}): Promise<number> {
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
    options: StateMachineRunOptions = {},
    startMode: StateMachineStartMode = "warm",
    parent: { runId: string; notify: boolean } | null = null
  ): Promise<StateMachineReceipt> {
    await this.lifecycle.ready();
    if ("parent" in options && options.parent !== undefined) {
      throw new Error(
        "run() does not accept `parent`; a child is started with ctx.spawn()"
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

    // The policy an interruption is retried under is resolved here, once,
    // and persisted with the run: a later change to the capability's step
    // defaults must not silently re-bound runs already in flight.
    const retryPolicy =
      options.interruptions === undefined
        ? null
        : resolveRetryPolicy(
            this.#stepDefaults,
            options.interruptions,
            "run interruptions"
          );
    const deadlineAt =
      options.deadline === undefined
        ? null
        : options.deadline instanceof Date
          ? options.deadline.getTime()
          : options.deadline;
    // A non-positive deadline would become a negative wake time the job
    // queue refuses — after the row was inserted. Refuse it before anything
    // durable happens.
    if (
      deadlineAt !== null &&
      !(Number.isFinite(deadlineAt) && deadlineAt > 0)
    ) {
      throw new Error(
        "deadline must be a finite time after the epoch when provided"
      );
    }

    // Resolved once and persisted with the run, like the interruption
    // policy: a later change to the capability's default must not re-bound
    // a transition already in flight.
    const turnTimeoutMs =
      options.turnTimeout === undefined
        ? this.#turnTimeoutMs
        : parseTaskDuration(options.turnTimeout, "turnTimeout");

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
        state: existing.state,
        createdAt: existing.created_at
      };
    }

    const runId = options.runId ?? `task_${nanoid()}`;
    const now = Date.now();
    // `definition_base` / `definition_version` are derived once, here, and
    // never rewritten: that is what lets an index ride them later without
    // paying a per-write tax.
    const { base, version } = parseDefinitionName(definition);
    // The checkpoint starts NULL. A function definition keeps it NULL for
    // the life of the run, which is what pins its journal scope to turn 0;
    // a machine's first transition writes its `initial` state over it.
    this.#store.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, definition_base, definition_version, input, state,
         metadata, idempotency_key, retain, attempt, deadline_at, interruptions,
         retry_policy, turn_timeout_ms, next_at, cancel_requested, checkpoint,
         checkpoint_turn, background, parent_run_id, parent_notify,
         created_at, updated_at)
      VALUES
        (${runId}, ${definition}, ${base}, ${version}, ${inputJson}, 'pending',
         ${metadataJson},
         ${options.idempotencyKey ?? null}, ${options.retain === false ? 0 : 1},
         0, ${deadlineAt}, 0,
         ${retryPolicy === null ? null : JSON.stringify(retryPolicy)},
         ${turnTimeoutMs}, ${now}, 0, NULL,
         0, ${options.background === true ? 1 : 0},
         ${parent?.runId ?? null}, ${parent === null || parent.notify ? 1 : 0},
         ${now}, ${now})
    `;
    await this.#syncWake(runId);
    this.#emit("task:accepted", { runId, definition, accepted: true });

    // Warm path: begin the first attempt immediately when the host is past
    // startup. The durable deadline above is authoritative either way.
    if (startMode === "warm" && this.lifecycle.status() !== "starting") {
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
    // A half-copied journal must never be read by a replay.
    if (this.#migrating()) return;
    if (this.#active.has(runId)) return;
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATES.has(row.state)) return;

    const now = Date.now();
    if (row.abort_mark !== null || row.cancel_requested === 1) {
      await this.#resolveMark(row);
      return;
    }
    // The deadline check comes before the due gate: a deadline brings a
    // parked run's wake forward (see #nextWake), so the wake that fires at
    // the deadline finds `next_at` still in the future.
    if (row.deadline_at !== null && row.deadline_at <= now) {
      await this.#failWithoutAttempt(
        row,
        new StateMachineDeadlineExceededError(runId, row.deadline_at)
      );
      return;
    }
    if (row.paused === 1) return;
    // A timed park is not due before its wake. An event-driven park may be
    // dispatched early — by a send or an answer — and re-parks if nothing
    // arrived; only its own `within` deadline reads as a timeout.
    const eventDriven =
      row.state === "waiting" &&
      row.wait_reason !== null &&
      EVENT_DRIVEN_PARKS.has(row.wait_reason);
    if (!eventDriven && row.next_at !== null && row.next_at > now) return;

    const resolved = await this.#resolveForRun(row);
    if (resolved === null) return;
    const { definition, row: current } = resolved;

    // A run found still 'running' was claimed by an isolate that is gone:
    // an unclean interruption, and the only thing the run's own `retries`
    // policy counts. A run parked 'interrupted' is the backoff between one
    // of those and its replay — counted already, at park time. A wake from
    // a sleep or a step retry park is neither, and costs nothing.
    const interruption = current.state === "running";
    const afterInterruption =
      interruption ||
      (current.state === "waiting" && current.wait_reason === "interrupted");

    // The interrupted step is read from the journal only on a claim that
    // follows an interruption; every other claim replays a clean journal.
    const interrupted = afterInterruption
      ? this.#interruptedStep(runId, current.checkpoint_turn)
      : null;

    const interruptions = interruption
      ? current.interruptions + 1
      : afterInterruption
        ? current.interruptions
        : 0;

    // An event-driven park woken by its own `within`: the first matching
    // wait in the re-dispatched handler returns `timedOut` (§5.8).
    const expiredWait =
      current.state === "waiting" &&
      current.wait_reason !== null &&
      EVENT_DRIVEN_PARKS.has(current.wait_reason) &&
      current.next_at !== null &&
      current.next_at <= now
        ? current.wait_reason
        : null;

    if (interruption) {
      this.#emit("task:attempt:interrupted", {
        runId,
        definition: current.definition,
        attempt: current.attempt,
        step: interrupted?.name ?? null
      });
      const policy = this.#runRetryPolicy(current);
      if (policy) {
        if (interruptions >= policy.retryLimit) {
          await this.#failWithoutAttempt(
            current,
            new StateMachineInterruptionsExhaustedError(runId, interruptions),
            interruptions
          );
          return;
        }
        const delayMs = computeRetryDelayMs(policy, interruptions);
        if (delayMs > 0) {
          await this.#parkInterruption(current, interruptions, now + delayMs);
          return;
        }
      }
    }

    if (interruption) await this.#rotateStreams(current);
    const generation = nanoid();
    const attempt = current.attempt + 1;
    const turnDeadline = this.#turnDeadline(current, now);
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET state = 'running', attempt = ${attempt}, generation = ${generation},
          interruptions = ${interruptions},
          started_at = coalesce(started_at, ${now}),
          next_at = ${now + this.#claimTimeoutMs()},
          turn_deadline_at = ${turnDeadline},
          wait_reason = NULL, updated_at = ${now}
      WHERE run_id = ${runId}
        AND state IN ('pending', 'waiting', 'running')
    `;
    await this.#syncWake(runId);

    const controller = new AbortController();
    // Emitted before the handler starts: invocation is synchronous up to the
    // first await, so the first step event would otherwise precede this one.
    this.#emit("task:attempt:started", {
      runId,
      definition: current.definition,
      attempt
    });
    const promise = this.#runAttempt(
      current,
      definition,
      generation,
      attempt,
      controller,
      interrupted,
      now,
      null,
      expiredWait
    );
    await this.#track(runId, generation, controller, promise);
    await this.#afterAttempt(runId, generation);
  }

  /**
   * Hold one invocation in `#active` for its lifetime. The delete is
   * guarded by generation: a signal-deaf invocation that finally ends must
   * not evict the cancel transition that has since taken its place.
   */
  async #track(
    runId: string,
    generation: string,
    controller: AbortController,
    promise: Promise<void>
  ): Promise<void> {
    this.#active.set(runId, { generation, controller, promise });
    try {
      await promise;
    } finally {
      if (this.#active.get(runId)?.generation === generation) {
        this.#active.delete(runId);
      }
    }
  }

  /**
   * An attempt that ended under a mark it could not settle itself — its
   * checkpoint, park or result was refused by the fence — hands the run to
   * the abort protocol here, in the same invocation.
   */
  async #afterAttempt(runId: string, generation: string): Promise<void> {
    const after = this.#store.getRun(runId);
    if (
      !after ||
      TERMINAL_STATES.has(after.state) ||
      after.generation !== generation ||
      (after.abort_mark === null && after.cancel_requested !== 1)
    ) {
      return;
    }
    await this.#resolveMark(after);
  }

  /** The turn watchdog deadline this claim carries, or NULL for none. */
  #turnDeadline(row: TaskRunRow, now: number): number | null {
    return row.turn_timeout_ms === null ? null : now + row.turn_timeout_ms;
  }

  /**
   * Resolve the definition a run is dispatched against. An exact name wins.
   * A name whose base is registered only at a newer version is adopted by
   * that version's `migrate`, or — when it declares none — the run is
   * `orphaned`: terminal `failed`, its checkpoint preserved even at
   * `retain: false`, so `reopen()` has something to reopen once the
   * definition is registered again. A base nobody registers at all is the
   * plain missing-definition failure it always was.
   */
  async #resolveForRun(row: TaskRunRow): Promise<{
    definition: AnyStateMachineDefinition;
    row: TaskRunRow;
  } | null> {
    const exact = this.#resolveDefinition(row.definition);
    if (exact !== undefined) return { definition: exact, row };
    const base =
      row.definition_base ?? parseDefinitionName(row.definition).base;
    const successor = this.#newestSuccessor(base, row.definition_version);
    if (successor === null) {
      const error = new StateMachineMissingDefinitionError(row.definition);
      console.error(error.message);
      await this.#failWithoutAttempt(row, error);
      return null;
    }
    const orphan = async (detail: string): Promise<null> => {
      const error = new StateMachineOrphanedDefinitionError(
        row.definition,
        row.definition_version,
        detail
      );
      await this.#settleOutcome(row, null, error, "orphaned");
      return null;
    };
    // A run that never committed a checkpoint carries no shape to migrate:
    // it starts under the successor as if declared there.
    if (row.checkpoint !== null && successor.definition.migrate === undefined) {
      return orphan(
        `"${successor.name}" is registered but declares no migrate()`
      );
    }
    let checkpoint = row.checkpoint;
    let input = row.input;
    if (row.checkpoint !== null && successor.definition.migrate !== undefined) {
      try {
        const migrated = successor.definition.migrate(
          JSON.parse(row.checkpoint),
          row.definition_version,
          deserializeTaskValue(row.input) as StateMachineJson
        );
        checkpoint = serializeTaskCheckpoint(
          migrated.state,
          `checkpoint migrated by "${successor.name}"`
        );
        if (migrated.input !== undefined) {
          input = serializeTaskValue(
            migrated.input,
            `input migrated by "${successor.name}"`
          );
        }
      } catch (thrown) {
        return orphan(
          `migrate() threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`
        );
      }
    }
    const now = Date.now();
    this.#store.sql`
      UPDATE cf_agents_task_runs
      SET definition = ${successor.name},
          definition_version = ${successor.version},
          checkpoint = ${checkpoint}, input = ${input}, updated_at = ${now}
      WHERE run_id = ${row.run_id}
        AND state IN ('pending', 'waiting', 'running')
    `;
    const adopted = this.#store.getRun(row.run_id);
    return adopted ? { definition: successor.definition, row: adopted } : null;
  }

  /** The highest registered version of a base above `version`, if any. */
  #newestSuccessor(
    base: string,
    version: number
  ): {
    name: string;
    version: number;
    definition: AnyStateMachineDefinition;
  } | null {
    let best: {
      name: string;
      version: number;
      definition: AnyStateMachineDefinition;
    } | null = null;
    const consider = (name: string, definition: AnyStateMachineDefinition) => {
      const parsed = parseDefinitionName(name);
      if (parsed.base !== base || parsed.version <= version) return;
      if (best === null || parsed.version > best.version) {
        best = { name, version: parsed.version, definition };
      }
    };
    for (const [name, definition] of Object.entries(this.#definitions)) {
      consider(name, definition);
    }
    for (const [name, definition] of this.#registered) {
      consider(name, definition);
    }
    const resolver = taskDefinitionResolvers.get(this);
    if (resolver !== undefined) {
      for (const name of resolver.names()) {
        const definition = resolver.resolve(name);
        if (definition !== undefined) consider(name, definition);
      }
    }
    return best;
  }

  /**
   * Apply an abort mark to a run with no live invocation: a machine that
   * declared `onCancel` gets the cancel transition; everything else settles
   * by the mark's inline default (§6.4).
   */
  async #resolveMark(row: TaskRunRow): Promise<void> {
    const definition = this.#resolveDefinition(row.definition);
    if (
      definition !== undefined &&
      declaresOnCancel(definition) &&
      row.checkpoint !== null
    ) {
      await this.#runCancelTransition(row, definition);
      return;
    }
    await this.#settleByMark(row, null);
  }

  /** The inline default for each mark (§6.4). */
  async #settleByMark(
    row: TaskRunRow,
    generation: string | null
  ): Promise<void> {
    const runId = row.run_id;
    const mark = row.abort_mark ?? "cancel";
    const fail = async (error: Error): Promise<void> => {
      if (await this.#settleFailed(runId, generation, toErrorSummary(error))) {
        await this.#observeError(error, row);
      }
    };
    switch (mark) {
      case "cancel":
        await this.#settleCancelled(
          runId,
          generation,
          row.abort_reason ?? row.cancel_reason ?? undefined
        );
        return;
      case "parent":
        await this.#settleCancelled(runId, generation, "parent aborted");
        return;
      case "deadline":
        await fail(
          new StateMachineDeadlineExceededError(
            runId,
            row.deadline_at ?? Date.now()
          )
        );
        return;
      case "turn-deadline":
        await fail(
          new StateMachineTurnDeadlineExceededError(
            runId,
            row.turn_deadline_at ?? Date.now()
          )
        );
        return;
      case "seal": {
        const error = new Error(
          row.abort_reason ?? "sealed by the memory limit"
        );
        error.name = "TaskMemoryLimitSealed";
        await fail(error);
        return;
      }
    }
  }

  /**
   * The cancel transition (§6.2 steps 4–5): a fresh claim, fenced against
   * whatever invocation held the run by the mark itself, running `onCancel`
   * with `ctx.cancelling` set. Non-reentrant: a second mark arriving while
   * it runs is already recorded and does not re-dispatch it.
   */
  async #runCancelTransition(
    row: TaskRunRow,
    definition: AnyStateMachineDefinition
  ): Promise<void> {
    const runId = row.run_id;
    const held = this.#active.get(runId);
    if (held !== undefined && held.generation === row.generation) {
      // Still live under the mark; #afterAttempt dispatches once it ends.
      return;
    }
    const now = Date.now();
    const generation = nanoid();
    const attempt = row.attempt + 1;
    const written = this.#store.write(
      `UPDATE cf_agents_task_runs
       SET state = 'running', attempt = ?, generation = ?,
           started_at = coalesce(started_at, ?), next_at = ?,
           turn_deadline_at = ?, wait_reason = NULL, updated_at = ?
       WHERE run_id = ? AND state IN ('pending', 'waiting', 'running')
         AND abort_mark IS NOT NULL`,
      [
        attempt,
        generation,
        now,
        now + this.#claimTimeoutMs(),
        this.#turnDeadline(row, now),
        now,
        runId
      ]
    );
    if (written === 0) return;
    await this.#syncWake(runId);
    const claimed = this.#store.getRun(runId);
    if (!claimed || claimed.abort_mark === null) return;
    const controller = new AbortController();
    this.#emit("task:attempt:started", {
      runId,
      definition: claimed.definition,
      attempt,
      cancelling: claimed.abort_mark
    });
    const promise = this.#runAttempt(
      claimed,
      definition,
      generation,
      attempt,
      controller,
      null,
      now,
      claimed.abort_mark
    );
    await this.#track(runId, generation, controller, promise);
  }

  /**
   * One claimed invocation: the turn loop. A handler runs for the phase the
   * checkpoint names, and the post-transition decision list (§5.4) chooses
   * what its return means — a terminal settles, a changed checkpoint
   * commits and dispatches the next phase here, progress without a new
   * checkpoint re-dispatches the same phase, and nothing at all is a stall.
   * Every write is fenced on the generation and the abort mark, so an
   * invocation the protocol has moved past can commit nothing.
   */
  async #runAttempt(
    row: TaskRunRow,
    machine: AnyStateMachineDefinition,
    generation: string,
    attempt: number,
    controller: AbortController,
    interrupted: { name: string; attempt: number } | null,
    claimedAtMs: number,
    cancelling: StateMachineAbortMark | null,
    expiredWait: StateMachineWaitReason | null = null
  ): Promise<void> {
    const runId = row.run_id;
    const compiled = isCompiledCheckpoint(machine.initial);
    const engine = this.#createEngine(
      runId,
      row.definition,
      generation,
      controller,
      claimedAtMs,
      compiled,
      cancelling !== null
    );
    const input = deserializeTaskValue(row.input);
    let turn = row.checkpoint_turn;
    let checkpointJson = row.checkpoint;
    let transitions = row.transitions;
    let stall = row.stall;
    let progress = row.progress;
    let credited = 0;
    let interruptedStep = interrupted;
    let mark = cancelling;
    const trail: string[] = [];

    let state: unknown;
    try {
      state = this.#loadState(machine, row, input, compiled);
    } catch (thrown) {
      await this.#settleThrown(row, generation, thrown, mark, false);
      return;
    }
    if (!compiled && checkpointJson === null) {
      // The first dispatch commits `initial` at turn 0 before any handler
      // runs, so a park in the first phase — and `onCancel` after it — has
      // a checkpoint to read. One row write, once per machine run.
      let json: string | null;
      try {
        json = serializeTaskCheckpoint(
          state,
          `initial checkpoint of "${row.definition}"`
        );
      } catch (thrown) {
        await this.#settleThrown(row, generation, thrown, mark, false);
        return;
      }
      const committed = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs SET checkpoint = ?, updated_at = ?
         WHERE run_id = ? AND generation = ? AND state = 'running'
           AND abort_mark IS NULL AND checkpoint IS NULL`,
        [json, Date.now()]
      );
      if (!committed) return;
      checkpointJson = json;
      this.#emit("task:checkpoint", {
        runId,
        definition: row.definition,
        turn,
        phase: phaseOf(state)
      });
    }

    for (;;) {
      const phase = compiled ? COMPILED_PHASE : phaseOf(state);
      const handler = mark !== null ? machine.onCancel : machine.phases[phase];
      if (handler === undefined) {
        await this.#settleThrown(
          row,
          generation,
          new Error(
            `Definition "${row.definition}" has no handler for phase "${phase}"`
          ),
          mark,
          false
        );
        return;
      }
      const ctx = new ReplayStep(engine, {
        attempt,
        startsLive: attempt === 1 || turn > row.checkpoint_turn,
        interrupted: interruptedStep,
        turn,
        input,
        facts: {
          id: runId,
          definition: row.definition,
          version: row.definition_version,
          background: row.background === 1,
          metadata:
            row.metadata === null
              ? undefined
              : (JSON.parse(row.metadata) as Record<string, StateMachineJson>),
          createdAt: row.created_at,
          progress,
          cancelling: mark,
          expiredWait
        }
      });
      interruptedStep = null;
      expiredWait = null;
      if (!compiled) {
        this.#emit("task:transition:started", {
          runId,
          definition: row.definition,
          phase: mark !== null ? "onCancel" : phase,
          turn
        });
        if (trail.push(phase) > BUDGET_TRAIL) trail.shift();
      }

      let returned: unknown;
      try {
        // SAFETY: the engine's machine type admits every handler through
        // never-typed parameters; this is the one place one is invoked, with
        // the checkpoint its phase declared and the context that implements
        // the whole `ctx` surface.
        returned = await this.lifecycle.runInHostContext(() =>
          handler(state as never, ctx as never)
        );
      } catch (thrown) {
        if (mark !== null && isTaskSuspension(thrown)) {
          // `onCancel` may not park (§6.2).
          await this.#settleOutcome(
            row,
            generation,
            new StateMachineCancelCannotParkError(thrown.reason),
            "faulted",
            "set"
          );
          return;
        }
        await this.#settleThrown(
          row,
          generation,
          thrown,
          mark,
          declaresOnCancel(machine)
        );
        return;
      }

      const terminal = readTaskTerminal(returned);
      if (terminal !== undefined) {
        ctx.settleStreams(
          terminal.kind === "complete" ? "completed" : "errored",
          terminal.kind === "aborted"
            ? (terminal.reason ?? "aborted")
            : "failed"
        );
        await this.#settleTerminal(row, generation, terminal, mark);
        return;
      }
      if (compiled) {
        // Unreachable by construction — the compiled phase IS
        // `ctx.complete(await fn(input, ctx))` — and loud rather than
        // silent on purpose: settling `completed` with a NULL result
        // would turn a wrong terminal into data instead of a fault.
        await this.#settleThrown(
          row,
          generation,
          new Error(
            `Task definition "${row.definition}" returned no terminal from its compiled phase`
          ),
          null,
          false
        );
        return;
      }

      let nextJson: string | null;
      try {
        nextJson = serializeTaskCheckpoint(
          returned,
          `checkpoint returned by "${row.definition}" phase "${phase}"`
        );
      } catch (thrown) {
        await this.#settleThrown(row, generation, thrown, mark, false);
        return;
      }
      engine.creditProgress(ctx.takeStreamProgress());
      const delta = engine.progressCredited() - credited;
      credited += delta;
      const now = Date.now();

      if (mark !== null) {
        // `onCancel` returned a checkpoint: the machine declined the
        // cancel. Clear the mark and resume from what it returned.
        const resumed = this.#store.fencedWrite(
          runId,
          generation,
          `UPDATE cf_agents_task_runs
           SET checkpoint = ?, checkpoint_turn = ?, transitions = 0, stall = 0,
               progress = ?, abort_mark = NULL, abort_reason = NULL,
               cancel_requested = 0, cancel_reason = NULL, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'
             AND abort_mark IS NOT NULL`,
          [nextJson, turn + 1, progress + delta, now]
        );
        if (!resumed) return;
        engine.retireJournal(turn);
        turn += 1;
        checkpointJson = nextJson;
        transitions = 0;
        stall = 0;
        progress += delta;
        state = returned;
        mark = null;
        this.#emit("task:resumed", {
          runId,
          definition: row.definition,
          turn,
          declined: true
        });
        this.#emit("task:checkpoint", {
          runId,
          definition: row.definition,
          turn,
          phase: phaseOf(state)
        });
      } else if (nextJson !== checkpointJson) {
        // Rule 7: the checkpoint changed.
        transitions += 1;
        if (transitions > this.#transitionBudget) {
          await this.#settleOutcome(
            row,
            generation,
            new StateMachineTransitionBudgetError(runId, transitions, [
              ...trail
            ]),
            "faulted"
          );
          return;
        }
        // The atomic cutover (§9.2): a live engine-owned stream settles in
        // the same transaction as the checkpoint, through the settle's
        // `commit` hook. A commit the fence refuses throws inside it, which
        // rolls the settle back and leaves the stream live for whoever now
        // owns the run.
        let committed = false;
        const commit = () => {
          committed = engine.commitCheckpoint({
            checkpoint: nextJson,
            turn: turn + 1,
            retireTurn: turn,
            transitions,
            stall: 0,
            progress: progress + delta
          });
          if (!committed) throw new AttemptSupersededError(runId);
        };
        if (ctx.openStreams().length === 0) {
          try {
            commit();
          } catch (thrown) {
            if (!(thrown instanceof AttemptSupersededError)) throw thrown;
          }
        } else {
          try {
            ctx.settleStreams("completed", undefined, commit);
          } catch (thrown) {
            if (!(thrown instanceof AttemptSupersededError)) throw thrown;
          }
        }
        if (!committed) return;
        turn += 1;
        checkpointJson = nextJson;
        stall = 0;
        progress += delta;
        state = returned;
        this.#emit("task:checkpoint", {
          runId,
          definition: row.definition,
          turn,
          phase: phaseOf(state)
        });
      } else if (delta > 0) {
        // Rule 8: the same checkpoint, but durable progress was made.
        const committed = engine.commitCheckpoint({
          checkpoint: checkpointJson,
          turn,
          retireTurn: null,
          transitions,
          stall: 0,
          progress: progress + delta
        });
        if (!committed) return;
        stall = 0;
        progress += delta;
      } else {
        // Rule 9: nothing changed, nothing parked, nothing credited.
        stall += 1;
        if (stall >= this.#stallLimit) {
          await this.#settleOutcome(
            row,
            generation,
            new StateMachineNoProgressError(runId, phase, this.#stallLimit),
            "faulted"
          );
          return;
        }
        await this.#parkRun(
          row,
          generation,
          "retry",
          now + STALL_BACKOFF_MS * stall,
          { stall }
        );
        return;
      }

      // Between transitions: a pause takes effect here. A mark is caught
      // by the fence on the next write, and by #afterAttempt after it.
      const current = this.#store.getRun(runId);
      if (!current || current.generation !== generation) return;
      if (current.paused === 1) {
        await this.#parkRun(row, generation, "paused", null, {});
        return;
      }
    }
  }

  /**
   * The checkpoint an invocation starts from: the sentinel for a compiled
   * function, the committed checkpoint for a machine, or its `initial` —
   * evaluated against the seed on the first dispatch, so a throwing
   * `initial` is an application error on the run and not on `run()`.
   */
  #loadState(
    machine: AnyStateMachineDefinition,
    row: TaskRunRow,
    input: unknown,
    compiled: boolean
  ): unknown {
    if (compiled) return COMPILED_CHECKPOINT;
    if (row.checkpoint !== null) return JSON.parse(row.checkpoint);
    const initial = machine.initial;
    const state =
      typeof initial === "function"
        ? (initial as (seed: unknown) => unknown)(input)
        : initial;
    phaseOf(state);
    return state;
  }

  /** Rule 2: the handler returned a terminal. */
  async #settleTerminal(
    row: TaskRunRow,
    generation: string,
    terminal: TaskTerminalSignal,
    cancelling: StateMachineAbortMark | null
  ): Promise<void> {
    const runId = row.run_id;
    const mark: MarkPredicate = cancelling === null ? "null" : "set";
    switch (terminal.kind) {
      case "complete": {
        const resultJson = serializeTaskValue(
          terminal.result,
          `result of Task definition "${row.definition}"`
        );
        const now = Date.now();
        const settled = this.#store.fencedWrite(
          runId,
          generation,
          `UPDATE cf_agents_task_runs
           SET state = 'completed', result = ?, generation = NULL, next_at = NULL,
               turn_deadline_at = NULL, settled_at = ?, updated_at = ?
           WHERE run_id = ? AND generation = ? AND state = 'running'
             AND ${markClause(mark)}`,
          [resultJson, now, now]
        );
        if (settled) {
          this.#emit("task:completed", { runId, definition: row.definition });
          await this.#finishTerminalSettlement(
            runId,
            this.#store.getRun(runId)
          );
        }
        // Fence rejected: a newer generation owns the run, or the mark
        // landed under this one and #afterAttempt hands it to the protocol.
        return;
      }
      case "fail": {
        const summary = toErrorSummary(terminal.error);
        const failed = await this.#settleFailed(
          runId,
          generation,
          summary,
          null,
          { mark }
        );
        if (failed) await this.#observeError(terminal.error, row);
        return;
      }
      case "aborted":
        await this.#settleCancelled(runId, generation, terminal.reason, mark);
        return;
    }
  }

  /** Settle `failed` with an outcome that preserves the row (§6.6). */
  async #settleOutcome(
    row: TaskRunRow,
    generation: string | null,
    error: Error,
    outcome: "faulted" | "orphaned",
    mark: MarkPredicate = "any"
  ): Promise<void> {
    const settled = await this.#settleFailed(
      row.run_id,
      generation,
      toErrorSummary(error),
      null,
      { outcome, mark }
    );
    if (!settled) return;
    this.#emit(outcome === "faulted" ? "task:faulted" : "task:orphaned", {
      runId: row.run_id,
      definition: row.definition,
      error: error.name
    });
    console.error(
      `Task run "${row.run_id}" (definition "${row.definition}") ${outcome}: ${error.name}: ${error.message}`
    );
    await this.#observeError(error, row);
  }

  /** Park a live invocation: one fenced write, same turn, journal intact. */
  async #parkRun(
    row: TaskRunRow,
    generation: string,
    reason: StateMachineWaitReason,
    wakeAt: number | null,
    columns: { stall?: number }
  ): Promise<void> {
    const now = Date.now();
    const parked = this.#store.fencedWrite(
      row.run_id,
      generation,
      `UPDATE cf_agents_task_runs
       SET state = 'waiting', wait_reason = ?, next_at = ?, generation = NULL,
           turn_deadline_at = NULL, transitions = 0,
           stall = coalesce(?, stall), updated_at = ?
       WHERE run_id = ? AND generation = ? AND state = 'running'
         AND abort_mark IS NULL`,
      [reason, wakeAt, columns.stall ?? null, now]
    );
    if (!parked) return;
    this.#emit(reason === "paused" ? "task:paused" : "task:waiting", {
      runId: row.run_id,
      definition: row.definition,
      reason,
      wakeAt
    });
    await this.#syncWake(row.run_id);
  }

  /** Persist a non-completed attempt outcome. */
  async #settleThrown(
    row: TaskRunRow,
    generation: string,
    thrown: unknown,
    cancelling: StateMachineAbortMark | null,
    deferToProtocol: boolean
  ): Promise<void> {
    const runId = row.run_id;

    // Rule 1: a superseded attempt unwinds and writes nothing.
    if (thrown instanceof AttemptSupersededError) {
      return;
    }

    // Rule 3: a platform failure rethrows; the claim backstop is the wake.
    if (isPlatformFailure(thrown)) {
      throw thrown;
    }

    if (isTaskCancellation(thrown)) {
      // A step boundary saw the mark. A machine with `onCancel` gets its
      // cancel transition from #afterAttempt; everything else takes the
      // inline default now.
      if (deferToProtocol) return;
      await this.#settleCancelled(runId, generation, thrown.reason);
      return;
    }

    if (isTaskSuspension(thrown)) {
      // Rule 5, fenced on the mark: a park that races a mark is refused,
      // and #afterAttempt hands the run to the protocol instead.
      await this.#parkRun(row, generation, thrown.reason, thrown.wakeAt, {});
      return;
    }

    // Rule 6: an application error settles `failed`.
    const summary = toErrorSummary(thrown);
    const failed = await this.#settleFailed(runId, generation, summary, null, {
      mark: cancelling === null ? "null" : "set"
    });
    if (failed) {
      console.error(
        `Task run "${runId}" (definition "${row.definition}") failed: ${summary.name}: ${summary.message}`
      );
      await this.#observeError(thrown, row);
    }
  }

  /**
   * The interruption retry policy stored with a run, or null when the run
   * was accepted without `retries` — an interruption replays immediately.
   * Resolved at acceptance and persisted, so the policy a run is bounded by
   * never changes under it.
   */
  #runRetryPolicy(row: TaskRunRow): ResolvedRetryPolicy | null {
    if (row.retry_policy === null) return null;
    // SAFETY: written by #accept from a resolved policy of this shape.
    return JSON.parse(row.retry_policy) as ResolvedRetryPolicy;
  }

  /**
   * Park an interrupted attempt on its retry backoff in one write, fenced
   * on the dead generation so a live attempt that reclaimed the run in the
   * meantime is never demoted to waiting. The park carries its own wait
   * reason: the next claim must be able to tell this backoff — where the
   * interruption was already counted and its journal evidence still
   * stands — from a step retry park, where neither is true.
   */
  async #parkInterruption(
    row: TaskRunRow,
    interruptions: number,
    wakeAt: number
  ): Promise<void> {
    const now = Date.now();
    const parked =
      this.#store.write(
        `UPDATE cf_agents_task_runs
         SET state = 'waiting', wait_reason = 'interrupted', generation = NULL,
             next_at = ?, interruptions = ?, updated_at = ?
         WHERE run_id = ? AND state = 'running' AND generation IS ?`,
        [wakeAt, interruptions, now, row.run_id, row.generation]
      ) > 0;
    if (!parked) return;
    this.#emit("task:waiting", {
      runId: row.run_id,
      definition: row.definition,
      reason: "interrupted",
      wakeAt
    });
    await this.#syncWake(row.run_id);
  }

  /** Fail a run StateMachine will not claim again, without running its handler. */
  async #failWithoutAttempt(
    row: TaskRunRow,
    error: Error,
    interruptions: number | null = null
  ): Promise<void> {
    const failed = await this.#settleFailed(
      row.run_id,
      null,
      toErrorSummary(error),
      interruptions
    );
    if (failed) await this.#observeError(error, row);
  }

  async #observeError(
    error: unknown,
    run: { run_id: string; definition: string }
  ): Promise<void> {
    if (!this.#onError) return;
    try {
      // Observing terminal failures is host-facing user code: run it inside
      // the host invocation boundary, like definition handlers.
      await this.lifecycle.runInHostContext(() =>
        this.#onError?.(error, {
          runId: run.run_id,
          definition: run.definition
        })
      );
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
    claimedAtMs: number,
    compiled: boolean,
    cancelTransition: boolean
  ): TaskStepEngine {
    return createTaskStepEngine({
      store: this.#store,
      runId,
      generation,
      signal: controller.signal,
      claimTimeoutMs: () => this.#claimTimeoutMs(),
      claimedAtMs,
      claimRefreshAfterMs: CLAIM_SLACK_MS / 2,
      compiled,
      cancelTransition,
      spawn: (child, input, options) =>
        this.#spawn(runId, child, input, options),
      openStream: (name, options) => this.#openStream(runId, name, options),
      openExternalStream: (streamId, options) =>
        this.#requireStreams().open(streamId, {
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
          ...(options.metadata !== undefined
            ? { metadata: options.metadata }
            : {})
        }),
      defaults: this.#stepDefaults,
      emit: (type, payload) =>
        this.#emit(type as StateMachineEventType, {
          runId,
          definition,
          ...payload
        })
    });
  }

  /**
   * The step a lost attempt left mid-execution — replay-entry evidence,
   * scoped to the run's committed turn. A sibling left running when the
   * checkpoint changes retires with the rest of that turn's rows, so it can
   * never be misread in a later turn.
   */
  #interruptedStep(
    runId: string,
    turn: number
  ): { name: string; attempt: number } | null {
    const rows = this.#store.sql<{ name: string; attempt: number }>`
      SELECT name, attempt FROM cf_agents_task_journal
      WHERE run_id = ${runId} AND turn = ${turn} AND state = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    return row ? { name: row.name, attempt: row.attempt } : null;
  }

  /**
   * Settle one run as cancelled and sync its queue mirror. Fenced when a
   * generation is supplied.
   */
  async #settleCancelled(
    runId: string,
    generation: string | null,
    reason: string | undefined,
    mark: MarkPredicate = "any"
  ): Promise<void> {
    const now = Date.now();
    let settled: boolean;
    if (generation !== null) {
      settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET state = 'cancelled', cancel_requested = 1, cancel_reason = ?,
             abort_mark = coalesce(abort_mark, 'cancel'),
             abort_reason = coalesce(abort_reason, ?),
             generation = NULL, next_at = NULL, turn_deadline_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND state = 'running' AND ${markClause(mark)}`,
        [reason ?? null, reason ?? null, now, now]
      );
    } else {
      const written = this.#store.write(
        `UPDATE cf_agents_task_runs
         SET state = 'cancelled', cancel_requested = 1, cancel_reason = ?,
             abort_mark = coalesce(abort_mark, 'cancel'),
             abort_reason = coalesce(abort_reason, ?),
             generation = NULL, next_at = NULL, turn_deadline_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND state IN ('pending', 'waiting', 'running')`,
        [reason ?? null, reason ?? null, now, now, runId]
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
   *
   * @param interruptions - The count this failure itself lands on, when the
   * failure is the interruption that spends the run's retry budget; the
   * stored count stands for every other failure.
   */
  async #settleFailed(
    runId: string,
    generation: string | null,
    error: { name: string; message: string },
    interruptions: number | null = null,
    options: {
      outcome?: "faulted" | "orphaned";
      mark?: MarkPredicate;
    } = {}
  ): Promise<boolean> {
    const now = Date.now();
    const outcome = options.outcome ?? null;
    let settled: boolean;
    if (generation !== null) {
      settled = this.#store.fencedWrite(
        runId,
        generation,
        `UPDATE cf_agents_task_runs
         SET state = 'failed', error_name = ?, error_message = ?, outcome = ?,
             generation = NULL, next_at = NULL, turn_deadline_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ? AND generation = ?
           AND state = 'running' AND ${markClause(options.mark ?? "any")}`,
        [error.name, error.message, outcome, now, now]
      );
    } else {
      const written = this.#store.write(
        `UPDATE cf_agents_task_runs
         SET state = 'failed', error_name = ?, error_message = ?, outcome = ?,
             interruptions = coalesce(?, interruptions),
             generation = NULL, next_at = NULL, turn_deadline_at = NULL,
             settled_at = ?, updated_at = ?
         WHERE run_id = ?
           AND state IN ('pending', 'waiting', 'running')`,
        [error.name, error.message, outcome, interruptions, now, now, runId]
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

  async #finishTerminalSettlement(
    runId: string,
    row: TaskRunRow | undefined
  ): Promise<void> {
    if (row !== undefined) await this.#notifyParent(row);
    // `faulted` and `orphaned` override `retain: false` (§6.6): never
    // silently delete what `reopen()` needs.
    if (
      row?.retain === 0 &&
      (row.outcome === null || !PRESERVED_OUTCOMES.has(row.outcome))
    ) {
      this.#store.deleteRun(runId);
    }
    await this.#syncWake(runId);
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
    // A row that is SUPPOSED to carry a wake and does not is repaired here.
    // The narrowing is the point: a run parked on the mailbox, an ask or a
    // child carries a NULL `next_at` by design, and flooring it to now would
    // bill one row write per parked run on every isolate start and dispatch
    // a transition that can only re-park. `pending` is kept as its own half
    // because a pending row's `wait_reason` is NULL, so it would fall out of
    // the reason list. A WAITING row with no reason is repaired too, for the
    // same reason `rowToSnapshot` reads one back as a sleep: nothing here
    // writes one, but a row seeded by a host or left by an older build must
    // not be stranded by a predicate that assumes it cannot exist.
    this.#store.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now}, updated_at = ${now}
      WHERE (state = 'pending' AND next_at IS NULL)
         OR (state = 'waiting' AND next_at IS NULL
             AND (wait_reason IS NULL
                  OR wait_reason IN ('sleep', 'retry', 'interrupted')))
    `;
  }

  // ── Snapshots ────────────────────────────────────────────────────────────

  async #snapshot<Output extends StateMachineValue>(
    runId: string,
    definition?: string
  ): Promise<StateMachineRunSnapshot<Output> | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#store.rowToSnapshot<Output>(row);
  }

  async #snapshotByKey<Output extends StateMachineValue>(
    idempotencyKey: string,
    definition?: string
  ): Promise<StateMachineRunSnapshot<Output> | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRunByKey(idempotencyKey);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#store.rowToSnapshot<Output>(row);
  }

  #emit(
    type: StateMachineEventType | string,
    payload: Record<string, unknown>
  ): void {
    this.lifecycle.events.emit(type, payload);
    const change = CHANGE_OF[type];
    const runId = payload.runId;
    if (change === undefined || typeof runId !== "string") return;
    const listeners = this.#watchers.get(runId);
    if (listeners === undefined || listeners.size === 0) return;
    const row = this.#store.getRun(runId);
    if (!row) return;
    const view = this.#store.rowToView(row);
    for (const listener of [...listeners]) {
      try {
        listener({ type: change, runId, view });
      } catch (error) {
        console.error(`Tasks watch listener for "${runId}" threw`, error);
      }
    }
  }
}
