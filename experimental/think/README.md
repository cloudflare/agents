# Think — Coding Agent

Experimental exploration of building a coding agent entirely on Workers, Durable Objects, and the Agents SDK. This is scaffolding for the infrastructure layer — message persistence, multi-thread management, and the facet-based architecture that the agent loop will run on.

## Architecture

```
ThinkAgent (Agent, owns WebSocket connections)
  ├── threads table (own SQLite — thread registry)
  ├── ctx.facets.get("thread-abc") → Chat (isolated SQLite)
  ├── ctx.facets.get("thread-def") → Chat (isolated SQLite)
  └── ctx.facets.get("thread-xyz") → Chat (isolated SQLite)
```

Two classes, two levels of storage:

**ThinkAgent** extends `Agent` and is the orchestrator. It owns WebSocket connections to the browser, maintains a thread registry in its own SQLite, and routes messages to per-thread Chat facets. All public methods (`createThread`, `deleteThread`, `renameThread`, `getThreads`) are callable via RPC — a parent gadget can drive ThinkAgent without WebSockets.

**Chat** extends `DurableObject` and is a facet — a child DO with isolated SQLite, created by the parent via `ctx.facets.get()`. Each Chat instance is one conversation thread. Its public API (`addMessage`, `deleteMessage`, `clearMessages`, `getMessages`) is the RPC surface that ThinkAgent calls. Chat has no opinion about transport — it doesn't know about WebSockets, clients, or broadcasting. It just persists messages.

### Why facets

Facets (`ctx.facets`, experimental) give each thread its own SQLite database, co-located on the same machine as the parent. This means:

- Thread isolation is structural, not by-convention. Each Chat cannot access another Chat's data.
- The parent controls the lifecycle — it can create, delete, and restrict capabilities of each thread.
- When the facet API ships, this architecture maps directly. For now, it works in dev with the `"experimental"` compatibility flag.

### Why not AIChatAgent

`@cloudflare/ai-chat` bundles together message persistence, the AI SDK streaming protocol, tool handling, stream resumption, and WebSocket transport. That's great for chat apps, but a coding agent needs different things:

- The agent loop may run for minutes or hours (long tool calls, hibernation, resume). The loop needs to be manually stepped, not driven by a streaming response.
- Messages might come from the agent itself (tool results, status updates), not just from user input or LLM output.
- The transport is pluggable — when running inside a gadget, the parent communicates via RPC, not WebSocket.
- Thread management is first-class — a single agent manages multiple independent conversations.

So we built the message layer from scratch, keeping it generic enough to swap the message format later (the sync layer only requires `{ id: string }`).

### Message format

The sync layer is parameterized over the message type via `BaseMessage = { id: string }`. The current concrete type is `ThinkMessage` (role + content + createdAt), but this will switch to AI SDK's `UIMessage` when the agent loop lands. The persistence layer stores messages as opaque JSON blobs — it doesn't inspect the shape beyond the `id` field.

### WebSocket protocol

Every message in the protocol carries a `threadId`. The server sends:

- `THREADS` — the full thread list (on connect + after thread mutations)
- `SYNC` — all messages for a specific thread (after message mutations)
- `CLEAR` — a thread was cleared

The client sends:

- `ADD` / `DELETE` / `CLEAR_REQUEST` — message operations, scoped to a thread
- `CREATE_THREAD` / `DELETE_THREAD` / `RENAME_THREAD` — thread management

The protocol is defined as discriminated unions in `src/shared.ts` and is the same whether the client is a browser or another agent.

## What's here

```
src/
  server.ts   ThinkAgent — orchestrator, thread registry, WebSocket transport
  chat.ts     Chat — facet, message persistence, RPC surface
  shared.ts   Types and protocol (BaseMessage, ThinkMessage, ThreadInfo, MessageType)
  client.tsx  React UI with thread sidebar
  index.tsx   React entry point
  styles.css  Tailwind + Kumo theme

tests/
  core.test.ts   Chat tested via DO stub (same as facet RPC) — 10 tests
  sync.test.ts   ThinkAgent tested via WebSocket + RPC — 14 tests

e2e/
  sync.spec.ts   Full-stack Playwright tests — 4 tests
```

## Run

```bash
npm install && npm run start
```

## Test

```bash
npm run test:workers   # vitest-pool-workers (Chat + ThinkAgent)
npm run test:e2e       # Playwright (full stack)
```

## What's next

- Agent loop: step-at-a-time `generateText` calls, tool dispatch, suspend/resume via alarms
- Switch `ThinkMessage` to AI SDK `UIMessage` (parts-based, supports tool calls and reasoning)
- Sandbox facet for code execution (isolated, restricted capabilities)
- Long-running tool support: persist pending tool calls, hibernate, resume when results arrive
