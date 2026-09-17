import type { LifecycleRouteAddress } from "../lifecycle/capability";
import type { StreamJson, StreamState, StreamWriter } from "../streams/types";
import type { TaskDurationString } from "./duration";

/**
 * JSON-serializable data accepted as Task input, step results, metadata,
 * and final results.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskJson =
  | string
  | number
  | boolean
  | null
  | TaskJson[]
  | { [key: string]: TaskJson };

/**
 * A value a Task handler or step callback may produce. `undefined` and
 * `void` persist as SQL `NULL` and restore as `undefined`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskValue = TaskJson | undefined | void;

// ── The machine form: checkpoints, terminals, and timeouts ────────────────

/**
 * The checkpoint's only structural requirement: a `phase` discriminant the
 * `phases` map is keyed by. Deliberately NOT `& TaskJson` — that constraint
 * rejects the `interface` spelling most users reach for first, and
 * serializability is enforced at the first commit instead (plus the opt-in
 * {@link AssertJson} next to the state declaration).
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskPhased = { phase: string };

declare const taskTerminal: unique symbol;

/**
 * Opaque terminal marker: only `ctx.complete()`, `ctx.fail()`, and
 * `ctx.aborted()` produce one. The brand is not exported, so a hand-rolled
 * `{ done: true }` fails to compile and a forgotten `return` fails as
 * `Promise<void>`.
 *
 * `Result` is constrained to {@link TaskValue} on purpose: without it
 * {@link TaskOutput} infers an unconstrained parameter, resolves to
 * `unknown`, and every `TaskRunSnapshot<TaskOutput<D>>` use site fails.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskTerminal<Result extends TaskValue> = {
  readonly [taskTerminal]: Result;
};

declare const taskTimedOut: unique symbol;

/**
 * The value every `within` wait returns when its deadline passes. A unit
 * type, so `value === ctx.timedOut` narrows; an object-typed sentinel would
 * narrow nothing and could leak into a committed checkpoint.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskTimedOut = typeof taskTimedOut;

type TaskJsonish<T> = T extends string | number | boolean | null | undefined
  ? true
  : T extends readonly (infer Element)[]
    ? TaskJsonish<Element>
    : // oxlint-disable-next-line @typescript-eslint/no-unsafe-function-type -- structural "is this a function" test
      T extends Function
      ? false
      : T extends object
        ? { [K in keyof T]-?: TaskJsonish<T[K]> }[keyof T] extends true
          ? true
          : false
        : false;

/**
 * Opt-in structural assertion that a checkpoint type is JSON-serializable.
 * Walks properties structurally, so an `interface`-spelled state is accepted
 * where an index-signature constraint would reject it. A non-serializable
 * member resolves to `{ CHECKPOINT_NOT_SERIALISABLE: T }`, which fails to
 * satisfy the declaration it annotates.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type AssertJson<T> =
  TaskJsonish<T> extends true ? T : { CHECKPOINT_NOT_SERIALISABLE: T };

// ── Asks: correlated durable questions ───────────────────────────────────

declare const askPayload: unique symbol;
declare const askAnswer: unique symbol;

/**
 * A typed ask kind, created with `defineAsk`. The answer type travels with
 * the KIND, not with the run, so `tasks.answer(askId, kind, value)` type
 * checks from a file that has never heard of the definition.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface AskKind<Payload, Answer> {
  readonly name: string;
  readonly [askPayload]?: Payload;
  readonly [askAnswer]?: Answer;
}

/**
 * One outstanding ask. `{ id }` at runtime, so it serializes into the
 * checkpoint unchanged; the answer type rides the phantom brand.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface Pending<Answer> {
  readonly id: string;
  readonly [askAnswer]?: Answer;
}

/** Lifecycle of one durable ask. */
export type TaskAskState = "open" | "answered" | "expired" | "withdrawn";

/**
 * Options for one `ctx.ask()` batch. Expiry is bounded per batch, not per
 * ask, which is what keeps it one wake rather than one per question.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskAskOptions {
  /** Duration or epoch ms after which the batch's asks flip to `expired`. */
  expiresIn?: number | TaskDurationString;

  /** JSON carried alongside for the UI. */
  metadata?: Record<string, TaskJson>;
}

