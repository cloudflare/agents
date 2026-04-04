# Think

An opinionated Agent base class for AI assistants. Handles the full chat lifecycle — session persistence, agentic loop, streaming, workspace tools, and extensions — all backed by Durable Object SQLite.

**Status:** experimental (`@cloudflare/think`)

## Problem

Every AI agent built on the Agents SDK needs the same infrastructure:

- **Session persistence** — store messages, survive hibernation, support multiple conversations
- **Streaming** — stream LLM output to clients in real time, handle cancellation
- **Tool execution** — run tools in an agentic loop, manage step limits
- **Error recovery** — persist partial messages on failure, don't lose context
- **Message management** — sanitize provider metadata, enforce storage limits, compact large outputs
- **Sub-agent coordination** — delegate tasks to child agents, stream results back

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
           SessionManager  Agentic Loop   Tools
           (SQLite tables) (streamText)
                   |            |             |
           ┌───────┴───────┐   |      ┌──────┴──────┐
           │  Sessions     │   |      │ Workspace   │
           │  Messages     │   |      │ Execute     │
           │  Compactions  │   |      │ Extensions  │
           │  (branching)  │   |      └─────────────┘
           └───────────────┘   |
```

Think operates in two modes:

1. **Top-level agent** — speaks the `cf_agent_chat_*` WebSocket protocol directly to browser clients via `useChat` + `AgentChatTransport`
2. **Sub-agent** — called via `chat()` over Durable Object RPC from a parent agent, streaming events through a `StreamCallback`

Both modes share the same internal lifecycle. The difference is only in how messages arrive and how responses are delivered.

## How it works

### Class hierarchy

```
Agent (agents SDK — includes runFiber, keepAlive, scheduling, etc.)
  └─ Think<Env, Config> — adds chat lifecycle, sessions, streaming
       └─ YourAgent extends Think<Env> — your overrides
