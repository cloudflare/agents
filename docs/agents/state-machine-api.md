# State machine API

> **Experimental.** Exports from `agents/state-machine` may change between releases.

```ts
import {
  StateMachine,
  defineGate,
  defineMachine,
  effectPending,
  settleStreamOnMachineCommit
} from "agents/state-machine";
```

See [State machine examples](./state-machine.md) for complete patterns.

## `StateMachine`

`StateMachine` is a Lifecycle capability. Use it to accept runs, inspect snapshots, deliver events, and control execution.

```ts
class StateMachine<Definitions extends MachineDefinitions> {
  constructor(options: StateMachineOptions<Definitions>);

  run<Name extends keyof Definitions & string>(
    definition: Name,
    input: MachineInput<Definitions[Name]>,
    options?: MachineRunOptions
  ): Promise<MachineReceipt>;

  get<Name extends keyof Definitions & string>(
    runId: string,
    definition?: Name
  ): Promise<MachineRunSnapshot<
    MachineState<Definitions[Name]>,
    MachineOutput<Definitions[Name]>
  > | null>;

  list<Name extends keyof Definitions & string>(
    options?: MachineListOptions & { definition?: Name }
  ): Promise<
    MachineRunSnapshot<
      MachineState<Definitions[Name]>,
      MachineOutput<Definitions[Name]>
    >[]
  >;

  notify(
    runId: string,
    event: MachineEvent,
    options: MachineNotifyOptions
  ): Promise<MachineNotifyReceipt>;

  cancel(runId: string, reason?: string): Promise<MachineCancelReceipt>;
  terminate(runId: string, reason?: string): Promise<boolean>;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  delete(runId: string): Promise<boolean>;

  readonly gates: {
    notify<Payload extends MachineJson, Answer extends MachineJson>(
      gateId: string,
      kind: GateKind<Payload, Answer>,
      answer: Answer,
      options: { eventId: string }
    ): Promise<MachineAnswerReceipt>;

    withdraw(gateId: string): Promise<boolean>;
  };
}
```

`StateMachineOptions` registers every definition and external effect runtime.
`jobHungTimeoutSeconds` is the threshold above which a drive job's dispatch is
treated as hung. A phase lasts as long as the work it awaits, and a phase that
drives a wrapped agent runtime routinely outlives the job queue's 30 second
default, so the capability raises it to ten minutes. Liveness does not depend
on this value: a dispatch that really is lost is recovered by the effect's own
`recovery` policy.

```ts
interface StateMachineOptions<Definitions extends MachineDefinitions> {
  definitions: Definitions;
  effects?: MachineEffectRuntimes;
  jobHungTimeoutSeconds?: number; // Default: 600
}

interface MachineRunOptions {
  runId?: string;
  idempotencyKey?: string;
  persist?: boolean; // Default: true
}

interface MachineListOptions {
  definition?: string;
  status?: MachineRunStatus | readonly MachineRunStatus[];
  limit?: number;
}

interface MachineReceipt {
  runId: string;
  definition: string;
  accepted: boolean;
  createdAt: number;
}
```

`MachineRunOptions` controls identity and terminal persistence. `MachineReceipt.accepted` is `false` when `run()` joins an existing run.

`persist: false` removes the run after it reaches a terminal state. `list()`
returns newest runs first, defaults to 100 results, and accepts at most 1,000.
An empty status list returns no runs.

## Definitions

`defineMachine()` preserves the input, state, event, and result types of a `MachineDefinition`. The definition contains the initial checkpoint and one handler for every phase.

```ts
function defineMachine<
  State extends MachinePhased,
  Result extends MachineValue = void,
  Input extends MachineValue = undefined,
  Event extends MachineEvent = MachineEvent
>(
  definition: MachineDefinition<State, Result, Input, Event>
): MachineDefinition<State, Result, Input, Event>;
```

```ts
interface MachineDefinition<
  State extends MachinePhased,
  Result extends MachineValue = void,
  Input extends MachineValue = undefined,
  Event extends MachineEvent = MachineEvent
> {
  version: number;
  initial(input: Input): State;

  phases: {
    [Phase in State["phase"]]: (
      state: Extract<State, { phase: Phase }>,
      context: MachineContext<State, Result, Event>
    ) =>
      | MachineDecision<State, Result>
      | Promise<MachineDecision<State, Result>>;
  };

  onCancel?(
    state: State,
    context: MachineContext<State, Result, Event>
  ): MachineDecision<State, Result> | Promise<MachineDecision<State, Result>>;
}
```

`MachinePhased`, `MachineJson`, and `MachineValue` define what StateMachine can store in checkpoints, events, and results.