/**
 * Read-only projection of one durable ask, as `tasks.asks()` and
 * `tasks.view()` report it. An expired or withdrawn ask keeps its row until
 * the run's delete cascade removes it, so a UI can still show what was
 * asked and why it lapsed.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskAskRecord {
  readonly askId: string;
  readonly runId: string;
  readonly name: string;
  readonly state: TaskAskState;
  readonly question?: TaskJson;
  readonly answer?: TaskJson;
  readonly metadata?: Record<string, TaskJson>;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly answeredAt?: number;
}

// ── Steps ────────────────────────────────────────────────────────────────

/**
 * Per-attempt context passed to a `step.do()` callback.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStepAttempt {
  /** One-based attempt number for this named step. */
  readonly attempt: number;

  /**
   * Stable external deduplication key for this step: identical across
   * attempts and replays of the same run.
   */
  readonly idempotencyKey: string;

  /** Aborted on cancellation or when this attempt's timeout elapses. */
  readonly signal: AbortSignal;
}

/**
 * Retry policy shape, shared by a `step.do()` config and a run's `interruptions`
 * so one number never means two things: `limit` counts total attempts
 * including the first in both places, and `delay`/`backoff` space the
 * retries out durably.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskRetryConfig {
  /** Total attempts, including the first. */
  limit?: number;
  /** Delay before the first retry. */
  delay?: number | TaskDurationString;
  /** Delay growth across retries. Defaults to exponential. */
  backoff?: "constant" | "linear" | "exponential";
}

/**
 * Retry and timeout policy for one `step.do()` call.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStepConfig {
  retries?: TaskRetryConfig;

  /** Timeout of one callback attempt. */
  timeout?: number | TaskDurationString;
}

/**
 * One event `step.waitForEvent()` consumed. Mirrors Workflows'
 * `WorkflowStepEvent<T>`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStepEvent<Payload> {
  readonly payload: Readonly<Payload>;
  readonly timestamp: Date;
  readonly type: string;
}

/**
 * The step API a Task handler receives. Named steps are the run's durable
 * journal: `do` memoizes completed results, sleeps persist their first
 * deadline, and both suspend the execution attempt rather than holding the
 * invocation open.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStep {
  /**
   * This execution's claim number for the run: 1 on the first attempt, and
   * one higher on every later claim — a replay after an unclean
   * interruption, and equally a wake from a sleep or a step retry park.
   * It is not the counter a run's `interruptions` bounds; that one counts only
   * interruptions.
   */
  readonly attempt: number;

  /**
   * The step an unclean interruption left mid-execution, or `null` on a
   * clean attempt — the durable evidence a replayed handler branches on
   * before re-entering irreversible work. Populated when a lost attempt's
   * claim is taken over, including across the run's own interruption
   * backoff park, which replays with the evidence intact. A first attempt,
   * a sleep wake, and a step retry park all see `null`.
   */
  readonly interrupted: {
    readonly name: string;
    readonly attempt: number;
  } | null;

  /**
   * Aborted for the whole attempt — on `cancel()`, and when the run's
   * `deadline` passes — so work awaited outside `step.do()` (a long model
   * turn, a drain loop) can unwind. Inside a step the per-attempt `signal`
   * already covers it.
   */
  readonly signal: AbortSignal;

  /** Run a named step once, replaying its journaled result thereafter. */
  do<T extends TaskValue>(
    name: string,
    callback: (attempt: TaskStepAttempt) => T | Promise<T>
  ): Promise<T>;
  do<T extends TaskValue>(
    name: string,
    config: TaskStepConfig,
    callback: (attempt: TaskStepAttempt) => T | Promise<T>
  ): Promise<T>;

  /**
   * Sleep durably. The first recorded deadline is authoritative; replays
   * before it suspend again, replays after it continue.
   */
  sleep(name: string, duration: number | TaskDurationString): Promise<void>;

  /** Sleep durably until a wall-clock time. */
  sleepUntil(name: string, when: number | Date): Promise<void>;

  /**
   * Update observable progress. Replays stay silent until execution reaches
   * new ground, so old progress is not re-published as new.
   */
  status(message: string): Promise<void>;

  /**
   * The stable external deduplication key `step.do(name, ...)` would get.
   * A function definition's key omits the turn segment, so it is identical
   * for the life of the run; inside a machine transition the key is scoped
   * to the committed checkpoint's turn. `{ scope: "run" }` asks for the
   * turn-free form from either.
   */
  idempotencyKey(name: string, options?: { scope?: "turn" | "run" }): string;

  /**
   * Park until an event of `type` arrives, journaled under `name`. An event
   * sent before the run reaches this call is buffered in the mailbox and
   * consumed here — a deliberate superset of Workflows, which makes no such
   * promise. Throws `TaskEventTimeoutError` when `timeout` elapses, which
   * is Workflows' behaviour; the machine layer's `within` waits return
   * `ctx.timedOut` instead.
   */
  waitForEvent<Payload extends TaskJson>(
    name: string,
    options: { type: string; timeout?: number | TaskDurationString }
  ): Promise<TaskStepEvent<Payload>>;
}

