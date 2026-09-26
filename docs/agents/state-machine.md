# State machine examples

> **Experimental.** Exports from `agents/state-machine` may change between releases.

See the [State machine API reference](./state-machine-api.md) for signatures and return types.

## Define and install

A definition maps each stored `phase` to a handler. Install the definition map on a Lifecycle Object so runs can resume after eviction.

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  StateMachine,
  defineMachine,
  type MachineDefinition
} from "agents/state-machine";

type OrderEvent = {
  type: "payment.received";
  key: string;
  transactionId: string;
};

type OrderState =
  | { phase: "waiting"; orderId: string }
  | { phase: "paid"; orderId: string; transactionId: string };

const order = defineMachine<
  OrderState,
  { orderId: string; transactionId: string },
  { orderId: string },
  OrderEvent
>({
  version: 1,
  initial: ({ orderId }) => ({ phase: "waiting", orderId }),
  phases: {
    waiting: (state, context) => {
      if (context.wake.kind === "timeout") {
        return context.fail(new Error("Payment expired"));
      }

      const payment = context.events.take({
        type: "payment.received",
        key: state.orderId
      });

      if (!payment) {
        return context.wait(state, {
          type: "payment.received",
          key: state.orderId,
          timeoutAt: Date.now() + 24 * 60 * 60 * 1000
        });
      }

      return context.transition({
        phase: "paid",
        orderId: state.orderId,
        transactionId: payment.event.transactionId
      });
    },
    paid: (state, context) =>
      context.complete({
        orderId: state.orderId,
        transactionId: state.transactionId
      })
  }
} satisfies MachineDefinition<
  OrderState,
  { orderId: string; transactionId: string },
  { orderId: string },
  OrderEvent
>);

const definitions = { order };

export class OrderObject extends DurableObject<Env> {
  readonly machines = new StateMachine({ definitions });
  readonly lifecycle = Lifecycle.install(this).use(this.machines);
}
```

## Start, notify, and inspect

`run()` durably accepts work, `notify()` adds an idempotent event, and `get()` returns the current checkpoint or terminal result.

```ts
const receipt = await machines.run(
  "order",
  { orderId: "order-123" },
  { idempotencyKey: "order-123" }
);

await machines.notify(
  receipt.runId,
  {
    type: "payment.received",
    key: "order-123",
    transactionId: "txn-456"
  },
  { eventId: "payment-webhook-txn-456" }
);

const snapshot = await machines.get(receipt.runId, "order");

const liveOrders = await machines.list({
  definition: "order",
  status: ["running", "waiting"],
  limit: 20
});

if (snapshot?.status === "completed") {
  console.log(snapshot.result.transactionId);
}
```

## Handle cancellation

Add `onCancel` for a final transition. Without it, cancellation settles the run as cancelled.

```ts
const cancellableOrder = defineMachine<
  OrderState,
  { orderId: string; transactionId: string },
  { orderId: string },
  OrderEvent
>({
  ...order,
  onCancel: (_state, context) =>
    context.fail(new Error(context.wake.reason ?? "Order cancelled"))
});

await machines.cancel(runId, "customer requested");
```

## Ask for approval

A gate stores a typed request and waits for one external answer. Save the gate reference in the next checkpoint.

```ts
import {
  defineGate,
  defineMachine,
  type MachineGateRef
} from "agents/state-machine";

const Approval = defineGate<{ command: string }, { approved: boolean }>(
  "approval"
);

type ApprovalState =
  | { phase: "request"; command: string }
  | {
      phase: "wait";
      command: string;
      gate: MachineGateRef<{ approved: boolean }>;
    };

const approval = defineMachine<ApprovalState, boolean, { command: string }>({
  version: 1,
  initial: ({ command }) => ({ phase: "request", command }),
  phases: {
    request: (state, context) => {
      const gate = context.gates.create(
        Approval,
        { command: state.command },
        {
          metadata: { source: "tool" },
          expiresAt: Date.now() + 10 * 60 * 1000
        }
      );

      return context.transition({
        phase: "wait",
        command: state.command,
        gate
      });
    },
    wait: (state, context) => {
      if (context.wake.kind === "timeout") {
        return context.complete(false);
      }

      const decision = context.gates.take(state.gate);
      if (!decision) {
        return context.wait(state, {
          type: "state-machine:gate-answer",
          key: state.gate.id,
          timeoutAt: Date.now() + 10 * 60 * 1000
        });
      }

      return context.complete(
        decision.status === "answered" && decision.answer.approved
      );
    }
  }
});
```

```ts
await machines.gates.notify(
  gateId,
  Approval,
  { approved: true },
  { eventId: `approval:${gateId}:yes` }
);

await machines.gates.withdraw(gateId);
```

## Run an external effect

Plan external work in one phase and execute it in the next. The recovery policy controls what happens when execution is interrupted.

```ts
import {
  StateMachine,
  defineMachine,
  effectPending,
  type MachineEffectRef,
  type MachineEffectRuntime
} from "agents/state-machine";

