# Fibers

> **Experimental.** Everything exported from `agents/fibers` may change
> between releases while the durable execution surface stabilizes.

`agents/fibers` adds durable, replayable background work to a [Lifecycle
Object](./lifecycle.md). One `Fibers` capability owns any number of named
Fiber definitions. A run of a definition survives process loss, deployments,
and hibernation: completed steps return journaled results, sleeps consult
persisted deadlines, and execution continues from the first unfinished step.

Fibers never touch the Durable Object's physical alarm. The capability
contributes its earliest deadline and `Lifecycle` arms one shared alarm, so
Fibers, the [Scheduler](./scheduling.md), and other capabilities coexist on
the same object.

## Install and define

Construct the capability with the host, register definitions in field
initializers, and install it with the lifecycle:

```ts
import { DurableObject } from "cloudflare:workers";
import { Fibers } from "agents/fibers";
import { Lifecycle } from "agents/lifecycle";

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

  readonly buildReport = this.fibers.create<ReportInput, ReportResult>(
    "build-report@v1",
    async (input, step) => {
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
  );

  readonly lifecycle = Lifecycle.install(this).use(this.fibers);
}
```

Definitions are registered in memory on every Durable Object wake; storage
persists only the definition name. Register definitions synchronously during
construction — `create()` throws once the lifecycle has started. Version the
name (`"build-report@v2"`) instead of changing an in-flight definition's step
layout.

## Starting runs

```ts
const receipt = await this.buildReport.run(input, {
  idempotencyKey: `report:${input.reportId}`
});
```

`run()` durably accepts the work and returns a receipt without waiting for
completion. The same `idempotencyKey` (or a caller-selected `runId`) joins
the existing run instead of creating a second one; `accepted: false` on the
receipt marks that join. Pass `metadata` to retain JSON alongside the run and
`retain: false` to remove the record after successful completion.

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
`FiberReplayDivergedError` or `DuplicateFiberStepError` rather than guessing.
A run whose definition name is no longer registered after a deployment fails
with a `MissingFiberDefinitionError`; it is never silently deleted or run
against a different handler.

## Inspection and control

```ts
const snapshot = await this.buildReport.get(receipt.runId);
const joined = await this.buildReport.getByIdempotencyKey("report:42");
const recent = await this.fibers.list({ definition: "build-report@v1" });
await this.fibers.cancel(receipt.runId, "superseded");
await this.fibers.delete({ settledBefore: new Date(Date.now() - 86_400_000) });
```

A snapshot is discriminated by `state`:

| State       | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `pending`   | Accepted, first attempt not yet claimed.                           |
| `running`   | An attempt is executing (`attempt`, `startedAt`, `statusMessage`). |
| `waiting`   | Parked on a durable deadline (`reason` is `sleep` or `retry`).     |
| `completed` | Settled with `result`.                                             |
| `failed`    | Settled with a safe `error` projection.                            |
| `cancelled` | Settled by cancellation, with its optional `reason`.               |

Cancellation is cooperative: a parked run settles immediately, a live attempt
is aborted through its signal and settles at its next step boundary. An
external effect already accepted cannot be undone.

## Choosing an API

| Requirement                                                      | Use                                    |
| ---------------------------------------------------------------- | -------------------------------------- |
| Normal request handling or short async work                      | ordinary `await`                       |
| Wake a named callback at a time or cron cadence                  | [scheduling](./scheduling.md)          |
| Durable object-local background work with steps, retries, sleeps | a Fiber                                |
| Cross-service orchestration with a managed dashboard             | [Cloudflare Workflows](./workflows.md) |

## Current limits

The first release is deliberately narrow: no custom recovery callback beside
the run handler, no `waitForCompletion` mode on `run()`, no automatic
`this.fibers` on `Agent`, and no runs on routed sub-agents. The design and
its planned phases are recorded in
[`design/rfc-fibers.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-fibers.md).
