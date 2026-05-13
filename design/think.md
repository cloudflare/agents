# Think

An opinionated Agent base class for AI assistants. Handles the chat lifecycle — message persistence, agentic loop, streaming, client tools, resumable streams, and extensions — all backed by Durable Object SQLite.

**Status:** experimental (`@cloudflare/think`, v0.1.2)

## Problem

Every AI agent built on the Agents SDK needs the same infrastructure:

- **Message persistence** — store messages, survive hibernation
- **Streaming** — stream LLM output to clients in real time, handle cancellation
- **Tool execution** — run tools in an agentic loop, manage step limits
- **Error recovery** — persist partial messages on failure, don't lose context
- **Message management** — sanitize provider metadata, enforce storage limits
- **Client tools** — dynamic tool registration from the browser, with result/approval flows
- **Resumable streams** — buffer chunks in SQLite, replay on reconnect

Building this from scratch for each agent is tedious and error-prone. The base `Agent` class provides the Durable Object primitives (SQLite, WebSocket, RPC, scheduling, fibers) but no opinion on how to run a chat.

Think is that opinion.

## Architecture overview

```
                            Browser
                              |
                        WebSocket (cf_agent_chat_* protocol)
                              |
                      ┌───────┴───────┐
                      │     Think     │
                      │  (top-level)  │
                      └───────┬───────┘
                              |
                 ┌────────────┼────────────┐
                 |            |             |
         SQLite Tables   Agentic Loop   Tools
         (flat messages) (streamText)
                 |            |             |
         ┌───────┴───────┐   |      ┌──────┴──────┐
         │  Messages     │   |      │ Workspace   │
         │  Request Ctx  │   |      │ Execute     │
         │  Config       │   |      │ Browser     │
         └───────────────┘   |      │ Extensions  │
                              |      └─────────────┘
```

Think operates in two modes:

1. **Top-level agent** — speaks the `cf_agent_chat_*` WebSocket protocol directly to browser clients via `useChat` + `AgentChatTransport`
2. **Sub-agent** — called via `chat()` over Durable Object RPC from a parent agent, streaming events through a `StreamCallback`

Both modes share the same internal lifecycle. The difference is only in how messages arrive and how responses are delivered.

## How it works

### Class hierarchy

```
Agent (agents SDK — includes runFiber, keepAlive, scheduling, etc.)
  └─ Think<Env, State, Props> — adds chat lifecycle, streaming, client tools
       └─ YourAgent extends Think<Env> — your overrides
```

Think extends `Agent` directly. Fiber support (`runFiber`, `stash`, `onFiberRecovered`) is inherited from the base class — no mixin needed.

### Override points

Think requires almost no boilerplate. The minimal subclass overrides one method:

```typescript
export class ChatSession extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6"
    );
  }
}
```

The full set of override points:

| Method               | Default                          | Purpose                               |
| -------------------- | -------------------------------- | ------------------------------------- |
| `getModel()`         | throws                           | Return the `LanguageModel` to use     |
| `getSystemPrompt()`  | `"You are a helpful assistant."` | System prompt                         |
| `getTools()`         | `{}`                             | AI SDK `ToolSet` for the agentic loop |
| `getMaxSteps()`      | `10`                             | Max tool-call rounds per turn         |
| `assembleContext()`  | prune older tool calls           | Customize what's sent to the LLM      |
| `onChatMessage()`    | `streamText(...)`                | Full control over inference           |
| `onChatError(error)` | passthrough                      | Customize error handling              |

### Step-by-step: a chat request

#### 1. Message arrival

**WebSocket path** (`_handleChatRequest`):

```
Client sends: { type: "cf_agent_use_chat_request", id: "req-abc", init: { method: "POST", body: JSON } }
```

The body contains `{ messages: UIMessage[], clientTools?: ClientToolSchema[] }`. Think appends each incoming message via `INSERT OR IGNORE` (idempotent on message ID), then reloads the full message list from SQLite. Client tool schemas are captured and persisted to SQLite (`think_request_context`) so they survive hibernation.