// ── Mailbox, children, streams ───────────────────────────────────────────

/**
 * Why a run carries an abort mark. The mark is the write barrier every
 * checkpoint-advancing write is fenced on, and the engine never invents an
 * outcome from it: `onCancel` owns that.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskAbortMark =
  | "cancel"
  | "deadline"
  | "turn-deadline"
  | "parent"
  | "seal";

/**
 * One item in a run's durable mailbox. `kind` is a free string — the
 * `Mailbox` generic types the payload, not the kind — with `"child"` and
 * `"event"` written by the engine itself.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskMailboxItem<Payload = TaskJson> {
  /** The `requestId` when one was supplied, else an engine-assigned key. */
  readonly key: string;
  /** FIFO order within the run, across kinds. */
  readonly seq: number;
  readonly kind: string;
  readonly type?: string;
  readonly payload: Payload;
  readonly createdAt: number;
}

/**
 * Which mailbox items a read or a park matches. An unmatched item stays
 * queued, which is what makes a selective `receive({ kind })` express
 * "postpone" with no re-queue write.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskMailboxFilter {
  kind?: string | readonly string[];
  type?: string | readonly string[];
  key?: string;
  limit?: number;
}

/**
 * A child run this run owns. `background` children are excluded from the
 * abort cascade and from the default join — structurally, because the
 * exclusion is a column on the child's own row.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskChildRef = {
  readonly runId: string;
  readonly definition: string;
  readonly background: boolean;
  /** Set when the child lives on another Lifecycle (a facet). */
  readonly ownerKey?: string;
};

/**
 * One settled child, as `ctx.join()` reports it. A child failing for a
 * business reason is data, not a throw.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskChildResult<Output extends TaskValue> =
  | { readonly ok: true; readonly runId: string; readonly output: Output }
  | { readonly ok: false; readonly runId: string; readonly error: TaskError };

/**
 * Options for one `ctx.stream()` writer.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskStreamOptions {
  /** Stable UI identity across epochs. Defaults to `${runId}:${name}`. */
  tag?: string;
  metadata?: Record<string, StreamJson>;
  /** Opt out of engine ownership: no rotation, no cutover, no progress credit. */
  streamId?: string;
}

// ── The per-handler runtime ──────────────────────────────────────────────

