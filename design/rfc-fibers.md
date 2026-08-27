# RFC: Lifecycle-owned Fibers for durable execution

Status: accepted (amended)

> Amended on acceptance: Fibers integrates through the shipped Lifecycle
> alarm-contribution model (`getNextAlarm()` / `onAlarm()` / `alarms.rearm()`)
> instead of the originally proposed central `cf_lifecycle_work` dispatcher,
> and definitions are declared in the `Fibers` constructor — a
> Scheduler-style `definitions` map — instead of imperative `fibers.create()`
> handles. Both are recorded under Alternatives considered. A typed
> `fibers.handle(name)` lens replaces per-definition handle fields, runs
> start with `fibers.run(name, input, options)`, and `create(name, run,
recover?)`'s recovery slot becomes a `{ run, recover }` map value when
> Phase 2 lands. Code samples are aligned with the Lifecycle API as landed in
> the schedules-capability extraction.

## Summary

Add an `agents/fibers` package centered on one `Fibers` capability. The capability owns Fiber definitions, run state, step journals, replay, recovery policy, cancellation, inspection, and retention. `Lifecycle` owns the physical Durable Object alarm. `Fibers` owns the durable deadlines that decide when it needs to wake, exposes the earliest through its alarm contribution, and handles due work when the shared alarm fires. It never calls `setAlarm()` or `deleteAlarm()` itself.

A host creates any number of named Fibers from one capability:

```ts
readonly report = this.fibers.create(
  "report",
  async (input: ReportInput, step) => {
    const data = await step.do("fetch", () => this.fetchData(input));
    await step.sleep("cool-off", "10 seconds");
    return step.do("publish", ({ idempotencyKey }) =>
      this.publish(data, { idempotencyKey })
    );
  }
);
```

Every Fiber is replayable. After an interruption, the handler starts again at its first line. Completed steps return journaled values, sleeps consult their persisted deadlines, and execution reaches the first unfinished step without repeating completed closures.

A Fiber may also supply one custom recovery callback beside its main callback:

```ts
readonly chatTurn = this.fibers.create(
  "chat-turn",
  async (input: ChatTurnInput, step) => {
    await step.do("model-turn", ({ checkpoint, signal }) =>
      this.runModelTurn(input, { checkpoint, signal })
    );
  },
  async (interruption) => {
    return this.recoverChatTurn(interruption);
  }
);
```

The custom callback controls what happens after an unclean interruption. If it is absent, `Fibers` replays automatically. If present, it may request replay, complete the run, fail it, or cancel it. There is no public strategy tag and no recovery callback hidden inside `step.do()` options.

The same API works in:

- a plain `DurableObject` using `agents/lifecycle`;
- the base `Agent`, where `this.fibers` is installed automatically;
- `AIChatAgent` and `Think`, which inherit the capability;
- internal Think chat and messenger recovery;
- user-defined long-running background work and AI tools.

## Decision in one page

1. `Lifecycle` owns the physical alarm; capabilities own their durable deadlines, contribute the earliest through `getNextAlarm()`, and handle `onAlarm()` dispatch when it fires.
2. `Fibers` is one reusable lifecycle capability. One instance owns all Fiber tables for its host.
3. `Fibers#create(name, run, recover?)` registers a named program and returns a typed `Fiber` handle.
4. A definition is reconstructed each time the host class is constructed. SQLite stores the definition name, input, run state, and step journal, never a closure.
5. `Fiber#run(input, options?)` commits durable acceptance before it returns a receipt.
6. Fiber handlers always replay from the beginning after a new execution attempt.
7. `step.do()` memoizes completed results. An interrupted step runs again by default.
8. `step.sleep()` and `step.sleepUntil()` persist a deadline, re-arm the shared alarm through the Fibers contribution, and end the current execution attempt.
9. An optional Fiber-level `recover` callback sits beside `run`. It is invoked only after an unclean interruption.
10. A custom recovery callback may return `replay`, `complete`, `fail`, or `cancel`.
11. A live execution attempt is generation-fenced. Late work from a superseded attempt cannot commit.
12. Existing `runFiber()`, `startFiber()`, inspection, cancellation, and recovery hooks become compatibility methods over `Fibers` before any deprecation is considered.
13. Think retains its `ChatRecoveryEngine`. The new capability replaces generic run bookkeeping and name dispatch, not Think's transcript-specific recovery decisions.

## Motivation

The Agents SDK currently has several overlapping ways to run durable or background work:

- `keepAlive()` keeps an isolate warm but does not recover work after process loss.
- `runFiber()` writes an active-run marker, accepts checkpoints through `stash()`, and calls `onFiberRecovered()` after interruption.
- `startFiber()` adds durable acceptance, idempotency, status, inspection, cancellation, and retained terminal records.
- `queue()` stores an immediate callback invocation but has weaker recovery and inspection semantics.
- `schedule()` stores named future callback invocations and already multiplexes Agent alarm use.
- `AgentWorkflow` delegates work to Cloudflare Workflows.
- Think and AIChatAgent wrap every chat turn in an internal Fiber and implement substantial custom recovery policy.

These APIs expose implementation history rather than one clear durable execution model. In particular:

- application authors must split normal execution and recovery across `runFiber()` and a large `onFiberRecovered()` switch;
- the original closure is gone during recovery, so users must reconstruct enough information from a name and untyped snapshot;
- managed Fibers and raw Fibers use related but separate lifecycle records;
- internal frameworks inspect Fiber tables directly;
- a new replay engine would otherwise duplicate acceptance, status, cancellation, interruption detection, alarms, and retention;
- capabilities cannot safely own separate physical alarm timestamps because a Durable Object has one alarm.

The `durable-mcp-server` project proves that a named handler plus a journal can provide a compact long-running API:

```ts
server.registerTask("send_report", config, async (input, step) => {
  const data = await step.do("fetch", () => fetchData(input));
  await step.sleep("cool-off", "10 seconds");
  return step.do("send", () => sendReport(data));
});
```

Its engine reconstructs the handler, replays it from the top, returns persisted results for completed steps, and retries the first unfinished step. That project also exposed important details:

- user callbacks need a stable code address after an isolate disappears;
- state and executable code should be separate;
- every active execution needs a generation fence;
- alarms are liveness, while polling is observation;
- progress writes need a replay gate or old progress is re-published as new;
- external effects are at-least-once and require downstream idempotency;
- the handler and step layout form a versioned durable contract.

The Agents SDK can use those lessons without copying the one-Durable-Object-per-task architecture. An Agent already provides a durable identity, SQLite, a lifecycle, sub-agent routing, and one shared alarm. One `Fibers` capability can manage many runs inside that host.

## Existing precedent: `durable-mcp-server`

The current `durable-mcp-server` engine has three layers:

```text
MCP Tasks router
  -> TaskRunner Durable Object
       task row + step journal + input rows + physical alarm
  -> TaskExecutor WorkerEntrypoint
       reconstruct server + find named task + replay handler
```

A registered task looks like this:

```ts
server.registerTask("send_report", { inputSchema }, async (input, step) => {
  const data = await step.do("fetch-data", () => fetchData(input));
  await step.sleep("cool-off", "10 seconds");
  return step.do("send", () => sendReport(data));
});
```

`TaskRunner` stores the string `send_report`, validated input, status, and journal. It never stores the callback. When its alarm fires, it calls `TaskExecutor`. The entrypoint constructs a fresh server, finds the current registration under `send_report`, and runs the callback from the top through `ReplayStep`.

`ReplayStep#do` calls back into a generation-bound `DurableStep` RPC capability owned by `TaskRunner`:

```text
beginStep("fetch-data")
  completed -> return persisted result
  failed    -> throw persisted terminal error
  pending   -> claim another attempt
  missing   -> insert and claim attempt 1
```

A sleep stores its first wake deadline and suspends the executor invocation. The TaskRunner alarm later starts another replay. A normal callback rejection records a retry or terminal failure. If the process disappears while a step is running, that step remains pending; the next claim runs it again. There is no custom recovery callback. Execution is at-least-once.

That architecture is right for a stateless MCP server because each protocol task needs an independent durable address. It is not the right storage topology for an Agent-local feature:

| Concern                    | `durable-mcp-server`                         | Proposed Agent Fibers                                |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| Durable owner              | one `TaskRunner` DO per task                 | existing Agent or Lifecycle Object                   |
| Callback reconstruction    | rebuild `createServer()` in WorkerEntrypoint | reconstruct host class and its Fiber registry        |
| State                      | isolated SQLite per task                     | one Fibers schema with many runs per host            |
| Physical alarm             | each TaskRunner owns one                     | Lifecycle alone owns the host alarm                  |
| Wake dispatch              | TaskRunner alarm calls executor              | Lifecycle alarm dispatches `onAlarm()` to Fibers     |
| Step execution             | ReplayStep plus DurableStep RPC              | local replay step under generation-fenced run        |
| Custom interruption policy | none                                         | optional callback beside main Fiber callback         |
| Protocol projection        | MCP Tasks                                    | direct host API first; tools and MCP can be adapters |

The pieces to carry forward are replay, named journal boundaries, generation fencing, durable deadlines, live-gated status, and strict serialization. The pieces to replace are per-task Durable Objects, callback reconstruction through an MCP server factory, and component-owned physical alarms.

## Existing Agents Fiber implementation

The current Agent implementation has two related ledgers:

- `cf_agents_runs` marks closures currently executing through `runFiber()` and stores the latest `stash()` snapshot;
- `cf_agents_fibers` retains managed `startFiber()` status, idempotency keys, metadata, terminal errors, and timestamps.

The important current operations are:

```text
runFiber(name, closure)
  insert cf_agents_runs
  acquire keepAlive
  execute closure under AsyncLocalStorage
  stash -> update snapshot
  settle -> delete cf_agents_runs

startFiber(name, closure, options)
  insert retained cf_agents_fibers row
  execute through runFiber using same ID
  update retained terminal state

_checkRunFibers()
  find run rows with no live in-memory attempt
  call _handleInternalFiberRecovery(ctx)
  otherwise call user onFiberRecovered(ctx)
```

Think funnels its chat entry points through `_runChatRecoveryFiber()`, which wraps the live turn in `_runFiberWithStashWrapper()`. On wake, `_handleInternalFiberRecovery()` delegates to `ChatRecoveryEngine`. Messenger replies use `startFiber()` and get first refusal in that same central recovery chain.

This works, but application recovery is separated from execution and dispatched by string switches. The proposed capability keeps the proven interruption marker, checkpoint, generation, keep-alive, and facet recovery behavior while moving recovery beside the named operation that owns it.

## Goals

- One public durable execution concept called Fiber.
- One `Fibers` capability per host.
- Multiple named Fiber definitions per capability.
- Durable acceptance and idempotent start.
- Typed input and output at the definition handle.
- Replayable steps with stored results.
- Durable sleeps and retry delays that allow hibernation.
- Optional custom interruption recovery beside the main callback.
- Common run status, inspection, cancellation, metadata, and retention.
- A clean path for plain Lifecycle Objects, Agent, AIChatAgent, Think, and sub-agents.
- Preserve Think's current chat recovery behavior and ordering.
- Give harness authors such as Pi a supported way to attach recovery to the operation it owns.
- Keep the physical alarm under `Lifecycle` ownership.
- Make eventual deprecation of overlapping managed-Fiber APIs possible, but only after parity and migration.

## Non-goals

