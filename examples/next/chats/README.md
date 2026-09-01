# Next: chats

The recommended shape for "many chats per user": **one top-level Durable
Object per chat** (`ChatAgent`), plus **one per-user index DO**
(`UserAgent`) that every chat pushes its metadata into.

```
UserAgent "alice"                ChatAgent "alice:{chatId}" (one per chat)
┌───────────────────────┐        ┌──────────────────────────┐
│ chats                 │ update │ messages                 │
│  chat_id → title,     │◀───────│  role, text, at          │
│  last_message,        │  push  │  (own SQLite, own alarms,│
│  updated_at           │        │   own placement)         │
└───────────────────────┘        └──────────────────────────┘
   listChats / searchChats            addMessage / getMessages
   read ONLY the index                destroy() deletes everything
```

## Why not facets (dynamic agents)?

A chat fails the facet test on every axis: it needs no isolation
boundary from a parent, it wants its own alarms (facets cannot set
alarms), a user accumulates an unbounded number of them (a facet tree is
pinned to one machine and stored as one logical root object), and
every WebSocket frame to a facet wakes the root parent. Facets are for
code the parent _supervises_ — dynamically-loaded or generated code,
per-run tool agents — reached via `this.dynamicAgents`. See
`docs/agents/sub-agents.md` for the decision rule.

## What the index buys you

- **Listing** a user's chats reads one DO — no chat wakes up.
- **Cross-chat search** is a `LIKE` over the pushed metadata, again
  without waking any chat DO. (This is the usual objection to
  DO-per-chat — "search across chats is impossible" — and the answer is
  a push-based mirror index, the same pattern the reference apps use.)
- **Deletion** is `chat.destroy()` plus one index row — no manual
  multi-table sweeps.

The index is derived data pushed on every write; the chats themselves
stay the source of truth. A push updates only an existing catalog row
and cannot replace metadata with an older activity timestamp, so delayed
activity cannot recreate a chat or overwrite newer metadata. The User DO
also assigns a monotonic activity sequence as a tie-breaker, while the
Chat-owned activity timestamp remains the primary list order.

This example demonstrates the topology, not guaranteed cross-DO delivery.
A failed metadata push leaves the derived index temporarily stale and does
not fail the already-committed chat write. The proposed production protocol
for idempotency, repair, deletion, and User-gated routing lives in
[`design/rfc-user-chat-durable-objects.md`](../../../design/rfc-user-chat-durable-objects.md).

## Run

```sh
pnpm install
pnpm run start
```

The React UI (Vite + Kumo) shows the whole pattern: the sidebar and
search read only the per-user index DO over one `useAgent` connection,
and each open chat gets its own WebSocket straight to that chat's DO.

## Test

```sh
pnpm run test
```