```

Think extends `Agent` directly. Fiber support (`runFiber`, `stash`, `onFiberRecovered`) is inherited from the base class — no mixin needed.

### Override points

Think requires almost no boilerplate. The minimal subclass overrides one method:

```typescript
export class ChatSession extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }
}
```

The full set of override points:

| Method                    | Default                          | Purpose                               |
| ------------------------- | -------------------------------- | ------------------------------------- |
| `getModel()`              | throws                           | Return the `LanguageModel` to use     |
| `getSystemPrompt()`       | `"You are a helpful assistant."` | System prompt                         |
| `getTools()`              | `{}`                             | AI SDK `ToolSet` for the agentic loop |
| `getMaxSteps()`           | `10`                             | Max tool-call rounds per turn         |
| `assembleContext()`       | prune older tool calls           | Customize what's sent to the LLM      |
| `onChatMessage(options?)` | `streamText(...)`                | Full control over inference           |
| `onChatError(error)`      | passthrough                      | Customize error handling              |
| `getWorkspace()`          | `null`                           | Workspace for extension host bridge   |

### Step-by-step: a chat request

#### 1. Message arrival

**WebSocket path** (`_handleChatRequest`):

```
Client sends: { type: "cf_agent_use_chat_request", id: "req-abc", init: { method: "POST", body: JSON } }
```

The body contains `{ messages: UIMessage[] }` — the full conversation from the client's perspective. Think extracts new messages and persists them.

**RPC path** (`chat()`):

```typescript
await session.chat("Summarize the project", relay, { signal, tools });
```

The parent agent calls `chat()` directly with a string or `UIMessage`.

#### 2. Session initialization

If no session exists yet, Think creates one:

```
INSERT INTO assistant_sessions (id, name) VALUES (uuid, "New Chat")
```

Incoming messages are appended to the session (idempotent — `INSERT OR IGNORE` on the message ID). The authoritative message list is then reloaded from SQLite:

```typescript
this.messages = this.sessions.getHistory(this._sessionId);
```

#### 3. Abort controller setup

Each request gets its own `AbortController`, keyed by request ID. The controller's signal is threaded through `onChatMessage()` → `streamText()` → the LLM provider.

#### 4. Agentic loop (`onChatMessage`)

The default implementation calls the AI SDK's `streamText()`:

```typescript
streamText({
  model: this.getModel(),
  system: this.getSystemPrompt(),
  messages: await this.assembleContext(),
  tools: mergedTools,
  stopWhen: stepCountIs(this.getMaxSteps()),
  abortSignal: options?.signal
});
```

The agentic loop runs until:

- The model produces a text response with no tool calls (natural completion)
- The step count limit is reached
- The abort signal fires (user cancelled)
- An error occurs

#### 5. Context assembly (`assembleContext`)

The default implementation converts `this.messages` (UIMessage format) to model messages and prunes old tool calls:

```typescript
pruneMessages({
  messages: await convertToModelMessages(this.messages),
  toolCalls: "before-last-2-messages"
});
```

Override this to inject memory, project context, RAG results, or compaction summaries.

#### 6. Streaming

The `streamText()` result is an async iterable of UI message chunks. Think iterates the stream and simultaneously:

- **Builds a UIMessage** — `applyChunkToParts()` accumulates text, reasoning, tool calls, tool results, sources, and files into the message's `parts` array
- **Broadcasts to clients** (WebSocket path) — each chunk is sent as `{ type: "cf_agent_use_chat_response", id, body: JSON, done: false }`
- **Calls `onEvent()`** (RPC path) — each chunk JSON is passed to the `StreamCallback`

When the stream completes:

```
WebSocket: { type: "cf_agent_use_chat_response", id, body: "", done: true }
RPC:       callback.onDone()
```

#### 7. Persistence

After the stream completes, the assembled assistant message is persisted with three transformations:

1. **Sanitize** — strip provider ephemeral metadata (`itemId`, `reasoningEncryptedContent`), remove empty reasoning parts
2. **Enforce row size** — compact tool outputs exceeding 1.8 MB (SQLite has a ~2 MB row limit)
3. **Incremental persist** — compare the serialized message to `_persistedMessageCache`. If unchanged, skip the SQL write

After persistence, `maxPersistedMessages` is enforced by deleting the oldest messages on the current branch.

#### 8. Error handling

If an error occurs during the agentic loop or streaming:

- **Partial message is persisted** — whatever was generated before the error is saved so context isn't lost
- **`onChatError(error)` is called** — override to log, transform, or swallow
- **Error is communicated** — WebSocket broadcasts `{ done: true, error: true }`, RPC calls `callback.onError()`

#### 9. Clear-during-stream safety

A `_clearGeneration` counter prevents a race: if the user clears the session while a stream is in-flight, the abort fires and the stream stops, but the post-stream persistence code must not write the partial message into the now-empty session. The counter is snapshotted at stream start and checked before persistence.

### Wire protocol

Think speaks the same WebSocket protocol as `@cloudflare/ai-chat`, making it compatible with `useAgentChat` and `useChat` + `AgentChatTransport`.

| Direction       | Message type                   | Purpose                                                         |
| --------------- | ------------------------------ | --------------------------------------------------------------- |
| Client → Server | `cf_agent_use_chat_request`    | Send a chat message (contains `{ messages: UIMessage[] }`)      |
| Client → Server | `cf_agent_chat_clear`          | Clear the current session's messages                            |
| Client → Server | `cf_agent_chat_request_cancel` | Cancel a specific request by ID                                 |
| Server → Client | `cf_agent_use_chat_response`   | Stream chunk (`done: false`) or completion (`done: true`)       |
| Server → Client | `cf_agent_chat_messages`       | Full message list broadcast (after persistence, session switch) |
| Server → Client | `cf_agent_chat_clear`          | Confirm session was cleared                                     |

### Session management

Think manages multiple named sessions per agent instance, backed by three SQLite tables:

```
assistant_sessions     — named conversation roots (id, name, timestamps)
assistant_messages     — append-only message log with parent_id for branching
assistant_compactions  — summaries that replace older messages in context
```

#### Tree-structured messages

Messages form a tree via `parent_id`. This enables **branching** — when a user edits an earlier message and gets a new response, it creates a new branch without losing the old one.

```
msg-1 (user: "Hello")
  └─ msg-2 (assistant: "Hi there!")
       ├─ msg-3 (user: "Tell me about X")
       │    └─ msg-4 (assistant: "X is...")      ← branch A
       └─ msg-5 (user: "Tell me about Y")
            └─ msg-6 (assistant: "Y is...")      ← branch B