- Exactly-once external side effects.
- Serializing a JavaScript continuation or closure.
- Replacing Cloudflare Workflows for cross-service orchestration, managed workflow analytics, or very large workflows.
- Automatically making arbitrary code between steps durable.
- Hiding deterministic replay requirements.
- Adding MCP Tasks in the first implementation.
- Adding human input, signals, DAG scheduling, compensation, or rollback in the first implementation.
- Moving Think's transcript, stream, or recovery-budget policy into `Fibers`.
- Allowing capabilities to manipulate the physical Durable Object alarm.

## Terminology

### Fibers capability

The single `Fibers` instance installed on a host. It owns definitions, run and step tables, execution claims, inspection, cancellation, recovery dispatch, and retention.

### Fiber definition

A named program registered in memory by `fibers.create(...)`. A definition contains a main callback and, optionally, a custom recovery callback. The definition itself is not persisted. The host class reconstructs it on every activation.

### Fiber run

One durable invocation of a definition with serialized input. A run has an ID, status, metadata, idempotency key, timestamps, result or error, and a step journal.

### Execution attempt

One live invocation of the Fiber handler in one isolate. A run may have many attempts across retries, sleeps, deployments, and process loss.

### Step

A named durable boundary within a replayable handler. Completed `do` steps store their result. Sleep steps store their wake time. Step names are part of the run's durable contract.

### Replay

Calling the Fiber handler from its beginning and using the journal to return completed results until the first unfinished step is reached.

### Interruption

An execution attempt that was claimed as running but did not settle cleanly. Common causes are deployment, isolate loss, process termination, wall-time termination, or memory failure.

### Recovery

The decision made after an interruption. Without a custom callback, recovery means replay. With a callback, application or framework code chooses replay, completion, failure, or cancellation.

### Alarm contribution

The earliest wake time a capability requests from `Lifecycle` through `getNextAlarm()`. `Lifecycle` arms the physical alarm at the minimum contribution and dispatches `onAlarm()` to every capability when it fires. Wake-ups are at-least-once; the owning capability re-reads its own durable state to decide whether work is still needed. Where this document speaks of a run's "trigger" or "deadline", it means the run's authoritative `next_at` timestamp surfaced through the Fibers contribution.

## Developer model

A host has one manager and many definitions:

```ts
class ExampleAgent extends Agent {
  readonly first = this.fibers.create("first", firstRun);
  readonly second = this.fibers.create("second", secondRun, secondRecover);
}
```

Creating definitions is synchronous and performs no storage I/O. The capability invokes callbacks with the host as `this`; arrow functions may also capture the host naturally from their field initializer. Starting a run is asynchronous and commits durable state:

```ts
const receipt = await this.first.run(input, {
  idempotencyKey: `message:${messageId}`
});
```

The returned receipt means the run and its due deadline are durable. It does not mean the run has completed.

The same definition may have many runs. The same idempotency key resolves to the same run within one host.

## Proposed public API

The package entry point is `agents/fibers`.

```ts
import {
  Fibers,
  type Fiber,
  type FiberInterruption,
  type FiberReceipt,
  type FiberRecoveryDecision,
  type FiberRunOptions,
  type FiberRunSnapshot,
  type FiberStep
} from "agents/fibers";
```

### Serializable values

Fiber input, step results, checkpoints, metadata, and final results must be JSON-serializable. `undefined` may be supported through a tagged storage envelope, matching `durable-mcp-server`, but nested non-JSON values are rejected.

```ts
export type FiberJson =
  | string
  | number
  | boolean
  | null
  | FiberJson[]
  | { [key: string]: FiberJson };

export type FiberValue = FiberJson | undefined | void;
```

The first release should enforce a documented serialized-size limit. A proposed default is 1 MiB per input, checkpoint, step result, and final result. This aligns with portable workflow constraints and prevents a single SQLite row from exhausting an isolate.

### Definition callbacks

```ts
export type FiberRunHandler<Host, Input, Output extends FiberValue> = (
  this: Host,
  input: Readonly<Input>,
  step: FiberStep
) => Output | Promise<Output>;

export type FiberRecoveryHandler<Host, Input, Output extends FiberValue> = (
  this: Host,
  interruption: FiberInterruption<Input>
) => FiberRecoveryDecision<Output> | Promise<FiberRecoveryDecision<Output>>;
```

The recovery callback is the third argument to `create`, directly beside the main callback:

```ts
interface Fibers<Host> {
  create<Input, Output extends FiberValue>(
    name: string,
    run: FiberRunHandler<Host, Input, Output>
  ): Fiber<Input, Output>;

  create<Input, Output extends FiberValue>(
    name: string,
    run: FiberRunHandler<Host, Input, Output>,
    recover: FiberRecoveryHandler<Host, Input, Output>
  ): Fiber<Input, Output>;
}
```

There is no strategy tag. The presence of `recover` changes interruption handling. Normal handler execution and the step API are identical.

### Fiber handle

```ts
export interface Fiber<Input, Output extends FiberValue> {
  readonly name: string;

  /** Durably accept a run and return without waiting for terminal state. */
  run(
    input: Input,
    options?: FiberRunOptions & { waitForCompletion?: false }
  ): Promise<FiberReceipt>;

  /**
   * Durably accept or join a run, then wait while this invocation remains
   * alive. The durable run does not depend on this waiter.
   */
  run(
    input: Input,
    options: FiberRunOptions & { waitForCompletion: true }
  ): Promise<FiberRunSnapshot<Output>>;

  get(runId: string): Promise<FiberRunSnapshot<Output> | null>;

  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<FiberRunSnapshot<Output> | null>;

  cancel(runId: string, reason?: string): Promise<boolean>;
}
```

Manager-level inspection covers runs across definitions:

```ts
export interface Fibers<Host> {
  get(runId: string): Promise<FiberRunSnapshot<FiberValue> | null>;

  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<FiberRunSnapshot<FiberValue> | null>;

  cancel(runId: string, reason?: string): Promise<boolean>;

  list(options?: {
    definition?: string;
    status?: FiberRunState | FiberRunState[];
    limit?: number;
  }): Promise<FiberRunSnapshot<FiberValue>[]>;

  delete(options?: {
    status?: Array<"completed" | "failed" | "cancelled">;
    settledBefore?: Date;
    limit?: number;
  }): Promise<number>;
}
```

### Run options and receipt

```ts
export interface FiberRunOptions {
  /** Stable key used to deduplicate repeated acceptance attempts. */
  idempotencyKey?: string;

  /** Caller-selected run ID. Generated when omitted. */
  runId?: string;

  /** JSON metadata retained with the run. */
  metadata?: Record<string, FiberJson>;

  /** Keep terminal state for inspection. Defaults to true. */
  retain?: boolean;

  /**
   * Wait only while this invocation remains alive. The run itself continues
   * when the caller disconnects or the isolate is replaced.
   */
  waitForCompletion?: boolean;
}

export interface FiberReceipt {
  runId: string;
  definition: string;
  accepted: boolean;
  state: FiberRunState;
  createdAt: number;
}
```

`accepted: false` means an existing run matched `runId` or `idempotencyKey`. It is not an error.

### Run state

The public state is a tagged union rather than a bag of optional fields:

```ts
export type FiberRunState =
  | "pending"
  | "running"
  | "waiting"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export type FiberRunSnapshot<Output extends FiberValue> =
  | {
      runId: string;
      definition: string;
      state: "pending";
      createdAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "running";
      attempt: number;
      startedAt: number;
      createdAt: number;
      statusMessage?: string;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "waiting";
      reason: "sleep" | "retry" | "recovery-backoff";
      wakeAt: number;
      createdAt: number;
      statusMessage?: string;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "recovering";
      interruptedStep: string | null;
      attempt: number;
      createdAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "completed";
      result: Output;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "failed";
      error: FiberError;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, FiberJson>;
    }
  | {
      runId: string;
      definition: string;
      state: "cancelled";
      reason?: string;
      createdAt: number;
      settledAt: number;
      metadata?: Record<string, FiberJson>;
    };

export interface FiberError {
  name: string;
  message: string;
}
```

Secrets, credentials, raw request headers, and access tokens must not be put in metadata, checkpoints, statuses, or errors.

## Lifecycle alarm ownership and the contribution model

A Durable Object has one physical alarm. No capability may treat that alarm as
its own timer. Calling `setAlarm()` with one capability's deadline can
overwrite an earlier deadline from another capability. Calling `deleteAlarm()`
can remove another capability's only wake-up.

The shipped Lifecycle already solves this with alarm contributions (see
[`alarm-coordination.md`](./alarm-coordination.md)):

- every capability owns the durable state that decides when it needs to wake,
  in its own tables;
- `DurableObjectCapability.getNextAlarm()` returns each capability's earliest
  requested wake time — a timestamp, an exclusive request, or `null`;
- `Lifecycle.rearmAlarm()` collects contributions from every installed
  capability plus the host, selects the earliest, and alone calls `setAlarm()`
  or `deleteAlarm()`; rearm requests are serialized so a later durable-state
  change cannot be overwritten by an earlier alarm calculation;
- when the alarm fires, Lifecycle dispatches `onAlarm()` to every capability;
  each capability re-reads its own durable state to find due work, and
  Lifecycle rearms afterwards from fresh contributions.

`Fibers` integrates exactly as the Scheduler does:

- `cf_fiber_runs.next_at` is the authoritative wake deadline for a run.
  Acceptance, sleep, retry, recovery backoff, and claim (hang-detection)
  deadlines all write it;
- `Fibers.getNextAlarm()` returns the minimum deadline across non-terminal
  runs, or `null`;
- `Fibers.onAlarm()` claims and executes due runs under generation fencing;
- every durable transition that changes a deadline calls
  `lifecycle.alarms.rearm()`.

Lifecycle does not understand runs, steps, sleeps, retries, or recovery. It
only ever sees the capability's next requested wake time.

### Responsibilities

`Lifecycle` owns:

- the physical Durable Object alarm;
- contribution collection, selection, and serialized rearming;
- alarm dispatch to capabilities and then the host.

A capability owns:

- the domain state that determines whether work is needed;
- handling its own due work in `onAlarm()`;
- making handling idempotent under at-least-once wakes;
- its own claim fencing and hang detection;
- reporting its next deadline through `getNextAlarm()`.

### Capability identity

Durable state needs a stable owner name that survives isolate replacement.
`LifecycleCapability` already requires one: every capability passes a stable
ID to its constructor (`super("fibers")`), and Lifecycle events carry it.
Fibers uses the ID `fibers`, matching the Scheduler's `scheduler`.

### Durable acceptance without a work queue

A run must not be committed without a durable wake-up. Otherwise an isolate
can disappear after inserting the run but before arming its alarm.

Two mechanisms close this window without a central trigger table:

1. Workers Durable Object storage coalesces synchronous writes: SQL writes and
   the `setAlarm()` issued by `alarms.rearm()` in the same task commit under
   one output gate, so in the common path acceptance and its alarm arm land
   together. This platform behavior must be confirmed against workerd during
   implementation rather than assumed.
2. `Fibers.onStart()` reconciles: any non-terminal run whose deadline is due,
   missing, or stale re-arms through `alarms.rearm()`, exactly as the
   Scheduler recovers overdue schedules at startup.

Reconciliation makes the invariant hold even if the process dies between the
run insert and the alarm write, provided anything later wakes the object. The
residual window — run committed, alarm never armed, object never touched
again — is shared with the Scheduler today and marks the platform-level
durability boundary of this design.

### Hang detection instead of leases

