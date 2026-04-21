# Multi AI Chat

Multi-session AI chat: a parent `Inbox` Durable Object owns a list of
chats and per-user shared memory; each chat is its own `AIChatAgent`
Durable Object.

This is the hand-rolled preview of the `Chats` pattern proposed in
[`design/rfc-think-multi-session.md`](../../design/rfc-think-multi-session.md).
When that RFC lands, most of `Inbox` becomes `extends Chats<Env>` and
the client-side wiring becomes a single `useChats()` hook call.

## Run

```bash
npm install
npm start
```

Open the dev URL. Click **New** to create a chat. Start chatting.
Type a fact in **Shared memory** at the bottom of the sidebar and hit
**Save memory** — every chat (existing and new) will see that memory
injected into its system prompt on the next turn.

## What's going on

```
┌───────────────────────────────────────────┐
│  Inbox (DO named "demo-user")             │
│  - chats: [ ... ] (broadcast via state)   │
│  - memory: "…"  (shared context)          │
│  - @callable: createChat / delete / rename│
│               getSharedMemory / set       │
└────┬──────────────────────────────────────┘
     │ DO namespace RPC
     ▼
┌───────────────────────┐  ┌───────────────────────┐
│  Chat (chat-abc)      │  │  Chat (chat-def)      │
│  AIChatAgent          │  │  AIChatAgent          │
│  onChatMessage → …    │  │  onChatMessage → …    │
│  onChatResponse →     │  │  onChatResponse →     │
│    inbox.recordChat…  │  │    inbox.recordChat…  │
└───────────────────────┘  └───────────────────────┘
```

Key things worth looking at in `src/server.ts`:

- `Inbox extends Agent<Env, InboxState>` — plain Agent, no framework
  magic. Its `state.chats` array is broadcast to connected clients
  automatically (it's the standard Agent state sync protocol).
- `Chat extends AIChatAgent` — plain AIChatAgent. In `onChatMessage`
  it RPCs its parent Inbox to read shared memory. In `onChatResponse`
  it RPCs again to update the sidebar preview.
- The client connects to both: one `useAgent({ agent: "inbox", ... })`
  for the sidebar, one `useAgent({ agent: "chat", name: activeId })`
  for the active chat. `useAgentChat` works unchanged.

## Why this shape

- **One Durable Object per chat** means two chats for the same user
  run in parallel. If all chats lived inside a single DO (a "session
  map" pattern), inference would serialize — DOs are single-threaded.
- **The Inbox is just an Agent.** If you need other background work
  (search indexer, summarizer, anything), use `this.subAgent(...)`
  from Inbox with a distinct class name. Nothing in this pattern
  precludes that.
- **Shared memory lives on the parent, not inside each chat.** This
  is what makes "facts the assistant learns about you" persist across
  chats. A more ambitious app could bump this up to Session context
  blocks + search (see `Think` + the `RemoteContextProvider` proposal).

## Notes / limits

- Single-user demo — the Inbox name is hardcoded to `demo-user`. In a
  real app, authenticate first and use the user's id.
- Deleting a chat leaves the child Chat DO to hibernate and be GC'd by
  TTL. Production: RPC the child to clear its messages before dropping
  the row. The `Chats` RFC covers the lifecycle rules.
- Titles default to `Chat — YYYY-MM-DD`. LLM-generated titles are
  intentionally out of scope for the example.

## Related

- [`examples/ai-chat`](../ai-chat) — single-conversation AIChatAgent
  demo with MCP, tools, approval, browser tools.
- [`design/rfc-think-multi-session.md`](../../design/rfc-think-multi-session.md)
  — proposal to codify this pattern as a `Chats` base class + React
  `useChats()` hook.
- [`design/rfc-ai-chat-maintenance.md`](../../design/rfc-ai-chat-maintenance.md)
  — stance on how `AIChatAgent` is maintained alongside `Think`.
