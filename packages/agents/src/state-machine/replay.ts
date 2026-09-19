/**
 * Replay step engine for the StateMachine capability.
 *
 * `ReplayStep` implements the `StateMachineStep` surface one handler attempt
 * receives. It owns replay semantics — journal hits, journal misses, retry
 * policy, durable sleeps, the status live gate, and duplicate/divergence
 * detection — while all SQL stays behind the narrow {@link TaskStepEngine}
 * port implemented by the `StateMachine` capability, the single owner of the
 * schema.
 */

import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformFailure
} from "../retries";
import { parseTaskDuration, type StateMachineDurationString } from "./duration";
import {
  StateMachineDuplicateStepError,
  StateMachineEventTimeoutError,
  StateMachineReplayDivergedError,
  StateMachineSerializationError,
  isNonRetryableError
} from "./errors";
import {
  asTaskTerminal,
  CHILD_MAILBOX_KIND,
  childMailboxKey,
  TaskTerminalSignal,
  TIMED_OUT
} from "./machine";
import { deserializeTaskValue, serializeTaskValue } from "./serialization";
import type { StreamWriter } from "../streams/types";
import type {
  AskKind,
  Pending,
  StateMachineAbortMark,
  StateMachineAskOptions,
  StateMachineChildRef,
  StateMachineChildResult,
  StateMachineContext,
  StateMachineJson,
  StateMachineMailboxFilter,
  StateMachineMailboxItem,
  StateMachinePhased,
  StateMachineReceipt,
  StateMachineRetryConfig,
  StateMachineSpawnOptions,
  StateMachineStepAttempt,
  StateMachineStepConfig,
  StateMachineStepEvent,
  StateMachineStreamOptions,
  StateMachineTerminal,
  StateMachineTimedOut,
  StateMachineValue,
  StateMachineWaitReason,
  TaskAskRow,
  TaskJournalRow,
  TaskMailboxRow
} from "./types";

/** The run facts one context carries, as of its attempt's claim. */
export type ReplayRunFacts = {
  readonly id: string;
  readonly definition: string;
  readonly version: number;
  readonly background: boolean;
  readonly metadata: Record<string, StateMachineJson> | undefined;
  readonly createdAt: number;
  /** Progress committed before this attempt; credits accrue on top. */
  readonly progress: number;
  /** The abort mark when this context runs `onCancel`, else null. */
  readonly cancelling: StateMachineAbortMark | null;
  /**
   * The event-driven wait this dispatch woke from with its `within` passed
   * — the first matching wait in the handler returns `timedOut` instead of
   * parking again. Null for every other wake.
   */
  readonly expiredWait: StateMachineWaitReason | null;
  /**
   * The event-driven wait this dispatch woke from early, with its `within`
   * still ahead: the first matching wait keeps that deadline instead of
   * re-arming a fresh one, so a trickle of unrelated sends cannot postpone
   * it forever.
   */
  readonly carriedWait: {
    reason: StateMachineWaitReason;
    deadline: number;
  } | null;
};

const NO_FACTS: ReplayRunFacts = {
  id: "",
  definition: "",
  version: 0,
  background: false,
  metadata: undefined,
  createdAt: 0,
  progress: 0,
  cancelling: null,
  expiredWait: null,
  carriedWait: null
};

/**
 * Resolved retry and backoff policy. Steps resolve one per `step.do()`; a
 * run resolves one for its interrupted attempts, which carries no timeout
 * (a run's claim backstop, not a callback race, bounds an attempt).
 */
export type ResolvedRetryPolicy = {
  readonly retryLimit: number;
  readonly retryDelayMs: number;
  readonly backoff: "constant" | "linear" | "exponential";
};

/** Resolved per-step retry and timeout policy. */
export type ResolvedStepPolicy = ResolvedRetryPolicy & {
  readonly timeoutMs: number;
};

/** Longest computed retry delay: backoff growth never exceeds one day. */
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/** Steps per run ceiling; crossing it fails the run instead of degrading. */
export const MAX_STEPS_PER_RUN = 10_000;

/** Longest accepted step name. Step names are durable journal keys. */
export const MAX_STEP_NAME_LENGTH = 256;

/**
 * Thrown by the engine to end one execution attempt while its run waits for
 * a durable deadline (sleep or retry). Not an `Error` subclass so a step
 * callback's `catch (error)` around unrelated work is less likely to swallow
 * it; the capability re-checks with {@link isTaskSuspension}.
 */
export class TaskSuspension {
  /** NULL for an event-driven park: no alarm, woken by a send or an answer. */
  readonly wakeAt: number | null;
  // An attempt only ever suspends itself; the 'interrupted' park is written
  // over a lost attempt by the capability, never thrown from inside one.
  readonly reason: Exclude<StateMachineWaitReason, "interrupted">;

  constructor(
    wakeAt: number | null,
    reason: Exclude<StateMachineWaitReason, "interrupted">
  ) {
    this.wakeAt = wakeAt;
    this.reason = reason;
  }
}

/** True when a thrown value is the engine's suspension signal. */
export function isTaskSuspension(value: unknown): value is TaskSuspension {
  return value instanceof TaskSuspension;
}

/**
 * Thrown by the engine when a step boundary observes the run's cancellation
 * request. The capability settles the run as cancelled.
 */
/**
 * Thrown by a step boundary during a compensation replay when the replay
 * reaches ground the original attempt never completed: the walk stops here,
 * and everything registered before it is compensated.
 */
/** @internal One compensation a compensation replay collected. */
export type StepCompensation = {
  readonly step: string;
  /** The step's resolved timeout, which bounds its compensation too. */
  readonly timeoutMs: number;
  readonly run: () => void | Promise<void>;
};

