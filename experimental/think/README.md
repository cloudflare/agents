# Think — Coding Agent

Experimental exploration of building a coding agent (and eventually a general personal assistant) entirely on Workers, Durable Objects, and the Agents SDK.

## Architecture

```
ThinkAgent (Agent — session orchestrator)
  ├── threads table (own SQLite)
  ├── WebSocket transport to browser
  ├── Gatekeeper for tool approval (future)
  │
  ├── Chat facet "thread-abc" (AgentFacet — isolated SQLite)
  │     ├── Message persistence
  │     ├── Tool state tracking
  │     ├── Streaming message management
  │     └── AgentLoop (step-at-a-time LLM execution)
  │
  ├── Chat facet "thread-def" (independent conversation)
  └── Sandbox facet (future — code execution, restricted env)
```

### Three layers

**AgentFacet** (`src/agent-facet.ts`) — base class for all facets. Extends `DurableObject` with:
- `this.sql` tagged template (same API as Agent)
- Full scheduling (delayed, Date, cron, interval with overlap detection + hung timeout)
- Abort controller lifecycle
- `this.retry()` with jittered exponential backoff
- `onError()` hook, `onStart()` lifecycle, `destroyed` flag
- Static `options` for retry defaults and hung schedule timeout

**Chat** (`src/chat.ts`) — extends AgentFacet. A single conversation thread:
- Message CRUD + batch `persistMessages()` with incremental diffing
- Row size limits (1.8MB cap, generic truncation of largest strings)
- `maxPersistedMessages` with oldest-first eviction
- OpenAI message sanitization (strips `itemId`, empty reasoning parts)
- Tool state tracking (`applyToolResult`, `applyToolApproval`) for both streaming and persisted messages
- Streaming message management (`startStreamingMessage` / `completeStreamingMessage`)
- Generic over message type — only requires `{ id: string }`

**ThinkAgent** (`src/server.ts`) — extends Agent. The session orchestrator:
- Thread registry (create, delete, rename, list) in its own SQLite
- Routes messages to per-thread Chat facets via `ctx.facets.get()`
- WebSocket transport to the browser (thread-aware protocol)
- All public methods are RPC-callable — a parent gadget can drive it without WebSockets

### AgentLoop

The agent loop (`src/agent-loop.ts`) is a standalone class — not a DO, not a facet. It:
- Takes a model + tools + messages, calls `generateText`, returns a structured result
- Runs one LLM call per `step()` invocation (step-at-a-time, not auto-looping)
- Has no opinion about persistence or transport — the caller decides
- Is testable with mock models and in-memory arrays

Chat wires the loop to its storage via `runStep()`. The loop is shared infrastructure — future facet types (task runner, research agent) compose differently with the same loop.

### Why facets

Facets (`ctx.facets`, experimental) give each thread its own SQLite database, co-located on the same machine as the parent:

- Thread isolation is structural, not by-convention
- The parent controls lifecycle (create, delete, restrict capabilities)
- Each facet inherits scheduling, SQL, retry from AgentFacet
- Works in dev with the `"experimental"` compatibility flag

### Why not AIChatAgent

`@cloudflare/ai-chat` bundles message persistence, streaming protocol, tool handling, and WebSocket transport into one class. A personal assistant needs different things:

- The agent loop may run for minutes or hours (long tool calls, hibernation, resume)
- Messages come from multiple sources (user, agent, tools, system)
- The transport is pluggable (WebSocket for browser, RPC for gadgets)
- Thread management is first-class
- The gatekeeper pattern needs structural separation between the loop and the policy layer

### WebSocket protocol

Every message carries a `threadId`. The server sends:

- `THREADS` — full thread list (on connect + after mutations)
- `SYNC` — messages for a thread (after mutations or on `GET_MESSAGES` request)
- `CLEAR` — thread was cleared

The client sends:

- `ADD` / `DELETE` / `CLEAR_REQUEST` — message operations, scoped to a thread
- `CREATE_THREAD` / `DELETE_THREAD` / `RENAME_THREAD` — thread management
- `GET_MESSAGES` — request messages for a thread (used on select/refresh)

URL routing: `/#threadId` maps to the active thread. Survives refresh, supports browser back/forward.

## What's here

```
src/
  agent-facet.ts  AgentFacet — base class (sql, scheduling, abort, retry)
  agent-loop.ts   AgentLoop — step-at-a-time LLM execution
  chat.ts         Chat — conversation facet (messages, tools, streaming)
  server.ts       ThinkAgent — session orchestrator (threads, WebSocket)
  shared.ts       Types and protocol
  client.tsx      React UI with thread sidebar + hash routing
  index.tsx       React entry point
  styles.css      Tailwind + Kumo theme

tests/
  agent-facet.test.ts  AgentFacet via DO stub (sql, scheduling, destroy)
  core.test.ts         Chat via DO stub (CRUD, batch, tools, streaming, sanitization)
  sync.test.ts         ThinkAgent via WebSocket + RPC (threads, sync, GET_MESSAGES)

e2e/
  sync.spec.ts         Full-stack Playwright tests
```

## Run

```bash
npm install && npm run start
```

## Test

```bash
npm run test:workers   # vitest-pool-workers (AgentFacet + Chat + ThinkAgent)
npm run test:e2e       # Playwright (full stack)
```

## Design influences

- **PI / OpenClaw** — layered agent framework (pi-ai → pi-agent-core → pi-coding-agent). Same separation: LLM provider → agent loop → session/tools. PI validates the step-at-a-time loop + composable tools pattern. Key ideas borrowed: `steer` (interrupt mid-loop) vs `followUp` (queue for after), extensions as lifecycle hooks, tool factories with operations override for sandboxing.
- **@cloudflare/ai-chat** — message persistence patterns (incremental diffing, row size limits, OpenAI sanitization, tool state tracking). Adapted for facet isolation instead of single-DO-does-everything.
- **Gadgets experiments** — facet architecture, parent-child RPC, structural capability control.
