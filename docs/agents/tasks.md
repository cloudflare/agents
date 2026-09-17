# Tasks

> **Experimental.** Everything exported from `agents/tasks` and
> `agents/state-machine` may change between releases while the durable
> execution surface stabilizes.

`agents/tasks` adds durable programs to a [Lifecycle Object](./lifecycle.md).
One `Tasks` capability owns any number of named definitions, and a
definition can be written **two ways on one engine**:

- a **durable job** — today's Workflows-shaped function,
  `(input, step) => result`, replayed from its first line with journaled
  steps and durable sleeps; a job has a beginning and an end;
- a **durable actor** — a state machine, `{ initial, phases }`, whose
  handlers receive the durable checkpoint and return the next one; an actor
  has an address, a mailbox, and no end until it says so.

Both survive process loss, deployments, and hibernation. The engine itself
ships as [`agents/state-machine`](./state-machine.md); `Tasks` is that
engine plus the job form, under the `Task` vocabulary this page uses.

The capability never touches the Durable Object's physical alarm. Every
non-terminal run's wake is mirrored as one job in the Lifecycle work queue,
and Lifecycle derives the single physical alarm from queue state — so Tasks,
the [Scheduler](./scheduling.md), and other capabilities coexist on the same
object. A run parked on its mailbox, an ask, or a child holds no alarm at
all.

## Install and define

Declare definitions in the constructor — like `Scheduler` callbacks — and
install the capability with the lifecycle:

```ts
import { DurableObject } from "cloudflare:workers";
import { Tasks, type TaskStep } from "agents/tasks";
import { Lifecycle } from "agents/lifecycle";

interface ReportInput {
  reportId: string;
  topic: string;
}

export class ReportObject extends DurableObject<Env> {
  readonly tasks = new Tasks({
    definitions: {
      "build-report@v1": async (input: ReportInput, step: TaskStep) => {
        await step.status("Researching");

        const research = await step.do(
          "research",
          { retries: { limit: 4, delay: "2 seconds", backoff: "exponential" } },
          ({ signal }) => this.research(input.topic, { signal })
        );

        await step.sleep("editorial-delay", "30 seconds");
        await step.status("Publishing");

        const objectKey = `reports/${input.reportId}.json`;
        await step.do("publish", ({ idempotencyKey }) =>
          this.publish(objectKey, research, { idempotencyKey })
        );

        return { reportId: input.reportId, objectKey };
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.tasks);
}
```

The constructor map is the registry. Storage persists only the definition
name, and the map is rebuilt on every Durable Object wake, so recovery of
in-flight runs is correct by construction — there is nothing to register at
the right moment and no lock to trip over. Handlers are ordinary arrows that
capture `this`. Version the name (`"build-report@v2"`) instead of changing an
in-flight definition's step layout; [Versioning](#versioning) below says what
happens to the runs that are already in flight.

## On an Agent

`Agent` installs the capability automatically as `this.tasks` (experimental).
Declare definitions on the overridable `taskDefinitions` field — the same
every-wake rebuild guarantee, resolved lazily so field order never matters:

```ts
import { Agent } from "agents";
import type { TaskHandlers, TaskStep } from "agents/tasks";

export class ReportAgent extends Agent<Env> {
  override readonly taskDefinitions = {
    "build-report@v1": async (input: ReportInput, step: TaskStep) => {
      // ...same step API; handlers run in the Agent's invocation context,
      // so getCurrentAgent() works throughout.
    }
  } satisfies TaskHandlers;
}
```