/**
 * The runtime one phase handler receives. It EXTENDS {@link TaskStep}: the
 * object a machine's handler gets as `ctx` is the same object a function
 * definition gets as `step`, so `step.do` and `ctx.do` are one method on one
 * journal, one claim path, and one abort protocol.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskContext<
  // Phantom, and deliberately so: it keeps this declaration symmetric with
  // `TaskMachine`'s, so one handler signature reads the same on both sides,
  // and it is the slot a checkpoint-typed member would occupy.
  // oxlint-disable-next-line no-unused-vars -- phantom parameter
  State extends TaskPhased,
  Mailbox = never,
  Result extends TaskValue = void,
  Seed = void
> extends TaskStep {
  // ── run facts, as of this attempt's claim ──────────────────────────────

  /** The run's id, which is also its address. */
  readonly id: string;

  /** The full definition name, `base` or `base@vN`. */
  readonly definition: string;

  /** The definition's version, or 0 for an unversioned name. */
  readonly version: number;

  /** The run seed: written once at accept, never re-committed. */
  readonly input: Seed;

  /** The committed checkpoint's generation, 0-based. */
  readonly turn: number;

  /** Durable work credited to this run so far. */
  readonly progress: number;

  /** Owned, non-terminal children. */
  readonly children: readonly TaskChildRef[];

  /** True when this run was spawned as a detached background child. */
  readonly background: boolean;

  readonly metadata?: Record<string, TaskJson>;

  readonly createdAt: number;

  // ── mailbox ────────────────────────────────────────────────────────────

  /** Park until one matching visible item arrives; consume and return it. */
  receive(
    filter?: TaskMailboxFilter & { within?: number | TaskDurationString }
  ): Promise<TaskMailboxItem<Mailbox> | TaskTimedOut>;

  /** Park until at least one matches, then drain every match in one block. */
  receiveAll(
    filter?: TaskMailboxFilter & { within?: number | TaskDurationString }
  ): Promise<TaskMailboxItem<Mailbox>[] | TaskTimedOut>;

  /** Non-consuming, non-parking look at the next matching item. */
  peek(filter?: TaskMailboxFilter): TaskMailboxItem<Mailbox> | undefined;

  /** Non-consuming, non-parking look at every matching visible item. */
  peekAll(filter?: TaskMailboxFilter): TaskMailboxItem<Mailbox>[];

  /** Remove a still-queued item by key. False when it was already consumed. */
  withdraw(key: string): boolean;

  // ── asks ───────────────────────────────────────────────────────────────

  /**
   * Raise durable correlated questions. Synchronous and one row write per
   * ask, so a handler can raise them and return the checkpoint that admits
   * their answers in one expression.
   */
  ask<Payload, Answer>(
    kind: AskKind<Payload, Answer>,
    payloads: readonly Payload[],
    options?: TaskAskOptions
  ): Pending<Answer>[];

  /** Park until answers land (`all` by default, or the first under `any`). */
  answers<Answer>(
    pending: readonly Pending<Answer>[],
    options?: {
      within?: number | TaskDurationString;
      mode?: "all" | "any";
    }
  ): Promise<Answer[] | TaskTimedOut>;

  /** Read answers already durable, without parking. Mirrors peek/peekAll. */
  peekAnswers<Answer>(
    pending: readonly Pending<Answer>[]
  ): (Answer | undefined)[];

  // ── run-scoped values ──────────────────────────────────────────────────

  /**
   * First-writer-wins value that survives checkpoint changes. Nonces live
   * here — derive the NAME from a checkpoint ordinal for fresh-but-stable.
   */
  memo<T extends TaskJson>(name: string, candidate: T): T;
  /** Read form; usable from `onCancel`, where no new work may be journaled. */
  memo<T extends TaskJson>(name: string): T | undefined;

  // ── children ───────────────────────────────────────────────────────────

  /** Start an owned child. Its settlement arrives as a mailbox item. */
  spawn(
    definition: string,
    input?: TaskJson,
    options?: TaskSpawnOptions
  ): Promise<TaskReceipt>;

  /** Sugar over consuming `kind:"child"` items until every child settles. */
  join<Output extends TaskValue>(
    children: readonly (TaskChildRef | TaskReceipt | string)[],
    options?: { within?: number | TaskDurationString }
  ): Promise<TaskChildResult<Output>[] | TaskTimedOut>;

  // ── streams ────────────────────────────────────────────────────────────

  /** An engine-owned output stream. Settles with the checkpoint write. */
  stream(name?: string, options?: TaskStreamOptions): Promise<StreamWriter>;

  // ── liveness and progress ──────────────────────────────────────────────

  /** Push the transition deadline forward. Throttled to one write per 15 s. */
  heartbeat(): void;

  /** Credit work the stream log cannot see (a forwarded child's output). */
  creditProgress(units?: number): void;

  // ── terminals ──────────────────────────────────────────────────────────

  complete(result: Result): TaskTerminal<Result>;
  fail(error: unknown): TaskTerminal<Result>;
  aborted(reason?: string): TaskTerminal<Result>;

  /** The unit-typed timeout sentinel returned by every `within` wait. */
  readonly timedOut: TaskTimedOut;

  /** The mark that caused this cancel transition; null inside a phase. */
  readonly cancelling: TaskAbortMark | null;
}

// ── Definitions ──────────────────────────────────────────────────────────

/**
 * One durable state machine: the second definition form, and the engine
 * both forms compile onto. `phases` is a mapped type over the state union's
 * `phase` discriminant, which is what gives per-phase narrowing,
 * exhaustiveness, and unknown-key rejection with no helper function.
 *
 * Declare one with `satisfies TaskMachine<State, Mailbox, Result, Seed>`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskMachine<
  State extends TaskPhased,
  Mailbox = never,
  Result extends TaskValue = void,
  Seed = void
> {
  /**
   * The checkpoint a fresh run starts from: a value, or a function of the
   * run seed — the function form is what carries a typed seed. It runs once,
   * at accept, and must be re-runnable: anything non-deterministic belongs
   * behind `ctx.memo`.
   */
  readonly initial: State | ((seed: Seed) => State);

  /** One handler per phase, `(state, ctx) => next`. Returning is the commit. */
  readonly phases: {
    [P in State["phase"]]: (
      state: Extract<State, { phase: P }>,
      ctx: TaskContext<State, Mailbox, Result, Seed>
    ) => Promise<State | TaskTerminal<Result>>;
  };

  /**
   * Cancel transition; owns the outcome. Runs in a fresh, fenced,
   * non-reentrant invocation and may not park. Returning a State lands
   * there and clears the mark, which is how a machine declines a cancel.
   */
  readonly onCancel?: (
    state: State,
    ctx: TaskContext<State, Mailbox, Result, Seed>
  ) => Promise<State | TaskTerminal<Result>>;

  /** Carry an older version's checkpoint forward. Absent means `orphaned`. */
  readonly migrate?: (
    checkpoint: TaskJson,
    fromVersion: number,
    input: TaskJson
  ) => { state: State; input?: Seed };
}

