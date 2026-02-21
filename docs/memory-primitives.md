# Memory Primitives (Experimental)

The `agents/experimental/memory` module adds session management, durable event storage, and ephemeral working context to the Agent. It is built around a `SessionAgent` subclass that extends `Agent` with SQL-backed session and event primitives, plus pure utility functions and model format adapters that work anywhere (Agents, Workflows, Workers).

> **⚠️ Experimental** — this module is unstable and may change without notice.

## Core Concepts

An **Agent** can have multiple **Sessions**. Each session is an ordered log of **Events** stored as individual rows in DO SQLite (one event per row, avoiding the 2MB row limit). A **WorkingContext** is an ephemeral, in-memory view of a subset of session events, built per-request and used for LLM invocations. After the request completes, only the new messages are batch-persisted back as events.

## Source Layout

```
packages/agents/src/experimental/memory/
├── index.ts              # Barrel exports
├── types.ts              # EventAction, SessionEvent, ContextMessage, StoredEvent, interfaces
├── utils.ts              # Pure functions: hydrateEvent, dehydrateEvent, eventToMessage, messageToEvent
├── context.ts            # WorkingContext class + buildWorkingContext pure function
├── session-agent.ts      # SessionAgent extends Agent — SQL tables, session/event CRUD
├── adapters/
│   ├── index.ts          # Re-exports ModelFormatAdapter + built-in adapters
│   └── workers-ai.ts     # Workers AI chat completions adapter
└── __tests__/
    ├── vitest.config.ts  # Node environment config
    ├── utils.test.ts     # hydrate/dehydrate roundtrips, event↔message mapping
    ├── context.test.ts   # WorkingContext, buildWorkingContext
    └── adapters.test.ts  # Workers AI adapter output format
```

## File Descriptions

### `types.ts`

All shared type definitions. Key exports:

- **`EventAction`** — string enum: `user_message`, `agent_message`, `tool_call_request`, `tool_result`, `system_instruction`, `compaction`.
- **`SessionEvent`** — discriminated union over `EventAction`. Each variant carries action-specific fields (e.g., `toolCalls` for `tool_call_request`, `toolCallId` for `tool_result`).
- **`StoredEvent` / `StoredSession`** — raw SQL row shapes (snake_case column names, JSON metadata as `string | null`).
- **`ContextMessage`** — common message format for `WorkingContext`, intentionally close to the OpenAI/Workers AI message shape. Includes structured `toolCalls?: ToolCall[]`.
- **`LoadEventsOptions` / `ContextBuilderOptions`** — option bags for loading events and building context.
- **`ModelFormatAdapter`** — interface for stateless adapters that convert `WorkingContext` messages to provider-specific input.

### `utils.ts`

Pure functions with **no SQL dependency** — safe to use from Agents, Workflows, Workers, or tests.