**RPC path** (`chat()`):

```typescript
await session.chat("Summarize the project", callback, { signal });
```

The parent agent calls `chat()` directly with a string or `UIMessage`.

#### 2. Abort controller setup

Each WebSocket request gets its own `AbortController`, keyed by request ID. The controller's signal is threaded through `onChatMessage()` → `streamText()` → the LLM provider. The `cf_agent_chat_request_cancel` message triggers `controller.abort()`.

For the RPC path, the caller passes an `AbortSignal` via `ChatOptions`.

#### 3. Agentic loop (`onChatMessage`)

The default implementation calls the AI SDK's `streamText()`:

```typescript
streamText({
  model: this.getModel(),
  system: this.getSystemPrompt(),
  messages: await this.assembleContext(),
  tools: { ...this.getTools(), ...clientToolSet },
  stopWhen: stepCountIs(this.getMaxSteps()),
  abortSignal: options?.signal
});
```

Client tool schemas (from the browser) are merged into the tool set via `createToolsFromClientSchemas()`. Tools for sub-agent turns are owned by the child agent through `getTools()`, extensions, MCP tools, session tools, or client tool schemas. Parent-child tool orchestration uses `agentTool()` / `runAgentTool()` rather than `chat()` options.

The agentic loop runs until:

- The model produces a text response with no tool calls (natural completion)
- The step count limit is reached
- The abort signal fires (user cancelled)
- An error occurs

#### 4. Context assembly (`assembleContext`)

The default implementation converts `this.messages` (UIMessage format) to model messages and prunes old tool calls:

```typescript
pruneMessages({
  messages: await convertToModelMessages(this.messages),
  toolCalls: "before-last-2-messages"
});
```

Override this to inject memory, project context, RAG results, or compaction summaries.

#### 5. Streaming

**WebSocket path** (`_streamResult`):

The `streamText()` result is iterated via `toUIMessageStream()`. Each chunk is simultaneously:

- **Applied to a `StreamAccumulator`** — builds the assistant `UIMessage` incrementally (text parts, reasoning, tool calls, tool results, sources, files). The accumulator detects error chunks and cross-message tool updates.
- **Stored for resumability** — `ResumableStream.storeChunk()` buffers chunks in SQLite for replay on reconnect.
- **Broadcast to clients** — each chunk is sent as `{ type: "cf_agent_use_chat_response", id, body: JSON, done: false }`, excluding connections pending stream resume.

When the stream completes:

```
{ type: "cf_agent_use_chat_response", id, body: "", done: true }
```

**RPC path** (`chat`):

Uses a separate `StreamAccumulator` and calls `callback.onEvent(json)` for each chunk, `callback.onDone()` on completion, `callback.onError(msg)` on error.

#### 6. Persistence

After the stream completes, the assembled assistant message is persisted with three transformations:

1. **Sanitize** — `sanitizeMessage()` strips provider ephemeral metadata (`itemId`, `reasoningEncryptedContent`), removes empty reasoning parts
2. **Enforce row size** — `enforceRowSizeLimit()` compacts tool outputs exceeding 1.8 MB (SQLite has a ~2 MB row limit)
3. **Incremental persist** — compares the serialized message to `_persistedMessageCache`. If unchanged, skips the SQL write. Uses `INSERT ON CONFLICT DO UPDATE` for the upsert.

After persistence, `maxPersistedMessages` is enforced by counting all messages and deleting the oldest ones beyond the limit. The updated message list is broadcast to all clients.

A `_turnQueue.generation` check prevents persisting into a cleared conversation — if the user cleared the chat while streaming, the generation counter will have changed and persistence is skipped.

#### 7. Error handling

If an error occurs during the agentic loop or streaming:

- **Partial message is persisted** — whatever was generated before the error is saved so context isn't lost (both WebSocket and RPC paths)
- **`onChatError(error)` is called** — override to log, transform, or swallow
- **Error is communicated** — WebSocket broadcasts `{ done: true, error: true }`, RPC calls `callback.onError()`

