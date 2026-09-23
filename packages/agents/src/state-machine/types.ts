/**
 * Any value a machine can persist.
 *
 * Arrays and objects are `readonly` so that a caller's own immutable types
 * satisfy this without copying or casting. A `readonly` array is not
 * assignable to a mutable one, so requiring mutability here would force
 * every caller holding `readonly` data through an unchecked cast. Nothing
 * in the engine mutates a checkpoint in place, so nothing needs the looser
 * form.
 */
export type MachineJson =
  | string
  | number
  | boolean
  | null
  | readonly MachineJson[]
  | { readonly [key: string]: MachineJson };

export type MachineValue = MachineJson | undefined | void;
export type MachinePhased = { phase: string } & Record<string, MachineJson>;

export interface MachineEvent {
  readonly type: string;
  readonly key?: string;
  readonly [key: string]: MachineJson | undefined;
}

export interface MachineCommitTransaction {
  afterCommit(callback: () => void): void;
}

export interface MachineCommitParticipant {
  /** @internal Runtime validation prevents application-created participants. */
  readonly __brand: "MachineCommitParticipant";
}

export interface MachineTransitionOptions {
  readonly commit?: readonly MachineCommitParticipant[];
}

export interface MachineWaitOptions {
  readonly type: string;
  readonly key?: string;
  readonly timeoutAt?: number | Date;
}

export type MachineWake =
  | { readonly kind: "ordinary" }
  | { readonly kind: "event"; readonly type: string; readonly key?: string }
  | { readonly kind: "timeout"; readonly type: string; readonly key?: string }
  | { readonly kind: "cancel"; readonly reason?: string };

export type MachineDecision<
  State extends MachinePhased,
  Result extends MachineValue
> =
  | {
      readonly kind: "transition";
      readonly state: State;
      readonly commit: readonly MachineCommitParticipant[];
    }
  | {
      readonly kind: "wait";
      readonly state: State;
      readonly wait: MachineWaitOptions;
      readonly commit: readonly MachineCommitParticipant[];
    }
  | {
      readonly kind: "complete";
      readonly result: Result;
      readonly commit: readonly MachineCommitParticipant[];
    }
  | {
      readonly kind: "fail";
      readonly error: { readonly name: string; readonly message: string };
      readonly commit: readonly MachineCommitParticipant[];
    };

export interface MachineQueuedEvent<Event extends MachineEvent = MachineEvent> {
  readonly eventId: string;
  readonly sequence: number;
  readonly event: Event;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface MachineEventFilter {
  readonly type: string;
  readonly key?: string;
}

export interface MachineEvents<Event extends MachineEvent> {
  take<const Filter extends MachineEventFilter>(
    filter: Filter
  ): MachineQueuedEvent<Extract<Event, { type: Filter["type"] }>> | null;
}

export interface GateKind<
  Payload extends MachineJson,
  Answer extends MachineJson
> {
  readonly name: string;
  /** @internal Type carriers. */
  readonly __payload?: Payload;
  readonly __answer?: Answer;
}

export interface MachineGateRef<Answer extends MachineJson = MachineJson> {
  readonly id: string;
  readonly kind: string;
  /** @internal Type carrier. */
  readonly __answer?: Answer;
}

export interface MachineGateOptions {
  readonly metadata?: Record<string, MachineJson>;
  readonly expiresAt: number | Date;
}

export type MachineGateOutcome<Answer extends MachineJson> =
  | {
      readonly status: "answered";
      readonly answer: Answer;
      readonly eventId: string;
    }
  | { readonly status: "expired" | "withdrawn" | "cancelled" };

export interface MachineGates {
  create<Payload extends MachineJson, Answer extends MachineJson>(
    kind: GateKind<Payload, Answer>,
    payload: Payload,
    options: MachineGateOptions
  ): MachineGateRef<Answer>;