export class CompensationBoundary {
  readonly step: string;

  constructor(step: string) {
    this.step = step;
  }
}

export function isCompensationBoundary(
  value: unknown
): value is CompensationBoundary {
  return value instanceof CompensationBoundary;
}

export class TaskCancellation {
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    this.reason = reason;
  }
}

/** True when a thrown value is the engine's cancellation signal. */
export function isTaskCancellation(value: unknown): value is TaskCancellation {
  return value instanceof TaskCancellation;
}

/**
 * Thrown by engine writes when another execution attempt has superseded this
 * one. The stale attempt unwinds without settling anything; every durable
 * write it might still try is generation-fenced.
 */
export class AttemptSupersededError extends Error {
  constructor(runId: string) {
    super(
      `Task attempt superseded: run "${runId}" is no longer claimed by this ` +
        `execution attempt`
    );
    this.name = "AttemptSupersededError";
  }
}

/**
 * Storage and policy port the `StateMachine` capability supplies to one attempt's
 * `ReplayStep`. Every mutation is fenced by the attempt's generation on the
 * capability side.
 */
export interface TaskStepEngine {
  /** Read one journal row of this turn, or undefined for a journal miss. */
  readStep(turn: number, name: string): TaskJournalRow | undefined;

  /** Number of journal rows this turn has written. */
  countSteps(turn: number): number;

  /** Insert a new journal row claimed at attempt 1. */
  insertStep(
    turn: number,
    name: string,
    kind: "do" | "sleep" | "event",
    wakeAt: number | null
  ): void;

  /** Journal an already-elapsed sleep born-completed, in one row write. */
  insertCompletedSleep(turn: number, name: string): void;

  /** Claim the next attempt of an existing step. Returns the new attempt. */
  claimStepAttempt(turn: number, name: string): number;

  /** Persist a completed step. Serializes and validates the result. */
  completeStep(turn: number, name: string, result: unknown): void;

  /** Persist a terminally failed step. */
  failStep(
    turn: number,
    name: string,
    error: { name: string; message: string }
  ): void;

  /** Move a step into its retry wait. */
  waitStep(turn: number, name: string, wakeAt: number): void;

  /** Delete one retiring turn's journal rows. Run-scoped rows are untouched. */
  retireJournal(turn: number): void;

  /** Read one run-scoped memo, or undefined when it was never written. */
  readMemo(name: string): TaskJournalRow | undefined;

  /** Write one run-scoped memo. False when a first writer already won. */
  writeMemo(name: string, value: string | null): boolean;

  /** Visible mailbox rows matching a filter, in FIFO order across kinds. */
  peekMailbox(
    filter: StateMachineMailboxFilter | undefined,
    now: number
  ): TaskMailboxRow[];

  /** Consume mailbox rows by key. Returns how many were still queued. */
  consumeMailbox(keys: readonly string[]): number;

  /** How many mailbox rows this run holds, consumed or not yet visible. */
  countMailbox(): number;

  /** The next FIFO sequence number for this run's mailbox. */
  nextMailboxSeq(): number;

  /** Append one mailbox row. False when its key was already present. */
  appendMailbox(item: {
    key: string;
    seq: number;
    kind: string;
    type: string | null;
    payload: string | null;
    visibleAfter: number | null;
  }): boolean;

  /** Write one ask row. */
  insertAsk(ask: {
    askId: string;
    turn: number;
    name: string;
    question: string | null;
    expiresAt: number | null;
    metadata: string | null;
  }): void;

  /** Read specific asks of this run by id. */
  readAsks(askIds: readonly string[]): TaskAskRow[];

  /** Settle one open ask. False when it was already answered or lapsed. */
  settleAsk(
    askId: string,
    state: "answered" | "expired" | "withdrawn",
    answer: string | null
  ): boolean;

  /** Mark every still-open ask of this run withdrawn. Returns the count. */
  withdrawOpenAsks(): number;

  /** The non-terminal children this run owns. */
  listChildren(): StateMachineChildRef[];

  /** The fenced write that commits one transition. False when fenced out. */
  commitCheckpoint(commit: {
    checkpoint: string | null;
    turn: number;
    retireTurn: number | null;
    transitions: number;
    stall: number;
    progress: number;
    /** Mailbox keys consumed by this transition; deleted with the commit. */
    consume: readonly string[];
  }): boolean;

  /** Delete mailbox items by key, unfenced: for the capability's own boundary writes. */
  deleteMailbox(keys: readonly string[]): number;

  /** Credit durable work the chunk log cannot see. Writes nothing itself. */
  creditProgress(units: number): void;

  /** Work credited through {@link creditProgress} during this attempt. */
  progressCredited(): number;

  /** Extend the run's claim deadline while a step attempt executes. */
  refreshClaim(): void;

  /** Persist the run's observable status message. */
  writeStatus(message: string): void;

  /** The cancellation reason when this run was asked to cancel, else null. */
  cancellationRequested(): { reason: string | undefined } | null;

  /** Abort signal for the whole attempt (cancellation or supersession). */
  readonly attemptSignal: AbortSignal;

  /** Accept a child of this run. */
  spawn(
    definition: string,
    input: unknown,
    options: StateMachineSpawnOptions | undefined
  ): Promise<StateMachineReceipt>;

  /** Open or resume this run's engine-owned stream `name`. */
  openStream(
    name: string,
    options: StateMachineStreamOptions | undefined
  ): Promise<StreamWriter>;

  /** Open a caller-identified stream the engine does not own. */
  openExternalStream(
    streamId: string,
    options: StateMachineStreamOptions
  ): Promise<StreamWriter>;