The rejected central dispatcher leased each trigger row. In the contribution
model, hang detection lives at the domain level, where the Scheduler already
implements it: a run claimed by a live attempt carries a claim deadline;
`getNextAlarm()` includes expired and upcoming claim deadlines, so a wedged or
vanished attempt wakes the object and `onAlarm()` reclaims the run under a
fresh generation. Fibers has one fencing layer — the run generation — rather
than one per trigger row and another per run.

### Invocation budget and handoff

Alarm invocations have a finite wall-time budget. `Fibers.onAlarm()` bounds
how many due runs it claims per invocation; remaining due runs keep their
deadlines, so the post-dispatch rearm arms an immediate continuation alarm.

A Fiber step attempt defaults to a timeout shorter than the platform alarm
budget. Long waits must use `step.sleep()` rather than holding the alarm
invocation. A callback that ignores its abort signal can continue until the
platform ends the invocation, but generation fencing prevents its late
settlement from overwriting a newer attempt.

### Coexisting alarm sources

Schedules, keep-alive, facet recovery, deferred destroy, and Fibers coexist as
alarm contributions; no migration of existing sources is required. The
implementation must include regression tests proving a Fiber deadline cannot
overwrite or delete a schedule, keep-alive heartbeat, destruction request, or
facet recovery wake — extending the existing alarm-arbitration suite.

## Fibers capability architecture

### One capability, many definitions

```ts
type FiberDefinition<Host extends LifecycleObject> = {
  readonly name: string;
  readonly run: FiberRunHandler<Host, unknown, FiberValue>;
  readonly recover?: FiberRecoveryHandler<Host, unknown, FiberValue>;
};

export class Fibers<Host extends LifecycleObject> extends LifecycleCapability {
  readonly #host: Host;
  readonly #definitions = new Map<string, FiberDefinition<Host>>();

  constructor(host: Host) {
    super("fibers");
    this.#host = host;
  }

  create<Input, Output extends FiberValue>(
    name: string,
    run: FiberRunHandler<Host, Input, Output>,
    recover?: FiberRecoveryHandler<Host, Input, Output>
  ): Fiber<Input, Output> {
    // Validate and register, then return a lightweight typed handle.
  }

  async onStart(): Promise<void> {
    // Migrate tables, lock the registry, reconcile due and interrupted runs.
  }

  getNextAlarm(): number | null {
    // Earliest next_at across non-terminal runs, or null.
  }

  async onAlarm(): Promise<void> {
    // Claim due runs, execute or recover, settle; Lifecycle rearms after.
  }
}
```

`Fibers` stores the host during construction for callback `this` binding. Lifecycle services (`storage`, `alarms`, `runInHostContext`, `events`) arrive when `.use(this.fibers)` installs the capability, so the natural plain-host field order works:

```ts
readonly fibers = new Fibers(this);
readonly lifecycle = Lifecycle.install(this).use(this.fibers);
```

All `Fiber` handles created by the manager share:

- one schema migration;
- one in-memory definition registry;
- one alarm contribution;
- one concurrency policy;
- one status and retention implementation;
- one active-attempt registry;
- one startup reconciliation pass.

A `Fiber` handle stores only its manager reference and name. It does not create a table or register another lifecycle capability.

### Definition construction

Agent and Durable Object instance fields run every time a fresh host instance is constructed:

```ts
readonly report = this.fibers.create("report", reportRun);
```

Therefore the registry is reconstructed before any request or alarm handler runs. Persistence stores the string `report`. Recovery resolves that string against the current registry.

Rules:

- names are non-empty strings;
- names are unique within one `Fibers` capability;
- reserved framework prefixes such as `__cf_internal_` are unavailable to user definitions;
- definitions must be created synchronously during construction;
- registration locks before the capability begins startup;
- `create()` after startup throws;
- missing definitions for active runs do not silently retry another callback;
- a missing definition marks the run blocked or failed with a clear deployment compatibility error, according to the decision made before implementation.

### Invocation context

Lifecycle capability hooks currently run outside the ambient `getCurrentAgent()` context. `Fibers` must not depend on ambient context for its own storage, claiming, or dispatch logic.

Fiber `run` and `recover` callbacks are semantic host code, not capability hooks. Immediately around those callbacks, `Fibers` enters a supported host invocation context:

```ts
return this.lifecycle.runInHostContext(() =>
  definition.run.call(this.#host, input, step)
);
```

The helper is the standard `runInHostContext` service every installed capability receives; the behavior is public:

- callback `this` is the owning host;
- `getCurrentAgent<Host>().agent` returns that host;
- request, WebSocket connection, and email values are absent;
- a Fiber never retains invocation-owned native handles;
- capability startup and `onAlarm` remain argument-driven outside this narrow callback boundary.

This matches background schedule execution and lets shared Agent helpers keep using `getCurrentAgent()` without making the Fibers engine itself ambient.

### Definition versioning

A Fiber's code and step layout are durable behavior. A deployment can change them while runs are in flight.

The initial API should allow an explicit version:

```ts
readonly report = this.fibers.create(
  "report@v1",
  reportV1
);
```

A later version can coexist:

```ts
readonly reportV1 = this.fibers.create("report@v1", reportV1);
readonly reportV2 = this.fibers.create("report@v2", reportV2);
```

A convenience `version` option may be considered later, but the persisted definition key must be unambiguous. Renaming or removing a definition with active runs is a deployment migration, not a transparent code edit.

### Proposed storage

One schema managed by `Fibers`:

```sql
CREATE TABLE IF NOT EXISTS cf_fiber_runs (
  run_id             TEXT PRIMARY KEY,
  definition         TEXT NOT NULL,
  input              TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN (
                       'pending','running','waiting','recovering',
                       'completed','failed','cancelled'
                     )),
  result             TEXT,
  error_name         TEXT,
  error_message      TEXT,
  status_message     TEXT,
  metadata           TEXT,
  idempotency_key    TEXT UNIQUE,
  retain             INTEGER NOT NULL DEFAULT 1,
  attempt            INTEGER NOT NULL DEFAULT 0,
  generation         TEXT NOT NULL,
  active_step        TEXT,
  checkpoint         TEXT,
  next_at            INTEGER,
  wait_reason        TEXT,
  cancel_requested   INTEGER NOT NULL DEFAULT 0,
  cancel_reason      TEXT,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  updated_at         INTEGER NOT NULL,
  settled_at         INTEGER
);

CREATE INDEX IF NOT EXISTS cf_fiber_runs_due
ON cf_fiber_runs (state, next_at);

CREATE INDEX IF NOT EXISTS cf_fiber_runs_definition
ON cf_fiber_runs (definition, created_at);

CREATE TABLE IF NOT EXISTS cf_fiber_steps (
  run_id             TEXT NOT NULL,
  step_name          TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('do','sleep')),
  state              TEXT NOT NULL CHECK (state IN (
                       'pending','running','waiting','completed','failed'
                     )),
  result             TEXT,
  error_name         TEXT,
  error_message      TEXT,
  attempt            INTEGER NOT NULL DEFAULT 0,
  generation         TEXT,
  checkpoint         TEXT,
  next_at            INTEGER,
  timeout_ms         INTEGER,
  created_at         INTEGER NOT NULL,
  started_at         INTEGER,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  PRIMARY KEY (run_id, step_name),
  FOREIGN KEY (run_id) REFERENCES cf_fiber_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cf_fiber_steps_due
ON cf_fiber_steps (run_id, state, next_at);
```

A future migration may separate interruption incidents or append attempt history for observability. The first implementation should store enough state to explain the current status without building an unbounded event log.

### Run acceptance

```ts
const receipt = await report.run(input, {
  idempotencyKey: `report:${reportId}`
});
```

Acceptance is one transaction:

1. parse input when the definition has an input parser;
2. serialize the refined input;
3. insert the run with state `pending` and `next_at = now`;
4. if an idempotency conflict exists, verify it belongs to the same definition;
5. leave `next_at = now` as the run's due deadline;
6. commit and re-arm the shared alarm (`alarms.rearm()`);
7. optionally start a warm-path attempt when concurrency is available;
8. return the receipt.

The durable deadline is authoritative. Warm execution is only a latency optimization.

### Warm execution

A request, tool, or message can start the newly accepted run immediately after commit. The same claim transaction used by alarm dispatch prevents the warm path and alarm path from both executing it.

If no concurrency permit is available, the run remains pending. Its deadline is already armed through the alarm contribution.

### Claims and generations

Before invoking user code, the capability claims a run:

```text
pending/waiting/recovering
  -> state running or recovering
  -> attempt = attempt + 1
  -> generation = random UUID
  -> active_step = null
  -> started_at = now
```

Every step write and final settlement includes:

```sql
WHERE run_id = ? AND generation = ?
```

A stale attempt that completes after timeout, cancellation, or recovery cannot change the run or step journal. An external effect already in flight may still finish, so downstream idempotency remains required.

### In-memory active registry

The capability keeps an in-memory map:

```ts
type ActiveFiberAttempt = {
  generation: string;
  promise: Promise<void>;
  controller: AbortController;
};
```

Duplicate same-isolate triggers attach to the active promise or return without claiming again. Eviction clears the map. Persisted state and the next alarm wake then drive a fresh claim.

## Step API and replay

Every Fiber handler is replayable. There is no replay strategy flag. Replay is the execution model.

```ts
export interface FiberStep {
  do<T extends FiberValue>(
    name: string,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T>;

  do<T extends FiberValue>(
    name: string,
    config: FiberStepConfig,
    callback: (attempt: FiberStepAttempt) => T | Promise<T>
  ): Promise<T>;

  sleep(name: string, duration: number | FiberDurationString): Promise<void>;

  sleepUntil(name: string, when: number | Date): Promise<void>;

  /**
   * Update observable progress. Replays suppress writes until execution reaches
   * new ground, so old progress is not presented as a new update.
   */
  status(message: string, metadata?: Record<string, FiberJson>): Promise<void>;

  /** Stable external deduplication key for a named step. */
  idempotencyKey(name: string): string;
}

export interface FiberStepAttempt {
  /** One-based attempt number for this named step. */
  readonly attempt: number;

  /** Stable across attempts and recoveries of this step. */
  readonly idempotencyKey: string;

  /** Aborted on cancellation, attempt timeout, or supersession. */
  readonly signal: AbortSignal;

  /**
   * Replace the interrupted step's recovery checkpoint. The write is
   * synchronous against the owning Durable Object SQLite database.
   */
  checkpoint(value: FiberValue): void;
}

export interface FiberStepConfig {
  retries?: {
    /** Total attempts, including the first. */
    limit?: number;
    /** Initial retry delay. */
    delay?: number | FiberDurationString;
    /** Defaults to exponential. */
    backoff?: "constant" | "linear" | "exponential";
  };

  /** Timeout of one callback attempt. */
  timeout?: number | FiberDurationString;
}

export type FiberDurationUnit = "second" | "minute" | "hour" | "day" | "week";

export type FiberDurationString = `${number} ${FiberDurationUnit}${"" | "s"}`;
```

`recover` is deliberately not a `FiberStepConfig` field. Custom recovery is a property of the Fiber program and appears beside its main callback.

### Determinism contract

On every new attempt, the handler runs from its beginning. Therefore:

- all externally visible side effects belong inside `step.do()`;
- code between steps must be deterministic and cheap;
- control flow may depend on Fiber input and completed step results;
- control flow must not depend on ambient `Date.now()`, `Math.random()`, or mutable external state unless that value is first captured by a `step.do()` result;
- step names are stable durable keys;
- loops suffix names with a stable index or domain identifier;
- changing step ordering, names, or branches for an in-flight definition requires versioning;
- inputs, checkpoints, and results must pass the Fiber serializer.