/**
 * One named, versioned durable program: either today's Workflows-shaped
 * function or a durable state machine. Both run on one engine.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskDefinition =
  // The machine arm is `any`-parameterised deliberately: every narrower
  // constraint (`never`, `TaskPhased`, `TaskJson & TaskPhased`) rejects
  // every concrete machine, because a handler's state parameter is
  // contravariant and its return is the state union.
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  | TaskMachine<any, any, any, any>
  // The input parameter is `never` so any concretely-typed definition
  // satisfies the constraint under contravariance; each definition's real
  // input type is recovered with `TaskInput`.
  | ((input: never, step: TaskStep) => TaskValue | Promise<TaskValue>);

/**
 * Constraint for a Tasks definitions map. The map is the registry, rebuilt
 * on every Durable Object wake, so in-flight runs always resolve their
 * persisted definition names.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskDefinitions = Record<string, TaskDefinition>;

/**
 * Back-compat alias: the function-only constraint Tasks shipped with.
 * Named handlers invoked from the beginning on every execution attempt,
 * with completed steps returning journaled results instead of running
 * again. An unclean interruption — process loss mid-attempt — replays the
 * handler the same way; durable progress lives in the step journal and in
 * whatever durable state the handler wrote (a stream's cursor, an
 * idempotent external write), so handlers resume from evidence instead of
 * receiving a recovery callback.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskHandlers = Record<
  string,
  (input: never, step: TaskStep) => TaskValue | Promise<TaskValue>
>;

/**
 * Default definitions surface for a Tasks constructed without a typed map:
 * any name compiles with an untyped input. At runtime a name must be
 * declared in the constructor map or supplied by a composition-root
 * resolver; a bare Tasks rejects it otherwise.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskCallbacks = Record<
  string,
  (input: unknown, step: TaskStep) => TaskValue | Promise<TaskValue>
>;

// ── Extractors ───────────────────────────────────────────────────────────

/**
 * The input type a registered Task definition accepts: a function
 * definition's first parameter, or a machine's `initial(seed)` parameter.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskInput<Definition> = Definition extends (
  input: infer Input,
  ...rest: never[]
) => unknown
  ? Input
  : Definition extends { initial: (seed: infer Seed) => unknown }
    ? Seed
    : Definition extends { phases: unknown }
      ? void
      : never;

/**
 * The checkpoint union a machine definition commits, inferred from the
 * RETURN position of its phases: inferring a discriminated union from a
 * parameter position is contravariant, so the candidates would intersect
 * and collapse to `never`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskState<Definition> = Definition extends {
  phases: Record<string, (state: never, ctx: never) => Promise<infer Returned>>;
}
  ? Exclude<Returned, TaskTerminal<TaskValue>>
  : unknown;

/**
 * The settled output type a registered Task definition produces. A machine
 * reads its terminals from `onCancel` as well as from `phases`, because a
 * machine's only terminal is often the one `onCancel` returns.
 *
 * Three details are load-bearing. `TaskTerminal<Result>` constrains
 * `Result` to `TaskValue`, without which `infer Output` is unconstrained
 * and every `TaskRunSnapshot<TaskOutput<D>>` use site fails. The
 * `[Extract<…>] extends [never] ? void` arm is tuple-wrapped because a bare
 * `never extends TaskTerminal<infer X>` is TRUE and infers `X` as
 * `unknown`, so the naive spelling never reaches its `void` arm. And the
 * inner `Output extends TaskValue` is what the function branch has always
 * done, for the same reason.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskOutput<Definition> = Definition extends {
  phases: Record<string, (state: never, ctx: never) => Promise<infer Returned>>;
  onCancel?: (state: never, ctx: never) => Promise<infer Cancelled>;
}
  ? [Extract<Returned | Cancelled, TaskTerminal<TaskValue>>] extends [never]
    ? void
    : Extract<
          Returned | Cancelled,
          TaskTerminal<TaskValue>
        > extends TaskTerminal<infer Output>
      ? Output extends TaskValue
        ? Output
        : never
      : never
  : Definition extends (...args: never[]) => infer Output
    ? Awaited<Output> extends TaskValue
      ? Awaited<Output>
      : never
    : never;

/**
 * The mailbox payload type a machine definition receives, read from its
 * handlers' `ctx` parameter.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskMailbox<Definition> = Definition extends {
  phases: Record<
    string,
    (
      state: never,
      ctx: TaskContext<never, infer Mailbox, never, never>
    ) => unknown
  >;
}
  ? Mailbox
  : never;

// ── Runs ─────────────────────────────────────────────────────────────────

/**
 * States a Task run moves through.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskRunState =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * A terminal quality that is not a state: `faulted` rides a failed run the
 * engine stopped for making no progress, `orphaned` one whose definition no
 * longer resolves. Both override `retain: false` — the checkpoint is
 * preserved so `reopen()` has something to reopen.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskRunOutcome = "faulted" | "orphaned";

/**
 * Why a waiting run is waiting: parked on a `step.sleep()` deadline, on a
 * step's retry delay, on the run's own backoff between an unclean
 * interruption and the replay of that attempt, or — with nothing resident
 * and, absent a `within`, no wake at all — on the mailbox, an event, an
 * ask, a child, or a `pause()`.
 */