```ts
interface MachinePhased {
  phase: string;
  [key: string]: MachineJson;
}

type MachineJson =
  | string
  | number
  | boolean
  | null
  | MachineJson[]
  | { [key: string]: MachineJson };

type MachineValue = MachineJson | undefined | void;
```

The definition name and `version` must remain registered while stored runs use them.

## Phase context

`MachineContext` is passed to each phase handler. It exposes durable coordination APIs and creates the decision committed after the handler returns.

```ts
interface MachineContext<
  State extends MachinePhased,
  Result extends MachineValue,
  Event extends MachineEvent = MachineEvent
> {
  readonly runId: string;
  readonly revision: number;
  readonly wake: MachineWake;
  readonly events: MachineEvents<Event>;
  readonly gates: MachineGates;
  readonly effects: MachineEffects;
  readonly children: MachineChildren<MachineDefinitions>;

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
```

`MachineWake` says why the phase is running. `MachineDecision` describes the next checkpoint or terminal result.

```ts
type MachineWake =
  | { kind: "ordinary" }
  | { kind: "event"; type: string; key?: string }
  | { kind: "timeout"; type: string; key?: string }
  | { kind: "cancel"; reason?: string };

type MachineDecision<State, Result> =
  | {
      kind: "transition";
      state: State;
      commit: readonly MachineCommitParticipant[];
    }
  | {
      kind: "wait";
      state: State;
      wait: MachineWaitOptions;
      commit: readonly MachineCommitParticipant[];
    }
  | {
      kind: "complete";
      result: Result;
      commit: readonly MachineCommitParticipant[];
    }
  | {
      kind: "fail";
      error: { name: string; message: string };
      commit: readonly MachineCommitParticipant[];
    };
```

Each phase returns a decision and its pending events, gates, effects, children, and commit participants are stored in one transaction.

## Events and waits

`notify()` writes a durable inbound event. `MachineNotifyOptions` supplies its unique ID and expiry; `MachineNotifyReceipt` reports admission. `MachineEvents.take()` claims the oldest matching event for the current decision.

```ts
interface MachineEvent {
  type: string;
  key?: string;
  [key: string]: MachineJson | undefined;
}

interface MachineNotifyOptions {
  eventId: string;
  expiresAt?: number | Date;
}

type MachineNotifyReceipt =
  | { status: "accepted"; sequence: number }
  | { status: "duplicate"; sequence: number }
  | { status: "not-found" }
  | { status: "terminal" };
```

```ts
interface MachineEvents<Event extends MachineEvent> {
  take<const Filter extends MachineEventFilter>(
    filter: Filter
  ): MachineQueuedEvent<Extract<Event, { type: Filter["type"] }>> | null;
}

interface MachineEventFilter {
  type: string;
  key?: string;
}

interface MachineQueuedEvent<Event extends MachineEvent> {
  eventId: string;
  sequence: number;
  event: Event;
  createdAt: number;
  expiresAt?: number;
}
```

`MachineWaitOptions` parks a run until a matching event or optional deadline wakes it.

```ts
interface MachineWaitOptions {
  type: string;
  key?: string;
  timeoutAt?: number | Date;
}
```

`eventId` is required. Reusing it with another payload throws. A phase cannot take an event and return `wait()` in the same transition.

## Gates

A gate is a typed request and answer built on the event queue. `GateKind` carries the request and answer types; `MachineGateRef` is safe to store in a checkpoint.

```ts
function defineGate<Payload extends MachineJson, Answer extends MachineJson>(
  name: string
): GateKind<Payload, Answer>;

interface GateKind<Payload extends MachineJson, Answer extends MachineJson> {
  readonly name: string;
}
```

```ts
interface MachineGates {
  create<Payload extends MachineJson, Answer extends MachineJson>(
    kind: GateKind<Payload, Answer>,
    payload: Payload,
    options: MachineGateOptions
  ): MachineGateRef<Answer>;

  take<Answer extends MachineJson>(
    gate: MachineGateRef<Answer>
  ): MachineGateOutcome<Answer> | null;
}

interface MachineGateRef<Answer extends MachineJson = MachineJson> {
  id: string;
  kind: string;
}

interface MachineGateOptions {
  metadata?: Record<string, MachineJson>;
  expiresAt: number | Date;
}

type MachineGateOutcome<Answer extends MachineJson> =
  | { status: "answered"; answer: Answer; eventId: string }
  | { status: "expired" | "withdrawn" | "cancelled" };
```

`MachineAnswerReceipt` reports whether an external gate answer was accepted.

```ts
type MachineAnswerReceipt =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "not-found" }
  | { status: "terminal" }
  | { status: "wrong-kind" }
  | { status: "expired" };
```