Correct:

```ts
const seed = await step.do(
  "seed",
  () => crypto.getRandomValues(new Uint32Array(1))[0]
);
const now = await step.do("clock", () => Date.now());

for (let index = 0; index < items.length; index++) {
  await step.do(`process:${index}`, () => process(items[index], seed, now));
}
```

Incorrect:

```ts
if (Date.now() % 2 === 0) {
  await step.do("even-path", () => doEvenWork());
} else {
  await step.do("odd-path", () => doOddWork());
}
```

A later replay can choose the other branch and diverge from the journal.

### Step-name uniqueness

Within one handler replay, a name may be used once across `do`, `sleep`, and `sleepUntil`. Reuse throws `DuplicateFiberStepError` before executing user code.

The initial version may require sequential steps. If concurrent `Promise.all([step.do(...), step.do(...)])` is supported, sequence assignment must occur synchronously in call order and interruption state must allow more than one active step. The storage schema already permits multiple running step rows; the custom recovery context should expose `interruptedSteps` as an array. This RFC recommends supporting concurrent independent `do` steps only after sequential recovery, cancellation, and generation fencing are proven.

### New step

For a journal miss:

```text
step.do("compile", callback)
  validate unique name and config
  insert pending step row
  claim attempt 1 under run generation
  execute callback with signal, key, checkpoint
  validate result serialization
  commit completed result under run + step generation
  return result
```

### Completed step

For a journal hit:

```text
step.do("compile", callback)
  find completed step row
  parse result
  return result
  never invoke callback
```

### Clean callback failure

A callback that throws is not an interruption. The active isolate observed the error and can settle it deterministically.

```text
callback throws
  if NonRetryableError or attempt limit reached
    mark step failed
    fail Fiber run
  otherwise
    calculate retry deadline
    mark step waiting
    mark run waiting with reason retry
    move the run deadline to the retry time and re-arm
    end this execution attempt cleanly
```

The Fiber-level custom recovery callback does not run for an ordinary caught exception. It handles unclean interruption where no code observed a final outcome.

### Unclean interruption during a step

Suppose a run has:

```text
fetch    completed
compile  completed
publish  running, attempt 1, checkpoint optional
```

The isolate disappears. The run's claim deadline — surfaced through the Fibers contribution, like the Scheduler's hung-schedule recheck — remains armed as a recovery backstop. On the next wake, `Fibers` sees:

- persisted run state `running`;
- no matching generation in the new isolate's active registry;
- a step row still `running`;

It classifies the previous attempt as interrupted.

Without a custom recovery callback:

```text
mark old generation interrupted
schedule replay immediately
invoke handler from the top
fetch and compile return persisted values
publish claims attempt 2 and executes again
```

With a custom recovery callback:

```text
mark old generation interrupted
set run state recovering under a new generation
invoke the Fiber definition's recover callback
apply its decision
```

### Durable sleep

First execution:

```text
step.sleep("cool-off", "10 seconds")
  validate name
  persist wake_at once
  mark step waiting
  mark run waiting, reason sleep
  move the run deadline to wake_at and re-arm
  end current execution attempt cleanly
```

Replay before the deadline suspends again without moving the original deadline. Replay after the deadline marks the sleep complete and returns.

The first recorded wake time is authoritative. Recomputing `Date.now() + duration` on every replay must not extend the sleep indefinitely.

### Progress and the replay live gate

`step.status()` changes observable state but is not a journaled result step. Naively calling it again while replaying old code makes completed progress appear new.

The `durable-mcp-server` story demo found this bug in production-like tests. After a human answered a fork, replay republished previous story beats with fresh timestamps, making the narrative move backwards.

Fibers should implement the same live-gate rule:

- attempt 1 starts live;
- a recovery replay starts silent;
- completed steps and old status calls are replayed silently;
- the replay becomes live at the latest prior suspension boundary or first journal miss;
- status calls after that point update `statusMessage` and timestamp.

This makes progress useful for long-running tasks without lying to observers after a resume.

## Custom recovery beside the main callback

The API is positional and direct:

```ts
const fiber = fibers.create(name, run);
const fiberWithRecovery = fibers.create(name, run, recover);
```

An object overload may be added only if configuration later grows enough to justify it. The first API should optimize for reading both code paths together.

### Recovery context

```ts
export interface FiberInterruption<Input> {
  readonly runId: string;
  readonly definition: string;
  readonly input: Readonly<Input>;
  readonly attempt: number;
  readonly createdAt: number;
  readonly interruptedAt: number;
  readonly metadata: Readonly<Record<string, FiberJson>> | null;

  /** Null when interruption happened between named steps. */
  readonly interruptedStep: FiberInterruptedStep | null;

  /** Cooperative cancellation signal for this recovery attempt. */
  readonly signal: AbortSignal;
}

export interface FiberInterruptedStep {
  readonly name: string;
  readonly kind: "do";
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly checkpoint: FiberValue | null;
  readonly startedAt: number;
}
```

If parallel steps are later supported, add `interruptedSteps` while keeping `interruptedStep` for the sequential case, or make the array shape a breaking pre-1.0 decision before release.

### Recovery decisions

```ts
export type FiberRecoveryDecision<Output extends FiberValue> =
  | {
      /** Replay the main callback. Completed steps are memoized. */
      action: "replay";
      /** Optional future retry time. Omit for immediate replay. */
      at?: number | Date;
    }
  | {
      /** Settle the Fiber run without replaying its main callback. */
      action: "complete";
      result: Output;
    }
  | {
      action: "fail";
      error: unknown;
    }
  | {
      action: "cancel";
      reason?: string;
    };
```

The callback is expected to reconcile durable application state. It may inspect provider state, transcript state, an external idempotency record, or a partial stream before deciding.

Example:

```ts
readonly payment = this.fibers.create(
  "capture-payment@v1",
  async (input: PaymentInput, step) => {
    return step.do("capture", ({ idempotencyKey, checkpoint }) => {
      checkpoint({ phase: "submitted" });
      return this.payments.capture(input, { idempotencyKey });
    });
  },
  async ({ interruptedStep }) => {
    if (interruptedStep?.name !== "capture") {
      return { action: "replay" };
    }

    const capture = await this.payments.lookupByIdempotencyKey(
      interruptedStep.idempotencyKey
    );

    if (capture?.state === "captured") {
      return {
        action: "complete",
        result: capture
      };
    }

    if (capture?.state === "declined") {
      return {
        action: "fail",
        error: new Error("Payment was declined")
      };
    }

    return { action: "replay" };
  }
);
```

This callback sits beside the main callback and owns the exceptional ambiguity. Ordinary Fibers omit it.

### Recovery callback interruption

Recovery itself can be interrupted. The run keeps a due claim deadline until recovery settles. A new activation sees `recovering` with no active in-memory generation and invokes recovery again under a fresh generation.

Recovery callbacks must be idempotent. If they perform external effects, they should use the run ID or interrupted step idempotency key.

A throwing recovery callback does not immediately lose the run. The capability records the safe error summary and schedules a bounded, backing-off recovery attempt. Recovery has a configurable maximum age or attempt budget so a poison callback cannot wake the Durable Object forever. When exhausted, the run becomes failed and emits an observability event.

### Why custom recovery is Fiber-level

Putting `recover` in `step.do()` configuration makes normal code hard to read and couples a rare failure policy to every operation:

```ts
// Rejected API
await step.do("publish", { recover: async () => ... }, async () => ...);
```

It also asks authors to reason about recovery while reading the ordinary happy path. Internal runtimes such as Think recover a whole turn using transcript and stream state, not one generic step result.

The Fiber-level callback gives one cohesive place for ambiguity policy and mirrors how existing `onFiberRecovered()` is used, while avoiding one global name switch. The definition that owns the run also owns its recovery.

The tradeoff is that a Fiber-level callback cannot infer the static result type of an arbitrary interrupted step. It settles or replays the Fiber as a whole. An application that needs to reconcile one step and then continue should write the main workflow so replay is safe after reconciliation, usually by using a stable downstream idempotency key and returning `replay`.

## Execution state machine

```text
                         run()
                           |
                           v
                        pending
                           |
                       alarm wake
                           |
                           v
                        running
                      /    |     \
         step retry /     |      \ clean result
                    v      |       v
                 waiting   |    completed
                    |      |
          retry/sleep      | process loss
          deadline         v
                    interrupted (derived)
                           |
                +----------+----------+
                |                     |
          no recover callback     recover callback
                |                     |
              replay              recovering
                                      |
                    +---------+-------+--------+
                    |         |                |
                  replay   complete       fail/cancel
```

`interrupted` need not be a long-lived public state. It can be detected from `running` or `recovering` plus the absence of an active generation and immediately transition to `recovering` or a replayable `waiting` state. Observability should still emit a distinct interruption event.

## Usage: plain Durable Object plus Lifecycle

A plain Durable Object constructs the capability and explicitly installs it:

```ts
import { DurableObject } from "cloudflare:workers";
import { Fibers } from "agents/fibers";
import { Lifecycle } from "agents/lifecycle";

interface Env {
  ReportObject: DurableObjectNamespace<ReportObject>;
  AI: Ai;
  REPORTS: R2Bucket;
}

interface ReportInput {
  reportId: string;
  topic: string;
}

interface ReportResult {
  reportId: string;
  objectKey: string;
}

export class ReportObject extends DurableObject<Env> {
  readonly fibers = new Fibers(this);

  readonly lifecycle = Lifecycle.install(this).use(this.fibers);

  readonly buildReport = this.fibers.create<ReportInput, ReportResult>(
    "build-report@v1",
    async (input, step) => {
      await step.status("Researching");

      const research = await step.do(
        "research",
        {
          retries: {
            limit: 4,
            delay: "2 seconds",
            backoff: "exponential"
          },
          timeout: "2 minutes"
        },
        ({ signal }) => this.research(input.topic, { signal })
      );

      await step.sleep("editorial-delay", "30 seconds");
      await step.status("Publishing");

      const objectKey = `reports/${input.reportId}.json`;
      // Writing the same body to the same R2 key is naturally idempotent.
      await step.do("publish", ({ signal }) =>
        this.writeReport(objectKey, research, { signal })
      );

      return { reportId: input.reportId, objectKey };
    }
  );

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/reports") {
      const input = parseReportInput(await request.json());
      const receipt = await this.buildReport.run(input, {
        idempotencyKey: `report:${input.reportId}`
      });

      return Response.json(receipt, { status: 202 });
    }

    const match = url.pathname.match(/^\/reports\/([^/]+)$/);
    if (request.method === "GET" && match) {
      const snapshot = await this.fibers.get(decodeURIComponent(match[1]));
      return snapshot
        ? Response.json(snapshot)
        : new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }

  /** Native Durable Object RPC bypasses fetch, so start Lifecycle explicitly. */
  async startReport(input: ReportInput): Promise<FiberReceipt> {
    await this.lifecycle.start();
    return this.buildReport.run(input, {
      idempotencyKey: `report:${input.reportId}`
    });
  }
}
```

The class declares no `alarm()` method. `Lifecycle.install(this)` owns it. The Fibers capability contributes its earliest deadline through `getNextAlarm()`; Lifecycle arms and dispatches the physical alarm.