export type TaskWaitReason =
  | "sleep"
  | "retry"
  | "interrupted"
  | "mailbox"
  | "event"
  | "ask"
  | "child"
  | "paused";

/** Safe projection of an error retained with a failed run. */
export interface TaskError {
  name: string;
  message: string;
}

/**
 * Who drives a run's first attempt. `warm` and `queued` return on durable
 * acceptance; `attached` additionally drives that first attempt in the
 * caller's invocation and awaits it to its next durable boundary.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskStartMode = "warm" | "queued" | "attached";

/**
 * Options accepted when starting one Task run.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskRunOptions {
  /** Stable key deduplicating repeated acceptance attempts onto one run. */
  idempotencyKey?: string;

  /** Caller-selected run ID. Generated when omitted. */
  runId?: string;

  /** JSON metadata retained with the run. */
  metadata?: Record<string, TaskJson>;

  /** Keep terminal state for inspection. Defaults to `true`. */
  retain?: boolean;

  /**
   * Retry policy for INTERRUPTED attempts: an attempt whose isolate died
   * mid-execution and is being reclaimed. `limit` counts total attempts
   * including the first, exactly as a step's does, and counts only
   * *consecutive* interruptions — reaching a durable boundary under the
   * attempt's own power (a sleep, a step retry park) clears the count, so a
   * long-lived run is never killed for having survived enough deploys.
   * Wakes from those parks are not attempts and cost nothing. Omitted: an
   * interruption replays immediately, without bound. When present, fields
   * left unset fall back to the capability's step `retries` defaults, and
   * the interruption that reaches `limit` fails the run with
   * `TaskInterruptionsExhaustedError`.
   */
  interruptions?: TaskRetryConfig;

  /**
   * Wall-clock deadline (epoch milliseconds or a `Date`). A live attempt's
   * `step.signal` aborts and the run fails with `TaskDeadlineExceededError`;
   * a parked run fails at its next wake, which the deadline brings forward.
   */
  deadline?: number | Date;

  /** Per-transition watchdog for this run. Defaults to the capability's. */
  turnTimeout?: number | TaskDurationString;

  /** Who drives the first attempt. Defaults to `warm`. */
  start?: TaskStartMode;

  /** Detached from an owner's abort cascade and from its default join. */
  background?: boolean;

  /** Owned by another run. Set by `ctx.spawn`; rejected on this surface. */
  parent?: never;
}

/**
 * Options for one `ctx.spawn()` child.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskSpawnOptions extends TaskRunOptions {
  /** Deliver the child's terminal outcome as a mailbox item. Default true. */
  notify?: boolean;

  /** Route the child onto another Lifecycle (a facet). */
  owner?: LifecycleRouteAddress;
}

/**
 * Durable acceptance receipt returned by `Task.run()`. `accepted: false`
 * means an existing run matched `runId` or `idempotencyKey`; it is not an
 * error.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskReceipt {
  runId: string;
  definition: string;
  accepted: boolean;
  state: TaskRunState;
  createdAt: number;
}

/**
 * Read-only snapshot of one Task run, discriminated by state. `state` is
 * the RUN's state, not the checkpoint's: the checkpoint is read from
 * `view()`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskRunSnapshot<Output extends TaskValue> =
  | {
      runId: string;
      definition: string;
      state: "pending";
      createdAt: number;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "running";
      attempt: number;
      startedAt: number;
      createdAt: number;
      statusMessage?: string;
      abortRequested?: true;
      abortReason?: string;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "waiting";
      reason: TaskWaitReason;
      /** Absent for an event-driven park: mailbox, event, ask, child, paused. */
      wakeAt?: number;
      createdAt: number;
      statusMessage?: string;
      abortRequested?: true;
      abortReason?: string;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "completed";
      result: Output;
      createdAt: number;
      settledAt: number;
      outcome?: TaskRunOutcome;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "failed";
      error: TaskError;
      createdAt: number;
      settledAt: number;
      outcome?: TaskRunOutcome;
      metadata?: Record<string, TaskJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "cancelled";
      reason?: string;
      createdAt: number;
      settledAt: number;
      outcome?: TaskRunOutcome;
      metadata?: Record<string, TaskJson>;
    };

