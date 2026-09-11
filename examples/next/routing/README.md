# Next: routing

An early-access example showing `RoutedAgents` from `agents/routing`
installed on a plain Cloudflare `DurableObject`. The hub does not extend
`Agent`; its targets do. It is the recommended shape for "many chats per
user": **one top-level Durable Object per chat** (`ChatAgent`), owned and
routed to by **one per-user hub** (`UserHub`).

```
UserHub "alice" (plain DurableObject)      ChatAgent (one per chat, opaque name)
┌────────────────────────────────┐         ┌──────────────────────────┐
│ RoutedAgents route "chats"     │ forward │ messages                 │
│  id → physical name,           │────────▶│  role, text, at          │
│       title, lastMessage       │         │  (own SQLite, own alarms,│
│ WebSockets callables           │◀────────│   own placement)         │
└────────────────────────────────┘  push   └──────────────────────────┘
   listChats / searchChats / deleteChat       addMessage / getMessages
   read and write ONLY the hub                 owns its WebSocket
```

| URL                                           | Handled by                                  |
| --------------------------------------------- | ------------------------------------------- |
| `/agents/user-hub/alice`                      | `UserHub` "alice", JSON view of the catalog |
| `/agents/user-hub/alice?__agents_rpc=capnweb` | `UserHub` "alice", callables over Cap'n Web |
| `/agents/user-hub/alice/chats/{id}`           | the `ChatAgent` behind that entry           |
| `/agents/user-hub/alice/chats/{id}/messages`  | same `ChatAgent`, sees the path `/messages` |

```ts
export class UserHub extends DurableObject<Env> {
  readonly chats = new RoutedAgents<ChatAgent, ChatMeta>({
    namespace: this.env.ChatAgent,
    route: "chats"
  });
  readonly webSockets = new WebSockets({ callables: new HubCallables(this) });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.chats)
    .use(this.webSockets);
}
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

- **Creation** allocates a public chat ID and an opaque physical name
  without waking anything. The hub then calls `init()` on the new chat
  once, through the typed stub `get(id)` returns, so the chat knows its
  owner.
- **Routing.** Requests and WebSocket upgrades under `/chats/{id}` are
  forwarded to that chat. The chat answers the upgrade and owns the
  socket, so chat frames never wake the hub. An unknown or deleted ID is
  a `404` from the capability; the hub's `onRequest` never sees it.
- **Listing and search** read only the hub. Each chat pushes its title
  and last message back with `recordChatActivity()`, which fences the
  push's own chat-local message ordinal against the entry's current one,
  inside `blockConcurrencyWhile`, before calling `setMetadata()` — a
  push delayed by a slow round-trip can't overwrite one that arrived
  first, two concurrent pushes can't both read the same stale value, and
  two messages landing in the same millisecond never tie the way a
  wall-clock fence would. Entries list most recently updated first, ties
  broken by write order.
- **Deletion** is `chats.delete(id)`: the entry is hidden, the chat is
  condemned so it wipes its own storage moments later, and the row is
  removed. A push for a deleted chat returns `false`, so delayed
  activity cannot resurrect it.

The pushed metadata is derived data. A failed push leaves it stale until
the chat's next message; the chat itself stays the source of truth.
Idempotency and repair belong to the production design in
[`design/rfc-user-chat-durable-objects.md`](../../../design/rfc-user-chat-durable-objects.md).

## The hub is a plain Durable Object

The hub has no `@callable()` methods and no Agent protocol. Its browser
interface is an `RpcTarget` served by the `WebSockets` capability as
Cap'n Web callables: the client opens one session with
`newWebSocketRpcSession(callablesRpcUrl(hubUrl))` and calls `createChat()`,
`listChats()`, `searchChats()`, and `deleteChat()` as ordinary methods.
Each chat still reaches its owner with a plain Durable Object stub,
`env.UserHub.getByName(userId)`.

Install order matters: `RoutedAgents` goes first so a forwarded upgrade
under `/chats/{id}` reaches the chat, and only the hub's own upgrades fall
through to the callables endpoint.

Two sharp edges to design around:

- **Pick a route that cannot collide.** Forwarding matches every occurrence
  of the route segment in the path. If the hub's own name, or a path the
  hub handles itself, is literally `chats`, a coincidental match with no
  active entry behind it is answered `404` instead of reaching the hub.
- **A routed suffix cannot address a chat's own dynamic agents.** A
  `/sub/{class}/{name}` marker is resolved against the hub before this
  capability runs. Reach a chat's dynamic agents through a direct
  connection to that chat.

## Run

```sh
pnpm install
pnpm run start
```

The React UI (Vite + Kumo) shows the whole pattern: the sidebar and
search use one Cap'n Web session to the hub, and each open chat gets
its own `useAgent` WebSocket through the hub's route via `basePath`.
No model is wired in; the "assistant" reply is an echo that proves both
roles land in the chat's own SQLite.

## Test

```sh
pnpm run test
```