The Worker routes to one named object according to the application's tenancy model:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const principal = await authenticate(request);
    const object = env.ReportObject.getByName(principal.accountId);
    return object.fetch(request);
  }
} satisfies ExportedHandler<Env>;
```

All report runs for one account live in that account's Durable Object. Different accounts remain isolated.

## Usage: base Agent

`Agent` installs one `Fibers` capability automatically. Subclasses only declare definitions:

```ts
import { Agent, callable } from "agents";
import type { Connection, WSMessage } from "agents";

interface IndexInput {
  requestId: string;
  paths: string[];
}

interface IndexResult {
  indexed: number;
}

export class WorkspaceAgent extends Agent<Env> {
  readonly rebuildIndex = this.fibers.create<IndexInput, IndexResult>(
    "rebuild-index@v1",
    async (input, step) => {
      const records = [];

      for (let index = 0; index < input.paths.length; index++) {
        const path = input.paths[index];
        const record = await step.do(`read:${index}`, () =>
          this.readWorkspaceRecord(path)
        );
        records.push(record);
        await step.status(`Read ${index + 1}/${input.paths.length}`);
      }

      const indexed = await step.do(
        "write-index",
        ({ idempotencyKey, signal }) =>
          this.writeIndex(records, { idempotencyKey, signal })
      );

      return { indexed };
    }
  );

  /** RPC callers get a durable receipt rather than holding the RPC open. */
  @callable()
  rebuild(input: IndexInput): Promise<FiberReceipt> {
    return this.rebuildIndex.run(input, {
      idempotencyKey: `index:${input.requestId}`
    });
  }

  @callable()
  inspectRun(runId: string) {
    return this.fibers.get(runId);
  }

  @callable()
  cancelRun(runId: string, reason?: string) {
    return this.fibers.cancel(runId, reason);
  }

  async onMessage(_connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    const input = parseIndexMessage(JSON.parse(message));

    await this.rebuildIndex.run(input, {
      idempotencyKey: `message:${input.requestId}`
    });
  }
}
```

### Starting work in `onStart`

`onStart` runs on every activation, including activations caused by Fiber work. It must not create an unrestricted new run each time.

For a migration that should run once per Agent:

```ts
readonly migrateWorkspace = this.fibers.create(
  "workspace-migration@v3",
  async (_input: undefined, step) => {
    await step.do("rewrite-manifest", () => this.rewriteManifestV3());
  }
);

async onStart() {
  await this.migrateWorkspace.run(undefined, {
    idempotencyKey: "workspace-migration:v3"
  });
}
```

The stable key returns the same retained run on every wake.

For work that may run again after the prior run settles, the eventual API may add an explicit concurrency key:

```ts
async onStart() {
  await this.refreshCache.run(undefined, {
    concurrencyKey: "startup-cache-refresh",
    dedupe: "while-active"
  });
}
```

This policy should not be included until its exact terminal-run semantics are specified. The safe first-release pattern is an application-selected idempotency key or an explicit lookup of active runs.

## Usage: AIChatAgent and Think application Fibers

`AIChatAgent` and `Think` inherit `this.fibers` from Agent. A user-defined background Fiber can become an AI SDK tool through a separate adapter entry point, keeping the core package free of a required AI dependency.

```ts
import { Think } from "@cloudflare/think";
import { fiberTool, fiberStatusTool, fiberCancelTool } from "agents/fibers/ai";
import { z } from "zod";

const researchInput = z.object({
  topic: z.string().min(1),
  depth: z.enum(["brief", "deep"])
});

type ResearchInput = z.infer<typeof researchInput>;

interface ResearchResult {
  title: string;
  summary: string;
  sources: string[];
}

export class ResearchAgent extends Think<Env> {
  readonly research = this.fibers.create<ResearchInput, ResearchResult>(
    "research@v1",
    async (input, step) => {
      await step.status("Searching sources");

      const sources = await step.do("search", ({ signal }) =>
        this.searchSources(input.topic, { signal })
      );

      if (input.depth === "deep") {
        await step.sleep("source-settle", "15 seconds");
      }

      await step.status("Writing summary");
      const result = await step.do("summarize", ({ signal }) =>
        this.summarizeSources(input.topic, sources, { signal })
      );

      return { ...result, sources };
    }
  );

  getTools() {
    return {
      startResearch: fiberTool(this.research, {
        description: "Start durable background research",
        inputSchema: researchInput
      }),

      getBackgroundWork: fiberStatusTool(this.fibers, {
        description: "Inspect durable background work by run ID"
      }),

      cancelBackgroundWork: fiberCancelTool(this.fibers, {
        description: "Cancel durable background work by run ID"
      })
    };
  }
}
```

The generated tool starts or joins a Fiber run and normally returns immediately:

```json
{
  "runId": "fiber_01J...",
  "definition": "research@v1",
  "state": "pending",
  "accepted": true
}
```

The tool derives its default idempotency key from the definition and AI SDK `toolCallId`:

```ts
`tool:${fiber.name}:${toolCallId}`;
```

This prevents a recovered chat turn from starting the same background work twice when the same tool call is replayed.

The adapter may support a bounded wait mode:

```ts
startResearch: fiberTool(this.research, {
  description: "Run durable research",
  inputSchema: researchInput,
  wait: {
    timeout: "20 seconds",
    onTimeout: "return-receipt"
  }
});
```

If the Fiber completes while the tool invocation is alive, the tool returns its result. Otherwise it returns the durable receipt. The Fiber continues even if the tool invocation, chat turn, WebSocket, or browser disappears.

A later Think-specific completion adapter can use `submitMessages()` with an idempotency key to start a new model turn after a Fiber completes. That is a projection over terminal Fiber state, not a responsibility of the core capability.

## Think internal use

Think currently uses Fibers for two distinct internal jobs:

1. every chat turn is wrapped by `_runChatRecoveryFiber()`;
2. Chat SDK messenger replies use managed `startFiber()` records.

The current chat path has seven call sites, but they already converge through `_runChatRecoveryFiber(requestId, continuation, fn)`. That gives the migration one narrow entry point.

### Durable chat-turn input

The end state should replace an arbitrary live closure with a serializable turn command:

```ts
interface ThinkChatFiberInput {
  requestId: string;
  recoveryRootRequestId: string;
  continuation: boolean;
  trigger:
    | "websocket"
    | "programmatic"
    | "submission"
    | "continuation"
    | "recovery";
  channel?: string;
  body?: Record<string, FiberJson>;
  clientTools?: ClientToolSchema[];
}
```

Think defines one internal Fiber:

```ts
private readonly chatTurnFiber = this.fibers.create<
  ThinkChatFiberInput,
  undefined
>(
  "__cf_internal_chat_turn@v1",
  async (input, step) => {
    await step.do(
      "model-turn",
      {
        retries: { limit: 1 },
        timeout: "14 minutes"
      },
      async ({ checkpoint, signal }) => {
        const snapshot = createChatFiberSnapshot({
          kind: "think-chat-turn",
          requestId: input.requestId,
          recoveryRootRequestId: input.recoveryRootRequestId,
          continuation: input.continuation,
          messages: this.messages,
          lastBody: input.body,
          lastClientTools: input.clientTools
        });

        checkpoint(
          wrapChatFiberSnapshot(
            "__cfThinkChatFiberSnapshot",
            snapshot,
            null
          )
        );

        await this._executeDurableTurn(input, {
          signal,
          checkpoint: (user) =>
            checkpoint(
              wrapChatFiberSnapshot(
                "__cfThinkChatFiberSnapshot",
                snapshot,
                user
              )
            )
        });
      }
    );
  },
  async (interruption) =>
    this._recoverInterruptedChatFiber(interruption)
);
```

Think's existing nested `this.stash(data)` calls can temporarily delegate to the active Fiber step's `checkpoint(data)`. New internal code should use the explicit callback.

### Starting and waiting for a live turn

A WebSocket or programmatic entry path wants to remain attached while the live turn executes, so it requests completion:

```ts
private async _runChatRecoveryFiber(
  input: ThinkChatFiberInput
): Promise<void> {
  await this.chatTurnFiber.run(input, {
    runId: input.requestId,
    idempotencyKey: `think-turn:${input.requestId}`,
    waitForCompletion: true,
    retain: false
  });
}
```

`waitForCompletion` keeps only the current caller waiting. The durable run does not depend on that caller. If the isolate disappears, the original caller disappears too, while Lifecycle later dispatches recovery.

`retain: false` lets successfully completed internal turn records be removed after the framework has persisted all transcript and stream state. Interrupted and failed records remain long enough for recovery and diagnosis.

### Think's custom recovery callback

Think should not automatically rerun an interrupted model step. It has richer evidence:

- Session-backed messages;
- persisted resumable-stream chunks and stream status;
- settled tool outputs that must not execute again;
- pending client-tool and approval interactions;
- provider run IDs and event offsets where available;
- chat recovery incidents, no-progress windows, and work budgets;
- durable submissions that need terminal settlement;
- agent-tool child-run ownership and reattachment state.

The custom recovery callback adapts `FiberInterruption` to the existing `ChatRecoveryEngine`:

```ts
private async _recoverInterruptedChatFiber(
  interruption: FiberInterruption<ThinkChatFiberInput>
): Promise<FiberRecoveryDecision<undefined>> {
  const checkpoint = interruption.interruptedStep?.checkpoint;
  const { snapshot, user } = unwrapChatFiberSnapshot<"think-chat-turn">(
    "__cfThinkChatFiberSnapshot",
    checkpoint,
    "think-chat-turn"
  );

  const outcome = await this._chatRecoveryEngine().recover({
    runId: interruption.runId,
    createdAt: interruption.createdAt,
    input: interruption.input,
    snapshot,
    recoveryData: user,
    messages: this.messages
  });

  switch (outcome.action) {
    case "completed":
      return { action: "complete", result: undefined };

    case "retry":
      // The recovery engine has repaired/persisted the transcript and judged
      // replay safe. A fresh main-handler replay starts a new model call.
      return { action: "replay" };

    case "continue":
      // The engine can perform or schedule its transcript-aware continuation.
      await this._continueRecoveredTurn(outcome);
      return { action: "complete", result: undefined };

    case "exhausted":
      await this._recordTerminalChatStatus(
        "interrupted",
        interruption.input.requestId,
        outcome.message
      );
      return {
        action: "fail",
        error: new Error(outcome.message)
      };
  }
}
```

The exact `ChatRecoveryEngine` return type will require an adapter refactor. The important boundary is stable: Fibers detects and dispatches interruption; Think decides what a partially executed model turn means.

### Startup ordering

Think recovery currently runs after Think initializes Session, resumable streams, cached request state, channels, and messenger definitions, but before the user's `onStart()`.

That ordering is load-bearing. A client-interaction check needs restored client tools, messenger recovery needs its definitions, and transcript recovery needs Session storage.

The migration must preserve this sequence:

```text
Lifecycle capability startup
  Fibers migrates tables and reconciles run deadlines
Think framework initialization
  Session
  streams
  request body and client tools
  channels and messengers
Agent framework recovery point
  await this.fibers.recoverPending()
user onStart
```

`Fibers.onStart()` must not invoke Think's custom recovery callback before the host is ready. It may migrate and identify pending work. Dispatch occurs on a later alarm wake after host initialization or through the existing Agent framework recovery point during migration.

### Messenger replies

Think's messenger runtime currently uses `startFiber()` plus a snapshot state machine. It becomes another internal definition:

```ts
private readonly messengerReplyFiber = this.fibers.create<
  MessengerReplyInput,
  undefined