### Wire protocol

Think speaks the same WebSocket protocol as `@cloudflare/ai-chat`, making it compatible with `useAgentChat` and `useChat` + `AgentChatTransport`.

| Direction       | Message type                     | Purpose                                                     |
| --------------- | -------------------------------- | ----------------------------------------------------------- |
| Client → Server | `cf_agent_use_chat_request`      | Send a chat message (contains `{ messages, clientTools? }`) |
| Client → Server | `cf_agent_chat_clear`            | Clear the current conversation                              |
| Client → Server | `cf_agent_chat_request_cancel`   | Cancel a specific request by ID                             |
| Client → Server | `cf_agent_tool_result`           | Client tool result (output, state, optional error)          |
| Client → Server | `cf_agent_tool_approval`         | Tool approval/denial response                               |
| Client → Server | `cf_agent_stream_resume_request` | Request stream replay after reconnect                       |
| Client → Server | `cf_agent_stream_resume_ack`     | Acknowledge stream resume, trigger chunk replay             |
| Server → Client | `cf_agent_use_chat_response`     | Stream chunk (`done: false`) or completion (`done: true`)   |
| Server → Client | `cf_agent_chat_messages`         | Full message list broadcast (after persistence)             |
| Server → Client | `cf_agent_chat_clear`            | Confirm conversation was cleared                            |
| Server → Client | `cf_agent_stream_resuming`       | Notify client that a stream is active and can be resumed    |
| Server → Client | `cf_agent_stream_resume_none`    | No active stream to resume                                  |
| Server → Client | `cf_agent_message_updated`       | Single message update (after tool result/approval applied)  |

### Client tools

Client tools are tools defined by the browser at runtime (via `clientTools` in the chat request body). Think handles the full lifecycle:

1. **Registration** — client sends `ClientToolSchema[]` with the chat request. Think converts them to AI SDK tools via `createToolsFromClientSchemas()` and merges them into the tool set.

2. **Schema persistence** — `_lastClientTools` is persisted to `think_request_context` (SQLite) so client tools survive hibernation and are available during auto-continuations.

3. **Tool result** — client sends `cf_agent_tool_result` with `{ toolCallId, output, state?, errorText?, autoContinue?, clientTools? }`. Think finds the matching tool part in `this.messages`, updates its state to `output-available` (or `output-error`), persists the updated message, and broadcasts `cf_agent_message_updated`.

4. **Tool approval** — client sends `cf_agent_tool_approval` with `{ toolCallId, approved, autoContinue? }`. Think updates the tool part state to `approval-responded` (if approved) or `output-denied` (if denied), persists, and broadcasts.

5. **Auto-continuation** — when `autoContinue: true` is set on a tool result or approval, Think schedules a continuation turn after a 50ms coalesce window. This batches rapid-fire tool results into a single LLM call. The continuation runs the full `onChatMessage()` → stream → persist pipeline. Deferred continuations queue up if a continuation is already in flight.

### Resumable streaming

Think uses `ResumableStream` from `agents/chat` for stream resumability:

1. **Chunk buffering** — during streaming, each chunk is stored in SQLite via `ResumableStream.storeChunk()`.

2. **Reconnect detection** — when a client connects (`onConnect`), Think checks for an active stream and sends `cf_agent_stream_resuming`. The client is added to `_pendingResumeConnections` and excluded from live chunk broadcasts to avoid duplicates.

3. **Replay** — when the client sends `cf_agent_stream_resume_ack`, Think replays all buffered chunks via `ResumableStream.replayChunks()`. If the stream was orphaned (restored from SQLite after hibernation with no live reader), the partial assistant message is reconstructed from chunks and persisted.

4. **Continuation coordination** — `ContinuationState` tracks pending, active, and deferred continuation requests. Connections awaiting a continuation stream to start are queued and notified when the stream begins.

