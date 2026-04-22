# Multi AI Chat

Multi-session AI chat built on the sub-agent routing primitive. A
single `Inbox` Durable Object owns the chat list + per-user shared
memory; each chat is a **facet** of that inbox — its own
`AIChatAgent` DO, colocated on the same machine, with isolated
SQLite storage.

This is the pattern the proposed `Chats` base class in
[`design/rfc-think-multi-session.md`](../../design/rfc-think-multi-session.md)
will codify as sugar. When that RFC lands, most of `Inbox` becomes
`extends Chats<Env>` and the client-side wiring collapses to a
single `useChats()` hook — but the mechanics underneath are already
shipped and demonstrated here.

## Run

```bash
npm install
npm start
```

Open the dev URL. Click **New** to create a chat. Start chatting.

The assistant has three tools it can choose to call during a turn:

- `rememberFact(fact)` — saves a fact to the user's shared memory
  (persisted on the parent `Inbox`, visible to every chat on the
  next turn). Try: _"Remember I prefer TypeScript over JavaScript."_
- `recallMemory()` — reads the full shared memory.
- `getCurrentTime()` — returns the server's current ISO time.

Each tool call renders in-line as a collapsible panel with state,
input, and output; reasoning traces (if the model emits any) show
up as dimmed "Thinking" blocks. Text, reasoning, and tool parts
stream in order as the model produces them.

You can also type a fact in **Shared memory** at the bottom of the
sidebar and hit **Save memory** to set it manually — useful when
you want to seed the assistant with context without a tool call.

## What's going on

```
  ┌─────────────────────────────────────────────┐
  │  Inbox (top-level DO, "demo-user")          │
  │  - chats: [ ... ]  (broadcast via state)    │
  │  - memory: "…"     (shared context)         │
  │  - onBeforeSubAgent → strict-registry gate  │
  │  - @callable: create/rename/deleteChat,     │
  │               get/setSharedMemory, ...      │
  └──┬────────────┬──────────────┬──────────────┘
     │ subAgent(Chat, id) — facets, one per chat
     ▼            ▼              ▼
  ┌────────────┐ ┌────────────┐ ┌────────────┐
  │ Chat abc   │ │ Chat def   │ │ Chat ghi   │
  │ AIChatAgent│ │ AIChatAgent│ │ AIChatAgent│
  │ parentPath │ │ parentPath │ │ parentPath │
  │  → Inbox   │ │  → Inbox   │ │  → Inbox   │
  └────────────┘ └────────────┘ └────────────┘
```

URL shapes the client connects to:

- `/agents/inbox/demo-user` — the sidebar / Inbox RPC surface.
- `/agents/inbox/demo-user/sub/chat/{chatId}` — a specific chat. The
  Inbox parent gatekeeps via `onBeforeSubAgent`, then the WebSocket
  is upgraded straight to the `Chat` facet.

Key things worth looking at in `src/server.ts`:

- `Inbox.onBeforeSubAgent` — a strict-registry gate. A chat becomes
  reachable only after `createChat` has called `this.subAgent(Chat, id)`
  once. `hasSubAgent` reads the framework-maintained registry that
  `subAgent` / `deleteSubAgent` populate. Unknown chat ids get a 404
  before any facet is woken.
- `Inbox.createChat` and `deleteChat` — both touch the user-facing
  `inbox_chats` table and call `this.subAgent(Chat, id)` /
  `this.deleteSubAgent(Chat, id)` to keep the registry in sync.
- `Chat.getInbox()` — resolves the parent via `this.parentPath[0]`,
  the root-first ancestor chain the framework populates at facet-init
  time. No hardcoded user id inside the chat.
- The worker entry is a one-liner: `routeAgentRequest(request, env)`.
  It already knows how to walk `/agents/inbox/.../sub/chat/...` — no
  custom routing needed.

And in `src/client.tsx`:

- The sidebar connection:
  `useAgent({ agent: "Inbox", name: DEMO_USER })`.
- The active chat connection:
  `useAgent({ agent: "Inbox", name: DEMO_USER, sub: [{ agent: "Chat", name: chatId }] })`.
  The `sub` array builds the nested URL; `useAgentChat` wraps the
  resulting socket unchanged.

## Why this shape

- **One Durable Object per chat** means two chats for the same user
  run in parallel. If all chats lived inside a single DO (a "session
  map" pattern), inference would serialize — DOs are single-threaded.
- **The Inbox keeps a single source of truth.** Chat creation,
  deletion, and shared memory all go through the parent. The registry
  - `hasSubAgent` gate prevents orphaned chats from accidentally
    being woken by speculative client requests.
- **`parentPath` replaces hardcoded parent lookups.** A child Chat
  doesn't need to know the user id — it knows its parent from the
  chain the framework gave it at facet-init time.
- **Shared memory lives on the parent, not inside each chat.** This
  is what makes "facts the assistant learns about you" persist across
  chats. A more ambitious app could bump this up to Session context
  blocks + search (see `Think` + the `RemoteContextProvider` proposal).

## Notes / limits

- Single-user demo — the Inbox name is hardcoded to `demo-user`. In a
  real app, authenticate first and use the user's id.
- Titles default to `Chat — YYYY-MM-DD`. LLM-generated titles are
  intentionally out of scope for the example.
- `onBeforeSubAgent` uses a permissive-by-default sketch: if you want
  to allow lazy chat creation on first connect (no explicit
  `createChat` step), drop the `hasSubAgent` check — the framework
  will call `subAgent()` as part of dispatch.

## Related

- [`design/rfc-sub-agent-routing.md`](../../design/rfc-sub-agent-routing.md)
  — the routing primitive this example is built on. `onBeforeSubAgent`,
  `parentPath`, `useAgent({ sub })`, `hasSubAgent`, etc.
- [`design/rfc-think-multi-session.md`](../../design/rfc-think-multi-session.md)
  — the follow-up `Chats` base class + `useChats()` hook, which will
  turn most of this example into ~10 lines of sugar.
- [`design/rfc-ai-chat-maintenance.md`](../../design/rfc-ai-chat-maintenance.md)
  — stance on how `AIChatAgent` is maintained alongside `Think`.
- [`examples/ai-chat`](../ai-chat) — single-conversation AIChatAgent
  demo with MCP, tools, approval, browser tools.