  /** Emit one capability event. */
  emit(type: string, payload: Record<string, unknown>): void;

  /**
   * Stable external deduplication key for one named step, scoped to the
   * turn the caller is in — `turn` leads, as it does on every journal
   * method, because the same name in two turns is two intended executions.
   */
  stepIdempotencyKey(
    turn: number,
    name: string,
    scope?: "turn" | "run"
  ): string;

  /** Default policy applied where a step config leaves fields unset. */
  readonly defaults: ResolvedStepPolicy;
}

/** Compute the delay before the next attempt after `failedAttempt` failed. */
export function computeRetryDelayMs(
  policy: ResolvedRetryPolicy,
  failedAttempt: number
): number {
  const base = policy.retryDelayMs;
  let delay: number;
  switch (policy.backoff) {
    case "constant":
      delay = base;
      break;
    case "linear":
      delay = base * failedAttempt;
      break;
    case "exponential":
      delay = base * 2 ** (failedAttempt - 1);
      break;
  }
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Resolve one retry policy against defaults, validating as it goes.
 *
 * @param context - The option being resolved (`"step retries"`,
 * `"run interruptions"`), used to name it in validation errors.
 */
export function resolveRetryPolicy(
  defaults: ResolvedRetryPolicy,
  retries: StateMachineRetryConfig | undefined,
  context: string
): ResolvedRetryPolicy {
  const limit = retries?.limit ?? defaults.retryLimit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Invalid ${context}.limit: expected an integer >= 1, got ${limit}`
    );
  }
  return {
    retryLimit: limit,
    retryDelayMs:
      retries?.delay !== undefined
        ? parseTaskDuration(retries.delay, `${context}.delay`)
        : defaults.retryDelayMs,
    backoff: retries?.backoff ?? defaults.backoff
  };
}

/** Resolve one `step.do()` config against the capability defaults. */
export function resolveStepPolicy(
  defaults: ResolvedStepPolicy,
  config: Pick<StateMachineStepConfig<never>, "retries" | "timeout"> | undefined
): ResolvedStepPolicy {
  return {
    ...resolveRetryPolicy(defaults, config?.retries, "step retries"),
    timeoutMs:
      config?.timeout !== undefined
        ? parseTaskDuration(config.timeout, "step timeout")
        : defaults.timeoutMs
  };
}

/**
 * The `StateMachineStep` implementation for one execution attempt.
 *
 * Attempt 1 starts live. A later attempt starts silent and becomes live at
 * the frontier of new ground — the first journal miss, or a step still
 * waiting or running — so replayed `status()` calls from completed ground
 * are suppressed instead of re-published as new progress.
 */
export class ReplayStep implements StateMachineContext<
  StateMachinePhased,
  unknown,
  StateMachineValue,
  unknown
> {
  readonly #engine: TaskStepEngine;
  readonly #usedNames = new Set<string>();
  #live: boolean;
  readonly attempt: number;
  readonly interrupted: {
    readonly name: string;
    readonly attempt: number;
  } | null;
  readonly signal: AbortSignal;

  /** The turn this invocation replays against; 0 for a compiled function. */
  readonly turn: number;

  /** The run's seed, as persisted at acceptance. */
  readonly input: unknown;

  // ── run facts ────────────────────────────────────────────────────────────
  readonly id: string;
  readonly definition: string;
  readonly version: number;
  readonly background: boolean;
  readonly metadata: Record<string, StateMachineJson> | undefined;
  readonly createdAt: number;
  readonly cancelling: StateMachineAbortMark | null;
  readonly timedOut: StateMachineTimedOut = TIMED_OUT;
  readonly #progressBase: number;
  #expiredWait: StateMachineWaitReason | null;
  #carriedWait: { reason: StateMachineWaitReason; deadline: number } | null;
  /**
   * Mailbox keys this transition has taken. They are deleted with the next
   * durable boundary — commit, park or settle — inside its fence, so a
   * transition the abort mark or a newer generation cuts off consumes
   * nothing; until then they are hidden from every read here.
   */
  readonly #consumed = new Set<string>();
  /**
   * Compensations registered by completed `do` steps, in completion order.
   * The engine runs them in reverse when the run is aborted (§ compensate).
   */
  readonly #compensations: StepCompensation[] = [];
  /**
   * True for a compensation replay: journaled ground replays as usual and
   * registers its compensations, and the first step the original attempt
   * never completed ends the walk instead of executing.
   */
  readonly #compensating: boolean;
  /** Asks raised in this transition, per kind: the ordinal in their ids. */
  readonly #askOrdinals = new Map<string, number>();
  /** Children spawned in this transition without a caller-chosen id. */
  #spawnOrdinal = 0;
  /** Engine-owned streams this invocation opened, by name. */
  readonly #streams = new Map<
    string,
    { writer: StreamWriter; openedCursor: number }
  >();

  constructor(
    engine: TaskStepEngine,
    options: {
      attempt: number;
      startsLive: boolean;
      interrupted?: { name: string; attempt: number } | null;
      turn?: number;
      input?: unknown;
      facts?: ReplayRunFacts;
      compensating?: boolean;
    }
  ) {
    this.#engine = engine;
    this.#live = options.startsLive;
    this.attempt = options.attempt;
    this.interrupted = options.interrupted ?? null;
    this.signal = engine.attemptSignal;
    this.turn = options.turn ?? 0;
    this.input = options.input;
    const facts = options.facts ?? NO_FACTS;
    this.id = facts.id;
    this.definition = facts.definition;
    this.version = facts.version;
    this.background = facts.background;
    this.metadata = facts.metadata;
    this.createdAt = facts.createdAt;
    this.cancelling = facts.cancelling;
    this.#progressBase = facts.progress;
    this.#expiredWait = facts.expiredWait;
    this.#carriedWait = facts.carriedWait;
    this.#compensating = options.compensating === true;
  }

  /** @internal The compensations to run, newest first. */
  compensations(): ReadonlyArray<StepCompensation> {
    return [...this.#compensations].reverse();
  }

  /**
   * In a compensation replay, keep the compensation a completed step
   * registered, bounded by that step's own timeout. A live attempt keeps
   * nothing: its compensations run in a fresh pass, never inline.
   */
  #register<T>(
    name: string,
    config: StateMachineStepConfig<T> | undefined,
    policy: ResolvedStepPolicy,
    result: T
  ): void {
    if (!this.#compensating) return;
    const compensate = config?.compensate;
    if (compensate === undefined) return;
    this.#compensations.push({
      step: name,
      timeoutMs: policy.timeoutMs,
      run: () => compensate(result)
    });
  }

  /** In a compensation replay, ground the attempt never completed ends the walk. */
  #boundary(name: string): void {
    if (this.#compensating) throw new CompensationBoundary(name);
  }

  /** @internal The mailbox keys taken this transition, handed to the boundary. */
  takeConsumed(): string[] {
    const keys = [...this.#consumed];
    this.#consumed.clear();
    return keys;
  }

  /** Mailbox rows not already taken this transition. */
  #unconsumed(rows: TaskMailboxRow[]): TaskMailboxRow[] {
    return rows.filter((row) => !this.#consumed.has(row.key));
  }

  /** Take rows: hidden from later reads here, deleted at the boundary. */
  #take(rows: readonly TaskMailboxRow[]): void {
    for (const row of rows) this.#consumed.add(row.key);
    this.#engine.creditProgress(rows.length);
  }

  /** Consume the woken-from-expiry flag for one wait kind, once. */
  #tookExpiry(reason: StateMachineWaitReason): boolean {
    if (this.#expiredWait !== reason) return false;
    this.#expiredWait = null;
    return true;
  }

  /**
   * The absolute deadline a `within` names, or null for none. A wait this
   * dispatch was woken into early keeps the deadline it parked with.
   */
  #withinDeadline(
    within: number | StateMachineDurationString | undefined,
    reason: StateMachineWaitReason
  ): number | null {
    const carried = this.#carriedWait;
    if (carried !== null && carried.reason === reason) {
      this.#carriedWait = null;
      return carried.deadline;
    }
    if (within === undefined) return null;
    return Date.now() + parseTaskDuration(within, "within");
  }

  /** Progress committed plus what this attempt has credited so far. */
  get progress(): number {
    return this.#progressBase + this.#engine.progressCredited();
  }

  /** The non-terminal children this run owns, read from the store. */
  get children(): readonly StateMachineChildRef[] {
    return this.#engine.listChildren();
  }

  // ── liveness and progress ────────────────────────────────────────────────

  heartbeat(): void {
    this.#engine.refreshClaim();
  }

  creditProgress(units = 1): void {
    if (!Number.isFinite(units) || units <= 0) return;
    this.#engine.creditProgress(units);
  }

  // ── run-scoped values ────────────────────────────────────────────────────

  memo<T extends StateMachineJson>(name: string, candidate: T): T;
  memo<T extends StateMachineJson>(name: string): T | undefined;
  memo<T extends StateMachineJson>(
    name: string,
    ...rest: [candidate: T] | []
  ): T | undefined {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Memo names must be non-empty strings");
    }
    const durable = this.#engine.readMemo(name);
    if (durable !== undefined) return deserializeTaskValue(durable.result) as T;
    if (rest.length === 0) return undefined;
    const [candidate] = rest;
    const json = serializeTaskValue(candidate, `memo "${name}"`);
    // First write wins; a fenced-out or repeated write returns false and the
    // durable value is re-read, so every attempt of this run sees one value.
    if (this.#engine.writeMemo(name, json)) return candidate;
    const written = this.#engine.readMemo(name);
    return written === undefined
      ? candidate
      : (deserializeTaskValue(written.result) as T);
  }

  // ── mailbox ──────────────────────────────────────────────────────────────

  async receive(
    filter?: StateMachineMailboxFilter & {
      within?: number | StateMachineDurationString;
    }
  ): Promise<StateMachineMailboxItem<unknown> | StateMachineTimedOut> {
    const { within, ...rest } = filter ?? {};
    const row = this.#unconsumed(this.#engine.peekMailbox(rest, Date.now()))[0];
    if (row !== undefined) {
      this.#take([row]);
      return mailboxItem(row);
    }
    if (this.#tookExpiry("mailbox")) return TIMED_OUT;
    this.#boundary("receive");
    throw new TaskSuspension(
      this.#withinDeadline(within, "mailbox"),
      "mailbox"
    );
  }

  async receiveAll(
    filter?: StateMachineMailboxFilter & {
      within?: number | StateMachineDurationString;
    }
  ): Promise<StateMachineMailboxItem<unknown>[] | StateMachineTimedOut> {
    const { within, ...rest } = filter ?? {};
    const rows = this.#unconsumed(this.#engine.peekMailbox(rest, Date.now()));
    if (rows.length > 0) {
      this.#take(rows);
      return rows.map(mailboxItem);
    }
    if (this.#tookExpiry("mailbox")) return TIMED_OUT;
    this.#boundary("receive");
    throw new TaskSuspension(
      this.#withinDeadline(within, "mailbox"),
      "mailbox"
    );
  }

  peek(
    filter?: StateMachineMailboxFilter
  ): StateMachineMailboxItem<unknown> | undefined {
    const row = this.#unconsumed(
      this.#engine.peekMailbox(filter, Date.now())
    )[0];
    return row === undefined ? undefined : mailboxItem(row);
  }

  peekAll(
    filter?: StateMachineMailboxFilter
  ): StateMachineMailboxItem<unknown>[] {
    return this.#unconsumed(this.#engine.peekMailbox(filter, Date.now())).map(
      mailboxItem
    );
  }

  withdraw(key: string): boolean {
    const row = this.#unconsumed(
      this.#engine.peekMailbox({ key }, Date.now())
    )[0];
    if (row === undefined) return false;
    this.#take([row]);
    return true;
  }

  // ── asks ─────────────────────────────────────────────────────────────────

  ask<Payload, Answer>(
    kind: AskKind<Payload, Answer>,
    payloads: readonly Payload[],
    options?: StateMachineAskOptions
  ): Pending<Answer>[] {
    const expiresAt =
      options?.expiresIn === undefined
        ? null
        : Date.now() + parseTaskDuration(options.expiresIn, "expiresIn");
    const metadata =
      options?.metadata === undefined ? null : JSON.stringify(options.metadata);
    // Ids are derived, not drawn: run, turn, kind and the ordinal of the ask
    // within this transition. A replay of the transition raises the same
    // ids, the insert is idempotent, and the answers already durable under
    // them are found rather than stranded behind a fresh batch.
    return payloads.map((payload, index) => {
      const ordinal = this.#askOrdinals.get(kind.name) ?? 0;
      this.#askOrdinals.set(kind.name, ordinal + 1);
      const askId = `${this.id}#t${this.turn}:${kind.name}:${String(ordinal).padStart(4, "0")}`;
      void index;
      this.#engine.insertAsk({
        askId,
        turn: this.turn,
        name: kind.name,
        question: serializeTaskValue(
          payload as StateMachineValue,
          `ask "${kind.name}" payload ${index}`
        ),
        expiresAt,
        metadata
      });
      this.#engine.emit("task:ask", { askId, name: kind.name });
      return { id: askId };
    });
  }

  async answers<Answer>(
    pending: readonly Pending<Answer>[],
    options?: {
      within?: number | StateMachineDurationString;
      mode?: "all" | "any";
    }
  ): Promise<(Answer | undefined)[] | StateMachineTimedOut> {
    const ids = pending.map((ask) => ask.id);
    const now = Date.now();
    const rows = this.#engine.readAsks(ids);
    // An expiry that passed while the run was parked flips here, one
    // conditional write per lapsed row, so the ledger is what the UI sees.
    let lapsed = false;
    for (const row of rows) {
      if (
        row.state === "open" &&
        row.expires_at !== null &&
        row.expires_at <= now &&
        this.#engine.settleAsk(row.ask_id, "expired", null)
      ) {
        row.state = "expired";
        lapsed = true;
      }
    }
    const byId = new Map(rows.map((row) => [row.ask_id, row]));
    const settled = ids.filter((id) => byId.get(id)?.state !== "open");
    const done =
      options?.mode === "any"
        ? settled.length > 0
        : settled.length === ids.length;
    if (done) return ids.map((id) => answerOf<Answer>(byId.get(id)));
    this.#boundary("answers");
    // A wake the expiry sweep explains is not the `within` deadline.
    if (!lapsed && this.#tookExpiry("ask")) return TIMED_OUT;
    const within = this.#withinDeadline(options?.within, "ask");
    const expiries = rows
      .filter((row) => row.state === "open" && row.expires_at !== null)
      .map((row) => row.expires_at ?? Number.POSITIVE_INFINITY);
    const candidates = [within, ...expiries].filter(
      (at): at is number => at !== null && Number.isFinite(at)
    );
    throw new TaskSuspension(
      candidates.length === 0 ? null : Math.min(...candidates),
      "ask"
    );
  }

  peekAnswers<Answer>(
    pending: readonly Pending<Answer>[]
  ): (Answer | undefined)[] {
    const rows = this.#engine.readAsks(pending.map((ask) => ask.id));
    const byId = new Map(rows.map((row) => [row.ask_id, row]));
    return pending.map((ask) => answerOf<Answer>(byId.get(ask.id)));
  }

  // ── children ─────────────────────────────────────────────────────────────

  /**
   * Accept a child of this run. Without a caller-chosen `runId` the child's
   * id is derived from the run, the turn and the spawn's ordinal in this
   * transition, so a replay of the transition joins the child it already
   * accepted instead of starting a second one. Derive an explicit id from
   * durable state, never from a counter.
   */
  spawn(
    definition: string,
    input?: StateMachineJson,
    options?: StateMachineSpawnOptions
  ): Promise<StateMachineReceipt> {
    const runId =
      options?.runId ?? `${this.id}:t${this.turn}:${this.#spawnOrdinal++}`;
    return this.#engine.spawn(definition, input, { ...options, runId });
  }

  /**
   * Sugar over `receive({ kind: "child" })`: waits until every named child
   * has settled, then consumes their notes in one block. Nothing is consumed
   * before all have arrived, so a wait that parks and re-enters sees them
   * all again.
   */
  async join<Output extends StateMachineValue>(
    children: readonly (StateMachineChildRef | StateMachineReceipt | string)[],
    options?: { within?: number | StateMachineDurationString }
  ): Promise<StateMachineChildResult<Output>[] | StateMachineTimedOut> {
    const ids = children.map((child) =>
      typeof child === "string" ? child : child.runId
    );
    const wanted = new Map(ids.map((id) => [childMailboxKey(id), id]));
    const rows = this.#unconsumed(
      this.#engine.peekMailbox({ kind: CHILD_MAILBOX_KIND }, Date.now())
    ).filter((row) => wanted.has(row.key));
    if (rows.length >= wanted.size) {
      const byKey = new Map(rows.map((row) => [row.key, row]));
      this.#take(rows);
      return ids.map((id) =>
        childResult<Output>(id, byKey.get(childMailboxKey(id)))
      );
    }
    if (this.#tookExpiry("child")) return TIMED_OUT;
    this.#boundary("join");
    throw new TaskSuspension(
      this.#withinDeadline(options?.within, "child"),
      "child"
    );
  }

  // ── streams ──────────────────────────────────────────────────────────────

  /**
   * Open this run's engine-owned stream `name` (default `"main"`), or resume
   * it. Appends heartbeat the claim; the stream settles with the next
   * checkpoint commit (§9.2), and its cursor advance is progress (§9.3).
   * `options.streamId` opts out of ownership: the writer is returned as is.
   */
  async stream(
    name = "main",
    options?: StateMachineStreamOptions
  ): Promise<StreamWriter> {
    if (options?.streamId !== undefined) {
      return this.#engine.openExternalStream(options.streamId, options);
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Stream names must be non-empty strings");
    }
    const open = this.#streams.get(name);
    if (open !== undefined) return open.writer;
    const inner = await this.#engine.openStream(name, options);
    const engine = this.#engine;
    const writer: StreamWriter = {
      streamId: inner.streamId,
      get cursor() {
        return inner.cursor;
      },
      append: (chunk) => {
        engine.refreshClaim();
        return inner.append(chunk);
      },
      close: (settle) => inner.close(settle),
      error: (reason, settle) => inner.error(reason, settle),
      onCommit: (fn) => inner.onCommit(fn)
    };
    this.#streams.set(name, { writer, openedCursor: inner.cursor });
    return writer;
  }

  /** @internal The engine-owned writers still open in this invocation. */
  openStreams(): StreamWriter[] {
    return [...this.#streams.values()].map((entry) => entry.writer);
  }

  /** @internal Cursor advance since open (or since last taken), as progress. */
  takeStreamProgress(): number {
    let credited = 0;
    for (const entry of this.#streams.values()) {
      const advance = entry.writer.cursor - entry.openedCursor;
      if (advance > 0) {
        credited += advance;
        entry.openedCursor = entry.writer.cursor;
      }
    }
    return credited;
  }

  /** @internal Settle every open engine-owned stream; the last one may commit. */
  settleStreams(
    state: "completed" | "errored",
    reason: string | undefined,
    commit?: () => void
  ): void {
    const entries = [...this.#streams.values()];
    this.#streams.clear();
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      const options = last && commit !== undefined ? { commit } : undefined;
      if (state === "completed") entry.writer.close(options);
      else entry.writer.error(reason, options);
    });
  }

  // ── terminals ────────────────────────────────────────────────────────────

  /** Settle this run with a result. */
  complete(result: StateMachineValue): StateMachineTerminal<StateMachineValue> {
    return asTaskTerminal(TaskTerminalSignal.complete(result));
  }

  /** Settle this run as failed. */
  fail(error: unknown): StateMachineTerminal<StateMachineValue> {
    return asTaskTerminal(TaskTerminalSignal.fail(error));
  }

  /** Settle this run as cancelled, carrying the abort mark's reason. */
  aborted(reason?: string): StateMachineTerminal<StateMachineValue> {
    return asTaskTerminal(TaskTerminalSignal.aborted(reason));
  }

  do<T extends StateMachineValue>(
    name: string,
    callback: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T>;
  do<T extends StateMachineValue>(
    name: string,
    config: StateMachineStepConfig<T>,
    callback: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T>;
  async do<T extends StateMachineValue>(
    name: string,
    configOrCallback:
      | StateMachineStepConfig<T>
      | ((attempt: StateMachineStepAttempt) => T | Promise<T>),
    maybeCallback?: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T> {
    const config =
      typeof configOrCallback === "function" ? undefined : configOrCallback;
    const callback =
      typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
    if (typeof callback !== "function") {
      throw new Error(`step.do("${name}") requires a callback`);
    }
    const policy = resolveStepPolicy(this.#engine.defaults, config);
    this.#enterStep(name);

    const row = this.#engine.readStep(this.turn, name);
    if (row === undefined) {
      // New ground: a compensation replay stops here; an attempt executes.
      this.#boundary(name);
      this.#live = true;
      if (this.#engine.countSteps(this.turn) >= MAX_STEPS_PER_RUN) {
        throw new Error(
          `Run exceeded ${MAX_STEPS_PER_RUN} steps; split the work across ` +
            `multiple Task runs`
        );
      }
      this.#engine.insertStep(this.turn, name, "do", null);
      const result = await this.#executeAttempt(name, 1, policy, callback);
      this.#register(name, config, policy, result);
      return result;
    }

    if (row.kind !== "do") {
      throw new StateMachineReplayDivergedError(
        name,
        `journaled as a ${row.kind} step but replayed as a do step`
      );
    }

    switch (row.state) {
      case "completed": {
        // Journaled ground replays without executing. A compensation pass
        // keeps the compensation the step registered — unless an earlier
        // pass already ran it, which the journal records.
        const result = deserializeTaskValue(row.result) as T;
        if (row.compensated_at === null) {
          this.#register(name, config, policy, result);
        }
        return result;
      }
      case "failed":
        this.#boundary(name);
        throw restoreStepError(row);
      case "waiting": {
        this.#boundary(name);
        this.#live = true;
        const wakeAt = row.next_at ?? Date.now();
        if (Date.now() < wakeAt) throw new TaskSuspension(wakeAt, "retry");
        const attempt = this.#engine.claimStepAttempt(this.turn, name);
        this.#engine.emit("task:step:retry", { step: name, attempt });
        const result = await this.#executeAttempt(
          name,
          attempt,
          policy,
          callback
        );
        this.#register(name, config, policy, result);
        return result;
      }
      case "running": {
        this.#boundary(name);
        this.#live = true;
        const attempt = this.#engine.claimStepAttempt(this.turn, name);
        const result = await this.#executeAttempt(
          name,
          attempt,
          policy,
          callback
        );
        this.#register(name, config, policy, result);
        return result;
      }
    }
  }

  async sleep(
    name: string,
    duration: number | StateMachineDurationString
  ): Promise<void> {
    const durationMs = parseTaskDuration(duration, "sleep duration");
    return this.#sleepAt(name, () => Date.now() + durationMs);
  }

  async sleepUntil(name: string, when: number | Date): Promise<void> {
    const wakeAt = when instanceof Date ? when.getTime() : when;
    if (!Number.isFinite(wakeAt)) {
      throw new Error(
        `Invalid sleepUntil time for step "${name}": ${String(when)}`
      );
    }
    return this.#sleepAt(name, () => wakeAt);
  }

  async status(message: string): Promise<void> {
    if (!this.#live) return;
    this.#engine.writeStatus(String(message));
  }

  idempotencyKey(name: string, options?: { scope?: "turn" | "run" }): string {
    return this.#engine.stepIdempotencyKey(this.turn, name, options?.scope);
  }

  async waitForEvent<Payload extends StateMachineJson>(
    name: string,
    options: { type: string; timeout?: number | StateMachineDurationString }
  ): Promise<StateMachineStepEvent<Payload>> {
    if (typeof options?.type !== "string" || options.type.length === 0) {
      throw new Error(`step.waitForEvent("${name}") requires an event type`);
    }
    this.#enterStep(name);
    const row = this.#engine.readStep(this.turn, name);
    let deadline: number | null;
    if (row === undefined) {
      this.#boundary(name);
      this.#live = true;
      deadline =
        options.timeout === undefined
          ? null
          : Date.now() + parseTaskDuration(options.timeout, "timeout");
      this.#engine.insertStep(this.turn, name, "event", deadline);
    } else {
      if (row.kind !== "event") {
        throw new StateMachineReplayDivergedError(
          name,
          `journaled as a ${row.kind} step but replayed as an event wait`
        );
      }
      if (row.state === "completed") {
        return eventOf<Payload>(deserializeTaskValue(row.result));
      }
      if (row.state === "failed") throw restoreStepError(row);
      this.#boundary(name);
      this.#live = true;
      deadline = row.next_at;
    }
    // One synchronous block: the oldest visible matching item is consumed
    // and memoized as the step's result, so a replay never re-reads it.
    const now = Date.now();
    const matched = this.#engine.peekMailbox(
      { kind: "event", type: options.type, limit: 1 },
      now
    )[0];
    if (matched !== undefined) {
      const journaled: JournaledEvent = {
        type: options.type,
        payload: deserializeTaskValue(matched.payload) as StateMachineJson,
        receivedAt: now
      };
      this.#engine.consumeMailbox([matched.key]);
      this.#engine.completeStep(this.turn, name, journaled);
      this.#engine.emit("task:step:completed", { step: name, attempt: 1 });
      return eventOf<Payload>(journaled);
    }
    if (deadline !== null && deadline <= now) {
      const error = new StateMachineEventTimeoutError(name, options.type);
      this.#engine.failStep(this.turn, name, toErrorSummary(error));
      throw error;
    }
    throw new TaskSuspension(deadline, "event");
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Validate a step boundary: name rules, duplicates, cancellation. */
  #enterStep(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Step names must be non-empty strings");
    }
    if (name.length > MAX_STEP_NAME_LENGTH) {
      throw new Error(
        `Step name exceeds ${MAX_STEP_NAME_LENGTH} characters: "${name.slice(0, 40)}…"`
      );
    }
    if (name.startsWith("__cf")) {
      throw new Error(`Step names must not use the reserved "__cf" prefix`);
    }
    if (this.#usedNames.has(name)) {
      throw new StateMachineDuplicateStepError(name);
    }
    this.#usedNames.add(name);

    const cancellation = this.#engine.cancellationRequested();
    if (cancellation) throw new TaskCancellation(cancellation.reason);
  }

  /** First persist wins: the recorded wake time is authoritative. */
  async #sleepAt(name: string, wakeTime: () => number): Promise<void> {
    this.#enterStep(name);

    const row = this.#engine.readStep(this.turn, name);
    if (row === undefined) {
      this.#boundary(name);
      this.#live = true;
      const wakeAt = wakeTime();
      if (wakeAt <= Date.now()) {
        this.#engine.insertCompletedSleep(this.turn, name);
        return;
      }
      this.#engine.insertStep(this.turn, name, "sleep", wakeAt);
      throw new TaskSuspension(wakeAt, "sleep");
    }

    if (row.kind !== "sleep") {
      throw new StateMachineReplayDivergedError(
        name,
        `journaled as a ${row.kind} step but replayed as a sleep step`
      );
    }
    if (row.state === "completed") return;

    // A sleep still ahead is where a compensation replay stops; a wake
    // before the deadline parks again on the deadline first recorded.
    this.#boundary(name);
    this.#live = true;
    const wakeAt = row.next_at ?? 0;
    if (Date.now() < wakeAt) throw new TaskSuspension(wakeAt, "sleep");
    this.#engine.completeStep(this.turn, name, undefined);
  }

  async #executeAttempt<T extends StateMachineValue>(
    name: string,
    attempt: number,
    policy: ResolvedStepPolicy,
    callback: (attempt: StateMachineStepAttempt) => T | Promise<T>
  ): Promise<T> {
    this.#engine.refreshClaim();
    this.#engine.emit("task:step:started", { step: name, attempt });

    const timeout = new AbortController();
    const onRunAbort = () => timeout.abort(this.#engine.attemptSignal.reason);
    this.#engine.attemptSignal.addEventListener("abort", onRunAbort, {
      once: true
    });
    const timer = setTimeout(() => {
      timeout.abort(
        new Error(
          `Step "${name}" attempt ${attempt} timed out after ${policy.timeoutMs}ms`
        )
      );
    }, policy.timeoutMs);

    try {
      const result = await this.#raceTimeout<T>(
        Promise.resolve(
          callback({
            attempt,
            idempotencyKey: this.#engine.stepIdempotencyKey(this.turn, name),
            signal: timeout.signal
          })
        ),
        timeout.signal
      );
      this.#engine.completeStep(this.turn, name, result);
      this.#engine.emit("task:step:completed", { step: name, attempt });
      return result;
    } catch (error) {
      if (error instanceof AttemptSupersededError) throw error;
      const cancellation = this.#engine.cancellationRequested();
      if (cancellation) throw new TaskCancellation(cancellation.reason);
      // The attempt itself was ended from outside (its deadline passed and
      // the run is already settled): not a step outcome, so neither retry
      // nor fail the step — unwind with the reason.
      if (this.#engine.attemptSignal.aborted) {
        throw this.#engine.attemptSignal.reason;
      }
      // A condemned isolate cannot recover in-process. Leave the journal row
      // running and let the whole Task reach the alarm boundary, where a code
      // update defers to fresh code and a memory reset enters the breaker.
      // Other platform transients (notably "Network connection lost") retain
      // the ordinary short step retry budget before the run defers.
      if (
        isDurableObjectCodeUpdateReset(error) ||
        isDurableObjectMemoryLimitReset(error)
      ) {
        throw error;
      }
      // Transient platform errors use the configured durable retry budget.
      // Once that budget is spent they still are not application failures:
      // keep the step claimed and defer the whole run to a later invocation.
      if (isPlatformFailure(error) && attempt >= policy.retryLimit) throw error;
      if (
        isNonRetryableError(error) ||
        error instanceof StateMachineSerializationError ||
        attempt >= policy.retryLimit
      ) {
        this.#engine.failStep(this.turn, name, toErrorSummary(error));
        throw error;
      }
      const wakeAt = Date.now() + computeRetryDelayMs(policy, attempt);
      this.#engine.waitStep(this.turn, name, wakeAt);
      throw new TaskSuspension(wakeAt, "retry");
    } finally {
      clearTimeout(timer);
      this.#engine.attemptSignal.removeEventListener("abort", onRunAbort);
    }
  }

  /**
   * Settle with the callback or its timeout, whichever finishes first. A
   * callback that ignores its abort signal cannot wedge the attempt; its
   * late settlement is discarded and generation fencing rejects late writes.
   */
  #raceTimeout<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }
}

