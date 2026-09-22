# Agent harness contract

> **Experimental.** Everything exported from `agents/harness` may change while
> native and wrapped harness implementations are validated.

`agents/harness` defines a transport-neutral lifecycle contract for agent
harnesses. It standardizes submission, durable input, inspection, abort, pause,
resume, and terminal results. Each implementation keeps its own input, event,
snapshot, result, transcript, provider, and tool types.

## StateMachine adapter

Use `StateMachineHarness` when one StateMachine definition owns the harness run:

```ts
import { StateMachineHarness } from "agents/harness";
import { StateMachine } from "agents/state-machine";

const machines = new StateMachine({
  definitions: {
    codingRun
  }
});

const harness = new StateMachineHarness({
  stateMachine: machines,
  definition: "codingRun"
});
```

The adapter owns no phases or storage. It maps the common lifecycle operations
to the named definition:

```ts
const receipt = await harness.submit(
  { prompt: "Run the tests" },
  { idempotencyKey: "request-123" }
);

await harness.send(
  receipt.runId,
  { type: "permission", key: "exec-1", approved: true },
  { eventId: "permission-exec-1" }
);

const snapshot = await harness.inspect(receipt.runId);
const result = await harness.result(receipt.runId);
```

`abort()` requests durable cancellation. It is separate from an `AbortSignal`
that stops one caller from waiting for a response.

## Streams

The core contract does not require one stream format. A harness that offers
durable output can also implement `HarnessStreams<Descriptor>`:

```ts
interface OutputDescriptor {
  streamId: string;
  cursor: number;
  kind: "model" | "tool" | "progress";
}

const output: HarnessStreams<OutputDescriptor> = {
  streams: async (runId) => findRunStreams(runId)
};
```

A reconnecting transport can inspect the run, discover implementation-specific
stream IDs, and replay them from its own cursors.

## Wrapping an existing durable runtime

Use `createHarnessEffectRuntime()` when another harness already owns its
transcript and internal recovery:

```ts
import { createHarnessEffectRuntime } from "agents/harness";

const runtime = createHarnessEffectRuntime({
  start: (input, { executionId, signal }) =>
    existingHarness.start(input, { executionId, signal }),
  inspect: (executionId) => existingHarness.inspect(executionId),
  cancel: (executionId) => existingHarness.cancel(executionId)
});
```

Register `runtime` as a StateMachine effect with `recovery: "reconcile"` and a
stable external execution ID. A running execution becomes a durable pending
effect; later drives inspect it instead of starting it again.

A harness does not need to use `StateMachineHarness`. It can implement
`AgentHarness` directly as long as it preserves the lifecycle contract. Native
pi, OpenCode, and Codex message, provider, tool, and continuation types remain
outside `agents/harness`.
