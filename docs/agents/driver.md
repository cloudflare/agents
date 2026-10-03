# Driver

> **Experimental.** Everything exported from `agents/driver` may change
> between releases while the harness execution surface stabilizes.

`agents/driver` runs agent harnesses durably on a [Lifecycle
Object](./lifecycle.md). The driver keeps a queue of operations per scope,
such as one queue of turns per chat, and a loop that keeps stepping the
oldest operation in each queue until it is done. The loop survives
evictions and deploys. The harness keeps everything else: its transcript,
its model and tool calls, and its approvals.

## Install

The host installs one `Driver` and passes it to each harness:

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

A runtime has one required method, `step`, and an optional `stop`. Pass
the driver an object that calls your private methods, so `step` and `stop`
don't become part of the harness's public API, and keep the handle you get
back:

```ts
import type {
  Driver,
  DriverHandle,
  DriverOperation,
  DriverStep
} from "agents/driver";
import { LifecycleCapability } from "agents/lifecycle";

type TurnInput = { messageId: string };
type TurnResult = { responseId: string };

export class MyHarness extends LifecycleCapability {
  readonly #driver: DriverHandle<TurnInput>;

  constructor(options: { driver: Driver }) {
    super("my-harness");
    this.#driver = options.driver.register<TurnInput, TurnResult>(
      "my-harness",
      {
        step: (turn, signal) => this.#step(turn, signal),
        stop: (turn) => this.#stop(turn)
      },
      { onFail: (turn, error) => this.#failTurn(turn.id, error) }
    );
  }

  // The host and its clients call these.
  send(chat: string, messageId: string) {
    return this.#driver.submit(chat, { messageId }, { id: messageId });
  }
  async answer(chat: string, approvalId: string, approved: boolean) {
    await this.#recordAnswer(approvalId, approved);
    await this.#driver.wake(chat);
  }
  stop(turnId: string) {
    return this.#driver.stop(turnId);
  }

  // The driver calls these.
  async #step(
    turn: DriverOperation<TurnInput>,
    signal: AbortSignal
  ): Promise<DriverStep<TurnResult>> {
    const next = this.#nextStep(turn.id); // read from durable records
    if (next.kind === "finished") return { then: "done", result: next.result };
    if (next.kind === "await-approval") return { then: "park" };
    await this.#runOneStep(turn.id, next, signal);
    return { then: "continue" };
  }

  async #stop(turn: DriverOperation<TurnInput>) {
    this.#abortTurn(turn.id);
  }
}
```

A step answers with what should happen next:

| Answer                     | The driver                                                    |
| -------------------------- | ------------------------------------------------------------- |
| `{ then: "continue" }`     | Steps the same operation again now                            |
| `{ then: "sleep", until }` | Steps it again at `until` (epoch milliseconds)                |
| `{ then: "park" }`         | Holds no job and no alarm until `wake(scope)`                 |
| `{ then: "done", result }` | Removes it and steps the next operation in the scope          |
| throws                     | Retries with backoff, then calls `onFail` after `maxAttempts` |

Keep one step bounded, such as one model call or one tool call, and answer
`continue`. Between steps is where `stop()` and `wake()` take effect.

## A step must be safe to repeat

The driver can call `step` again for the same state: after an eviction,
after a deploy, or when a `wake` arrives. So a step reads the harness's
durable records rather than process memory, and does the next thing from
there. If the operation already finished, the step answers `done` again.
The `result` in `done` is for the harness's own bookkeeping. The driver
does not store it.

`operation.attempt` counts the steps that threw in a row. Use it to decide
whether an interrupted call is worth repeating.

## Handle

| Method                         | Does                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `submit(scope, input, { id })` | Queues an operation. Submitting an id that is already queued is a no-op |
| `wake(scope)`                  | Steps the scope now, including one that is parked or sleeping           |
| `stop(id)`                     | Stops one operation, queued or running                                  |
| `pending(scope?)`              | Lists queued and running operations, oldest first                       |

A `wake()` that arrives while a step is running is kept. The scope steps
again as soon as that step returns, even if the step answered `park` or
`sleep`.

At startup the driver steps every scope that has operations once, parked
ones included, so a harness always gets a chance to notice input it
missed.

## Stopping

`stop(id)` records the request durably. If the operation's step is
running, the driver aborts its `signal` and waits up to five seconds for
it to return. Then it calls the runtime's `stop`, removes the operation,
and moves on to the next one in the scope. A step that throws because it
was aborted does not count toward `onFail`.

If the runtime's `stop` throws, `stop(id)` rejects and the operation stays
queued with `stopRequested: true`. The driver retries the stop with
backoff and does not step the operation again.

## Failures

A step that throws is retried with exponential backoff (`retryBaseMs`,
default 1s, up to `retryMaxMs`, default 30s). After `maxAttempts` (default 3) throws in a row, the driver calls `onFail(operation, error)`, removes
the operation and moves on. A step that answers resets the count. If
`onFail` throws, the driver retries it later without stepping again.

## Long steps

A step may run longer than one alarm invocation should block. The driver
starts it in the background, registers it with the alarm's work tracker,
and keeps the queue's job alive with a heartbeat (`heartbeatMs`, default
30s). If the object is evicted mid-step, the heartbeat fires and the step
runs again.

## Durable tool runs

`DurableToolRuns` tracks tool work that outlives one step, such as a
sandbox command or a sub-agent. It stores each run, checks on it from its
own job, and calls `wake` with the owning operation when the run settles:

```ts
readonly tools = new DurableToolRuns({
  id: "tools",
  runtime: sandboxToolRuntime,
  wake: (owner) => this.harness.wake(owner.scope)
});
```

## Current limits

Operations in one scope run strictly in order. Replacing or dropping
queued operations, and steering a running one, are up to the harness.
