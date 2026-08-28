# Tasks

> **Experimental.** Everything exported from `agents/tasks` may change
> between releases while the durable execution surface stabilizes.

`agents/tasks` adds durable, replayable background work to a [Lifecycle
Object](./lifecycle.md). One `Tasks` capability owns any number of named
Task definitions. A run of a definition survives process loss, deployments,
and hibernation: completed steps return journaled results, sleeps consult
persisted deadlines, and execution continues from the first unfinished step.

The capability never touches the Durable Object's physical alarm. Every
non-terminal run's deadline is mirrored as one job in the Lifecycle work
queue (a retime is a same-id replace), and Lifecycle derives the single
physical alarm from queue state — so Tasks, the
[Scheduler](./scheduling.md), and other capabilities coexist on the same
object.

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
  readonly fibers = new Tasks({
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
in-flight definition's step layout.

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

Task deadlines share the Agent's physical alarm with schedules, keep-alive,
and the rest of the Agent's durable work through the Lifecycle job queue. Internally, Agent's own chat frameworks (Think, AIChatAgent, and
Think's messenger replies) run their turns on this same capability.

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
`retain: false` to remove the record after successful completion.

`run()` and `handle()` type the definition name and its input against the
declared map. A handle is a typed lens scoped to one definition — its `run`,
`get`, `getByIdempotencyKey`, and `cancel` see only that definition's runs,
and it can be created at any time:

```ts
const buildReport = this.tasks.handle("build-report@v1");
const run = await buildReport.get(receipt.runId); // result typed by the map
```

Inputs, step results, metadata, and final results must be JSON-serializable
and at most 1 MiB serialized.

## The step API

| Method                        | Behavior                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `step.do(name, config?, cb)`  | Run a named step once; journaled results replay without re-executing. `config` sets `retries` and `timeout`. |
| `step.sleep(name, duration)`  | Persist a wake deadline and suspend; no isolate stays resident while waiting.                                |
| `step.sleepUntil(name, when)` | Sleep until a wall-clock time.                                                                               |
| `step.status(message)`        | Update observable progress; replays stay silent over old ground.                                             |
| `step.idempotencyKey(name)`   | The stable external deduplication key `step.do(name, …)` receives.                                           |

Each `do` attempt receives `{ attempt, idempotencyKey, signal }`. The signal
aborts on cancellation and on the attempt timeout (default 5 minutes); a
callback that ignores it still loses the attempt, and a stale attempt's late
writes are rejected.

A callback that throws retries on a durable delay (default: 5 attempts,
exponential backoff). Throw `NonRetryableError` to fail the run immediately.

## Replay semantics

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

## Inspection and control

```ts
const snapshot = await this.tasks.get(receipt.runId);
const joined = await this.tasks.getByIdempotencyKey("report:42");
const recent = await this.tasks.list({ definition: "build-report@v1" });
await this.tasks.cancel(receipt.runId, "superseded");
await this.tasks.delete({ settledBefore: new Date(Date.now() - 86_400_000) });
```

A snapshot is discriminated by `state`:

| State       | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `pending`   | Accepted, first attempt not yet claimed.                           |
| `running`   | An attempt is executing (`attempt`, `startedAt`, `statusMessage`). |
| `waiting`   | Parked on a durable deadline (`reason`: `sleep` or `retry`).       |
| `completed` | Settled with `result`.                                             |
| `failed`    | Settled with a safe `error` projection.                            |
| `cancelled` | Settled by cancellation, with its optional `reason`.               |

Cancellation is cooperative: a parked run settles immediately, a live attempt
is aborted through its signal and settles at its next step boundary. An
external effect already accepted cannot be undone.

## Interruption and replay

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

A step callback that throws is not an interruption; the retry policy owns
it, with the run parked `waiting` between attempts. Interruptions also emit
a `task:attempt:interrupted` event carrying the same step name.

## Choosing an API

| Requirement                                                      | Use                                    |
| ---------------------------------------------------------------- | -------------------------------------- |
| Normal request handling or short async work                      | ordinary `await`                       |
| Wake a named callback at a time or cron cadence                  | [scheduling](./scheduling.md)          |
| Durable object-local background work with steps, retries, sleeps | a Task                                 |
| Cross-service orchestration with a managed dashboard             | [Cloudflare Workflows](./workflows.md) |

## Current limits

The first release is deliberately narrow: no `waitForCompletion` mode on
`run()`, and no runs on routed sub-agents (facet-hosted work stays on the
legacy fiber engine for now). The legacy `runFiber()`/`startFiber()` APIs are
unchanged and still recovered by their own scan; deprecation waits for
migration evidence per the RFC. The design and its phases are recorded in
[`design/rfc-fibers.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-fibers.md).