### Message storage

Think uses a flat `assistant_messages` table — no tree structure, no branching, no sessions:

```sql
CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,         -- JSON-serialized UIMessage
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

Messages are ordered by `created_at` on load. User messages use `INSERT OR IGNORE` (idempotent). Assistant messages use `INSERT ON CONFLICT DO UPDATE` (streaming builds incrementally).

A separate table stores request context across hibernation:

```sql
CREATE TABLE think_request_context (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

Currently stores only `lastClientTools`.

### Dynamic configuration

`configure()` / `getConfig()` persist a JSON-serializable blob in SQLite. The type is provided at the call site via a method-level generic:

```typescript
export class ChatSession extends Think<Env> {
  getModel() {
    const tier = this.getConfig<AgentConfig>()?.modelTier ?? "fast";
    return MODELS[tier];
  }
}
```

Configuration is stored in SQLite (`think_config`) and cached in memory. It
survives hibernation. Legacy Think-owned keys written into
`assistant_config(session_id, key, value)` are migrated into `think_config` on
startup. A parent orchestrator can configure sub-agents via RPC:

```typescript
const session = await this.subAgent(ChatSession, "agent-abc");
await session.configure<AgentConfig>({ modelTier: "capable" });
```

Prefer `Agent.state` / `setState` for values that should be broadcast to connected clients; `configure` stays private to the server.

### Sub-agent RPC entry point

When used as a sub-agent, the `chat()` method runs a full turn and streams events via a callback:

```typescript
interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}
```

The parent implements `StreamCallback` as an `RpcTarget` (so it crosses the DO RPC boundary). The `chat()` method handles the full lifecycle: persist user message, call `onChatMessage()`, iterate stream, persist assistant message, handle errors.

### Clear

Clearing (`cf_agent_chat_clear`) is comprehensive:

1. Reset the turn queue (increments generation, invalidating queued turns)
2. Abort all in-flight requests
3. Clear resumable stream state
4. Clear continuation state (pending, deferred, awaiting connections)
5. Clear client tools
6. Delete all messages from SQLite
7. Clear in-memory message list and persistence cache
8. Broadcast `cf_agent_chat_clear` to all clients

### Durable fibers

Think inherits `runFiber()` from the `Agent` base class. Fiber state is persisted in `cf_agents_runs` (SQLite). See [forever.md](../experimental/forever.md) for the full design.

**Note:** Think does not currently wire fibers into the chat lifecycle. There is no `chatRecovery` flag and no `onChatRecovery` hook. Chat turns are not wrapped in `runFiber` — they rely on `keepAliveWhile()` to prevent eviction during streaming.

## Tools

Think provides a built-in workspace and factory functions for additional tool patterns.

### Built-in workspace

Every Think instance gets `this.workspace` — a `Workspace` (from `@cloudflare/shell`) backed by the DO's SQLite storage. Workspace tools (`read`, `write`, `edit`, `list`, `find`, `grep`, `delete`) are automatically merged into every `onChatMessage` call, before `getTools()`.

Override to add R2 spillover: `override workspace = new Workspace({ sql: this.ctx.storage.sql, r2: this.env.R2, name: () => this.name })`.

### Workspace tools (`@cloudflare/think/tools/workspace`)

The individual tool factories are also exported for custom storage backends. Seven file operation tools backed by abstract operation interfaces (`ReadOperations`, `WriteOperations`, etc.).

| Tool             | Description                                       | Operations interface |
| ---------------- | ------------------------------------------------- | -------------------- |
| `read_file`      | Read file contents                                | `ReadOperations`     |
| `write_file`     | Create or overwrite a file                        | `WriteOperations`    |
| `edit_file`      | Find-and-replace edit (rejects ambiguous matches) | `EditOperations`     |
| `list_directory` | List directory contents with metadata             | `ListOperations`     |
| `find_files`     | Glob pattern search                               | `FindOperations`     |
| `grep`           | Regex search across files                         | `GrepOperations`     |
| `delete`         | Delete files or directories                       | `DeleteOperations`   |

All tools use Zod v4 schemas for input validation.

### Code execution (`@cloudflare/think/tools/execute`)

A sandboxed JavaScript execution tool powered by `@cloudflare/codemode`:

```typescript
const executeTool = createExecuteTool({
  tools: workspaceTools, // available as codemode.* in sandbox
  state: workspaceBackend, // optional: available as state.* in sandbox
  providers: [], // optional: additional named namespaces
  loader: this.env.LOADER
});
```

The LLM writes JavaScript code. The tool sends it to a dynamic Worker isolate via `DynamicWorkerExecutor`. The sandbox can call workspace tools via `codemode.*` and optionally the full `state.*` filesystem API (`readFile`, `writeFile`, `glob`, `searchFiles`, `planEdits`, etc.). Fully isolated: no network access by default, configurable timeout.

### Browser tools (`@cloudflare/think/tools/browser`)

Two AI SDK tools for CDP-based browser automation:

- **`browser_search`** — query the CDP protocol spec to discover commands, events, and types. The model writes JavaScript that runs against a normalized copy of the protocol, exposed via `spec.get()`.
- **`browser_execute`** — run CDP commands against a live browser session. The model writes JavaScript that calls `cdp.send()`, `cdp.attachToTarget()`, and debug log helpers.

Both tools delegate to `createBrowserToolHandlers` from `agents/browser`, reusing the same code-mode sandbox and CDP session management. Requires a Browser Rendering binding (`browser`) and a `WorkerLoader` (`loader`).

```typescript
createBrowserTools({
  browser: this.env.BROWSER,
  loader: this.env.LOADER
});
```

### Extensions (`@cloudflare/think/tools/extensions`)

Two AI SDK tools for managing extensions at runtime:

- **`load_extension`** — LLM writes a JS object expression defining tools, Think loads it as a sandboxed Worker via `WorkerLoader`
- **`list_extensions`** — lists currently loaded extensions and their tools

### Extension system (`@cloudflare/think/extensions`)

`ExtensionManager` handles the full extension lifecycle:

1. **Loading** — wraps extension source in a Worker module with `describe()` / `execute()` RPC, loads via `WorkerLoader` with permission-gated bindings
2. **Tool discovery** — calls `describe()` to get tool descriptors (JSON Schema inputs), exposes as AI SDK tools with namespaced names (`{extensionName}_{toolName}`)
3. **Persistence** — stores extension manifest + source in DO storage, `restore()` rebuilds from storage after hibernation
4. **Permissions** — extensions declare `network` (allowed hosts) and `workspace` (`read` | `read-write` | `none`) permissions. Workspace access is mediated by `HostBridgeLoopback`, a `WorkerEntrypoint` that resolves the parent agent via `ctx.exports` and delegates operations with permission checks.
5. **Unloading** — removes the extension and its tools, deletes from storage

## SQLite tables

| Table                   | Owner             | Purpose                                                    |
| ----------------------- | ----------------- | ---------------------------------------------------------- |
| `assistant_messages`    | Session           | Tree-structured conversation history                       |
| `assistant_compactions` | Session           | Compaction overlays and summaries                          |
| `assistant_fts`         | Session           | Full-text search index for messages                        |
| `assistant_config`      | Session           | Shared session-scoped metadata reserved by Session         |
| `think_config`          | Think             | Think-private config (`_think_config`, client tools, body) |
| `cf_agents_runs`        | Agent (inherited) | Durable fiber state and checkpoints                        |
| `cf_agents_schedules`   | Agent (inherited) | Scheduled tasks and intervals                              |

## Known gaps (vs AIChatAgent)

Features present in `@cloudflare/ai-chat` but not yet in Think:

| Feature                              | AIChatAgent                                      | Think                                              |
| ------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Multi-session / branching            | No                                               | No (flat table, no session ID)                     |
| `saveMessages()`                     | Programmatic message injection + turn trigger    | Not implemented                                    |
| `continueLastTurn()`                 | Continue from last assistant message             | Not implemented                                    |
| `chatRecovery` / `onChatRecovery`    | Fiber-wrapped turns, recovery after eviction     | Not implemented (has fibers but not wired to chat) |
| `onChatResponse` hook                | Post-turn lifecycle callback                     | Not implemented                                    |
| `onSanitizeMessage` hook             | Custom message transformation before persistence | Not implemented                                    |
| `waitUntilStable()`                  | Await conversation quiescence                    | Not implemented                                    |
| `hasPendingInteraction()`            | Track pending client tool state                  | Not implemented                                    |
| Message reconciliation               | ID remapping, dedup, merge on client sync        | `INSERT OR IGNORE` only                            |
| Regeneration                         | `regenerate-message` trigger                     | Not implemented                                    |
| `messageConcurrency` strategies      | queue, latest, merge, drop, debounce             | Queue only (via TurnQueue)                         |
| Custom body persistence              | `_lastBody` persisted to SQLite                  | Not parsed or persisted                            |
| `CF_AGENT_CHAT_MESSAGES` from client | Full array sync from client                      | Not handled                                        |
| `onFinish` callback                  | Provider-level finish metadata                   | Not exposed                                        |
| v4 → v5 message migration            | `autoTransformMessages()`                        | Not implemented (v5 only)                          |
| Compaction                           | No (only in experimental Session)                | Not implemented                                    |
| Context blocks                       | No (only in experimental Session)                | Not implemented                                    |

## Key decisions

### Why a base class instead of a mixin?

Think is more than a behavior addition — it's an opinion about how chat agents work. The message store, streaming protocol, persistence pipeline, and error handling are deeply intertwined. A mixin would force awkward composition with other mixins that might conflict on `onMessage`, `onStart`, or storage tables. A base class makes the lifecycle explicit and predictable.

### Why `StreamAccumulator` instead of inline chunk parsing?

AIChatAgent uses `applyChunkToParts()` with manual state tracking. Think uses `StreamAccumulator` (from `agents/chat`) which encapsulates the same logic behind a cleaner interface — `applyChunk()` returns a `ChunkResult` with optional actions (cross-message tool updates, errors). This avoids duplicating the chunk-to-parts logic.

### Why INSERT OR IGNORE for user messages, INSERT ON CONFLICT UPDATE for assistant messages?

User messages arrive from the client with stable IDs. The same message may arrive multiple times (reconnect, retry). `INSERT OR IGNORE` makes this idempotent.

Assistant messages are built incrementally during streaming. The first persist inserts; subsequent persists need to update the content. `INSERT ON CONFLICT DO UPDATE` handles both cases.

### Why a persistence cache?

The `_persistedMessageCache` maps message IDs to their last-persisted JSON. Before writing to SQLite, Think compares the current serialization to the cached version. If identical, the write is skipped. Without the cache, every broadcast would trigger unnecessary SQL writes.

### Why sanitize messages before persistence?

LLM providers attach ephemeral metadata to messages (OpenAI's `itemId`, `reasoningEncryptedContent`). This metadata is meaningless after the response is complete and wastes storage. Sanitization strips it before persistence.

### Why enforce row size limits?

Durable Object SQLite has a ~2 MB row size limit. Tool outputs (especially from code execution or file reads) can easily exceed this. Rather than failing the entire persistence operation, Think truncates oversized parts with a clear marker. The threshold is 1.8 MB, leaving headroom.

### Why the loopback pattern for extensions?

Extension Workers loaded via `WorkerLoader` can only receive `Fetcher`/`ServiceStub` in their `env`, not `RpcStub`. The `HostBridgeLoopback` is a `WorkerEntrypoint` that carries serializable props and resolves the actual agent at call time via `ctx.exports`. See [loopback.md](./loopback.md).

## Tradeoffs

**Think is opinionated.** It assumes UIMessage format, the AI SDK's `streamText` interface, and a specific WebSocket protocol. Agents that need a fundamentally different message format or streaming protocol should use the base `Agent` class directly.

**All messages in memory.** `this.messages` holds the full conversation. For very long conversations, this could be expensive. `maxPersistedMessages` is a partial mitigation. Compaction is not yet implemented.

**Single conversation per instance.** Think currently stores all messages in a single flat table with no session ID. There is no multi-session support. The `SessionManager` from `agents/experimental/memory/session` is designed to fill this gap but has not been integrated.

**No message reconciliation.** Think uses `INSERT OR IGNORE` for incoming messages — it does not handle the client sending edited or truncated message lists. Regeneration (re-running from an earlier point) is not supported.

**Extension sandbox is all-or-nothing on network.** The `permissions.network` field declares allowed hosts, but actual enforcement is binary: either no network or full network. Per-host filtering is not yet implemented at the runtime level.

## Testing

Tests in `packages/think/src/tests/`, running inside the Workers runtime via `@cloudflare/vitest-pool-workers`:

- **Core chat** (`think-session.test.ts`) — send, multi-turn, persistence, streaming, clear, UIMessage input, getMessages
- **Error handling** (`think-session.test.ts`) — error messages, partial persistence, error hooks, recovery after error
- **Abort** (`think-session.test.ts`) — stop streaming, persist partial on abort, callback not called after abort
- **Agentic loop** (`assistant-agent-loop.test.ts`) — text-only, with tools, context assembly, model errors, custom getTools
- **WebSocket protocol** (`assistant-agent.test.ts`) — send, stream, persistence via WS, clear, resumable streaming
- **Client tools** (`client-tools.test.ts`) — tool result application, tool approval, auto-continuation, schema persistence
- **Extensions** (`extension-manager.test.ts`) — load, unload, restore, tool creation, permissions, namespacing
- **Fibers** (`fiber.test.ts`) — runFiber execution, checkpoint via ctx.stash, fire-and-forget, recovery via onFiberRecovered
- **Tools** (`assistant-tools.test.ts`) — workspace tools, code execution tool
- **E2E** (`assistant-e2e.test.ts`) — end-to-end WebSocket flows

## Package exports

| Import path                          | Source                    | Purpose                                                |
| ------------------------------------ | ------------------------- | ------------------------------------------------------ |
| `@cloudflare/think`                  | `src/think.ts`            | Think base class, Session, Workspace re-exports, types |
| `@cloudflare/think/extensions`       | `src/extensions/index.ts` | ExtensionManager, HostBridgeLoopback                   |
| `@cloudflare/think/tools/workspace`  | `src/tools/workspace.ts`  | File operation tool factories (for custom backends)    |
| `@cloudflare/think/tools/execute`    | `src/tools/execute.ts`    | Sandboxed code execution tool                          |
| `@cloudflare/think/tools/browser`    | `src/tools/browser.ts`    | CDP browser automation tools (search + execute)        |
| `@cloudflare/think/tools/extensions` | `src/tools/extensions.ts` | Extension management AI tools                          |

## Inspiration

Think's design — skills, extensions, tree-structured sessions, compaction, and context engineering — was inspired by [pi](https://pi.dev), a minimal terminal coding agent by Mario Zechner / Earendil Inc.

## History

- [chat-shared-layer.md](./chat-shared-layer.md) — shared streaming, sanitization, and protocol primitives (Think uses `StreamAccumulator`, `sanitizeMessage`, `enforceRowSizeLimit`, `CHAT_MESSAGE_TYPES`, `TurnQueue`, `ResumableStream`, `ContinuationState` from `agents/chat`)
- [rfc-sub-agents.md](./rfc-sub-agents.md) — sub-agents via facets (Think's `subAgent()` is built on this)
- [loopback.md](./loopback.md) — cross-boundary RPC pattern (used by extension host bridge)
- [workspace.md](./workspace.md) — Workspace design (Think's file tools are backed by this)
