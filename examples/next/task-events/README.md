# Task events

This example shows an Agent Task accepting durable, run-scoped events while it
is already executing, then consuming those events later.

## Run it

```sh
pnpm install
pnpm run start
```

No environment variables or API keys are required. The research step is a
deterministic eight-second delay so the event behavior is easy to observe.

## Flow

1. Start a brief with a topic.
2. Send notes while the active research step is running.
3. Answer the audience question when the Task reaches `waitForEvent()`.
4. The Task resumes, drains the buffered notes with `takeEvents()`, and returns
   them in FIFO order as part of the retained result.

The definition receives one audience event and then reviews the note mailbox:

```ts
const audience = await step.waitForEvent<{ audience: string }>(
  "wait-for-audience",
  "audience"
);

const notes = await step.takeEvents<{ text: string }>("review-notes", "note", {
  limit: 10
});
```

Callable methods deliver input to a specific run:

```ts
await this.tasks.sendEvent(
  runId,
  "note",
  { text },
  { idempotencyKey: `note:${deliveryId}` }
);
```

An event receipt confirms durable mailbox acceptance, not consumption. The
demo client waits for every note receipt and closes its note form before
delivering the audience answer. This orders one tab's notes before
`takeEvents()` snapshots the mailbox. If a delivery response is ambiguous,
retry the same run ID, type, payload, and idempotency key.

The callable API accepts at most ten unique note delivery IDs per run, matching
the bounded `takeEvents()` step. Retrying an accepted ID does not consume
another slot.

For multiple independent event producers, define an authoritative close
protocol instead of relying on client-side ordering. This example also uses an
unauthenticated, random Agent name for local demonstration; add authentication,
quotas, and retained-run cleanup before deploying the pattern to production.

## Related

- [Plain Durable Object Tasks example](../tasks)
- [WebSocket and callable methods example](../websockets)
- [Tasks documentation](../../../docs/agents/tasks.md)