/**
 * The deep read of one run: its snapshot plus the checkpoint and everything
 * the run owns. `get()` is the cheap read; this is the one a UI renders.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskRunView<Output extends TaskValue, State = unknown> {
  readonly snapshot: TaskRunSnapshot<Output>;
  readonly checkpoint: State;
  readonly turn: number;
  readonly progress: number;
  readonly transitions: number;
  readonly mailbox: readonly TaskMailboxItem[];
  readonly asks: readonly TaskAskRecord[];
  readonly children: readonly TaskChildRef[];
  readonly streams?: readonly {
    readonly name: string;
    readonly tag: string;
    readonly streamId: string;
    readonly epoch: number;
    readonly cursor: number;
    readonly state: StreamState;
  }[];
}

/** What moved when a `watch()` subscriber is notified. */
export type TaskChangeType =
  | "accepted"
  | "claimed"
  | "checkpoint"
  | "status"
  | "progress"
  | "mailbox"
  | "ask"
  | "answer"
  | "child"
  | "waiting"
  | "settled";

/**
 * One change delivered to a `watch()` subscriber. It carries the whole
 * view: a resumable cursor would need a durable change log, which is one
 * row write on the hottest paths.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskChange<State = unknown> {
  readonly type: TaskChangeType;
  readonly runId: string;
  readonly view: TaskRunView<TaskValue, State>;
}

/**
 * How one `tasks.send()` interacts with the run's unconsumed items.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskSendOptions {
  /** Deduplication key. A repeat writes zero rows. Becomes the item's `key`. */
  requestId?: string;
  kind?: string;
  type?: string;
  /** How this send interacts with unconsumed items of the same kind+type. */
  policy?: "append" | "latest" | "drop" | "debounce";
  /** With `policy:"debounce"`: make the item visible this many ms from now. */
  debounceMs?: number;
}

/**
 * The receipt one `send()` returns. `accepted: false` is not an error — it
 * is the same convention `TaskReceipt` established for `run()`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskSendReceipt {
  readonly accepted: boolean;
  readonly key: string;
  readonly reason?: "duplicate" | "dropped" | "terminal" | "limit";
}

/**
 * The receipt one `answer()` returns.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskAnswerReceipt {
  readonly accepted: boolean;
  readonly reason?:
    | "duplicate"
    | "expired"
    | "withdrawn"
    | "unknown"
    | "terminal";
}

// ── Handles ──────────────────────────────────────────────────────────────

/**
 * Typed lens over one named Task definition, returned by `tasks.handle()`.
 * The handle holds no state of its own; it addresses runs of its definition
 * through the owning capability.
 *
 * The definition type is the first parameter, which is what makes the three
 * machine verbs conditional: on a function definition they are `never` and
 * therefore uncallable, rather than compiling against a run that has no
 * mailbox.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskHandle<
  Definition,
  Input,
  State,
  Output extends TaskValue
> {
  readonly name: string;

  /** Durably accept a run and return without waiting for terminal state. */
  run(input: Input, options?: TaskRunOptions): Promise<TaskReceipt>;

  /** Read one run of this definition. */
  get(runId: string): Promise<TaskRunSnapshot<Output> | null>;

  /** Read one run of this definition by its idempotency key. */
  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<TaskRunSnapshot<Output> | null>;

  /** Request cooperative cancellation. True when a live run was cancelled. */
  cancel(runId: string, reason?: string): Promise<boolean>;

  /** A typed handle on one run of this definition. */
  at(runId: string): TaskRunHandle<Definition>;

  /** Machine definitions only: `never`, and so uncallable, on a function. */
  send: Definition extends { phases: unknown }
    ? (
        runId: string,
        payload: TaskMailbox<Definition>,
        options?: TaskSendOptions
      ) => Promise<TaskSendReceipt>
    : never;

  /** Machine definitions only. */
  view: Definition extends { phases: unknown }
    ? (runId: string) => Promise<TaskRunView<Output, State> | null>
    : never;

  /** Machine definitions only. */
  watch: Definition extends { phases: unknown }
    ? (
        runId: string,
        listener: (change: TaskChange<State>) => void
      ) => () => void
    : never;
}

