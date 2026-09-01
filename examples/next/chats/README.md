# Next: chats

The recommended shape for "many chats per user": **one top-level Durable
Object per chat** (`ChatAgent`), plus **one per-user index DO**
(`UserAgent`) that every chat pushes its metadata into.

```
UserAgent "alice"                ChatAgent "alice:{chatId}" (one per chat)
┌───────────────────────┐        ┌──────────────────────────┐
│ chats                 │ upsert │ messages                 │
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
pinned to one machine and shares the parent DO's storage budget), and
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
stay the source of truth.

## Run

```sh
pnpm install
pnpm run dev
```

Everything is exposed via `@callable` RPC; the routing worker serves the
standard `/agents/{class}/{name}` surface, so you can drive it with the
agents client or from another Worker via `getAgentByName`.

## Test

```sh
pnpm run test
```
