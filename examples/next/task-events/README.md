# Task events

This example shows an Agent Task preparing an audience-tailored technical
briefing outline while accepting durable, run-scoped editor notes. Its job is
to draft three sections about a topic, ask who will read them and what decision
they face, then tailor every section to that context.

## Run it

```sh
pnpm install
pnpm run start
```

No environment variables or API keys are required. The drafting step is a
deterministic eight-second delay so the event behavior is easy to observe.

## Flow

1. Start a technical briefing with a topic.
2. Send editor notes while the active drafting step is running.
3. Describe the reader and their decision when the Task reaches
   `waitForEvent()`.
4. The Task tailors all three outline sections to that context, drains the
   buffered notes with `takeEvents()`, and returns them in FIFO order as part of
   the retained result.

The definition receives one reader-context event and then reviews the note
mailbox:

```ts
const audience = await step.waitForEvent<{
  audience: string;
  decision: string;
}>("wait-for-audience", "audience");

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
delivering the reader context. This orders one tab's notes before
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