/**
 * Back-compat alias for the lens shape Tasks shipped with: an untyped
 * definition, so the three machine verbs read `never` on it — the honest
 * answer for a lens that does not know its definition's shape.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type Task<Input, Output extends TaskValue> = TaskHandle<
  unknown,
  Input,
  unknown,
  Output
>;

/**
 * One run, typed by its definition. Obtained from `tasks.at(name, runId)`.
 * It does not replace `run()`'s receipt: `TaskReceipt.accepted` is the
 * entire point of durable acceptance.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskRunHandle<Definition> {
  readonly runId: string;
  readonly definition: string;

  send(
    payload: TaskMailbox<Definition>,
    options?: TaskSendOptions
  ): Promise<TaskSendReceipt>;

  sendEvent(event: {
    type: string;
    payload: TaskJson;
    requestId?: string;
  }): Promise<TaskSendReceipt>;

  answer<Payload, Answer>(
    askId: string,
    kind: AskKind<Payload, Answer>,
    answer: Answer
  ): Promise<TaskAnswerReceipt>;

  withdraw(key: string): Promise<boolean>;

  get(): Promise<TaskRunSnapshot<TaskOutput<Definition>> | null>;

  view(): Promise<TaskRunView<
    TaskOutput<Definition>,
    TaskState<Definition>
  > | null>;

  watch(
    listener: (change: TaskChange<TaskState<Definition>>) => void
  ): () => void;

  cancel(reason?: string, options?: { wait?: boolean }): Promise<boolean>;

  terminate(reason?: string): Promise<boolean>;
}

/**
 * What `register()` hands back: the one way to start a run of a reserved
 * `__cf`-prefixed definition, which public `run()` refuses.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface TaskInternalHandle {
  readonly name: string;
  run(input?: unknown, options?: TaskRunOptions): Promise<TaskReceipt>;
}

// ── Rows ─────────────────────────────────────────────────────────────────

/** @internal Raw `cf_agents_task_runs` SQLite row. */
export type TaskRunRow = {
  run_id: string;
  definition: string;
  input: string | null;
  state: TaskRunState;
  result: string | null;
  error_name: string | null;
  error_message: string | null;
  status_message: string | null;
  metadata: string | null;
  idempotency_key: string | null;
  retain: number;
  attempt: number;
  deadline_at: number | null;
  interruptions: number;
  retry_policy: string | null;
  generation: string | null;
  next_at: number | null;
  wait_reason: TaskWaitReason | null;
  cancel_requested: number;
  cancel_reason: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  settled_at: number | null;
  checkpoint: string | null;
  checkpoint_turn: number;
  definition_base: string | null;
  definition_version: number;
  outcome: TaskRunOutcome | null;
  progress: number;
  stream_retired: number;
  stall: number;
  transitions: number;
  abort_mark: TaskAbortMark | null;
  abort_reason: string | null;
  turn_deadline_at: number | null;
  turn_timeout_ms: number | null;
  paused: number;
  parent_run_id: string | null;
  parent_owner_key: string | null;
  parent_notify: number;
  background: number;
  stream_epoch: number;
  stream_tag: string | null;
};

/** @internal Raw `cf_agents_task_journal` SQLite row. */
export type TaskJournalRow = {
  run_id: string;
  /** The run's `checkpoint_turn`; -1 holds run-scoped rows (memos). */
  turn: number;
  name: string;
  kind: "do" | "sleep" | "event" | "memo";
  state: "running" | "waiting" | "completed" | "failed";
  result: string | null;
  error_name: string | null;
  error_message: string | null;
  attempt: number;
  next_at: number | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
};

/** @internal Raw `cf_agents_task_mailbox` SQLite row. */
export type TaskMailboxRow = {
  run_id: string;
  key: string;
  seq: number;
  kind: string;
  type: string | null;
  payload: string | null;
  visible_after: number | null;
  created_at: number;
};

/** @internal Raw `cf_agents_task_asks` SQLite row. */
export type TaskAskRow = {
  ask_id: string;
  run_id: string;
  turn: number;
  name: string;
  question: string | null;
  answer: string | null;
  state: TaskAskState;
  expires_at: number | null;
  metadata: string | null;
  created_at: number;
  answered_at: number | null;
};

/** @internal Raw `cf_agents_task_routes` SQLite row. */
export type TaskRouteRow = {
  run_id: string;
  owner_path: string;
  owner_path_key: string;
  parent_run_id: string | null;
  parent_owner_key: string | null;
  created_at: number;
};
