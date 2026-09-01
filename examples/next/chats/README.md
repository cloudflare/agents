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
│  updated_at, revision │        │   own placement)         │
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

The index is a derived projection; each Chat DO remains authoritative.
Messages use caller-supplied ids, so retrying a request cannot duplicate
a committed message. Each complete metadata snapshot carries the chat's
monotonic revision. The User DO applies only newer revisions, updates only
an existing catalog row, and assigns its own activity sequence. Delayed
snapshots therefore cannot overwrite newer metadata or recreate a deleted
chat.

A failed projection does not make the accepted message fail. The index may
be temporarily stale, and `UserAgent.repairChat(chatId)` pulls the latest
authoritative snapshot from that Chat DO. This keeps the example free of
callback objects, background queues, and dual-write races.

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