## Effects

Effects represent outbound work that cannot be part of the checkpoint transaction. `MachineEffects` stores intent and executes the registered `MachineEffectRuntime`.

```ts
type MachineEffectRecovery = "safe" | "never" | "reconcile";

interface MachineEffects {
  plan<Input extends MachineJson, Output extends MachineValue>(
    kind: string,
    input: Input,
    options: MachineEffectPlanOptions
  ): MachineEffectRef<Output>;

  execute<Output extends MachineValue>(
    effect: MachineEffectRef<Output>
  ): Promise<MachineEffectOutcome<Output>>;

  run<Input extends MachineJson, Output extends MachineValue>(
    kind: string,
    input: Input,
    options: MachineEffectPlanOptions
  ): Promise<MachineEffectOutcome<Output>>;
}

interface MachineEffectRef<Output extends MachineValue = MachineValue> {
  id: string;
  kind: string;
  recovery: MachineEffectRecovery;
  timeoutMs?: number;
  retries?: MachineEffectRetryPolicy;
}

interface MachineEffectPlanOptions {
  recovery: MachineEffectRecovery;
  externalId?: string;
  timeoutMs?: number;
  retries?: MachineEffectRetryPolicy;
}

interface MachineEffectRetryPolicy {
  limit?: number;
  delay?: number;
  backoff?: "constant" | "linear" | "exponential";
}
```

`MachineEffectRef` is stored in a checkpoint. `MachineEffectPlanOptions` selects
its recovery policy, external ID, per-attempt timeout, and durable retry policy.
Retry `limit` includes the first attempt. `run()` commits the effect at the
current checkpoint and executes it without an intermediate transition.

`MachineEffectRuntime` supplies execution, reconciliation, and cancellation for one effect kind. `MachineEffectInvocation` provides stable identifiers and an abort signal.

```ts
interface MachineEffectRuntime<
  Input extends MachineJson = MachineJson,
  Output extends MachineValue = MachineValue
> {
  execute(
    input: Input,
    invocation: MachineEffectInvocation
  ): Promise<Output | MachineEffectPending>;

  reconcile?(
    externalId: string,
    invocation: MachineEffectInvocation
  ): Promise<
    | { status: "running" }
    | { status: "completed"; output: Output }
    | { status: "failed"; error: { name: string; message: string } }
    | { status: "not-found" }
  >;

  cancel?(
    externalId: string,
    invocation: MachineEffectInvocation
  ): Promise<void>;
}

interface MachineEffectInvocation<Input extends MachineJson = MachineJson> {
  effectId: string;
  idempotencyKey: string;
  externalId?: string;
  attempt: number;
  signal: AbortSignal;
  input: Input;
}
```

`effectPending()` records external work that is still running. `MachineEffectOutcome` is returned to the phase that calls `execute()`.

```ts
function effectPending(externalId: string): MachineEffectPending;

interface MachineEffectPending {
  status: "running";
  externalId: string;
}

type MachineEffectOutcome<Output extends MachineValue> =
  | { status: "running"; attempt: number }
  | { status: "retrying"; attempt: number; retryAt: number }
  | { status: "completed"; output: Output; attempt: number }
  | {
      status: "failed";
      error: { name: string; message: string };
      attempt: number;
    }
  | { status: "interrupted"; attempt: number };
```

| Recovery    | Interrupted execution                                 |
| ----------- | ----------------------------------------------------- |
| `safe`      | Runs `execute()` again with the same idempotency key. |
| `never`     | Returns `interrupted`.                                |
| `reconcile` | Calls `reconcile()` with `externalId`.                |

A retryable failure returns `retrying` with a durable `retryAt` deadline. The
phase must return a wait decision using that deadline. Once a `never` effect
starts, the engine does not invoke it again after any failure.

## Children

`MachineChildren` is a typed layer over reconcile effects. `spawn()` plans the child effect with the parent checkpoint. `join()` starts or reconciles the child. Child completion also sends a durable event that wakes a waiting parent.

```ts
type MachineChildMode = "attached" | "background";

interface MachineChildren<Definitions extends MachineDefinitions> {
  spawn<Output extends MachineValue = MachineValue>(
    definition: keyof Definitions & string,
    input: MachineValue,
    options?: MachineSpawnOptions
  ): MachineChildRef<Output>;

  join<Output extends MachineValue>(
    child: MachineChildRef<Output>
  ): Promise<MachineChildResult<Output> | null>;
}
```

`MachineChildRef` stores the underlying effect reference in the parent checkpoint. `MachineSpawnOptions` selects identity and cancellation mode.