  take<Answer extends MachineJson>(
    gate: MachineGateRef<Answer>
  ): MachineGateOutcome<Answer> | null;
}

export type MachineEffectRecovery = "safe" | "never" | "reconcile";

/**
 * A handle to one planned effect.
 *
 * Declared as a type alias rather than an interface so it satisfies
 * {@link MachineJson}: TypeScript gives an interface no implicit index
 * signature, which would stop a machine storing its own effect handle in its
 * own checkpoint. A wrapped runtime that parks between passes has to do
 * exactly that, so the alias is load-bearing.
 */
export type MachineEffectRef<Output extends MachineValue = MachineValue> = {
  readonly id: string;
  readonly kind: string;
  readonly recovery: MachineEffectRecovery;
  /** Maximum duration of each execution or reconciliation attempt. */
  readonly timeoutMs?: number;
  /** Durable retry policy carried through a checkpoint. */
  readonly retries?: MachineEffectRetryPolicy;
  /** @internal Type carrier. */
  readonly __output?: Output;
};

export interface MachineEffectPlanOptions {
  readonly recovery: MachineEffectRecovery;
  readonly externalId?: string;
  /** Maximum duration of each execution or reconciliation attempt. */
  readonly timeoutMs?: number;
  /** Retry policy. `limit` counts the first attempt. */
  readonly retries?: MachineEffectRetryPolicy;
}

export type MachineEffectBackoff = "constant" | "linear" | "exponential";

export type MachineEffectRetryPolicy = {
  readonly limit?: number;
  readonly delay?: number;
  readonly backoff?: MachineEffectBackoff;
};

export interface MachineEffectInvocation<
  Input extends MachineJson = MachineJson
> {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly externalId?: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  /**
   * The input this effect was planned with.
   *
   * Available to every hook, including `reconcile` and `cancel`. Those run
   * after a crash, when the only other thing they are given is `externalId`,
   * so without this a runtime has to encode what it needs into that string
   * and parse it back, or keep an in-memory side table that recovery has
   * already lost.
   */
  readonly input: Input;
}

export interface MachineEffectPending {
  readonly status: "running";
  readonly externalId: string;
  /** @internal Runtime validation prevents application-created pending values. */
  readonly __brand: "MachineEffectPending";
}

export interface MachineEffectRuntime<
  Input extends MachineJson = MachineJson,
  Output extends MachineValue = MachineValue
> {
  execute(
    input: Input,
    invocation: MachineEffectInvocation<Input>
  ): Promise<Output | MachineEffectPending>;
  reconcile?(
    externalId: string,
    invocation: MachineEffectInvocation<Input>
  ): Promise<
    | { status: "running" }
    | { status: "completed"; output: Output }
    | { status: "failed"; error: { name: string; message: string } }
    | { status: "not-found" }
  >;
  cancel?(
    externalId: string,
    invocation: MachineEffectInvocation<Input>
  ): Promise<void>;
}

export type MachineEffectOutcome<Output extends MachineValue> =
  | { readonly status: "running"; readonly attempt: number }
  | {
      readonly status: "retrying";
      readonly attempt: number;
      readonly retryAt: number;
    }
  | {
      readonly status: "completed";
      readonly output: Output;
      readonly attempt: number;
    }
  | {
      readonly status: "failed";
      readonly error: { name: string; message: string };
      readonly attempt: number;
    }
  | { readonly status: "interrupted"; readonly attempt: number };

export type MachineEffectRuntimes = Record<string, MachineEffectRuntime>;

export interface MachineEffects {
  plan<Input extends MachineJson, Output extends MachineValue>(
    kind: string,
    input: Input,
    options: MachineEffectPlanOptions
  ): MachineEffectRef<Output>;
  execute<Output extends MachineValue>(
    effect: MachineEffectRef<Output>
  ): Promise<MachineEffectOutcome<Output>>;
  /** Commit an effect at the current checkpoint and execute it immediately. */
  run<Input extends MachineJson, Output extends MachineValue>(
    kind: string,
    input: Input,
    options: MachineEffectPlanOptions
  ): Promise<MachineEffectOutcome<Output>>;
}

/**
 * - `attached`: parent cancellation requests child cancellation.
 * - `background`: outlives the parent turn; excluded from the default join.
 */
export type MachineChildMode = "attached" | "background";

export interface MachineChildRef<Output extends MachineValue = MachineValue> {
  readonly runId: string;
  readonly definition: string;
  readonly mode: MachineChildMode;
  readonly effect: MachineEffectRef<MachineJson>;
  /** @internal Type carrier. */
  readonly __output?: Output;
}

export type MachineChildResult<Output extends MachineValue> =
  | { readonly ok: true; readonly output: Output }
  | { readonly ok: false; readonly error: { name: string; message: string } };

export interface MachineSpawnOptions {
  readonly runId?: string;
  readonly mode?: MachineChildMode;
}

export interface MachineChildren<Definitions extends MachineDefinitions> {
  spawn<Output extends MachineValue = MachineValue>(
    definition: keyof Definitions & string,
    input: MachineValue,
    options?: MachineSpawnOptions
  ): MachineChildRef<Output>;
  join<Output extends MachineValue>(
    child: MachineChildRef<Output>
  ): Promise<MachineChildResult<Output> | null>;
}

export interface MachineContext<
  State extends MachinePhased,
  Result extends MachineValue,
  Event extends MachineEvent = MachineEvent,
  Definitions extends MachineDefinitions = MachineDefinitions
> {
  readonly runId: string;
  readonly revision: number;
  readonly wake: MachineWake;
  readonly events: MachineEvents<Event>;
  readonly gates: MachineGates;
  readonly effects: MachineEffects;
  readonly children: MachineChildren<Definitions>;

  transition(
    state: State,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
  wait(
    state: State,
    wait: MachineWaitOptions,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
  complete(
    result: Result,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
  fail(
    error: unknown,
    options?: MachineTransitionOptions
  ): MachineDecision<State, Result>;
}

export interface MachineDefinition<
  State extends MachinePhased,
  Result extends MachineValue = void,
  Input extends MachineValue = undefined,
  Event extends MachineEvent = MachineEvent
> {
  readonly version: number;
  readonly initial: (input: Input) => State;
  readonly phases: {
    [Phase in State["phase"]]: (
      state: Extract<State, { phase: Phase }>,
      context: MachineContext<State, Result, Event>
    ) =>
      | MachineDecision<State, Result>
      | Promise<MachineDecision<State, Result>>;
  };
  readonly onCancel?: (
    state: State,
    context: MachineContext<State, Result, Event>
  ) => MachineDecision<State, Result> | Promise<MachineDecision<State, Result>>;
}

export type AnyMachineDefinition = {
  readonly version: number;
  readonly initial: (input: never) => MachinePhased;
  readonly phases: Record<string, (state: never, context: never) => unknown>;
};

export type MachineDefinitions = Record<string, AnyMachineDefinition>;

export type MachineInput<Definition> = Definition extends {
  initial: (input: infer Input) => unknown;
}
  ? Input
  : never;

export type MachineOutput<Definition> = Definition extends {
  phases: infer Phases;
}
  ? Phases extends Record<string, (...args: never[]) => unknown>
    ? Awaited<ReturnType<Phases[keyof Phases]>> extends MachineDecision<
        MachinePhased,
        infer Output
      >
      ? Output
      : never
    : never
  : never;

export type MachineState<Definition> = Definition extends {
  initial: (...args: never[]) => infer State;
}
  ? State extends MachinePhased
    ? State
    : never
  : never;

export type MachineEventOf<Definition> =
  Definition extends MachineDefinition<
    MachinePhased,
    MachineValue,
    MachineValue,
    infer Event
  >
    ? Event
    : MachineEvent;

export interface MachineRunOptions {
  readonly runId?: string;
  readonly idempotencyKey?: string;
  readonly persist?: boolean;
}

export interface MachineReceipt {
  readonly runId: string;
  readonly definition: string;
  readonly accepted: boolean;
  readonly createdAt: number;
}

export interface MachineNotifyOptions {
  readonly eventId: string;
  readonly expiresAt?: number | Date;
}

export type MachineNotifyReceipt =
  | { readonly status: "accepted"; readonly sequence: number }
  | { readonly status: "duplicate"; readonly sequence: number }
  | { readonly status: "not-found" }
  | { readonly status: "terminal" };

export type MachineAnswerReceipt =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | { readonly status: "not-found" }
  | { readonly status: "terminal" }
  | { readonly status: "wrong-kind" }
  | { readonly status: "expired" };

export type MachineCancelReceipt =
  | { readonly status: "requested" }
  | { readonly status: "not-found" }
  | { readonly status: "terminal" };

export type MachineRunStatus =
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface MachineListOptions {
  readonly definition?: string;
  /** An empty list matches no runs. */
  readonly status?: MachineRunStatus | readonly MachineRunStatus[];
  /** Defaults to 100 and cannot exceed 1,000. */
  readonly limit?: number;
}

export type MachineRunSnapshot<
  State extends MachinePhased = MachinePhased,
  Result extends MachineValue = MachineValue
> =
  | {
      readonly runId: string;
      readonly definition: string;
      readonly definitionVersion: number;
      readonly status: "running" | "waiting" | "paused";
      readonly state: State;
      readonly revision: number;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly wait?: {
        readonly kind: string;
        readonly type: string;
        readonly key?: string;
        readonly timeoutAt?: number;
      };
      readonly gates?: readonly MachineGateView[];
      readonly effects?: readonly MachineEffectView[];
      readonly children?: readonly MachineChildView[];
    }
  | {
      readonly runId: string;
      readonly definition: string;
      readonly definitionVersion: number;
      readonly status: "completed";
      readonly result: Result;
      readonly revision: number;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly settledAt: number;
    }
  | {
      readonly runId: string;
      readonly definition: string;
      readonly definitionVersion: number;
      readonly status: "failed" | "cancelled";
      readonly error: { readonly name: string; readonly message: string };
      readonly revision: number;
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly settledAt: number;
    };

export interface MachineGateView {
  readonly gateId: string;
  readonly kind: string;
  readonly metadata?: Record<string, MachineJson>;
  readonly state: "open" | "answered" | "expired" | "withdrawn" | "cancelled";
  readonly expiresAt: number;
}

export interface MachineEffectView {
  readonly effectId: string;
  readonly kind: string;
  readonly recovery: MachineEffectRecovery;
  readonly status: MachineEffectRow["status"];
  readonly externalId?: string;
  readonly attempt: number;
  readonly retryAt?: number;
}

export interface MachineChildView {
  readonly runId: string;
  readonly definition: string;
  readonly mode: MachineChildMode;
  readonly status: string;
}

/** @internal Raw StateMachine run row. */
export interface MachineRunRow {
  run_id: string;
  definition: string;
  definition_version: number;
  status:
    | "running"
    | "waiting"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  phase: string | null;
  checkpoint_json: string | null;
  revision: number;
  /** Advances on transitions, but not waits, to identify one logical phase visit. */
  builder_revision: number;
  control_json: string;
  job_id: string | null;
  wait_kind: string | null;
  wait_type: string | null;
  wait_key: string | null;
  next_at: number | null;
  event_sequence: number;
  cancel_requested: number;
  cancel_reason: string | null;
  result_json: string | null;
  error_name: string | null;
  error_message: string | null;
  persist: number;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

/** @internal */
export interface MachineEventRow {
  run_id: string;
  sequence: number;
  event_id: string;
  type: string;
  event_key: string | null;
  payload_json: string;
  created_at: number;
  expires_at: number | null;
  consumed_revision: number | null;
  consumed_at: number | null;
}

/** @internal */
export interface MachineGateRow {
  gate_id: string;
  run_id: string;
  kind: string;
  request_json: string;
  metadata_json: string | null;
  state: "open" | "answered" | "expired" | "withdrawn" | "cancelled";
  expires_at: number;
  decision_event_id: string | null;
  created_at: number;
  settled_at: number | null;
}

/** @internal */
export interface MachineEffectRow {
  run_id: string;
  effect_id: string;
  revision: number;
  kind: string;
  recovery: MachineEffectRecovery;
  status:
    | "pending"
    | "running"
    | "retrying"
    | "completed"
    | "failed"
    | "interrupted";
  input_json: string;
  external_id: string | null;
  result_json: string | null;
  error_name: string | null;
  error_message: string | null;
  attempt: number;
  retry_at: number | null;
  options_json: string;
  created_at: number;
  settled_at: number | null;
}

/** @internal */
export interface MachineChildRow {
  parent_run_id: string;
  child_run_id: string;
  child_definition: string;
  mode: MachineChildMode;
  status: "running" | "completed" | "failed" | "cancelled";
  completion_event_id: string;
  created_at: number;
  settled_at: number | null;
}
