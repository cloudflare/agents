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

Declare definitions in the constructor — like `Scheduler` callbacks — and
install the capability with the lifecycle:

```ts
import { DurableObject } from "cloudflare:workers";
import { Fibers, type FiberStep } from "agents/fibers";
import { Lifecycle } from "agents/lifecycle";

interface ReportInput {
  reportId: string;
  topic: string;
}

export class ReportObject extends DurableObject<Env> {
  readonly fibers = new Fibers({
    definitions: {
      "build-report@v1": async (input: ReportInput, step: FiberStep) => {
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

  readonly lifecycle = Lifecycle.install(this).use(this.fibers);
}
```

The constructor map is the registry. Storage persists only the definition
name, and the map is rebuilt on every Durable Object wake, so recovery of
in-flight runs is correct by construction — there is nothing to register at
the right moment and no lock to trip over. Handlers are ordinary arrows that
capture `this`. Version the name (`"build-report@v2"`) instead of changing an
in-flight definition's step layout.

## On an Agent

`Agent` installs the capability automatically as `this.fibers` (experimental).
Declare definitions on the overridable `fiberDefinitions` field — the same
every-wake rebuild guarantee, resolved lazily so field order never matters:

```ts
import { Agent } from "agents";
import type { FiberHandlers, FiberStep } from "agents/fibers";

export class ReportAgent extends Agent<Env> {
  override readonly fiberDefinitions = {
    "build-report@v1": async (input: ReportInput, step: FiberStep) => {
      // ...same step API; handlers run in the Agent's invocation context,
      // so getCurrentAgent() works throughout.
    }
  } satisfies FiberHandlers;
}
```

Fiber deadlines share the Agent's physical alarm with schedules, keep-alive,
and the rest of the Agent's durable work through the Lifecycle contribution
model. Internally, Agent's own chat frameworks (Think, AIChatAgent, and
Think's messenger replies) run their turns on this same capability.

## Starting runs

```ts
const receipt = await this.fibers.run("build-report@v1", input, {
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
const buildReport = this.fibers.handle("build-report@v1");
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
`FiberReplayDivergedError` or `DuplicateFiberStepError` rather than guessing.
A run whose definition name is no longer registered after a deployment fails
with a `MissingFiberDefinitionError`; it is never silently deleted or run
against a different handler.

## Inspection and control

```ts
const snapshot = await this.fibers.get(receipt.runId);
const joined = await this.fibers.getByIdempotencyKey("report:42");
const recent = await this.fibers.list({ definition: "build-report@v1" });
await this.fibers.cancel(receipt.runId, "superseded");
await this.fibers.delete({ settledBefore: new Date(Date.now() - 86_400_000) });
```

A snapshot is discriminated by `state`:

| State        | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `pending`    | Accepted, first attempt not yet claimed.                               |
| `running`    | An attempt is executing (`attempt`, `startedAt`, `statusMessage`).     |
| `waiting`    | Parked on a durable deadline (`reason`: `sleep`, `retry`, `recovery`). |
| `recovering` | An interruption is being reconciled by the definition's `recover`.     |
| `completed`  | Settled with `result`.                                                 |
| `failed`     | Settled with a safe `error` projection.                                |
| `cancelled`  | Settled by cancellation, with its optional `reason`.                   |

Cancellation is cooperative: a parked run settles immediately, a live attempt
is aborted through its signal and settles at its next step boundary. An
external effect already accepted cannot be undone.

## Custom recovery

Automatic replay is right when every side effect sits in a step and repeats
safely under its idempotency key. When replaying immediately could duplicate
an irreversible effect — a payment, a model stream — a definition pairs its
handler with a `recover` callback that owns the interruption decision:

```ts
readonly fibers = new Fibers({
  definitions: {
    "capture-payment@v1": {
      run: async (input: PaymentInput, step: FiberStep) => {
        return step.do("capture", ({ idempotencyKey, checkpoint }) => {
          checkpoint({ phase: "submitted" });
          return this.payments.capture(input, { idempotencyKey });
        });
      },
      recover: async (interruption: FiberInterruption<PaymentInput>) => {
        const submitted = interruption.interruptedStep;
        if (submitted === null) return { action: "replay" as const };

        const outcome = await this.payments.lookup(submitted.idempotencyKey);
        if (outcome?.state === "captured") {
          return { action: "complete" as const, result: outcome };
        }
        if (outcome?.state === "declined") {
          return {
            action: "fail" as const,
            error: new Error("Payment was declined")
          };
        }
        return { action: "replay" as const };
      }
    }
  }
});
```

`recover` runs only after an unclean interruption — an attempt that was
claimed but never settled. A step callback that throws is not an
interruption; the retry policy owns it. The callback receives the run's
input, metadata, and the interrupted step (name, attempt, stable
`idempotencyKey`, and the last `checkpoint` the lost attempt wrote via its
step attempt context), and decides:

| Decision                         | Effect                                       |
| -------------------------------- | -------------------------------------------- |
| `{ action: "replay", at? }`      | Replay the handler, now or at a future time. |
| `{ action: "complete", result }` | Settle the run without replaying.            |
| `{ action: "fail", error }`      | Fail the run.                                |
| `{ action: "cancel", reason? }`  | Cancel the run.                              |

Recovery itself can be interrupted, so callbacks must be idempotent: the
next wake invokes recovery again. A throwing `recover` retries on an
exponential backoff (5 attempts) before the run fails. Most definitions
should stay bare handlers — replay plus downstream idempotency is the
simpler, safer default.

## Choosing an API

| Requirement                                                      | Use                                    |
| ---------------------------------------------------------------- | -------------------------------------- |
| Normal request handling or short async work                      | ordinary `await`                       |
| Wake a named callback at a time or cron cadence                  | [scheduling](./scheduling.md)          |
| Durable object-local background work with steps, retries, sleeps | a Fiber                                |
| Cross-service orchestration with a managed dashboard             | [Cloudflare Workflows](./workflows.md) |

## Current limits

The first release is deliberately narrow: no `waitForCompletion` mode on
`run()`, and no runs on routed sub-agents (facet-hosted work stays on the
legacy fiber engine for now). The legacy `runFiber()`/`startFiber()` APIs are
unchanged and still recovered by their own scan; deprecation waits for
migration evidence per the RFC. The design and its phases are recorded in
[`design/rfc-fibers.md`](https://github.com/cloudflare/agents/blob/main/design/rfc-fibers.md).
