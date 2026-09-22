# State machines

> **Experimental.** Everything exported from `agents/state-machine` may change
> between releases while the durable coordination surface stabilizes.

`agents/state-machine` adds durable, checkpointed state machines to a
[Lifecycle Object](./lifecycle.md). Each transition replaces one complete,
versioned checkpoint. Lifecycle jobs wake runs after events and deadlines, so a
parked machine holds no JavaScript invocation in memory.

Use StateMachine for long-lived coordination such as agent loops, permission
flows, external jobs, and parent-child work. Use [Tasks](./tasks.md) when a
shorter replay-from-the-top function with journaled steps is a better fit.

## Define and install a machine

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  StateMachine,
  defineMachine,
  type MachineDefinition
} from "agents/state-machine";

type RunState =
  | { phase: "waiting"; key: string }
  | { phase: "processing"; value: string };

type RunEvent = {
  type: "input";
  key: string;
  value: string;
};

const run = defineMachine<RunState, string, { key: string }, RunEvent>({
  version: 1,
  initial: (input) => ({ phase: "waiting", key: input.key }),
  phases: {
    waiting: (state, context) => {
      const input = context.events.take({ type: "input", key: state.key });
      if (input) {
        return context.transition({
          phase: "processing",
          value: input.event.value
        });
      }
      return context.wait(state, { type: "input", key: state.key });
    },
    processing: (state, context) => context.complete(state.value)
  }
} satisfies MachineDefinition<RunState, string, { key: string }, RunEvent>);

export class RunObject extends DurableObject<Env> {
  readonly machines = new StateMachine({ definitions: { run } });
  readonly lifecycle = Lifecycle.install(this).use(this.machines);
}
```

The definition map is rebuilt on every Durable Object wake. Keep a definition's
name and version available while retained runs use them.

## Start and inspect a run

```ts
const receipt = await machines.run(
  "run",
  { key: "request-1" },
  {
    idempotencyKey: "request-1"
  }
);

const snapshot = await machines.get(receipt.runId, "run");
```

A caller-selected `runId` or `idempotencyKey` joins an existing run instead of
creating another one.

## Send events

Every delivery requires an idempotent `eventId`:

```ts
await machines.send(
  receipt.runId,
  { type: "input", key: "request-1", value: "hello" },
  { eventId: "input-request-1" }
);
```

Events may arrive before a machine starts waiting. StateMachine queues them and
consumes a matching event atomically with the next checkpoint. A repeated
`eventId` cannot feed a later wait.

Add `timeoutAt` to a wait to schedule a durable deadline:

```ts
return context.wait(state, {
  type: "input",
  key: state.key,
  timeoutAt: Date.now() + 60_000
});
```

On re-entry, `context.wake.kind` distinguishes an event wake from a timeout.

## Permission gates

A gate is a typed, correlated question built on the event queue:

```ts
import { defineGate } from "agents/state-machine";

const Permission = defineGate<
  { tool: string; command: string },
  { approved: boolean }
>("permission");

const gate = context.gates.open(
  Permission,
  { tool: "exec", command: "pnpm test" },
  {
    metadata: { tool: "exec" },
    expiresAt: Date.now() + 10 * 60_000
  }
);
```

Store `gate.id` in the next checkpoint. An external request answers it by ID:

```ts
await machines.answer(
  gateId,
  Permission,
  { approved: true },
  { eventId: `decision:${gateId}` }
);
```

Authentication and authorization remain the host application's responsibility.

## External effects

External effects separate durable intent from invocation. Register runtimes on
the capability and choose a recovery policy when planning an effect:

- `safe`: invoke again with the same idempotency key;
- `never`: do not repeat an uncertain invocation;
- `reconcile`: inspect work through its persisted external ID.

```ts
const machines = new StateMachine({
  definitions,
  effects: {
    command: {
      execute: (input, invocation) =>
        sandbox.exec(input.command, {
          id: invocation.externalId,
          signal: invocation.signal
        }),
      reconcile: (externalId) => sandbox.inspect(externalId)
    }
  }
});
```

Plan an effect in one phase, commit its reference in state, then execute it from
the next phase. This makes a crash before intent distinct from an uncertain
external outcome.

## Child machines

`context.children.spawn()` creates a local child run in the same transaction as
the parent checkpoint. The parent can continue and later consume the child's
durable completion:

```ts
const child = context.children.spawn<string>(
  "research",
  { topic: state.topic },
  { mode: "attached" }
);
```

Attached children receive parent cancellation. Background children continue
unless cancelled directly. Cross-Durable-Object and detached children are not
part of this experimental version.

## Cancellation and pause

```ts
await machines.cancel(runId, "user requested");
await machines.pause(runId);
await machines.resume(runId);
await machines.terminate(runId, "administrative stop");
```

A definition may provide `onCancel` to return a final or stable next state. A
definition without `onCancel` settles as cancelled. Pause removes the run's job
without changing its checkpoint.