>(
  "__cf_internal_messenger_reply@v1",
  async (input, step) => {
    await step.do("deliver", async ({ checkpoint, signal }) => {
      checkpoint(messengerReplySnapshot("accepted", input.event, input.thread));
      await this._deliverMessengerReply(input, { checkpoint, signal });
    });
  },
  async (interruption) => {
    const outcome = await this._messengerRuntime?.recoverReply(interruption);
    return outcome ?? {
      action: "fail",
      error: new Error("Messenger runtime is unavailable")
    };
  }
);
```

This removes the current central first-refusal chain where `_handleInternalFiberRecovery()` asks the messenger runtime, then chat recovery, then the user's hook. Each named definition owns its recovery directly.

### Think no longer reads Fiber tables

Think currently queries `cf_agents_runs` by Fiber name to decide whether a submission has fresh recovery evidence. After extraction it uses capability methods:

```ts
const evidence = await this.chatTurnFiber.get(input.requestId);
const recoverable =
  evidence?.state === "running" ||
  evidence?.state === "recovering" ||
  evidence?.state === "waiting";
```

The Fibers schema remains private to `agents/fibers`.

## Long-running durable patterns

### Pattern 1: replayable application pipeline

Use default replay when every side effect can be placed in a named step and repeated safely with an idempotency key.

```ts
readonly importData = this.fibers.create<ImportInput, ImportResult>(
  "import-data@v1",
  async (input, step) => {
    const manifest = await step.do("read-manifest", ({ signal }) =>
      this.readManifest(input.objectKey, { signal })
    );

    let imported = 0;
    for (let index = 0; index < manifest.batches.length; index++) {
      const batch = manifest.batches[index];
      const count = await step.do(
        `import:${index}`,
        {
          retries: {
            limit: 8,
            delay: "2 seconds",
            backoff: "exponential"
          }
        },
        ({ idempotencyKey, signal }) =>
          this.importBatch(batch, { idempotencyKey, signal })
      );
      imported += count;
      await step.status(
        `Imported ${index + 1}/${manifest.batches.length} batches`
      );
    }

    await step.do("verify", ({ signal }) =>
      this.verifyImport(input.importId, { signal })
    );

    return { imported };
  }
);
```

A deployment during batch 41 causes a replay. Batches 0 through 40 return stored counts. Batch 41 runs again under the same idempotency key. The source handler starts at the top, while logical work resumes at batch 41.

### Pattern 2: work separated by long waits

```ts
readonly onboarding = this.fibers.create<OnboardingInput, undefined>(
  "onboarding@v1",
  async (input, step) => {
    await step.do("welcome", ({ idempotencyKey }) =>
      this.sendWelcome(input.userId, { idempotencyKey })
    );

    await step.sleep("day-two-delay", "1 day");

    await step.do("day-two", ({ idempotencyKey }) =>
      this.sendDayTwoGuide(input.userId, { idempotencyKey })
    );

    await step.sleep("week-one-delay", "1 week");

    await step.do("week-one", ({ idempotencyKey }) =>
      this.sendWeekOneSurvey(input.userId, { idempotencyKey })
    );
  }
);
```

No isolate remains active during the waits. The Fiber run and its deadline are durable. Each wake reconstructs the host and replays the handler.

The initial implementation must define its maximum supported sleep horizon from the platform alarm contract. Longer waits can be chained by Lifecycle if the platform limits one alarm deadline.

### Pattern 3: start an external job, then poll

External jobs often run longer than a Worker invocation. Start once, store the external job ID as a step result, then use named sleep and poll steps.

```ts
readonly renderVideo = this.fibers.create<RenderInput, RenderResult>(
  "render-video@v1",
  async (input, step) => {
    const external = await step.do(
      "start-render",
      ({ idempotencyKey, signal }) =>
        this.video.start(input, { idempotencyKey, signal })
    );

    for (let poll = 0; poll < 1_000; poll++) {
      await step.sleep(`poll-delay:${poll}`, "1 minute");

      const status = await step.do(`poll:${poll}`, ({ signal }) =>
        this.video.status(external.jobId, { signal })
      );

      await step.status(`Render ${status.percent}% complete`);

      if (status.state === "completed") {
        return {
          jobId: external.jobId,
          url: status.url
        };
      }

      if (status.state === "failed") {
        throw new NonRetryableError(status.message);
      }
    }

    throw new NonRetryableError("Render did not finish within 1,000 polls");
  }
);
```

This can run for hours without holding memory. The stable loop index keeps step names deterministic.

### Pattern 4: reconcile an external side effect after uncertain interruption

Use custom recovery when replaying immediately could duplicate an irreversible effect and the external system provides a lookup or continuation API.

```ts
readonly provisionAccount = this.fibers.create<
  ProvisionInput,
  ProvisionResult
>(
  "provision-account@v1",
  async (input, step) => {
    const account = await step.do(
      "create-account",
      ({ checkpoint, idempotencyKey, signal }) => {
        checkpoint({ phase: "submitted" });
        return this.provider.createAccount(input, {
          idempotencyKey,
          signal
        });
      }
    );

    await step.do("configure-account", ({ idempotencyKey, signal }) =>
      this.provider.configure(account.id, input.plan, {
        idempotencyKey,
        signal
      })
    );

    return account;
  },
  async (interruption) => {
    const active = interruption.interruptedStep;
    if (!active) return { action: "replay" };

    const outcome = await this.provider.lookupOperation(
      active.idempotencyKey
    );

    if (outcome.state === "unknown" || outcome.state === "not-started") {
      return { action: "replay" };
    }

    if (outcome.state === "failed") {
      return {
        action: "fail",
        error: new Error(outcome.message)
      };
    }

    // The provider says the effect completed, but the main handler needs the
    // result in its step journal before it can continue. V1's whole-Fiber
    // completion decision cannot inject an arbitrary step value.
    //
    // Two safe options exist:
    // 1. return the whole Fiber result if the external effect was the final
    //    operation;
    // 2. persist the reconciled result in application storage, return replay,
    //    and make the step callback read that durable record before issuing a
    //    new external request.
    await this.recordReconciledProvision(
      active.idempotencyKey,
      outcome.account
    );
    return { action: "replay" };
  }
);
```

The main step then checks the reconciliation record first:

```ts
const account = await step.do(
  "create-account",
  async ({ checkpoint, idempotencyKey, signal }) => {
    const reconciled = await this.readReconciledProvision(
      step.idempotencyKey("create-account")
    );
    if (reconciled) return reconciled;

    checkpoint({ phase: "submitted" });
    return this.provider.createAccount(input, {
      idempotencyKey,
      signal
    });
  }
);
```

This keeps recovery beside the main Fiber while letting replay reconstruct the same local value graph.

A later API may permit a recovery decision to complete an interrupted step with a typed value, but that requires coupling the Fiber recovery callback to heterogeneous step result types. It should not be added without a concrete ergonomic design.

### Pattern 5: provider-aware stream recovery

Think, AIChatAgent, and Pi need custom recovery because the durable truth is richer than one step result. Their callback may:

- reattach to a provider run at an event offset;
- reconstruct a partial assistant message from stored chunks;
- avoid rerunning tools whose outputs already settled;
- continue the model from a persisted partial;
- regenerate from the unanswered user message;
- park while a human-controlled client tool is unresolved;
- exhaust after a no-progress or work budget;
- complete the Fiber after terminal state has already been written elsewhere.

That logic fits the optional Fiber recovery callback. It does not fit automatic replay alone.

### Pattern 6: ordinary short work

Do not use a Fiber merely because work is asynchronous.

```ts
const result = await this.keepAliveWhile(() => this.fetchSlowResource());
```

Use normal request handling or `keepAliveWhile()` when:

- the caller needs the immediate result;
- the work takes seconds or a few minutes;
- interruption can be treated as a request failure;
- no durable receipt, status, sleep, retry, or recovery is required.

Use a Fiber when durable acceptance or recovery matters.

## Replay versus custom recovery

| Need                                                     | Default replay     | Custom recovery                 |
| -------------------------------------------------------- | ------------------ | ------------------------------- |
| Completed steps should not rerun                         | Yes                | Yes, if recovery chooses replay |
| Interrupted step may safely rerun with same key          | Ideal              | Usually unnecessary             |
| External provider can report uncertain operation outcome | Possible           | Recommended                     |
| Partial output exists outside the step result journal    | Insufficient alone | Recommended                     |
| Recovery may continue rather than restart                | No                 | Yes                             |
| Recovery may terminalize from durable external state     | No                 | Yes                             |
| Simple application pipeline                              | Recommended        | Avoid extra policy              |
| Model or harness stream                                  | Usually unsafe     | Recommended                     |

The default should remain replay. Most application authors should never write a recovery callback.

## Failure semantics

### Handler throws outside a step

A handler exception outside `step.do()` fails the run. The engine records a safe error summary. It does not automatically replay because there is no durable boundary identifying what work completed.

### Step callback rejects

The retry policy handles it. A `NonRetryableError` or exhausted attempts fails the step and run.

### Step timeout

The engine aborts the attempt signal. If the callback cooperates and rejects, normal retry policy applies. If it ignores cancellation, the active concurrency permit remains held while that callback is still running in the same isolate. Generation fencing prevents late writes after a newer attempt claims the step.

Across isolate loss, execution remains at-least-once. Timeouts do not make an external side effect exactly-once.

### Process loss during a step

The next wake detects the abandoned generation. It invokes custom recovery if present, otherwise it replays.

### Process loss between steps

No step is marked running. Custom recovery receives `interruptedStep: null`. Default recovery replays and reaches the next journal miss.

### Process loss during sleep

The sleep deadline remains durable and contributed. A wake before the deadline re-arms it. A wake after the deadline completes the sleep and replays forward.

### Cancellation

Cancellation is cooperative:

1. persist `cancel_requested` and reason;
2. abort the active attempt signal in the current isolate;
3. set the run deadline to now and re-arm;
4. every step boundary checks cancellation;
5. generation fencing rejects stale settlements;
6. settle `cancelled` when no successful terminal result won first.

An external side effect already accepted cannot be undone.

### Missing definition after deployment

An active run whose definition is no longer registered must not execute another handler or be silently deleted. The capability records a `MissingFiberDefinitionError`, keeps enough metadata for inspection, and either fails immediately or enters a bounded blocked state. This exact terminal policy is an open decision, but silent replay is forbidden.

### Replay divergence

The engine detects at least:

- a known step name used under a different kind;
- a stored step skipped while later known steps are reached;
- duplicate names in one replay;
- changed retry or timeout settings where that change affects a pending attempt;
- changed custom-recovery presence for an interrupted run, if the run stored that marker.

It fails with `FiberReplayDivergedError` rather than guessing.

## Choosing between platform features

| Requirement                                                                                         | Recommended API                                             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Normal request or short async work                                                                  | ordinary `await`                                            |
| Keep a live operation warm for a few minutes, loss is acceptable                                    | `keepAliveWhile()`                                          |
| Durable Agent-local background work, steps, retries, or sleeps                                      | Fiber                                                       |
| Provider/transcript-specific recovery                                                               | Fiber with custom recovery                                  |
| Wake a named Agent method at a calendar time or cron cadence                                        | schedule                                                    |
| Separate managed workflow service, cross-service orchestration, dashboard, or very large step count | Cloudflare Workflows through `AgentWorkflow`                |
| Remote service already owns a long-running job                                                      | Fiber that starts and polls, or callback plus durable state |

Fibers do not remove the value of Cloudflare Workflows. They provide Agent-local durable execution with direct access to host state and methods. Workflows provide an independent managed execution service and binding.

## Sub-agents and facets

A top-level Lifecycle can atomically commit a Fiber run and its armed deadline
because the run rows and the alarm live in one Durable Object. A facet has
isolated storage but no independent physical alarm: the root Lifecycle owns
the only alarm, so a child's Fiber deadlines must reach the root.

The shipped Lifecycle routing service (`lifecycle.routes`) is the channel for
this: a child capability sends capability-owned messages to the root, the root
indexes child deadlines into its own contribution, and root alarm dispatch
routes wakes back down — extending the current Agent pattern where the root
indexes active facet Fibers and routes recovery scans to the child.

The exact acceptance protocol crosses two storage jurisdictions and cannot be
one SQLite transaction, so it needs a prepare/confirm design with bounded
expiry for orphaned records on either side. That design is deferred: facet-
hosted Fibers are out of scope for the first releases, and the protocol should
be specified against real facet requirements before implementation.

## Compatibility and migration

### Existing APIs remain initially

The first release adds `agents/fibers` and moves implementation behind the capability. It does not immediately deprecate:

- `runFiber()`;
- `startFiber()`;
- `inspectFiber()` and `inspectFiberByKey()`;
- `listFibers()`;
- `cancelFiber()` and `cancelFiberByKey()`;
- `deleteFibers()`;
- `resolveFiber()`;
- `stash()`;
- `onFiberRecovered()`.

Deprecating before Think, AIChatAgent, Pi, messenger delivery, sub-agents, and recovery tests migrate would trade API neatness for regressions.

### Legacy raw Fiber adapter

Current `runFiber(name, closure)` accepts a closure that cannot be reconstructed after restart. Compatibility mode registers one internal definition, not one recoverable user definition per call:

```text
__cf_internal_legacy_fiber
```

Its persisted input contains the historical name and run metadata. During live execution it invokes the supplied closure. On interruption its custom recovery callback invokes the existing `onFiberRecovered()` hook with the old context shape.

```ts
async runFiber<T>(
  name: string,
  fn: (context: FiberContext) => Promise<T>
): Promise<T> {
  return this.fibers.internal_runLegacy(name, fn);
}
```

The compatibility adapter preserves:

- direct return value while the caller remains alive;
- `stash()` checkpoints;
- existing internal snapshot wrappers;
- custom `onFiberRecovered()` semantics;
- default warning behavior;
- facet recovery routing;
- current observability events during the migration period.

### Managed Fiber adapter

`startFiber()` maps to a retained legacy Fiber run:

```ts
async startFiber(
  name: string,
  fn: (context: FiberContext) => Promise<void>,
  options?: StartFiberOptions
): Promise<StartFiberResult> {
  return this.fibers.internal_startLegacy(name, fn, options);
}
```

Existing inspection APIs project `FiberRunSnapshot` back into the old `FiberInspection` type. Existing status names map as follows:

| Current       | New capability state                                |
| ------------- | --------------------------------------------------- |
| `pending`     | `pending`                                           |
| `running`     | `running`                                           |
| `completed`   | `completed`                                         |
| `aborted`     | `cancelled`                                         |
| `interrupted` | `recovering` or retained compatibility interruption |
| `error`       | `failed`                                            |

`resolveFiber()` applies a compatibility recovery decision to a retained legacy run.

### `stash()`

During a new replay Fiber step:

```ts
this.stash(value);
```

may delegate to the active `FiberStepAttempt.checkpoint(value)` for compatibility. New public examples should use the explicit step attempt callback:

```ts
await step.do("operation", ({ checkpoint }) => {
  checkpoint(value);
  return operation();
});
```

During a legacy Fiber it behaves exactly as today.

### Potential later deprecations

After full internal migration and at least one stable release:

- `startFiber()` can be replaced by `fiber.run()` plus common inspection.
- `inspectFiber*`, `listFibers`, `cancelFiber*`, and `deleteFibers` can be replaced by `this.fibers` methods.
- `onFiberRecovered()` can be replaced by recovery callbacks attached to named definitions.
- raw `runFiber()` may remain as an advanced compatibility API for ad hoc closures, or become deprecated in favor of named definitions.
- `queue()` may become a one-step Fiber compatibility adapter once FIFO and concurrency behavior are specified.

`keepAlive()` and scheduling remain separate concepts. `AgentWorkflow` remains the Cloudflare Workflows integration.

No deprecation should occur solely because a new abstraction exists. It should require behavioral parity, migration docs, and evidence from Think, AIChatAgent, Pi, and real applications.

## Package boundaries

### `agents/fibers`

Framework-neutral durable execution:

```text
packages/agents/src/fibers/
  index.ts
  capability.ts
  definition.ts
  run-store.ts
  replay-step.ts
  serialization.ts
  duration.ts
  errors.ts
  types.ts