const commandEffect: MachineEffectRuntime<
  { command: string },
  { stdout: string }
> = {
  async execute(input, invocation) {
    const job = await sandbox.start(input.command, {
      idempotencyKey: invocation.idempotencyKey,
      signal: invocation.signal
    });

    return effectPending(job.id);
  },

  async reconcile(externalId) {
    const job = await sandbox.get(externalId);

    if (!job) return { status: "not-found" };
    if (job.status === "running") return { status: "running" };
    if (job.status === "failed") {
      return {
        status: "failed",
        error: { name: "CommandError", message: job.error }
      };
    }

    return {
      status: "completed",
      output: { stdout: job.stdout }
    };
  },

  async cancel(externalId) {
    await sandbox.cancel(externalId);
  }
};

type CommandState =
  | { phase: "plan"; command: string }
  | {
      phase: "execute";
      effect: MachineEffectRef<{ stdout: string }>;
    };

const command = defineMachine<
  CommandState,
  { stdout: string },
  { command: string }
>({
  version: 1,
  initial: ({ command }) => ({ phase: "plan", command }),
  phases: {
    plan: (state, context) => {
      const effect = context.effects.plan<
        { command: string },
        { stdout: string }
      >("command", { command: state.command }, { recovery: "reconcile" });

      return context.transition({ phase: "execute", effect });
    },
    execute: async (state, context) => {
      const outcome = await context.effects.execute(state.effect);

      if (outcome.status === "completed") {
        return context.complete(outcome.output);
      }
      if (outcome.status === "failed") {
        return context.fail(new Error(outcome.error.message));
      }
      if (outcome.status === "retrying") {
        return context.wait(state, {
          type: "effect.retry",
          key: state.effect.id,
          timeoutAt: outcome.retryAt
        });
      }
      if (outcome.status === "interrupted") {
        return context.fail(new Error("Command interrupted"));
      }

      return context.wait(state, {
        type: "effect.poll",
        timeoutAt: Date.now() + 5_000
      });
    }
  }
});

const machines = new StateMachine({
  definitions: { command },
  effects: { command: commandEffect }
});
```

Use `context.effects.run()` to commit and execute an effect without an
intermediate transition. It accepts `timeoutMs` and a durable retry policy:

```ts
const outcome = await context.effects.run(
  "command",
  { command: state.command },
  {
    recovery: "safe",
    timeoutMs: 30_000,
    retries: { limit: 3, delay: 1_000, backoff: "exponential" }
  }
);

if (outcome.status === "retrying") {
  return context.wait(state, {
    type: "effect.retry",
    key: context.runId,
    timeoutAt: outcome.retryAt
  });
}
```

Retry `limit` includes the first attempt. A retrying run waits durably until
`retryAt`, so it does not keep the Durable Object in memory. Keep calls and
arguments to `effects.run()`, `effects.plan()`, `gates.create()`, and
`children.spawn()` in a stable order while the same phase visit re-enters. A
later transition back to the phase creates new operations.

After an effect with `recovery: "never"` starts, the engine does not invoke it
again after an error, timeout, process failure, or transition conflict.

## Join a child

A child is a built-in reconcile effect. `spawn()` commits its intent, `join()` starts or inspects it, and a durable completion event wakes the parent. Attached children follow parent cancellation.

```ts
type ParentState =
  | { phase: "spawn"; topic: string }
  | {
      phase: "join";
      child: {
        runId: string;
        definition: string;
        mode: "attached" | "background";
        effect: {
          id: string;
          kind: string;
          recovery: "reconcile";
        };
      };
    };

const parent = defineMachine<ParentState, string, { topic: string }>({
  version: 1,
  initial: ({ topic }) => ({ phase: "spawn", topic }),
  phases: {
    spawn: (state, context) => {
      const child = context.children.spawn<string>(
        "research",
        { topic: state.topic },
        { mode: "attached" }
      );

      return context.transition({ phase: "join", child });
    },
    join: async (state, context) => {
      const result = await context.children.join(state.child);

      if (!result) {
        return context.wait(state, {
          type: "state-machine:child-completed",
          key: state.child.runId,
          timeoutAt: Date.now() + 30_000
        });
      }

      return result.ok
        ? context.complete(result.output)
        : context.fail(new Error(result.error.message));
    }
  }
});
```

Use `mode: "background"` to exclude the child from parent cancellation. The completion event is the normal wake path; the timeout reconciles the child if event delivery is delayed.

## Pause, resume, terminate, and delete

Pause keeps the checkpoint. Terminate settles immediately. Delete removes a terminal run.

```ts
await machines.pause(runId);
await machines.resume(runId);

await machines.terminate(runId, "operator stopped run");
await machines.delete(runId); // Terminal runs only
```

## Settle a stream with a decision

A commit participant updates another Lifecycle capability in the same transaction as the machine decision.

```ts
import { settleStreamOnMachineCommit } from "agents/state-machine";

return context.complete(result, {
  commit: [settleStreamOnMachineCommit(streams, streamId)]
});
```