```ts
interface MachineChildRef<Output extends MachineValue = MachineValue> {
  runId: string;
  definition: string;
  mode: MachineChildMode;
  effect: MachineEffectRef<MachineJson>;
}

interface MachineSpawnOptions {
  runId?: string;
  mode?: MachineChildMode; // Default: "attached"
}

type MachineChildResult<Output extends MachineValue> =
  | { ok: true; output: Output }
  | { ok: false; error: { name: string; message: string } };
```

| Mode         | Parent cancellation        | Completion                   |
| ------------ | -------------------------- | ---------------------------- |
| `attached`   | Cancels the child.         | Read with `children.join()`. |
| `background` | Does not cancel the child. | Read with `children.join()`. |

A `state-machine:child-completed` event is the normal wake path. A timer-backed wait can call `join()` again as a reconciliation fallback.

## Snapshots

`MachineRunSnapshot` is a status-discriminated view returned by `get()`. Active snapshots include coordination state; terminal snapshots include a result or error.

```ts
type MachineRunSnapshot<
  State extends MachinePhased = MachinePhased,
  Result extends MachineValue = MachineValue
> =
  | {
      status: "running" | "waiting" | "paused";
      runId: string;
      definition: string;
      definitionVersion: number;
      state: State;
      revision: number;
      createdAt: number;
      updatedAt: number;
      wait?: { kind: string; type: string; key?: string; timeoutAt?: number };
      gates?: readonly MachineGateView[];
      effects?: readonly MachineEffectView[];
      children?: readonly MachineChildView[];
    }
  | {
      status: "completed";
      runId: string;
      definition: string;
      definitionVersion: number;
      result: Result;
      revision: number;
      createdAt: number;
      updatedAt: number;
      settledAt: number;
    }
  | {
      status: "failed" | "cancelled";
      runId: string;
      definition: string;
      definitionVersion: number;
      error: { name: string; message: string };
      revision: number;
      createdAt: number;
      updatedAt: number;
      settledAt: number;
    };
```

The view interfaces summarize open gates, effects, and children on active snapshots.

```ts
interface MachineGateView {
  gateId: string;
  kind: string;
  metadata?: Record<string, MachineJson>;
  state: "open" | "answered" | "expired" | "withdrawn" | "cancelled";
  expiresAt: number;
}

interface MachineEffectView {
  effectId: string;
  kind: string;
  recovery: MachineEffectRecovery;
  status: string;
  externalId?: string;
}

interface MachineChildView {
  runId: string;
  definition: string;
  mode: MachineChildMode;
  status: string;
}
```

## Type helpers

These helpers extract the types carried by a definition.

| Type                         | Extracts                       |
| ---------------------------- | ------------------------------ |
| `MachineInput<Definition>`   | Input passed to `initial()`.   |
| `MachineState<Definition>`   | State returned by `initial()`. |
| `MachineOutput<Definition>`  | Result passed to `complete()`. |
| `MachineEventOf<Definition>` | Event accepted by `notify()`.  |

## Control receipts

`MachineCancelReceipt` distinguishes an accepted request from missing and terminal runs. The boolean control methods return `false` when the requested state change does not apply.

```ts
type MachineCancelReceipt =
  | { status: "requested" }
  | { status: "not-found" }
  | { status: "terminal" };
```

| Method        | Result                                                               |
| ------------- | -------------------------------------------------------------------- |
| `cancel()`    | Requests cooperative cancellation and runs `onCancel`, when defined. |
| `terminate()` | Cancels external effects and settles immediately.                    |
| `pause()`     | Stops jobs without changing the checkpoint.                          |
| `resume()`    | Restarts a paused run.                                               |
| `delete()`    | Deletes a terminal run.                                              |

## Commit participants

A `MachineCommitParticipant` adds another synchronous durable write to the machine transaction. Applications receive participants from integrations such as Streams rather than constructing them.

```ts
interface MachineTransitionOptions {
  commit?: readonly MachineCommitParticipant[];
}

interface MachineCommitParticipant {
  readonly __brand: "MachineCommitParticipant";
}

function settleStreamOnMachineCommit(
  streams: Streams,
  streamId: string,
  state?: "completed" | "errored",
  reason?: string | null
): MachineCommitParticipant;
```

## Limits and errors

Checkpoints are limited to one mebibyte. The exported errors identify serialization, definition lookup, queue capacity, and concurrent transition failures.

```ts
const MAX_MACHINE_CHECKPOINT_BYTES = 1_048_576;

class MachineSerializationError extends Error {}
class MissingMachineDefinitionError extends Error {}
class MachineEventQueueFullError extends Error {}
class MachineTransitionConflictError extends Error {}
```