```

It may import `agents/lifecycle` internals and Workers types. It must not import the AI SDK, Think, or AIChatAgent.

### `agents/fibers/ai`

Optional AI SDK adapters:

```ts
export interface FiberToolOptions<Input> {
  description: string;
  inputSchema: FlexibleSchema<Input>;
  wait?: {
    timeout: number | FiberDurationString;
    onTimeout: "return-receipt" | "fail";
  };
  /** Defaults to false so accepted work survives turn cancellation. */
  cancelOnAbort?: boolean;
}

export type FiberToolResult<Output extends FiberValue> =
  | { kind: "receipt"; receipt: FiberReceipt }
  | { kind: "result"; result: Output };

export function fiberTool<Input, Output extends FiberValue>(
  fiber: Fiber<Input, Output>,
  options: FiberToolOptions<Input>
): Tool<Input, FiberToolResult<Output>>;

export function fiberStatusTool(
  fibers: Fibers<LifecycleObject>,
  options?: { description?: string }
): Tool<{ runId: string }, FiberRunSnapshot<FiberValue> | null>;

export function fiberCancelTool(
  fibers: Fibers<LifecycleObject>,
  options?: { description?: string }
): Tool<{ runId: string; reason?: string }, { cancelled: boolean }>;
```

This entry point guards the optional AI dependency. The core package stays usable in plain Durable Objects.

### Root `agents`

The root exports the built-in `Agent#fibers` property and compatibility types. Users who want the capability class or plain Lifecycle integration import from `agents/fibers`.

### Think and AIChatAgent

These packages import only Fiber types and use the `Agent#fibers` instance. Their chat adapters remain in `agents/chat` or their owning package.

## Observability

Suggested events:

```ts
type FiberObservabilityEvent =
  | {
      type: "fiber:accepted";
      runId: string;
      definition: string;
      accepted: boolean;
    }
  | {
      type: "fiber:attempt:started";
      runId: string;
      definition: string;
      attempt: number;
    }
  | {
      type: "fiber:attempt:interrupted";
      runId: string;
      definition: string;
      attempt: number;
      step?: string;
    }
  | {
      type: "fiber:recovery:started";
      runId: string;
      definition: string;
      attempt: number;
    }
  | {
      type: "fiber:recovery:decided";
      runId: string;
      definition: string;
      action: string;
    }
  | { type: "fiber:step:started"; runId: string; step: string; attempt: number }
  | {
      type: "fiber:step:retry";
      runId: string;
      step: string;
      attempt: number;
      nextAt: number;
    }
  | {
      type: "fiber:step:completed";
      runId: string;
      step: string;
      attempt: number;
      elapsedMs: number;
    }
  | { type: "fiber:waiting"; runId: string; reason: string; wakeAt: number }
  | {
      type: "fiber:completed";
      runId: string;
      definition: string;
      elapsedMs: number;
    }
  | { type: "fiber:failed"; runId: string; definition: string; error: string }
  | {
      type: "fiber:cancelled";
      runId: string;
      definition: string;
      reason?: string;
    }
  | { type: "fiber:deleted"; runId: string; definition: string };
```

Safe fields include run ID, definition, step name, attempt, status, timing, and typed error name. Do not emit inputs, results, checkpoints, arbitrary metadata, secrets, or raw external errors by default.

Fibers publishes these through the Lifecycle capability events service, which stamps its stable capability identity on every event.

## Security and tenancy

- Fiber IDs are opaque and unguessable by default.
- A run is reachable only through its owning Durable Object or Agent API.
- Tool adapters must not make a run globally addressable.
- Host authorization protects run inspection and cancellation.
- Inputs and metadata may contain customer data and remain in the host's SQLite jurisdiction.
- Error and observability projections exclude secrets.
- Custom recovery must not trust checkpoint data without parsing it. Checkpoints may have been written by older code.
- Definition names are developer-controlled and safe to expose in diagnostics, but not automatically to end users.
- Retention defaults must be documented. Terminal records should not remain forever without an explicit policy.

## Limits

Proposed initial limits, subject to validation:

- 1 MiB per serialized input, checkpoint, step result, and final result;
- 8 KiB status metadata;
- 10,000 named steps per run;
- 5 minute default step timeout;
- 5 attempts per step by default;
- bounded alarm batch size and concurrency;
- finite default recovery retry age;
- finite list and delete limits;
- stable step names no longer than a documented maximum;
- no concurrent `step.do()` in v1 unless explicitly proven and tested;
- no cross-host transaction guarantee for facets, using the routed preparation protocol described above.

These are SDK policy limits and may differ from broader platform limits.

## Testing plan

### Unit and type tests

- Fiber input and output inference.
- `create(name, run)` and `create(name, run, recover)` overloads.
- Duplicate and reserved definition names.
- Duration parsing.
- retry and timeout policy parsing.
- JSON serialization and size limits.
- recovery decision exhaustiveness.
- old-to-new status projections.

### Lifecycle Workers tests

Use real workerd Durable Object SQLite and alarms. The existing
alarm-arbitration suite already proves the shared-alarm invariants (single
`setAlarm` owner, earliest contribution wins, exclusive destroy, host and
capability coexistence). Fibers adds:

- a Fiber deadline and a schedule arm the earlier of the two.
- moving a Fiber deadline later does not delay a schedule, and vice versa.
- settling every Fiber run does not delete another capability's alarm.
- run acceptance and its alarm arm commit together; startup reconciliation
  re-arms a committed run whose alarm write was lost.
- a bounded `onAlarm()` batch leaves remaining due runs armed.
- an interrupted attempt's claim deadline wakes the object and the run is
  reclaimed under a fresh generation.

### Fibers Workers tests

- durable acceptance before receipt.
- same idempotency key returns the same run.
- key reuse under a different definition fails.
- warm execution and alarm execution cannot double-claim.
- completed step returns its persisted result on replay.
- an interrupted step retries by default.
- clean step rejection follows retry policy and does not invoke custom recovery.
- custom recovery is invoked after unclean interruption.
- each recovery decision settles or reschedules correctly.
- recovery interruption retries recovery idempotently.
- sleep uses its first recorded deadline.
- status live gate suppresses old replayed progress.
- cancellation fences late completion.
- attempt timeout aborts the signal.
- late old-generation writes are rejected.
- missing definition and replay divergence are visible failures.
- retained and non-retained terminal cleanup.

### Agent integration tests

- `this.fibers` is installed once.
- user definitions are registered before startup locks.
- runs started from `onStart`, `onMessage`, HTTP, RPC, and schedules.
- existing schedules and Fiber deadlines coexist.
- keep-alive and Fiber deadlines coexist.
- deferred destroy preempts normal work without losing records.
- observability events carry safe fields.

### Facet tests