```

History retrieval walks from a leaf to the root via a recursive CTE. By default, `getHistory()` follows the path to the most recent leaf.

#### Compaction

When conversations grow long, older messages can be summarized. A compaction record stores the summary text and the message range it covers. When assembling history, covered messages are replaced with a single system message containing the summary.

#### Session operations

```typescript
session.createSession("research");
session.switchSession(sessionId);
session.getSessions();
session.deleteSession(id);
session.renameSession(id, "new name");
session.clearMessages();
session.getCurrentSessionId();
```

### Dynamic configuration

Think accepts a `Config` type parameter for per-instance configuration:

```typescript
export class ChatSession extends Think<Env, AgentConfig> {
  getModel() {
    const tier = this.getConfig()?.modelTier ?? "fast";
    return MODELS[tier];
  }
}
```

Configuration is stored in SQLite (`_think_config`) and cached in memory. It survives hibernation. A parent orchestrator can configure sub-agents via RPC:

```typescript
const session = await this.subAgent(ChatSession, "agent-abc");
await session.configure({ modelTier: "capable", systemPrompt: "..." });
```

### Sub-agent streaming via RPC

When used as a sub-agent, the `chat()` method runs a full turn and streams events via a callback:

```typescript
interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}
```

The parent implements `StreamCallback` as an `RpcTarget` (so it crosses the DO RPC boundary).

### Durable fibers

Think inherits `runFiber()` from the `Agent` base class:

```typescript
export class MyAgent extends Think<Env> {
  async doExpensiveWork(url: string) {
    await this.runFiber("expensive-work", async (ctx) => {
      const result = await fetch(url);
      ctx.stash({ progress: 50 });
      await processResult(result);
    });
  }
}
```

Fiber state is persisted in `cf_agents_runs` (SQLite). On eviction, the alarm fires, `onFiberRecovered` is called with the last snapshot, and the developer decides how to resume. See [forever.md](../experimental/forever.md) for the full design.

## Tools

Think provides factory functions for common tool patterns:

### Workspace tools (`@cloudflare/think/tools/workspace`)

Seven file operation tools backed by the Agents SDK Workspace:

| Tool             | Description                                       |
| ---------------- | ------------------------------------------------- |
| `read_file`      | Read file contents                                |
| `write_file`     | Create or overwrite a file                        |
| `edit_file`      | Find-and-replace edit (rejects ambiguous matches) |
| `list_directory` | List directory contents with metadata             |
| `find_files`     | Glob pattern search                               |
| `grep`           | Regex search across files                         |
| `delete`         | Delete files or directories                       |

Each tool has Zod schemas and is backed by operation interfaces (`ReadOperations`, `WriteOperations`, etc.) so you can create tools against custom storage backends.

### Code execution (`@cloudflare/think/tools/execute`)

A sandboxed JavaScript execution tool powered by `@cloudflare/codemode`:

```typescript
const executeTool = createExecuteTool({
  tools: workspaceTools,
  loader: this.env.LOADER
});
```

The LLM writes JavaScript code. The tool sends it to a dynamic Worker isolate via `DynamicWorkerExecutor`. The sandbox can call workspace tools via a typed `codemode` object. Fully isolated: no network access by default, configurable timeout, and tool access is mediated by the executor.

### Extensions (`@cloudflare/think/tools/extensions`)

Dynamic tool loading at runtime. The LLM can write extension source code, load it as a sandboxed Worker, and use the new tools on the next turn:

```
LLM writes extension source → ExtensionManager.load()
  → wraps in Worker module with describe/execute RPC
  → loads via WorkerLoader with permission-gated bindings
  → discovers tools via describe() RPC
  → exposes as AI SDK tools via getTools()
```

Extensions declare permissions (`network`, `workspace`) and get controlled access to the host agent via `HostBridgeLoopback` — a `WorkerEntrypoint` that resolves the parent agent via `ctx.exports` and delegates workspace operations with permission checks.

## The execution ladder

Think supports increasing levels of execution capability:

```
Tier 0: Workspace
  └─ Durable filesystem (SQLite + R2). Read, write, edit, search.
     Zero network overhead for small files. Pure DO storage.

Tier 1: Dynamic isolate
  └─ Run LLM-generated JavaScript in a sandboxed Worker.
     Has access to workspace tools. No network, no npm.
     Millisecond cold start.

Tier 2: Isolate + npm (planned)
  └─ Dynamic Worker with bundled dependencies.

Tier 3: Browser rendering (planned)
  └─ Browser via Browser Rendering API.

Tier 4: Full sandbox (planned)
  └─ Container or microVM with real process execution.
