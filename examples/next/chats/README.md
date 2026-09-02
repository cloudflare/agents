# Next: chats

The recommended shape for "many chats per user": **one top-level Durable
Object per chat** (`ChatAgent`), owned and routed to by **one per-user hub**
(`UserAgent`) built on `RoutedAgents` from `agents/routing`.

```
UserAgent "alice"                          ChatAgent (one per chat, opaque name)
┌────────────────────────────────┐         ┌──────────────────────────┐
│ RoutedAgents route "chats"     │ forward │ messages                 │
│  id → physical name,           │────────▶│  role, text, at          │
│       title, lastMessage       │         │  (own SQLite, own alarms,│
│                                │◀────────│   own placement)         │
└────────────────────────────────┘  push   └──────────────────────────┘
   listChats / searchChats / deleteChat       addMessage / getMessages
   read and write ONLY the hub                 owns its WebSocket

/agents/user-agent/alice                -> the hub
/agents/user-agent/alice/chats/{id}     -> that chat, suffix preserved
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

## What `RoutedAgents` does for the hub

- **Creation** allocates a public chat ID and an opaque physical name.
  The hub then calls `init()` on the new chat once so it knows its owner.
- **Routing.** Requests and WebSocket upgrades under `/chats/{id}` are
  forwarded to that chat. The chat answers the upgrade and owns the
  socket, so chat frames never wake the hub.
- **Listing and search** read only the hub. Each chat pushes its title
  and last message back with `recordChatActivity()`, which fences the
  push's own timestamp against the entry's current one before calling
  `setMetadata()` — a push delayed by a slow round-trip can't overwrite
  a more recent one that arrived first. Entries list most recently
  updated first, ties broken by write order.
- **Deletion** is `chats.delete(id)`: the entry is hidden, the chat is
  condemned so it wipes its own storage moments later, and the row is
  removed. A push for a deleted chat returns `false`, so delayed
  activity cannot resurrect it.

The pushed metadata is derived data. A failed push leaves it stale until
the chat's next message; the chat itself stays the source of truth.
Idempotency and repair belong to the production design in
[`design/rfc-user-chat-durable-objects.md`](../../../design/rfc-user-chat-durable-objects.md).

## Run

```sh
pnpm install
pnpm run start
```

The React UI (Vite + Kumo) shows the whole pattern: the sidebar and
search use one `useAgent` connection to the hub, and each open chat gets
its own WebSocket through the hub's route via `basePath`.

## Test

```sh
pnpm run test
```