- child acceptance survives parent and child interruption windows.
- root Lifecycle dispatch routes to the owning child.
- child sleep and retry move the root deadline.
- terminal child cleanup is idempotent.
- deleting a child removes routed work.
- nested child owner paths route correctly.
- no independent child physical alarm is assumed.

### Think, AIChatAgent, and Pi tests

Preserve current recovery contracts:

- every Think turn entry path creates the internal chat Fiber.
- process loss invokes the definition's custom recovery callback.
- persisted partial output is reconstructed.
- settled tools do not rerun.
- pending client interactions remain parked.
- retry and continuation share incident budgets.
- provider resume checkpoints are restored before fallback.
- messenger replies recover through their own definition.
- recovery happens after framework state initializes and before user `onStart`.
- durable submissions reach the same terminal outcome.
- Pi and TanStack fixtures prove the capability is not coupled to AI SDK message types.

### End-to-end kill tests

Use a real Wrangler process and persistent local storage:

1. start a replay Fiber;
2. wait until a selected step begins;
3. SIGKILL the process;
4. restart with the same persistence directory;
5. verify completed steps do not rerun and the interrupted step does;
6. verify final result and no orphan work records.

Repeat for:

- custom recovery completion;
- custom recovery replay;
- interruption during recovery;
- sleep;
- cancellation;
- concurrent independent runs;
- a Think streaming turn;
- a sub-agent Fiber routed through the root Lifecycle.

## Rollout plan

### Phase 0: contracts (already shipped)

Alarm arbitration, capability contributions, capability identity, and the
host-context aperture shipped with the Lifecycle extraction, with the
Scheduler as the working precedent. No new Lifecycle surface is required
before Phase 1.

### Phase 1: replay Fibers

- add `agents/fibers`;
- implement definitions, run acceptance, journaled `do`, sleep, retries, status, inspection, cancellation, and retention;
- install `this.fibers` on Agent;
- ship a plain Lifecycle Object example and an Agent example.

### Phase 2: custom recovery

- add the third `recover` argument and decisions;
- add checkpoints and interruption detection;
- harden recovery retry budgets and observability.

### Phase 3: compatibility adapters

- move current Fiber storage and scanner behind `Fibers`;
- delegate `runFiber()`, `startFiber()`, `stash()`, and inspection APIs;
- preserve existing behavior and events.

### Phase 4: framework migration

- migrate Think chat turns;
- migrate AIChatAgent chat turns;
- migrate Think messenger replies;
- migrate Pi and TanStack recovery fixtures;
- remove direct Fiber-table reads and central name switches.

### Phase 5: optional adapters and API review

- add `agents/fibers/ai` tool adapters;
- evaluate queue compatibility;
- evaluate deprecations only after migration evidence;
- decide whether Cloudflare Workflows can implement the same `Fiber` definition contract as an alternate backend.

## Alternatives considered

### Keep replay tasks separate from Fibers

This avoids disturbing working chat recovery. It also duplicates durable acceptance, status, cancellation, interruption detection, alarms, retention, and observability. Users must learn which durable execution product to choose. Rejected if the shared capability can preserve current behavior.

### Public strategy tag

```ts
fibers.create(name, { strategy: "replay", run });
fibers.create(name, { strategy: "custom", run, recover });
```

The tag repeats information already expressed by the optional recovery callback and suggests two unrelated run systems. Rejected.

### Put recovery inside `step.do()` configuration

This makes the happy path noisy and gives every operation a second nested callback. Think recovers a whole turn from transcript and stream state rather than a generic typed step value. Rejected for v1.

### One Fiber capability per definition

This gives each Fiber its own lifecycle hook and storage ownership. It increases startup work, table coordination, and alarm competition, and makes cross-definition inspection awkward. Rejected. One `Fibers` capability owns many lightweight definitions.

### Write closures as dynamic methods on the host

A hidden method such as `__cf_fiber_report` could be added to `this`. This expands the Agent RPC and reflection risk, can collide with user methods, and is harder to lock. A private registry owned by `Fibers` gives the same reconstruction behavior without mutating the host's method set. Rejected.

### Let Fibers own the physical alarm

This conflicts with schedules, keep-alive, facet recovery, deferred destroy, and other capabilities. It violates the one-alarm constraint. Rejected. Lifecycle owns the physical alarm; Fibers contributes deadlines.

### Central Lifecycle work dispatcher

The original version of this RFC proposed a Lifecycle-owned `cf_lifecycle_work` trigger table with claim, lease, and generation columns, a `LifecycleWorkScheduler` service with a transaction seam, and an `onWork()` dispatch hook. Rejected in favor of the shipped contribution model:

- it duplicates state — a run's wake time would live in `cf_fiber_runs.next_at` and `cf_lifecycle_work.due_at`, and since the capability remains the authority for whether work is needed, the trigger row is a non-authoritative index requiring reconciliation;
- fencing would exist twice, per trigger row and per run, while the run-level generation is required regardless because warm-path attempts never pass through a dispatcher;
- lease-based hang detection restates what the Scheduler already does at the domain level with claim deadlines surfaced through `getNextAlarm()`;
- it would re-architect alarm arbitration that shipped and is regression-tested, in the same release that ships a large new capability.

Worth revisiting only if a future capability without domain deadline tables needs durable payload-carrying triggers.

### `create()` handles instead of a constructor definitions map

The original proposal registered definitions imperatively — `readonly report = this.fibers.create(name, run, recover?)` — returning typed handle fields, with the registry locked once Lifecycle startup began. Rejected in favor of a constructor `definitions` map:

- the every-wake registry guarantee relied on an enforcement rule users could trip over — `create()` after the lock threw, and the lock landed before even the host's own `onStart`, which runs after capability startup;
- a constructor map makes the guarantee structural: the definitions are the constructor options, rebuilt by construction on every wake, with nothing to register at the right moment;
- it matches the Scheduler's `callbacks` idiom, so the two capabilities read identically at the composition root;
- typed per-definition handles survive as pure `fibers.handle(name)` lenses, creatable at any time because they hold no registration state;
- framework-internal definitions (the Think chat turn, messenger replies, the legacy Fiber adapter) attach through an internal composition-root resolver aperture — mirroring the Scheduler's callback-name resolver — instead of occupying the host's map.

### Use Agent schedules for every Fiber wake

This can bootstrap a prototype, but it couples plain Lifecycle Fibers to Agent scheduling, stores internal run wakes as user schedules, and cannot give Lifecycle one final alarm authority. Rejected as the final architecture. The Scheduler already contributes its own deadlines; Fibers contributes alongside it rather than storing run wakes as user schedules.

### One Durable Object per Fiber run

This matches `durable-mcp-server` and gives each run isolated storage and an alarm. It adds a binding and object hop, separates task state from the owning Agent, complicates facets and tenancy, and loses direct transactions with Agent state. Rejected for Agent-local Fibers. It remains a valid architecture for stateless protocol servers.

### Always replay, with no custom recovery

Simple and correct for normal tasks. Unsafe or insufficient for model streams and harnesses with partial durable output, settled tool calls, provider resumption, and recovery budgets. Rejected.

### Custom recovery only, no step replay

This preserves current Fibers but leaves application authors manually implementing phase state machines and checkpoints. It fails the ergonomic goal demonstrated by `durable-mcp-server`. Rejected.

## References

- Cloudflare Agents SDK current Fiber implementation: [`packages/agents/src/index.ts`](https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts), including `runFiber`, `startFiber`, `_checkRunFibers`, and `_handleInternalFiberRecovery`.
- Current durable-execution guide: [`docs/agents/durable-execution.md`](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md).
- Current Lifecycle implementation: [`packages/agents/src/lifecycle`](https://github.com/cloudflare/agents/tree/main/packages/agents/src/lifecycle).
- Accepted Lifecycle RFC: [`design/rfc-durable-object-lifecycle.md`](./rfc-durable-object-lifecycle.md).
- Alarm arbitration as shipped: [`design/alarm-coordination.md`](./alarm-coordination.md) and [`design/durable-object-lifecycle.md`](./durable-object-lifecycle.md).
- Shared chat recovery architecture: [`design/rfc-chat-recovery-foundation.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-chat-recovery-foundation.md).
- Think chat Fiber wrapper and recovery adapter: [`packages/think/src/think.ts`](https://github.com/cloudflare/agents/blob/main/packages/think/src/think.ts).
- Pi recovery validation host: [`experimental/pi-recovery/src/pi-agent.ts`](https://github.com/cloudflare/agents/blob/main/experimental/pi-recovery/src/pi-agent.ts).
- Durable MCP Tasks implementation and design: [`mattzcarey/durable-mcp-server`](https://github.com/mattzcarey/durable-mcp-server), especially `packages/durable-mcp-server/src/do/task-runner.ts`, `src/step/replay-step.ts`, and `docs/how-it-works.md`.
- Upstream durability library: [`avenceslau/durability`](https://github.com/avenceslau/durability), including the Durable Object-local workflow proposal in [PR 26](https://github.com/avenceslau/durability/pull/26).
- Cloudflare Workflows documentation: [developers.cloudflare.com/workflows](https://developers.cloudflare.com/workflows/).

## Open questions

1. Should the positional API be the only `create` form, or should configuration such as schema and default retry policy justify an object overload before release?
2. Should definition versions remain part of the name, or should `create` accept a separate required version that becomes part of the persisted key?
3. Should custom recovery be allowed to inject a typed result for an interrupted step and then replay, or should v1 keep only whole-Fiber decisions?
4. What exact state should a run enter when its definition is absent after deployment?
5. Should clean handler errors outside steps fail immediately or receive a Fiber-level retry policy?
6. What default retention applies to user Fibers and internal framework Fibers?
7. What maximum serialized value and step count fit current SQLite and memory constraints?
8. Should v1 support concurrent `step.do()` calls?
9. How should a caller wait for completion without holding a Durable Object input gate or leaking waiters?
10. Should Lifecycle work dispatch happen before or after the host's semantic `onAlarm()` hook? — Resolved by the shipped Lifecycle: capability `onAlarm()` runs before the host's semantic hook, and one rearm follows both.
11. How does Lifecycle work coexist during a staged migration with Agent's current custom `alarm()` method? — Resolved: there is no separate work dispatcher; Agent's alarm sources already coexist as contributions.
12. What is the exact two-phase routed-work protocol for facets, and what expiry applies to prepared root triggers?
13. Should recovery retry indefinitely for retained runs, or always have a finite default age?
14. Which existing Fiber observability event names must remain stable for downstream consumers?
15. Does the AI tool adapter cancel its Fiber when the tool aborts, or does detachment remain the default? Recommendation: detachment by default, explicit `cancelOnAbort` option.

## Decision

Accepted with one amendment. The architectural direction:

- one `Fibers` lifecycle capability per host;
- many named definitions declared in the constructor `definitions` map (amended from `fibers.create()` handles); custom recovery attaches as a `{ run, recover }` map value when Phase 2 lands;
- replay from the beginning for every execution attempt;
- memoized named steps and durable sleeps;
- optional Fiber-level recovery callback beside the main callback;
- no public strategy tag;
- Lifecycle keeps sole ownership of the physical alarm; Fibers integrates
  through the shipped alarm-contribution model (`getNextAlarm()` /
  `onAlarm()` / `alarms.rearm()`) exactly as the Scheduler does, instead of
  the originally proposed central work dispatcher (see Alternatives
  considered);
- compatibility migration before deprecation;
- Think retains specialized chat recovery policy through a named internal Fiber definition.

The first implementation PR is a Phase 1 subset — replay Fibers only, without
custom recovery or legacy adapters — so the change stays reviewable.