```

The agent doesn't need to pick a tier upfront. The tools compose — a single `getTools()` can return workspace tools, an execute tool, and extension tools simultaneously. The LLM chooses which to invoke based on the task.

## The orchestrator pattern

For complex applications, Think agents are composed in a parent-child hierarchy:

```
┌─────────────────────────────────────┐
│          MyAssistant                │
│        (extends Agent)              │
│                                     │
│  ┌──────────┐  ┌──────────┐       │
│  │ ChatSession│  │ ChatSession│     │
│  │ (Think)   │  │ (Think)   │     │
│  │ agent-abc │  │ agent-def │     │
│  └──────────┘  └──────────┘       │
│                                     │
│  SharedWorkspace    MCP Client      │
│  Agent Registry     Tool Bridges    │
└─────────────────────────────────────┘
```

The orchestrator manages:

- **Agent registry** — tracks sub-agents, their status, message counts (SQLite)
- **Shared workspace** — a `Workspace` instance accessible by all sub-agents via `ToolBridge`
- **MCP client** — connects to external MCP servers, bridges tools into sub-agent tool sets
- **Delegation** — task dispatch to sub-agents with live streaming relay

Sub-agents are Think instances created via `this.subAgent(ChatSession, "agent-abc")`. They get their own isolated SQLite storage but share the parent's workspace and MCP tools via RPC bridges.

### Cross-boundary tools via ToolBridge

Sub-agents need access to the parent's shared resources (workspace, MCP servers), but they run in separate Durable Objects. The `ToolBridge` pattern solves this — an `RpcTarget` that the parent creates and passes to the sub-agent. The sub-agent wraps each bridge method as an AI SDK `tool()` with Zod schemas. All calls cross the DO boundary transparently.

### Cross-boundary abort

`AbortSignal` is not serializable across the RPC boundary. The `AbortReceiver` pattern solves this: the sub-agent creates an `AbortController` + `AbortReceiver` (`RpcTarget`), returns the receiver to the parent, and threads the controller's signal through `streamText()`. The parent calls `receiver.abort()` over RPC to cancel.

## SQLite tables

| Table                   | Owner          | Purpose                               |
| ----------------------- | -------------- | ------------------------------------- |
| `assistant_sessions`    | SessionManager | Named conversation roots              |
| `assistant_messages`    | SessionManager | Messages with parent_id for branching |
| `assistant_compactions` | SessionManager | Summaries replacing old messages      |
| `_think_config`         | Think          | Dynamic configuration (key-value)     |
| `cf_agents_runs`        | Agent          | Durable fiber state and checkpoints   |
| `cf_agents_schedules`   | Agent          | Scheduled tasks and intervals         |
| `cf_workspace_{ns}`     | Workspace      | Virtual filesystem entries            |

## Key decisions

### Why a base class instead of a mixin?

Think is more than a behavior addition — it's an opinion about how chat agents work. The session manager, streaming protocol, persistence pipeline, and error handling are deeply intertwined. A mixin would force awkward composition with other mixins that might conflict on `onMessage`, `onStart`, or storage tables. A base class makes the lifecycle explicit and predictable.

### Why SessionManager as a separate class?

SessionManager is usable standalone, outside of Think. An agent that doesn't need the full Think lifecycle (no streaming, no WebSocket protocol) can still use SessionManager for conversation persistence. This separation also makes testing easier.

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

**Think is opinionated.** It assumes UIMessage format, the AI SDK's streamText interface, and a specific WebSocket protocol. Agents that need a fundamentally different message format or streaming protocol should use the base `Agent` class directly.

**All messages in memory.** `this.messages` holds the full conversation for the current session. For very long conversations, this could be expensive. `maxPersistedMessages` and compaction are partial mitigations.

**No cross-session context.** Each session is independent. There's no built-in mechanism for sharing context across sessions. This is left to `assembleContext()` overrides.

**Single-writer sessions.** Sessions assume a single active writer. Multiple agents writing to the same session concurrently would produce interleaved messages.

**Extension sandbox is all-or-nothing on network.** The `permissions.network` field declares allowed hosts, but actual enforcement is binary: either no network or full network. Per-host filtering is not yet implemented at the runtime level.

## Testing

115 tests across 7 suites in `packages/think/src/tests/`, running inside the Workers runtime via `@cloudflare/vitest-pool-workers`:

- **Core chat** — send, multi-turn, persistence, streaming, sessions, custom responses, message parts
- **Error handling** — error messages, partial persistence, error hooks, recovery after error
- **Abort** — stop streaming, persist partial on abort, recover after abort
- **Agentic loop** — text-only, with tools, context assembly, model errors, custom getTools
- **Sessions** — create, switch, list, delete, rename, message counts, history, branching
- **Extensions** — load, unload, restore, tool creation, permissions, namespacing
- **Fibers** — runFiber execution, checkpoint via ctx.stash, fire-and-forget, recovery via \onFiberRecovered

## History

- [chat-shared-layer.md](./chat-shared-layer.md) — shared streaming, sanitization, and protocol primitives (Think uses `StreamAccumulator`, `sanitizeMessage`, `enforceRowSizeLimit`, `CHAT_MESSAGE_TYPES` from `agents/chat`)
- [rfc-sub-agents.md](./rfc-sub-agents.md) — sub-agents via facets (Think's `subAgent()` is built on this)
- [loopback.md](./loopback.md) — cross-boundary RPC pattern (used by extension host bridge)
- [workspace.md](./workspace.md) — Workspace design (Think's file tools are backed by this)
