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

```ts
interface StateMachineOptions<Definitions extends MachineDefinitions> {
  definitions: Definitions;
  effects?: MachineEffectRuntimes;
  detachedHandlers?: Readonly<Record<string, MachineDetachedHandler>>;
}

interface MachineRunOptions {
  runId?: string;
  idempotencyKey?: string;
  retain?: boolean; // Default: true
}

interface MachineReceipt {
  runId: string;
  definition: string;
  accepted: boolean;
  createdAt: number;
}
```

`retain: false` removes the run after it reaches a terminal state.

## Definitions

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

Every phase must return one decision. A decision and its pending events, gates, effects, children, and commit participants are stored in one transaction.

## Events and waits

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

```ts
interface MachineWaitOptions {
  type: string;
  key?: string;
  timeoutAt?: number | Date;
}
```

`eventId` is required. Reusing it with another payload throws. A phase cannot take an event and return `wait()` in the same transition.

## Gates

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
}

interface MachineEffectRef<Output extends MachineValue = MachineValue> {
  id: string;
  kind: string;
  recovery: MachineEffectRecovery;
}

interface MachineEffectPlanOptions {
  recovery: MachineEffectRecovery;
  externalId?: string;
}
```

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

interface MachineEffectInvocation {
  effectId: string;
  idempotencyKey: string;
  externalId?: string;
  signal: AbortSignal;
}
```

```ts
function effectPending(externalId: string): MachineEffectPending;

interface MachineEffectPending {
  status: "running";
  externalId: string;
}

type MachineEffectOutcome<Output extends MachineValue> =
  | { status: "running" }
  | { status: "completed"; output: Output }
  | { status: "failed"; error: { name: string; message: string } }
  | { status: "interrupted" };
```

| Recovery    | Interrupted execution                                 |
| ----------- | ----------------------------------------------------- |
| `safe`      | Runs `execute()` again with the same idempotency key. |
| `never`     | Returns `interrupted`.                                |
| `reconcile` | Calls `reconcile()` with `externalId`.                |

## Children

```ts
type MachineChildMode = "attached" | "background" | "detached";

interface MachineChildren<Definitions extends MachineDefinitions> {
  spawn<Output extends MachineValue = MachineValue>(
    definition: keyof Definitions & string,
    input: MachineValue,
    options?: MachineSpawnOptions
  ): MachineChildRef<Output>;

  take<Output extends MachineValue>(
    child: MachineChildRef<Output>
  ): MachineChildResult<Output> | null;
}
```

```ts
interface MachineChildRef<Output extends MachineValue = MachineValue> {
  runId: string;
  definition: string;
  mode: MachineChildMode;
  owner?: MachineOwnerAddress;
}

interface MachineOwnerAddress {
  key: string;
  data: string;
}

interface MachineSpawnOptions {
  runId?: string;
  mode?: MachineChildMode; // Default: "attached"
  owner?: MachineOwnerAddress;
  onFinish?: string;
  maxBudgetMs?: number; // Detached default: 24 hours
}

type MachineChildResult<Output extends MachineValue> =
  | { ok: true; output: Output }
  | { ok: false; error: { name: string; message: string } };
```

| Mode         | Parent cancellation         | Completion                      |
| ------------ | --------------------------- | ------------------------------- |
| `attached`   | Cancels the child.          | Read with `children.take()`.    |
| `background` | Does not cancel the child.  | Read with `children.take()`.    |
| `detached`   | Uses its own finite budget. | Calls a named detached handler. |

`owner` is reserved for routed child ownership. Omit it for the supported local child lifecycle.

## Detached delivery

```ts
interface MachineDetachedDelivery {
  deliveryId: string;
  kind: "finish" | "give-up";
  parentRunId: string;
  childRunId: string;
  handler: string;
  attempt: number;
  outcome?: MachineChildResult<MachineValue>;
}

type MachineDetachedHandler = (
  delivery: MachineDetachedDelivery
) => void | Promise<void>;
```

Delivery is at least once. Deduplicate handler work with `deliveryId`. `give-up` and `finish` use different delivery IDs.

## Snapshots

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
  owner?: MachineOwnerAddress;
}
```

## Type helpers

| Type                         | Extracts                       |
| ---------------------------- | ------------------------------ |
| `MachineInput<Definition>`   | Input passed to `initial()`.   |
| `MachineState<Definition>`   | State returned by `initial()`. |
| `MachineOutput<Definition>`  | Result passed to `complete()`. |
| `MachineEventOf<Definition>` | Event accepted by `notify()`.  |

## Control receipts

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

```ts
const MAX_MACHINE_CHECKPOINT_BYTES = 1_048_576;

class MachineSerializationError extends Error {}
class MissingMachineDefinitionError extends Error {}
class MachineEventQueueFullError extends Error {}
class MachineTransitionConflictError extends Error {}
```
