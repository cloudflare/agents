# Session Agent Example

Demonstrates the **experimental session primitives** from `agents/experimental/memory` — SQL-backed sessions, append-only event storage, ephemeral `WorkingContext`, and the Workers AI adapter.

> ⚠️ The session primitives API is experimental and may change without notice.

## What it does

- Extends `SessionAgent` to get built-in session and event management via DO SQLite
- Runs an agentic loop with tool calling (echo + weather tools)
- Accumulates user message, tool calls/results, and assistant response in-memory
- Batch-persists the entire turn atomically at the end (concurrency-safe)
- Loads the most recent completed events for context

## Usage

```bash
npm install
npm run dev
```

### Chat

```bash
curl -X POST "http://localhost:8787/chat?agent=test" \
  -H "Content-Type: application/json" \
  -d '{"query": "What is the weather in San Francisco?"}'
```

### Get session + events

```bash
curl "http://localhost:8787/session?agent=test"
```

### Reset session

```bash
curl -X DELETE "http://localhost:8787/session?agent=test"
```

## How it works

```
POST /chat
  → buildContext(sessionId)           # load completed events → WorkingContext
  → ctx.addMessage(userMessage)       # add user message in-memory only
  → workersAIAdapter.toModelMessages  # convert to Workers AI format
  → env.AI.run(model, ...)           # LLM call
  → handle tool calls (loop)         # accumulate in-memory
  → persistWorkingContext(sessionId)  # batch-persist user + assistant atomically
```

The user message is **not** persisted before the LLM call. This prevents concurrent
requests from seeing each other's in-flight user messages via `loadEvents()`. The
entire turn (user message + tool calls + assistant response) is written atomically
at the end.

Key primitives used:

| Primitive                                     | Purpose                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `SessionAgent`                                | Agent subclass with session/event SQL tables                |
| `buildContext` (wraps `_buildWorkingContext`) | Load completed events from SQL → `WorkingContext`           |
| `workersAIAdapter`                            | Convert `WorkingContext` messages to Workers AI format      |
| `persistWorkingContext`                       | Batch-persist all new messages (user + assistant) as events |
