# Driver

> **Experimental.** Everything exported from `agents/driver` may change
> between releases while the harness execution surface stabilizes.

`agents/driver` runs agent harnesses durably on a [Lifecycle
Object](./lifecycle.md). A harness keeps its own state: its transcript,
its model and tool calls, its approvals. The driver keeps the part every
harness needs and none of them should rewrite, which is a durable queue of
submissions and a loop that drives them across evictions and deploys.

Each queue is keyed by a runtime id and a scope. A scope is whatever one
line of conversation is for that harness, such as a chat or a lane. Within
one scope, submissions run in order and one at a time. Different scopes and
different runtimes run independently from the same physical alarm.

## Install

The host installs one `Driver` and passes it to each harness. The harness
registers itself and keeps the handle it gets back.

```ts
import { DurableObject } from "cloudflare:workers";
import { Driver } from "agents/driver";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";

export class ChatObject extends DurableObject<Env> {
  readonly driver = new Driver();
  readonly streams = new Streams();
  readonly harness = new MyHarness({
    driver: this.driver,
    streams: this.streams
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.driver)
    .use(this.harness);
}
```

Several harnesses can share one driver. Each registers under its own id,
and their queues never mix.

## Write a runtime

A runtime is four methods. The driver calls them from its job loop. Each
one may run again after an eviction, so each reads the harness's durable
record and never process memory.

```ts
import {
  type Driver,
  type DriverHandle,
  type DriverRuntime
} from "agents/driver";
import { LifecycleCapability } from "agents/lifecycle";
import type { Streams } from "agents/streams";

type TurnInput = { messageId: string };
type TurnResult = { responseId: string };

export class MyHarness
  extends LifecycleCapability
  implements DriverRuntime<TurnInput, TurnResult>
{
  readonly #driver: DriverHandle<TurnInput>;

  constructor(options: { driver: Driver; streams: Streams }) {
    super("my-harness");
    this.#driver = options.driver.register<TurnInput, TurnResult>(
      "my-harness",
      this,
      { settle: (submission, result) => this.#publish(submission, result) }
    );
  }

  // Public API. The host and its clients call these.
  send(chat: string, messageId: string) {
    return this.#driver.submit(chat, { messageId }, { operationId: messageId });
  }
  async answer(chat: string, approvalId: string, approved: boolean) {
    await this.#recordAnswer(approvalId, approved);
    await this.#driver.wake(chat);
  }
  stop(turnId: string) {
    return this.#driver.cancel(turnId);
  }
  wake(chat: string) {
    return this.#driver.wake(chat);
  }

  // Runtime. The driver calls these.
  async inspect(chat: string, turnId: string) {
    const turn = this.#turn(turnId);
    if (!turn) return { status: "not-admitted" } as const;
    if (turn.result)
      return { status: "completed", result: turn.result } as const;
    return { status: "active" } as const;
  }
  async admit(chat: string, turnId: string, input: TurnInput) {
    this.#startTurn(chat, turnId, input);
  }
  async drive(chat: string, turnId: string, signal: AbortSignal) {
    const next = this.#nextStep(turnId);
    if (next.kind === "await-approval") return { status: "waiting" } as const;
    if (next.kind === "done") {
      return { status: "completed", result: next.result } as const;
    }
    await this.#runOneStep(turnId, next, signal);
    return { status: "continue" } as const;
  }
  async cancel(chat: string, turnId: string) {
    this.#abortTurn(turnId);
    return { status: "cancelled" } as const;
  }
}
```

| Method    | Called when                           | Returns                                                                     |
| --------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `inspect` | Before every drive                    | `not-admitted`, `active`, `waiting`, `completed` or `failed`                |
| `admit`   | The submission reaches the queue head | Nothing. Record that the operation started                                  |
| `drive`   | Each job cycle while `active`         | `continue`, `waiting` or `completed`                                        |
| `cancel`  | `handle.cancel()` or a retried cancel | `cancelled`, `not-found`, `completed`, or `pending` to be asked again later |

Keep one drive bounded, such as one model step or one tool call, and return
`continue`. The driver then drives again on the next job cycle, which is
where a `cancel()` or a `wake()` takes effect.

## Waiting

`drive` or `inspect` returning `waiting` pauses the scope.

- With `notBefore`, the driver drives it again at that time. Use it for a
  retry delay or a poll.
- Without `notBefore`, the scope is parked and holds no job and no alarm.
  It stays parked until `handle.wake(scope)`. Use it for input nobody can
  predict, such as a human approval.

A `wake()` that arrives while a drive is still running is kept. The scope
drives again as soon as that drive returns, even if the drive itself
returned `waiting`.

At startup the driver drives every scope with queued work once, parked ones
included, so a harness always gets a chance to notice input it missed.

## Long drives

A drive may run longer than one alarm invocation should block. The driver
starts it in the background, registers it with the alarm's work tracker,
and keeps its job alive with a heartbeat (`heartbeatMs`, default 30s). If
the object is evicted mid-drive, the job fires again and the runtime's
`inspect` decides what happened.

## Failures and retries

A drive that throws is retried with exponential backoff (`retryBaseMs`,
`retryMaxMs`). After `maxAttempts` (default 3) consecutive throws, the
submission fails: the driver calls `fail`, removes it, and moves on to the
next submission in the scope. A drive that returns anything resets the
count. A `settle` or `fail` hook that throws is retried without driving the
runtime again.

## Cancellation

`handle.cancel(operationId)` records the request durably, aborts the signal
of a drive in flight, and calls the runtime's `cancel`. If that throws or
returns `pending`, the driver asks again later. The submission is removed
once the runtime answers `cancelled` or `not-found`. A runtime answering
`completed` settles the result instead.

## Durable tool runs

`DurableToolRuns` tracks tool work that outlives one drive, such as a
sandbox command or a sub-agent. It stores each run, drives it on its own
job, and calls `wake` with the owning operation when the run settles, so
the harness can pick up the result on its next drive.

```ts
readonly tools = new DurableToolRuns({
  id: "tools",
  runtime: sandboxToolRuntime,
  wake: (owner) => this.harness.wake(owner.scope)
});
```

A run is `foreground` or `background`, and `with-parent` or `detached` for
cancellation.

## Current limits

Submissions in one scope run strictly in order. Replacing or dropping
queued work, and steering a running operation, are up to the harness.