- **`hydrateEvent(row)`** — converts a `StoredEvent` SQL row into a typed `SessionEvent`.
- **`dehydrateEvent(event)`** — converts a `SessionEvent` back into a `StoredEvent` for INSERT.
- **`eventToMessage(event)`** — converts a `SessionEvent` into a `ContextMessage` (returns `null` for events that shouldn't appear in LLM context).
- **`messageToEvent(sessionId, msg)`** — converts a `ContextMessage` into a `SessionEvent` (assigns a `crypto.randomUUID()` id, placeholder `seq`).

### `context.ts`

- **`WorkingContext`** — in-memory message array with system instructions. Tracks an internal `_initialCount` so `getNewMessages()` returns only messages added after construction. Thrown away after each request.
- **`buildWorkingContext(events, options?)`** — pure function that maps `SessionEvent[]` through `eventToMessage` and returns a `WorkingContext`. Accepts optional custom mapper via `options.eventToMessage`.

### `session-agent.ts`

`SessionAgent` extends `Agent` and creates the `cf_agents_sessions` and `cf_agents_events` SQL tables in its constructor (guaranteed to run, matching the `Agent` pattern for `cf_agents_state`, `cf_agents_queues`, etc.).

**RPC-safe methods** (return/accept plain serializable objects):

- **`createSession(metadata?)`** — creates a session row, returns the ID.
- **`getSession(sessionId)`** — returns `StoredSession | null`.
- **`listSessions()`** — returns all sessions for this agent.
- **`deleteSession(sessionId)`** — deletes a session and all its events.
- **`loadEvents(sessionId, opts?)`** — loads hydrated `SessionEvent[]` ordered by `seq`. Default limit: 50.
- **`appendEvents(sessionId, events)`** — validates session exists, assigns monotonic `seq` values, inserts rows.
- **`deleteEvents(sessionId, eventIds)`** — deletes specific events by ID.

**Local-only methods** (not for RPC — class instances lose methods over serialization):

- **`buildWorkingContext(sessionId, opts?)`** — loads events + builds a `WorkingContext`. **Local use only** — do not call via RPC.
- **`persistWorkingContext(sessionId, ctx)`** — extracts new messages from a `WorkingContext`, converts to events, and appends them.

### `adapters/workers-ai.ts`

Stateless adapter for Cloudflare Workers AI chat completions format. Converts system instructions into a single system message, maps `ContextMessage` to `WorkersAIChatMessage`, and formats structured `toolCalls` into Workers AI's `tool_calls` array (with `type: "function"` and stringified `arguments`).

## SQL Schema

```sql
CREATE TABLE IF NOT EXISTS cf_agents_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,  -- ms since epoch
  updated_at INTEGER NOT NULL,  -- ms since epoch
  metadata TEXT                 -- JSON
);

CREATE TABLE IF NOT EXISTS cf_agents_events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,         -- monotonic insertion order within session
  action TEXT NOT NULL,
  content TEXT,
  metadata TEXT,                -- JSON
  created_at INTEGER NOT NULL   -- ms since epoch
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq
  ON cf_agents_events(session_id, seq);
```

## Usage

### Inside the Agent

```ts
class MyAgent extends SessionAgent<Env> {
  async handleUserMessage(sessionId: string, userMessage: string) {
    const ctx = this.buildWorkingContext(sessionId, {
      systemInstructions: ["You are a helpful assistant."],
      limit: 10
    });
    ctx.addMessage({ role: "user", content: userMessage });

    const modelInput = workersAIAdapter.toModelMessages(
      ctx.systemInstructions,
      ctx.messages
    );
    const response = await this.env.AI.run(
      "@cf/meta/llama-3-8b-instruct",
      modelInput
    );

    ctx.addMessage({ role: "assistant", content: response.response });
    this.persistWorkingContext(sessionId, ctx);

    return response.response;
  }
}
```

### From a Workflow (via RPC)

```ts
const agent = await getAgentByName<SessionAgent>(env.MY_AGENT, "agent-id");

// RPC — returns plain serializable data
const events = await agent.loadEvents(sessionId, { limit: 10 });

// Build context locally (pure function, no RPC)
const ctx = buildWorkingContext(events, {
  systemInstructions: ["You are a helpful assistant."]
});
ctx.addMessage({ role: "user", content: userMessage });

// ... call LLM, accumulate messages ...

// Persist new messages back via RPC
const newEvents = ctx
  .getNewMessages()
  .map((msg) => messageToEvent(sessionId, msg));
await agent.appendEvents(sessionId, newEvents);
```

## Testing

Tests use Vitest with a node environment config (`__tests__/vitest.config.ts`). Run with:

```sh
npx vitest run --config src/experimental/memory/__tests__/vitest.config.ts
```

- **`utils.test.ts`** — 26 tests: hydrate/dehydrate roundtrips, event↔message mapping, edge cases.
- **`context.test.ts`** — 11 tests: WorkingContext construction, new message tracking, custom mappers.
- **`adapters.test.ts`** — 8 tests: Workers AI format, tool calls, full agentic loop conversation.

## Known Limitations

> This module is experimental. Expect breaking changes.

- **Workers AI only** — only the Workers AI adapter is shipped. OpenAI/Anthropic adapters are planned.
- **No compaction/summarization** — the event schema supports compaction events, but no orchestration or auto-compaction is implemented yet. Bring your own summarizer.
- **No token estimation** — there is no built-in token counter. Use an external estimator or character-based heuristic if you need to enforce context limits.
- **Concurrent request context divergence** — two simultaneous requests to the same agent DO will each build separate `WorkingContext` snapshots from the last completed turn. User messages should be added in-memory (via `ctx.addMessage`) and persisted atomically with the full turn via `persistWorkingContext` — **not** via `appendEvents` before the LLM call, which would leak in-flight messages to concurrent requests. Even with this pattern, concurrent LLM responses may be contextually divergent since neither request sees the other's in-flight messages.
- **No Vercel AI SDK integration** — only raw Workers AI `env.AI.run()` is supported via the adapter.
- **`buildWorkingContext` is local-only** — do not call via RPC; the returned `WorkingContext` class instance loses its methods when serialized.

## Key Design Decisions

| Decision      | Choice                                           | Rationale                                                     |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Storage       | One event per row + `seq` column                 | Avoids 2MB row limit, deterministic ordering                  |
| Timestamps    | Milliseconds everywhere (`Date.now()`)           | No seconds/ms mismatch                                        |
| Session API   | `SessionAgent` subclass + pure utility functions | RPC-accessible CRUD; pure fns for local/testable logic        |
| RPC safety    | `buildWorkingContext` is local-only (documented) | Prevents dead-object trap over RPC boundary                   |
| Tool calls    | Structured `ToolCall[]` on `ContextMessage`      | Preserves structure through storage→load→adapter roundtrips   |
| Validation    | Application-level (no FK constraints)            | SQLite FK OFF by default                                      |
| Default limit | `loadEvents` defaults to 50                      | Prevents accidental full-table scans                          |
| Compaction    | Deferred                                         | Architecture supports it (event deletion + summary insertion) |
