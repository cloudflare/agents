# `@cloudflare/channels`

A durable turn engine for stateful agents on Cloudflare Workers.

This package does one thing: it turns an admitted event into a durable,
serialized agent turn whose output is recorded in an append-only journal.
It does not provide HTTP routing, messenger adapters, web protocols, transcript
hydration, or platform-specific delivery.

## Guarantees

- A source event id identifies one durable turn within a conversation.
- Turns settle exactly once as `ok`, `error`, or `interrupted`.
- Running turns in one conversation execute in admission order.
- Output journal entries are committed exactly once.
- `accepted` turns safely re-run after restart.
- `streaming` turns resume only when the connector declares that capability;
  otherwise they settle as interrupted without discarding partial output.
- Human interactions park durably in `waiting` without blocking later turns.
- Stale executions cannot regress a turn or append after settlement.

Connector execution is at least once. Any external side effect performed by a
connector must therefore be idempotent or carry its own durable recovery key.

## Construct an engine

```ts
import { createTurnEngine, type AgentConnector } from "@cloudflare/channels";

function createEngine(ctx: DurableObjectState, connector: AgentConnector) {
  return createTurnEngine(ctx, { connector });
}
```

The host owns event routing. Submit a normalized event at that seam:

```ts
const admission = await engine.submit({
  conversationId: "customer-123",
  sourceEventId: "message-456",
  input: [userMessage]
});
```

Consume `engine.openJournal(turnId, fromSeq)` to replay committed output and
follow the turn until it parks or settles. The consumer owns presentation,
delivery acknowledgment, and retry policy.

Forward the Durable Object alarm to `engine.onWake()`. The engine uses it only
to prune settled journals after their retention period. `createTurnEngine`
handles SQLite setup, isolate lifetime extension, and race-safe alarm updates.

## Human interactions

A connector may throw `TurnPause`:

```ts
throw new TurnPause({
  id: "approve-refund",
  kind: "approval",
  payload: { amount: 42 }
});
```

The engine journals the interaction and moves the turn to `waiting`. Complete
it by submitting another event at the same conversation address:

```ts
await engine.submit({
  conversationId: "customer-123",
  sourceEventId: "approval-event-789",
  input: [],
  interaction: { id: "approve-refund", value: true }
});
```

The original turn re-enters its connector with the completed interaction in
`turn.interactions`.

## Deliberately out of scope

- transports and webhook verification
- Chat SDK or messenger projection
- web chat protocols
- transcript/history storage
- provider-specific connectors
- platform delivery guarantees

Those belong in modules built on top of the durable turn engine.