`taskDefinitions` is typed `TaskDefinitions`, so a machine declared on it
(type the map `satisfies TaskDefinitions` when it mixes both forms) reaches
the engine the same way. Task wakes share the Agent's
physical alarm with schedules, keep-alive, and the rest of the Agent's
durable work through the Lifecycle job queue. Internally, Agent's own chat
frameworks (Think, AIChatAgent, and Think's messenger replies) run their
turns on this same capability.

## Starting runs

```ts
const receipt = await this.tasks.run("build-report@v1", input, {
  idempotencyKey: `report:${input.reportId}`
});
```

`run()` durably accepts the work and returns a receipt without waiting for
completion. The same `idempotencyKey` (or a caller-selected `runId`) joins
the existing run instead of creating a second one; `accepted: false` on the
receipt marks that join. Pass `metadata` to retain JSON alongside the run and
`retain: false` to remove the record after terminal settlement.

`start` chooses who drives the first attempt: `"warm"` (the default) begins
it at once in the accepting invocation, `"queued"` leaves it to the next
wake, and `"attached"` drives it in the caller's invocation and resolves at
its next durable boundary — a step boundary, a park, or the end.

Two options bound a run. `interruptions` is the run's policy for _interrupted_
attempts — an attempt whose isolate died mid-execution and is being
reclaimed — and it takes the same `{ limit, delay, backoff }` shape as a
step's, with the same meanings: `limit` is total attempts including the
first, `delay` and `backoff` space the replays out durably, and fields left
unset fall back to the capability's step `retries` defaults. The count is
consecutive — an attempt that reaches a durable boundary under its own
power clears it — so a run is failed only for dying repeatedly, never for
having survived a deploy days ago. A wake from a sleep or a step retry park
is not an attempt and costs nothing. The interruption that reaches `limit`
fails the run with `TaskInterruptionsExhaustedError` instead of replaying it
again. Omitted, an interruption replays immediately, without bound.
`deadline` (epoch milliseconds or a `Date`) is a wall-clock bound: a live
attempt's `step.signal` aborts and the run fails with
`TaskDeadlineExceededError`; a parked run is woken at the deadline and fails
there. `turnTimeout` bounds one transition of an actor (see
[Abort and deadlines](#abort-and-deadlines)).

```ts
await this.tasks.run("build-report@v1", input, {
  interruptions: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  deadline: Date.now() + 60 * 60 * 1000
});
```

`run()`, `handle()` and `at()` type the definition name and its input
against the declared map. A handle is a typed lens scoped to one definition
— its `run`, `get`, `getByIdempotencyKey`, and `cancel` see only that
definition's runs — and `at(name, runId)` is a typed handle on one run:

```ts
const buildReport = this.tasks.handle("build-report@v1");
const run = await buildReport.get(receipt.runId); // result typed by the map
const one = this.tasks.at("build-report@v1", receipt.runId);
await one.cancel("superseded");
```

On an actor definition the lens and the run handle also carry `send`,
`view` and `watch`, typed by the machine; on a job definition those members
are `never` — uncallable — because a job has no mailbox to send to.

Inputs, step results, metadata, and final results must be JSON-serializable
and at most 1 MiB serialized.

## Durable jobs: the step API

| Method                                       | Behavior                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `step.do(name, config?, cb)`                 | Run a named step once; journaled results replay without re-executing. `config` sets `retries` and `timeout`.        |
| `step.sleep(name, duration)`                 | Persist a wake deadline and suspend; no isolate stays resident while waiting.                                       |
| `step.sleepUntil(name, when)`                | Sleep until a wall-clock time.                                                                                      |
| `step.waitForEvent(name, { type, timeout })` | Park until `tasks.sendEvent(runId, { type, payload })` delivers a matching event; the event is journaled once.      |
| `step.status(message)`                       | Update observable progress; replays stay silent over old ground.                                                    |
| `step.idempotencyKey(name)`                  | The stable external deduplication key `step.do(name, …)` receives.                                                  |
| `step.signal`                                | Aborts for the whole attempt on `cancel()` and at the run's `deadline`, for work awaited outside a step.            |
| `step.attempt`                               | This execution's claim number: 1 on the first, one higher on every later claim — replay, sleep or retry wake alike. |

Each `do` attempt receives `{ attempt, idempotencyKey, signal }`. The signal
aborts on cancellation and on the attempt timeout (default 5 minutes); a
callback that ignores it still loses the attempt, and a stale attempt's late
writes are rejected. Work awaited in the handler body rather than in a step
has no step timeout; `step.signal` is how it learns the attempt is over: it
aborts on `cancel()` and when the run's `deadline` passes. A body that
ignores it runs on as a zombie whose writes the generation fence rejects.

A callback that throws retries on a durable delay (default: 5 attempts,
exponential backoff). Throw `NonRetryableError` to fail the run immediately.

`waitForEvent` is the Workflows verb for one shape of the mailbox below:
`tasks.sendEvent(runId, { type, payload, requestId? })` is
`tasks.send(runId, payload, { kind: "event", type, requestId })`. An event
sent before the handler reaches the wait is buffered durably and delivered
when it gets there; a `timeout` that passes fails the run with
`TaskEventTimeoutError`.

> **Where this differs from Cloudflare Workflows.** A run has no
> `waitForCompletion`: `start: "attached"` resolves at the next durable
> boundary, not at the end. There is no `pause`/`resume` window on a live
> step — `pause()` takes effect at the next boundary. And `sendEvent` never
> throws on a terminal run: the receipt says `accepted: false`.

### Replay semantics

On every execution attempt the handler runs again from its first line.
Therefore:

- put every externally visible side effect inside a `step.do()`;
- keep code between steps deterministic and cheap — capture `Date.now()` or
  randomness as a step result before branching on it;
- give loop steps stable names (`` `import:${index}` ``);
- treat execution as at-least-once: an interrupted step runs again, so pass
  the attempt's `idempotencyKey` to external systems that support
  deduplication.

If a replay observes a journal its code cannot have written — a known step
name under a different kind, or a name used twice — the run fails with a
`TaskReplayDivergedError` or `DuplicateTaskStepError` rather than guessing.
A run whose definition name is no longer registered after a deployment fails
with a `MissingTaskDefinitionError`; it is never silently deleted or run
against a different handler.

### Interruption and replay

There is no separate recovery mode: an unclean interruption — an attempt
claimed by an isolate that died — simply replays the handler on the next
wake. Completed steps return journaled results, sleeps consult their
persisted deadlines, and durable state carries everything else. Two
patterns make replay safe for irreversible effects:

- **Idempotency keys.** Every step attempt receives a stable
  `idempotencyKey` (identical across attempts and replays); pass it to the
  external service so a repeat of the same step deduplicates:

  ```ts
  "capture-payment@v1": async (input: PaymentInput, step: TaskStep) => {
    return step.do("capture", ({ idempotencyKey }) =>
      this.payments.capture(input, { idempotencyKey })
    );
  }
  ```

- **Durable evidence.** When progress lives in durable state — a
  [stream](./streams.md)'s cursor, a rows-written count — read it at the
  top of the work and resume from it. A producer that starts its loop at
  `stream.cursor` never duplicates a chunk, no matter how many times it
  replays.

The interrupted step itself is first-class evidence: `step.interrupted`
is `{ name, attempt }` when the previous attempt's isolate died
mid-execution (and `null` on a clean attempt), so a handler can branch
before re-entering irreversible work:

```ts
"send-report@v1": async (input: ReportInput, step: TaskStep) => {
  if (step.interrupted?.name === "deliver") {
    // the delivery may or may not have left the building — check first
  }
  ...
}
```

A step callback that throws is not an interruption; the step's retry policy
owns it, with the run parked `waiting` between attempts. Interruptions also
emit a `task:attempt:interrupted` event carrying the same step name.

Replays are immediate and unbounded unless the run carries an
`interruptions` policy. With one, each interruption parks the run `waiting` (reason
`interrupted`) for its backoff before replaying, and a run whose attempts
keep dying — a deterministic crash, a body that never settles — fails with
`TaskInterruptionsExhaustedError` at `limit`, without running the handler again.
Only consecutive deaths spend that budget: an attempt that gets as far as a
sleep or a step retry park clears the count. `step.attempt`, by contrast,
counts every claim including those parks, so it is a replay counter rather
than the budget.

Every terminal failure reaches the constructor's `onError(error, run)`,
including the ones Tasks records without running a handler: a missing
definition, a spent interruption retry budget, a passed deadline. `run`
names the `runId` and `definition`, so a host that keeps its own record of
the work can settle it.

## Durable actors: the machine

A machine is `initial` plus one `(state, ctx) => next` handler per phase,
keyed by the state union's `phase` discriminant. The handler receives the
durable checkpoint, does work, and returns the next checkpoint — **returning
is the commit**, one fenced row write — or a terminal from `ctx.complete`,
`ctx.fail`, or `ctx.aborted`.

```ts
import {
  defineAsk,
  type TaskMachine,
  type TaskDefinitions
} from "agents/tasks";

type OrderState =
  | { phase: "placed"; sku: string; qty: number }
  | { phase: "approving"; sku: string; qty: number; ask: { id: string } }
  | { phase: "charged"; charge: string };

const Approval = defineAsk<{ sku: string; qty: number }, boolean>("approval");

export const order = {
  initial: (seed: { sku: string; qty: number }): OrderState => ({
    phase: "placed",
    ...seed
  }),
  phases: {
    placed: async (state, ctx) => {
      if (state.qty < 10)
        return { phase: "charged", charge: await charge(state) };
      const [ask] = ctx.ask(Approval, [{ sku: state.sku, qty: state.qty }], {
        expiresIn: "2 days"
      });
      return { ...state, phase: "approving", ask: { id: ask?.id ?? "" } };
    },
    approving: async (state, ctx) => {
      const answers = await ctx.answers([state.ask], { within: "2 days" });
      if (answers === ctx.timedOut || answers[0] !== true) {
        return ctx.fail(new Error("not approved"));
      }
      return { phase: "charged", charge: await charge(state) };
    },
    charged: async (state, ctx) => ctx.complete(state.charge)
  },
  onCancel: async (state, ctx) => {
    if (state.phase === "charged") await refund(state.charge);
    return ctx.aborted("cancelled by the customer");
  }
} satisfies TaskMachine<
  OrderState,
  never,
  string,
  { sku: string; qty: number }
>;
```

Annotate every machine `satisfies TaskMachine<State, Mailbox, Result, Seed>`.
It is what narrows each handler's `state` to its own phase, rejects an
unknown phase key, and types `ctx` — the mailbox payload, the result the
terminals take, the seed `initial` receives. A map of parameterless handlers
that omits it still compiles, with every handler's state read as `never`; a
lint rule to catch that is planned, and until it lands the annotation is a
review-time rule.

`initial` may be a value or a function of the run's seed (`run()`'s input).
It is evaluated on the first dispatch and committed as turn 0, so a park in
the first phase — and `onCancel` after it — always has a checkpoint to read.
A checkpoint is JSON of at most 256 KiB; anything larger, or anything
without a JSON form, fails the run with `TaskCheckpointTooLargeError` or
`TaskSerializationError` rather than being silently dropped.

`onCancel` is optional. A machine without it gets the inline default a job
gets (below); a machine with it gets a **fresh invocation** running
`onCancel(state, ctx)` after the live transition is signalled and joined.
It may return a checkpoint — which clears the request and resumes the run —
or a terminal. It may not park: a wait inside it faults the run with
`TaskCancelCannotParkError`.

### The runtime

`ctx` **extends** `step`: the object a machine handler gets as `ctx` is the
same object a job gets as `step`, widened. `ctx.do`, `ctx.sleep`,
`ctx.status`, `ctx.signal`, `ctx.interrupted` and the rest of the step API
are available in a phase handler and behave identically — one journal, one
claim path, one abort protocol. Step names are scoped to the transition:
`do("charge")` in turn 1 and in turn 7 are two executions, and their
idempotency keys differ (`ctx.idempotencyKey(name, { scope: "run" })` asks
for one key across turns).

| Member                                        | Behavior                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.id`, `.definition`, `.version`, `.input` | The run's facts, as of this attempt's claim. `.turn`, `.progress`, `.children`, `.background`, `.metadata`, `.createdAt` beside them.                           |
| `ctx.receive(filter & { within? })`           | Take the oldest visible mailbox item matching the filter, or park. With `within`, returns `ctx.timedOut` when the wait expires.                                 |
| `ctx.receiveAll(filter & { within? })`        | Park until at least one item matches, then drain every match in one block.                                                                                      |
| `ctx.peek(filter)` / `ctx.peekAll(filter)`    | Read without consuming or parking. Zero writes.                                                                                                                 |
| `ctx.withdraw(key)`                           | Drop a still-queued item.                                                                                                                                       |
| `ctx.ask(kind, payloads, { expiresIn? })`     | Raise durable questions, one row each, synchronously; returns `Pending<A>[]` — `{ id }` objects that belong in the checkpoint of the phase that reads them.     |
| `ctx.answers(pending, { within?, mode? })`    | Park until every ask (`mode: "all"`, the default) or the first (`"any"`) is answered, expired or withdrawn; a lapsed ask reads as `undefined`.                  |
| `ctx.peekAnswers(pending)`                    | The answers already durable, without parking.                                                                                                                   |
| `ctx.memo(name, candidate?)`                  | A run-scoped value: the first write wins and every later attempt reads it. Use it for a request id, a random draw, a generated key.                             |
| `ctx.spawn(definition, input, options)`       | Accept a child run of this run. `background: true` detaches it: outside the cancel cascade, silent unless `notify: true`.                                       |
| `ctx.join(children, { within? })`             | Park until every named child has settled; returns `{ ok, output } \| { ok: false, error }` per child. `ctx.receive({ kind: "child" })` is the raw form.         |
| `ctx.stream(name?)`                           | Open (or resume) this run's engine-owned [stream](./streams.md) `name`. Needs the `streams` option on the capability.                                           |
| `ctx.heartbeat()`                             | Refresh the claim and the transition watchdog from a long transition that has nothing else to write.                                                            |
| `ctx.creditProgress(n?)`                      | Credit durable work the engine cannot see, so it counts as progress.                                                                                            |
| `ctx.complete(r)` / `.fail(e)` / `.aborted()` | The three terminals. `ctx.timedOut` is the unit value every `within` wait returns on expiry; `ctx.cancelling` is the abort mark inside `onCancel`, else `null`. |

**The mailbox.** `tasks.send(runId, payload, options)` appends one item
— `kind` (default `"message"`), optional `type`, `requestId` as a
deduplication key — and returns a receipt: `accepted: false` with a reason
for a duplicate `requestId`, a `drop` policy that found a match, or a
terminal run. A mailbox write never resurrects a run. Items are delivered
in the order they were sent, and an item sent before the handler reaches
its `receive` is buffered durably: there is no listener to register and no
race to lose a message to. `policy: "latest"` replaces every unconsumed
item of the same kind and type, `"drop"` writes nothing when one exists,
and `"debounce"` with `debounceMs` re-hides the same `requestId` until the
window passes. `tasks.withdraw(runId, key)` removes a still-queued item.
Past `mailboxLimit` (default 1000) items, `send` throws
`TaskMailboxFullError`.

| Reading mode                   | Parks?          | Row writes               |
| ------------------------------ | --------------- | ------------------------ |
| `receive(filter & { within })` | yes             | one delete when it takes |
| `peek(filter)`                 | no              | none                     |
| `peekAll(filter)`              | no              | none                     |
| `receiveAll(filter)`           | until ≥ 1, then | k deletes in one block   |

**Asks.** `tasks.answer(askId, kind, value)` needs only the ask id — the
run it belongs to is the prefix before `#` — and is applied exactly once:
a repeat, an expired or withdrawn ask, or an unknown id reads as a receipt,
not an error. The `kind` types the answer, so a wrong shape fails to
compile from any file. `tasks.withdrawAsk(askId)` withdraws one; a batch
with `expiresIn` lapses on its own, and the rows stay readable through
`tasks.asks({ runId, state })` and `view()` so a UI can show what was asked
and why it lapsed.

**Children.** A child is a run of another definition with this run as its
parent. When it settles, a note lands in the parent's mailbox
(`kind: "child"`, keyed by the child's run id) and wakes the parent if it
is parked on it. Cancelling a parent takes every in-tree child with it;
`background: true` children are detached and run on. Derive a child's
`runId` from durable state (`` `child:${state.turnSeq}:${i}` ``), never
from a counter. Children run on the parent's Lifecycle in this release;
cross-facet ownership (`spawn(..., { owner })`) is not wired yet.

**Streams.** `ctx.stream(name)` opens an engine-owned stream whose id is
`${runId}:${name}#${epoch}` and whose tag, `${runId}:${name}`, is stable
across epochs, so a UI following the tag sees continuous output. Returning
the next checkpoint from a transition that holds a live stream settles the
stream and writes the checkpoint in one transaction. A reclaim after an
interruption seals the lost attempt's stream and rotates the epoch. Chunks
appended count as progress; nothing is written per append. The capability
needs the `Streams` capability passed as `streams` in its options (and
installed on the same Lifecycle); `Agent` does not install one today, so
`ctx.stream()` on an Agent-hosted actor throws.

Timer primitives never touch `setAlarm`: every `within`, every ask expiry,
every sleep is the run's one wake, mirrored into the Lifecycle queue.

## One engine

A job is not a second engine. It compiles onto the machine as a single
phase whose handler is `ctx.complete(await fn(ctx.input, ctx))`, whose
checkpoint is a sentinel persisted as `NULL`, and whose turn is therefore
always 0 — which is what keeps every existing journal key and idempotency
key byte-identical to what shipped before. The declaration that makes this
literal is the type itself:

```ts
interface TaskContext<State, Mailbox, Result, Seed> extends TaskStep { … }
```

The job API is the state machine with less freedom. Everything that
follows applies to both forms; where a rule can only fire for a machine,
it says so.

## Progress and faults

After a phase handler settles, the engine re-reads the run row in the same
invocation and applies the first matching rule:

1. **Superseded** — another attempt owns the run: unwind, write nothing.
2. **Terminal** — `ctx.complete/fail/aborted`: one fenced settle.
3. **Platform failure** — rethrow; the claim backstop is the wake.
4. **Abort mark** — end the invocation; the abort protocol takes over.
5. **Parked** — a sleep, a retry, a mailbox, event, ask or child wait: one
   fenced write to `waiting`, same turn, journal intact.
6. **Application error** — settle `failed`.
7. **Checkpoint changed** — commit it, retire the previous turn's journal,
   and dispatch the next phase's handler in this same invocation.
8. **Checkpoint unchanged but progress made** — a step completed, a
   mailbox item consumed, a memo first-written, an ask answered, a stream
   advanced: commit the progress and dispatch the same phase again.
9. **Nothing changed** — a stall.

Two rules bound an actor that has stopped making progress, and they catch
different failures. **Rule A** (`stallLimit`, default 1): a transition that
changed no checkpoint, parked on nothing and credited nothing has made
none; at the limit the run fails with `TaskNoProgressError`. **Rule B**
(`transitionBudget`, default 1000): the number of transitions since the
last park; exceeding it fails the run with `TaskTransitionBudgetError`,
naming the phases it cycled through. Both record `outcome: "faulted"` on
the failed run and **keep the row even at `retain: false`** — a fault is
never silently deleted. A healthy handler that parks is never faulted,
because parks are decided above the stall rule. Neither rule can fire for
a job: its one phase returns a terminal or parks.

There is no recovery callback in either form. An interrupted transition
replays from the phase's first line, with `ctx.interrupted` naming the step
it died in and `ctx.memo` holding whatever it recorded.

## Abort and deadlines

Five causes set the run's abort mark: `cancel()`; the run `deadline`
passing; the per-transition **watchdog**, `turnTimeout` (on the
capability or per run), which fires when one transition neither returns
nor heartbeats within it; a parent's cancel cascade; and the memory-limit
breaker sealing the object. `tasks.terminate(runId)` is a sixth path that
is deliberately not a mark: it settles at once without running `onCancel`,
children included.

The mark is a write barrier: every checkpoint, park and settle write is
fenced on it, so a live transition that races the mark cannot commit past
it. For a definition without `onCancel` — every job, and any machine that
does not opt in — the **inline default** applies: a parked run settles
inside `cancel()`, a live one has its `step.signal` aborted and settles at
its next step boundary. `cancel` ⇒ `cancelled`; `deadline` ⇒ `failed` with
`TaskDeadlineExceededError`; `turn-deadline` ⇒ `failed` with
`TaskTurnDeadlineExceededError`; a parent's cascade ⇒ `cancelled` with
reason `"parent aborted"`.

For a machine with `onCancel`: the live invocation is signalled and joined
(bounded), then a fresh invocation runs `onCancel(state, ctx)` with
`ctx.cancelling` set to the mark. Between the mark and that settlement
`get()` reports the prior state with `abortRequested: true`; pass
`{ wait: true }` to `cancel()` to await terminality, or `watch()` it.

A signal-deaf transition is not waited on: it runs until its isolate goes,
and every durable write it attempts is refused — the run row by the
generation fence and the mark, the journal by its attempt check, stream
appends because the epoch was sealed.

## Versioning

A definition name is `base` or `base@vN`. There is no replay of old code:
new code reads old state, and `@vN` plus `migrate` is the lever.

```ts
"order@v2": {
  initial: …,
  phases: …,
  migrate: (checkpoint, fromVersion, input) => ({
    state: { ...(checkpoint as OrderV1), phase: "placed", qty: 1 }
  })
} satisfies TaskMachine<OrderState>
```

A run whose exact name is still registered dispatches against it. A run
whose base is registered only at a newer version is adopted through that
version's `migrate` — its checkpoint and, optionally, its input rewritten
once, its definition name moved forward. Without a `migrate`, the run
becomes **`orphaned`**: terminal `failed` with `outcome: "orphaned"`, its
checkpoint preserved even at `retain: false`, holding no alarm.
`tasks.reopen(runId)` brings an orphaned or faulted run back to `pending`
once the definition it needs is registered again. A base nobody registers
at all is the plain `MissingTaskDefinitionError` failure it always was.

Put the `phase` discriminant on the checkpoint, never inside a payload
field, and keep a `Pending` ask id in the phase that reads its answer:
`migrate` receives the whole checkpoint and nothing else.

## Inspection and control

```ts
const snapshot = await this.tasks.get(receipt.runId);
const joined = await this.tasks.getByIdempotencyKey("report:42");
const recent = await this.tasks.list({ definition: "build-report@v1" });
const deep = await this.tasks.view(receipt.runId);
const stop = this.tasks.watch(receipt.runId, (change) => render(change.view));
await this.tasks.cancel(receipt.runId, "superseded");
await this.tasks.pause(receipt.runId);
await this.tasks.resume(receipt.runId);
await this.tasks.delete({ settledBefore: new Date(Date.now() - 86_400_000) });
```

A snapshot is discriminated by `state`:

| State       | Meaning                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | Accepted, first attempt not yet claimed.                                                                                                             |
| `running`   | An attempt is executing (`attempt`, `startedAt`, `statusMessage`).                                                                                   |
| `waiting`   | Parked; `reason` is `sleep`, `retry`, `interrupted`, `mailbox`, `event`, `ask`, `child` or `paused`. `wakeAt` is absent for a park with no deadline. |
| `completed` | Settled with `result`.                                                                                                                               |
| `failed`    | Settled with a safe `error` projection; `outcome` is `faulted` or `orphaned` when the engine, not the handler, ended it.                             |
| `cancelled` | Settled by cancellation, with its optional `reason`.                                                                                                 |

`running` and `waiting` snapshots carry `abortRequested` and `abortReason`
between a cancel being accepted and the run settling. `view()` is the deep
read — the checkpoint, turn, progress, mailbox, asks, children and
engine-owned streams beside the snapshot — and `watch()` delivers a change
with that view on every accepted send, ask, answer, checkpoint, park and
settlement. It holds nothing durable: a subscriber that dies with its
isolate calls `view()` once and subscribes again. `pause()` stops
dispatching at the next boundary and `resume()` continues; a paused run
holds no alarm and still accepts sends and answers.

Cancellation is cooperative: an external effect already accepted cannot be
undone. Every settlement — including faults, orphans and cascades — reaches
`onError` where it is a failure, and emits its `task:*` event.

## Choosing an API

| Requirement                                                      | Use                                    |
| ---------------------------------------------------------------- | -------------------------------------- |
| Normal request handling or short async work                      | ordinary `await`                       |
| Wake a named callback at a time or cron cadence                  | [scheduling](./scheduling.md)          |
| Durable object-local background work with steps, retries, sleeps | a Task job                             |
| A long-lived actor that is steered, asked, or parented           | a Task machine                         |
| Cross-service orchestration with a managed dashboard             | [Cloudflare Workflows](./workflows.md) |

A job has a beginning and an end; an actor has an address. Both cost the
same per durable boundary — one row write per step completion, park,
checkpoint commit or settlement, plus one wake-queue write when the wake
time moves — so choose on shape, not on price.

## Current limits

No `waitForCompletion` on `run()`. `ctx.spawn(..., { owner })` — a child
owned by another Lifecycle — is declared and refused; children run on their
parent's object. `Agent` installs Tasks without a `Streams` capability, so
`ctx.stream()` is available on a hand-composed Lifecycle Object only. The
legacy `runFiber()`/`startFiber()` APIs are public and deprecated in favour
of Tasks; they are still recovered by their own scan. Per-step compensation
(`compensate`) is deferred. The design and its evolution are recorded in
[`design/rfc-tasks-state-machine.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-tasks-state-machine.md).