/** Rebuild a persisted terminal step error for rethrow. */
/** The JSON form an event wait journals; `timestamp` rehydrates as a Date. */
type JournaledEvent = {
  type: string;
  payload: StateMachineJson;
  receivedAt: number;
};

/** The Workflows-shaped event a completed wait returns. */
function eventOf<Payload extends StateMachineJson>(
  journaled: unknown
): StateMachineStepEvent<Payload> {
  const stored = journaled as JournaledEvent;
  return {
    type: stored.type,
    payload: stored.payload as Payload,
    timestamp: new Date(stored.receivedAt)
  };
}

/** Project one mailbox row as the item a handler receives. */
function mailboxItem(row: TaskMailboxRow): StateMachineMailboxItem<unknown> {
  return {
    key: row.key,
    seq: row.seq,
    kind: row.kind,
    ...(row.type !== null ? { type: row.type } : {}),
    payload: deserializeTaskValue(row.payload),
    createdAt: row.created_at
  };
}

/** One child's settlement note as the join result it stands for. */
function childResult<Output extends StateMachineValue>(
  runId: string,
  row: TaskMailboxRow | undefined
): StateMachineChildResult<Output> {
  const note = (
    row === undefined ? {} : (deserializeTaskValue(row.payload) ?? {})
  ) as {
    state?: string;
    result?: Output;
    error?: { name: string; message: string };
    reason?: string;
  };
  if (note.state === "completed") {
    return { ok: true, runId, output: note.result as Output };
  }
  return {
    ok: false,
    runId,
    error: note.error ?? {
      name: note.state === "cancelled" ? "TaskCancelled" : "TaskUnsettled",
      message: note.reason ?? `child ${runId} did not complete`
    }
  };
}

/** The answer one settled ask row carries; undefined when it lapsed. */
function answerOf<Answer>(row: TaskAskRow | undefined): Answer | undefined {
  if (row === undefined || row.state !== "answered") return undefined;
  return deserializeTaskValue(row.answer) as Answer;
}

function restoreStepError(row: TaskJournalRow): Error {
  const error = new Error(row.error_message ?? "Step failed");
  error.name = row.error_name ?? "Error";
  return error;
}

/** Safe name/message projection of an arbitrary thrown value. */
export function toErrorSummary(error: unknown): {
  name: string;
  message: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
