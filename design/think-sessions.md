# Think + Session: Replacing `.messages` with Session

Design for integrating `agents/experimental/memory/session` into Think as the conversation storage layer. Think hasn't shipped yet, so there is no backward compatibility constraint — this is a clean redesign.

This is Phase 1 of the Think implementation plan. See [think-roadmap.md](./think-roadmap.md) for the full phased plan including durability, programmatic API, and client-side improvements.

Related:

- [think.md](./think.md) — Think design doc
- [think-roadmap.md](./think-roadmap.md) — implementation plan (builds on this design)
- [think-vs-aichat.md](./think-vs-aichat.md) — feature gap analysis vs AIChatAgent
- [chat-api.md](./chat-api.md) — API analysis of AIChatAgent + useAgentChat

---

## Table of Contents

1. [Motivation](#motivation)
2. [What Session Provides](#what-session-provides)
3. [What Gets Removed from Think](#what-gets-removed-from-think)
4. [New Architecture](#new-architecture)
5. [API Design](#api-design)
6. [Internal Changes](#internal-changes)
7. [Context Assembly Pipeline](#context-assembly-pipeline)
8. [Regeneration via Branching](#regeneration-via-branching)
9. [Multi-Session Support](#multi-session-support)
10. [Usage Examples](#usage-examples)
11. [Design Decisions](#design-decisions)
12. [What Session Doesn't Cover](#what-session-doesnt-cover)

---

## Motivation

Think currently stores messages in a flat `assistant_messages` table with no tree structure, no branching, no sessions, no compaction, and no context blocks. The design doc acknowledges this:

> **Single conversation per instance.** Think currently stores all messages in a single flat table with no session ID. There is no multi-session support. The `SessionManager` from `agents/experimental/memory/session` is designed to fill this gap but has not been integrated.
>
> **No message reconciliation.** Think uses `INSERT OR IGNORE` for incoming messages — it does not handle the client sending edited or truncated message lists.
>
> **Compaction** — No (only in experimental Session)
> **Context blocks** — No (only in experimental Session)

Session already provides all of this — tree-structured messages, compaction overlays, context blocks with provider system, FTS5 search, and multi-session management. Rather than reimplementing these features in Think, we integrate Session as Think's storage layer.

Since Think hasn't shipped, we can make this the only storage design. No migration path, no compat layer.

---

## What Session Provides

### 1. Tree-structured messages with branching

Messages have `parent_id`. `getHistory(leafId)` walks the tree root-to-leaf via recursive CTE. `getBranches(messageId)` returns sibling responses. This directly enables regeneration — a gap from the AIChatAgent comparison.

```sql
-- Session's assistant_messages table
CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,  -- JSON-serialized UIMessage
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

For linear conversations (the default), `getHistory()` returns the same flat `UIMessage[]` that Think's current `_loadMessages()` does. The tree structure only activates when `parentId` is explicitly used.

### 2. Compaction overlays

Stored in `assistant_compactions`, overlays are summaries that replace a range of messages at read time. The original messages remain in SQLite — the overlay is non-destructive:

```typescript
// applyCompactions: replaces messages[fromId..toId] with a synthetic summary message
result.push({
  id: `compaction_${comp.id}`,
  role: "assistant",
  parts: [{ type: "text", text: comp.summary }],
  createdAt: new Date()
});
```

The `createCompactFunction` helper implements a full hermes-style algorithm:

1. Protect head messages (first N)
2. Protect tail by token budget (walk backward from end)
3. Align boundaries to avoid splitting tool call/result groups
4. Summarize middle section with LLM (structured format with iterative updates)
5. Sanitize orphaned tool pairs after compaction

Auto-compaction triggers when estimated token count exceeds a configurable threshold.

### 3. Context blocks

Persistent key-value blocks injected into the system prompt. Provider-based with four types:

| Provider type             | `get` | `set`    | Extra           | Tool             |
| ------------------------- | ----- | -------- | --------------- | ---------------- |
| `ContextProvider`         | Yes   | —        | —               | — (readonly)     |
| `WritableContextProvider` | Yes   | Yes      | —               | `set_context`    |
| `SkillProvider`           | Yes   | Optional | `load(key)`     | `load_context`   |
| `SearchProvider`          | Yes   | Optional | `search(query)` | `search_context` |

Context blocks render into a frozen system prompt with structured headers:

```
══════════════════════════════════════════════
SOUL
══════════════════════════════════════════════
You are a coding assistant who writes clean TypeScript.

══════════════════════════════════════════════
MEMORY (Important facts — use set_context to update) [42% — 462/1100 tokens]
══════════════════════════════════════════════
- User prefers functional patterns
- Project uses Cloudflare Workers
```

The frozen prompt is cached for LLM prefix caching — writes to context blocks update the provider immediately but don't invalidate the snapshot until `refreshSystemPrompt()` is called.

### 4. FTS5 full-text search

Every message is indexed in an FTS5 virtual table on insert/update. `searchMessages(query)` performs full-text search within a session. `SessionManager.search(query)` searches across all sessions. The model can search its own history via `session_search` or `search_context` tools.

### 5. Session management (via `SessionManager`)

Multi-session lifecycle: create, list, delete, rename, fork. Each session gets namespaced providers. Cross-session search. Usage tracking (input/output tokens, estimated cost). Session metadata (`parent_session_id`, `model`, `source`, `end_reason`).

```typescript
interface SessionInfo {
  id: string;
  name: string;
  parent_session_id: string | null;
  model: string | null;
  source: string | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}
```

### 6. Token estimation and truncation utilities

`estimateMessageTokens()` — heuristic token counting (hybrid char/word, no tokenizer dependency, ~80KB savings vs tiktoken). `truncateOlderMessages()` — read-time truncation of old tool outputs and long text.

---

## What Gets Removed from Think

Since Think hasn't shipped, these are not removals from a public API — they're simplifications of the internal design.

### Removed: `_initStorage()` / flat `assistant_messages` table

Think's current flat table:

```sql
CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

Replaced by Session's `AgentSessionProvider` which creates a richer table (with `session_id`, `parent_id`, FTS5 index, compaction table, config table).

### Removed: `_persistedMessageCache`

Think uses `Map<string, string>` to skip unchanged SQL writes during streaming. Session's `appendMessage` is idempotent by ID (checks for existing before insert), and `updateMessage` is explicit — called only when the message content has actually changed. The persistence cache optimization is no longer needed.

### Removed: `_loadMessages()` / `_appendMessage()` / `_upsertMessage()` / `_clearMessages()` / `_deleteMessages()`

All five storage methods are replaced by Session equivalents:

| Think (removed)        | Session (replacement)         |
| ---------------------- | ----------------------------- |
| `_loadMessages()`      | `session.getHistory()`        |
| `_appendMessage(msg)`  | `session.appendMessage(msg)`  |
| `_upsertMessage(msg)`  | `session.updateMessage(msg)`  |
| `_clearMessages()`     | `session.clearMessages()`     |
| `_deleteMessages(ids)` | `session.deleteMessages(ids)` |

### Removed: `_rebuildPersistenceCache()`

No cache, no rebuild.

### Removed: `_enforceMaxPersistedMessages()` / `maxPersistedMessages`

Compaction is the mechanism for managing conversation length. It preserves information as summaries instead of deleting messages. `maxPersistedMessages` was a lossy stopgap.

### Removed: `this.messages` as a mutable field

The mutable `messages: UIMessage[] = []` field becomes a computed getter backed by `session.getHistory()`.

### Removed: `think_request_context` table

Client tool persistence and other request context moves to Session's `assistant_config` table (which has `(session_id, key)` as primary key and was explicitly reserved for Think integration).

### Removed: `_think_config` table

Think's dynamic configuration (`configure()` / `getConfig()`) moves to `assistant_config` with a reserved key prefix. The `Config` type parameter and `configure()` / `getConfig()` API are preserved — only the backing table changes.

### Removed: `_storageReady` / `#configTableReady` / `#configCache`

Session handles its own table initialization lazily. Config moves to Session's config table.

---

## New Architecture

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
            Session      Agentic Loop   Tools
         (messages +     (streamText)
          context +           |
          compaction +    ┌───┴────┐
          search +        | Tools  |
          config)         | MCP    |
                          | Client |
                          | Ext.   |
                          └────────┘
```

Think owns the **chat execution lifecycle** — streaming, abort, client tools, resumable streams, WebSocket protocol, auto-continuation. Session owns the **conversation data** — message persistence, context blocks, compaction, search, multi-session management.

---

## API Design

### Class definition

```typescript
export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Config = Record<string, unknown>
> extends Agent<Env> {
  // ── Session ────────────────────────────────────────────────

  /** The conversation session — messages, context, compaction, search. */
  session!: Session;

  /**
   * Conversation history. Computed from the active session.
   * Equivalent to `this.session.getHistory()`.
   */
  get messages(): UIMessage[] {
    return this.session.getHistory();
  }

  // ── Override points ────────────────────────────────────────

  /** Return the language model to use for inference. */
  getModel(): LanguageModel;

  /** Return the system prompt (simple string). Used as fallback when no context blocks are configured. */
  getSystemPrompt(): string;

  /** Return the server-side tools for the agentic loop. */
  getTools(): ToolSet;

  /** Return the maximum number of tool-call steps per turn. */
  getMaxSteps(): number;

  /**
   * Configure the session. Called once during `onStart`.
   * Override to add context blocks, compaction, search, skills.
   *
   * The base session is pre-created with `Session.create(this)`.
   * Return it with builder methods chained.
   */
  configureSession(session: Session): Session;

  /**
   * Assemble context for the LLM from the current session state.
   *
   * Default implementation:
   * 1. Freezes the system prompt from context blocks (falls back to getSystemPrompt())
   * 2. Gets history from session
   * 3. Applies read-time truncation (old tool outputs, long text)
   * 4. Converts to model messages with tool call pruning
   *
   * Returns { system, messages } so the caller has both.
   */
  async assembleContext(): Promise<{
    system: string;
    messages: ModelMessage[];
  }>;

  /**
   * Handle a chat turn. Default runs the agentic loop with assembled context.
   * Override for full control over inference.
   */
  async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult>;

  /**
   * Called after a chat turn completes and the assistant message has been persisted.
   * Override for logging, chaining, side effects.
   */
  onChatResponse(result: ChatResponseResult): void | Promise<void>;

  /** Handle an error during a chat turn. Override to customize. */
  onChatError(error: unknown): unknown;

  // ── Dynamic configuration ──────────────────────────────────

  /** Persist a typed configuration object. Survives restarts. */
  configure(config: Config): void;

  /** Read persisted configuration, or null if never configured. */
  getConfig(): Config | null;

  // ── Sub-agent RPC ──────────────────────────────────────────

  /** Run a chat turn via RPC from a parent agent. */
  async chat(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void>;

  // ── Message access ─────────────────────────────────────────

  /** Get all messages (alias for this.messages). */
  getMessages(): UIMessage[];

  /** Clear all messages from the active session. */
  clearMessages(): void;
}
```

### `configureSession` — the builder pattern

`configureSession` receives a pre-created `Session.create(this)` and returns it with builder methods applied. This is the primary configuration point for anything beyond the simple case:

```typescript
configureSession(session: Session): Session {
  return session;  // Default: no context blocks, no compaction
}
```

The Session builder methods available:

| Method                          | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `.withContext(label, options?)` | Add a context block (auto-wires to SQLite if no provider) |
| `.withCachedPrompt(provider?)`  | Cache frozen system prompt in SQLite (or custom provider) |
| `.onCompaction(fn)`             | Register LLM compaction function                          |
| `.compactAfter(tokenThreshold)` | Auto-compact when tokens exceed threshold                 |
| `.forSession(sessionId)`        | Isolate to a session ID (for multi-session)               |

### `assembleContext` — system prompt composition

The default `assembleContext` composes context blocks into the system prompt and returns both the system prompt and model messages:

```typescript
async assembleContext(): Promise<{ system: string; messages: ModelMessage[] }> {
  // 1. Get system prompt — context blocks if configured, else getSystemPrompt()
  const hasContextBlocks = this.session.getContextBlocks().length > 0;
  const system = hasContextBlocks
    ? await this.session.freezeSystemPrompt()
    : this.getSystemPrompt();

  // 2. Get conversation history from session (tree walk + compaction overlays)
  const history = this.session.getHistory();

  // 3. Read-time truncation of old tool outputs and long text
  const truncated = truncateOlderMessages(history);

  // 4. Convert to model messages with tool call pruning
  const messages = pruneMessages({
    messages: await convertToModelMessages(truncated),
    toolCalls: "before-last-2-messages"
  });

  return { system, messages };
}
```

The return type changes from `Promise<ModelMessage[]>` to `Promise<{ system: string; messages: ModelMessage[] }>` so that context blocks can influence the system prompt. The default `onChatMessage` destructures this:

```typescript
async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
  const baseTools = this.getTools();
  const clientToolSet = createToolsFromClientSchemas(options?.clientTools);
  const contextTools = await this.session.tools();
  const tools = { ...baseTools, ...clientToolSet, ...contextTools, ...options?.tools };

  const { system, messages } = await this.assembleContext();

  if (messages.length === 0) {
    throw new Error("No messages to send to the model.");
  }

  return streamText({
    model: this.getModel(),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(this.getMaxSteps()),
    abortSignal: options?.signal
  });
}
```

Note: Session context tools (`set_context`, `load_context`, `search_context`) are auto-merged into the tool set. If no context blocks are configured, `session.tools()` returns `{}` — no overhead.

### `getSystemPrompt` as the simple-case escape hatch

For agents that don't need context blocks, `getSystemPrompt()` still works exactly as before:

```typescript
export class SimpleAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }
  getSystemPrompt() {
    return "You are a helpful assistant.";
  }
}
```

No `configureSession` override needed. `assembleContext` detects no context blocks and uses `getSystemPrompt()` as the system prompt. Zero new concepts for the simple case.

### `onChatResponse` — new lifecycle hook

Think currently has no post-turn hook. Adding `onChatResponse` (borrowed from AIChatAgent but with a cleaner signature) provides:

```typescript
export type ChatResponseResult = {
  message: UIMessage;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
};
```

This fires after every turn completion — WebSocket, RPC, and auto-continuation. Useful for:

- Usage tracking via `SessionManager.addUsage()`
- Logging, analytics, observability
- Triggering follow-up actions
- Refreshing the system prompt after context block changes

---

## Internal Changes

### `onStart`

Before:

```typescript
onStart() {
  this._initStorage();
  this._resumableStream = new ResumableStream(this.sql.bind(this));
  this.messages = this._loadMessages();
  this._rebuildPersistenceCache();
  this._restoreClientTools();
  this._setupProtocolHandlers();
}
```

After:

```typescript
onStart() {
  const baseSession = Session.create(this);
  this.session = this.configureSession(baseSession);

  this._resumableStream = new ResumableStream(this.sql.bind(this));
  this._restoreClientTools();
  this._setupProtocolHandlers();
}
```

No `_initStorage`, no `_loadMessages`, no `_rebuildPersistenceCache`. Session handles its own table creation lazily on first access.

### User message persistence

Before:

```typescript
for (const msg of incomingMessages) {
  this._appendMessage(msg); // INSERT OR IGNORE
}
this.messages = this._loadMessages();
```

After:

```typescript
for (const msg of incomingMessages) {
  await this.session.appendMessage(msg); // Idempotent by ID, auto-parents to latest leaf
}
// No reload needed — this.messages is a getter that calls getHistory()
```

### Assistant message persistence (after streaming)

Before:

```typescript
private _persistAssistantMessage(msg: UIMessage): void {
  const sanitized = sanitizeMessage(msg);
  const safe = enforceRowSizeLimit(sanitized);
  const json = JSON.stringify(safe);

  if (this._persistedMessageCache.get(safe.id) !== json) {
    this._upsertMessage(safe);
  }

  if (this.maxPersistedMessages != null) {
    this._enforceMaxPersistedMessages();
  }

  this.messages = this._loadMessages();
}
```

After:

```typescript
private _persistAssistantMessage(msg: UIMessage): void {
  const sanitized = sanitizeMessage(msg);
  const safe = enforceRowSizeLimit(sanitized);

  const existing = this.session.getMessage(safe.id);
  if (existing) {
    this.session.updateMessage(safe);
  } else {
    this.session.appendMessage(safe);
  }
  // No reload — this.messages getter reads from session
  // No maxPersistedMessages — use compaction instead
}
```

### Clear

Before:

```typescript
private _handleClear() {
  this._turnQueue.reset();
  // ... abort all, clear resume, clear continuation ...
  this._clearMessages();
  this.messages = [];
  this._persistedMessageCache.clear();
  this._broadcast({ type: MSG_CHAT_CLEAR });
}
```

After:

```typescript
private _handleClear() {
  this._turnQueue.reset();
  // ... abort all, clear resume, clear continuation ...
  this.session.clearMessages();
  this._broadcast({ type: MSG_CHAT_CLEAR });
}
```

### Client tool persistence

Before (using `think_request_context` table):

```typescript
private _persistClientTools(): void {
  if (this._lastClientTools) {
    this.sql`
      INSERT OR REPLACE INTO think_request_context (key, value)
      VALUES ('lastClientTools', ${JSON.stringify(this._lastClientTools)})
    `;
  } else {
    this.sql`DELETE FROM think_request_context WHERE key = 'lastClientTools'`;
  }
}
```

After (using Session's `assistant_config` table):

```typescript
private _persistClientTools(): void {
  const sessionId = this.session._sessionId ?? "";
  if (this._lastClientTools) {
    this.sql`
      INSERT OR REPLACE INTO assistant_config (session_id, key, value)
      VALUES (${sessionId}, 'lastClientTools', ${JSON.stringify(this._lastClientTools)})
    `;
  } else {
    this.sql`DELETE FROM assistant_config WHERE session_id = ${sessionId} AND key = 'lastClientTools'`;
  }
}
```

### Dynamic configuration

Before (using `_think_config` table):

```typescript
configure(config: Config): void {
  this._ensureConfigTable();
  this.sql`INSERT OR REPLACE INTO _think_config (key, value) VALUES ('config', ${json})`;
}
```

After (using `assistant_config` table):

```typescript
configure(config: Config): void {
  const sessionId = this.session._sessionId ?? "";
  this.sql`
    INSERT OR REPLACE INTO assistant_config (session_id, key, value)
    VALUES (${sessionId}, '_think_config', ${JSON.stringify(config)})
  `;
  this.#configCache = config;
}
```

All Think-internal state consolidates into Session's `assistant_config` table. One table instead of three (`think_request_context`, `_think_config`, and the flat `assistant_messages`).

### Broadcasting messages

Before:

```typescript
private _broadcastMessages(exclude?: string[]): void {
  this._broadcast({
    type: MSG_CHAT_MESSAGES,
    messages: this.messages
  }, exclude);
}
```

After (same, but `this.messages` is now a getter):

```typescript
private _broadcastMessages(exclude?: string[]): void {
  this._broadcast({
    type: MSG_CHAT_MESSAGES,
    messages: this.messages  // Calls session.getHistory()
  }, exclude);
}
```

---

## Context Assembly Pipeline

The full pipeline from user message to LLM call:

```
1. User message arrives (WebSocket or RPC)
   │
2. session.appendMessage(userMsg)
   │  → INSERT into assistant_messages (idempotent by ID)
   │  → parent_id = latest leaf (or explicit)
   │  → Index in FTS5
   │  → Auto-compact if over tokenThreshold
   │
3. Broadcast messages to other clients
   │
4. Enter turn queue
   │
5. assembleContext()
   │  ├─ Context blocks configured?
   │  │  ├─ Yes → session.freezeSystemPrompt()
   │  │  │        → Check prompt store for cached prompt
   │  │  │        → If none: load all block providers, render, cache
   │  │  │        → Return frozen prompt string
   │  │  └─ No  → getSystemPrompt()
   │  │
   │  ├─ session.getHistory()
   │  │  → Recursive CTE: walk tree from latest leaf to root
   │  │  → Apply compaction overlays (replace ranges with summaries)
   │  │  → Return UIMessage[]
   │  │
   │  ├─ truncateOlderMessages(history)
   │  │  → Truncate old tool outputs (>500 chars)
   │  │  → Truncate old long text (>10K chars)
   │  │  → Keep recent messages intact
   │  │
   │  └─ pruneMessages(convertToModelMessages(truncated))
   │     → Strip tool calls from older messages
   │     → Return ModelMessage[]
   │
6. Merge tools: getTools() + clientTools + session.tools() + MCP tools
   │
7. streamText({ model, system, messages, tools, ... })
   │
8. Stream result → broadcast chunks → persist assistant message
   │
9. onChatResponse({ message, requestId, status })
```

---

## Regeneration via Branching

Session's tree structure enables regeneration as a first-class feature — closing a major gap vs AIChatAgent.

### How it works

1. Client sends `trigger: "regenerate-message"` with a truncated message list (up to the point where the user wants to regenerate)
2. Think finds the user message that the old assistant response was parented to
3. A new `onChatMessage` turn runs — the model sees the same history up to the branch point
4. The new assistant message is appended with the same parent as the old response, creating a sibling branch
5. `getHistory()` follows the latest leaf by default — the new response is the active path

```
User: "Explain monads"
  └─ Assistant (v1): "A monad is a monoid..." ← old response (still in tree)
  └─ Assistant (v2): "Think of a monad as..." ← new response (latest leaf, active path)
```

The old response remains accessible via `getBranches(userMessageId)`. The client could show a "← Previous version" UI.

### Contrast with AIChatAgent

AIChatAgent handles regeneration by deleting stale rows (`_deleteStaleRows: true` in `persistMessages`). This is destructive — the old response is gone. Session's branching is non-destructive — all alternatives are preserved.

---

## Multi-Session Support

For agents that need multiple conversations per DO instance, Think can expose `SessionManager`:

```typescript
export class MultiChatAgent extends Think<Env> {
  sessions = SessionManager.create(this)
    .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
    .withSearchableHistory("history")
    .withCachedPrompt();

  configureSession(session: Session) {
    // Default session — used when no sessionId is specified
    return session
      .withContext("memory", { maxTokens: 2000 })
      .withCachedPrompt();
  }

  // Switch session based on client request
  async onChatMessage(options?: ChatMessageOptions) {
    const sessionId = options?.body?.sessionId;
    if (sessionId) {
      this.session = this.sessions.getSession(sessionId);
    }
    return super.onChatMessage(options);
  }
}
```

`SessionManager` provides:

- `create(name)` — create a new session with metadata
- `list()` — list all sessions (ordered by `updated_at`)
- `delete(id)` — delete a session and its messages
- `rename(id, name)` — rename a session
- `fork(id, atMessageId, newName)` — fork a session at a specific point
- `search(query)` — cross-session FTS5 search
- `addUsage(id, inputTokens, outputTokens, cost)` — token accounting
- `compactAndSplit(id, summary)` — compact + archive old session, create new one with summary
- `tools()` — `session_search` tool for cross-session search

This is an advanced feature. Most agents use the default single-session mode and never touch `SessionManager`.

---

## Usage Examples

### Minimal (unchanged from current Think)

```typescript
export class ChatAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }
}
```

No `configureSession` needed. No context blocks. `getSystemPrompt()` returns the default. Behaves identically to a flat-message Think — Session operates in linear mode with no extras.

### With system prompt (unchanged)

```typescript
export class ChatAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }
  getSystemPrompt() {
    return "You are a helpful coding assistant specializing in TypeScript.";
  }
}
```

### With context blocks and self-updating memory

```typescript
export class MemoryAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: { get: async () => "You are a helpful coding assistant." }
      })
      .withContext("memory", {
        description:
          "Important facts learned during conversation. Update proactively.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }
}
```

The model gets:

- A frozen system prompt with `SOUL` (readonly) and `MEMORY` (writable) blocks
- A `set_context` tool that writes to the `MEMORY` block
- The memory block persists across sessions and survives hibernation

### With compaction for long conversations

```typescript
import { createCompactFunction } from "agents/experimental/memory/utils";

export class LongChatAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("memory", { maxTokens: 1500 })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.getModel(), prompt }).then((r) => r.text)
        })
      )
      .compactAfter(50000)
      .withCachedPrompt();
  }
}
```

When token count exceeds 50K, the session auto-compacts: summarizes the middle section with the LLM, stores an overlay, and refreshes the system prompt. The next `getHistory()` returns the compacted version.

### With R2 skills (on-demand knowledge)

```typescript
import { R2SkillProvider } from "agents/experimental/memory/session";

export class KnowledgeAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("docs", {
        description: "Project documentation — use load_context to read",
        provider: new R2SkillProvider(this.env.DOCS_BUCKET, { prefix: "docs/" })
      })
      .withContext("memory", { maxTokens: 1500 })
      .withCachedPrompt();
  }
}
```

System prompt shows skill metadata (list of available docs). Model uses `load_context` to fetch specific docs on demand.

### With usage tracking and post-turn hooks

```typescript
export class TrackedAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("memory", { maxTokens: 1500 })
      .withCachedPrompt();
  }

  async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      // Refresh context blocks after each turn (memory may have been updated)
      await this.session.refreshSystemPrompt();
    }
  }
}
```

---

## Design Decisions

### Why `configureSession` instead of constructor options?

Builder methods are discoverable via IDE autocomplete. The method can reference `this.env` (runtime bindings aren't available at class definition time). Extension classes can call `super.configureSession(session).withContext(...)` to add blocks without replacing the parent's configuration.

### Why `this.messages` as a getter instead of a cached field?

A getter that calls `session.getHistory()` eliminates staleness bugs — messages are always fresh from SQLite. The cost is a recursive CTE per access, but for typical conversation lengths (10–200 messages) this is <1ms on DO SQLite. For the streaming hot path (where Think previously called `this.messages = this._loadMessages()` at turn start), the getter is called once per turn and the result used throughout — no different from the reload pattern.

If profiling shows this is a bottleneck for very long conversations, we can add per-turn caching: set `_turnHistory = getHistory()` at turn start, return `_turnHistory` from the getter during a turn, clear at turn end. But we should profile first.

### Why context blocks instead of extending `getSystemPrompt`?

Context blocks solve three problems `getSystemPrompt` doesn't:

1. **Persistence**: Blocks survive hibernation, restart, and eviction. `getSystemPrompt` is re-evaluated each time.
2. **LLM-writable**: The model can update its own context via `set_context`. With `getSystemPrompt` the model has no way to persist learned information.
3. **Prefix caching**: The frozen prompt is stable across turns (writes don't invalidate until `refreshSystemPrompt`), enabling LLM prefix cache hits. A dynamic `getSystemPrompt` that reads from storage on every call defeats prefix caching.

### Why drop `maxPersistedMessages`?

Compaction is strictly better — it preserves information as summaries instead of deleting messages. `maxPersistedMessages` was a blunt instrument: it deleted the oldest messages regardless of whether they contained important context. With compaction, the LLM generates a structured summary that preserves key information, decisions, and open items.

For agents that truly need a hard ceiling (e.g., demo apps, resource-constrained environments), the compaction threshold serves the same purpose with better information retention.

### Why not have Session own the streaming pipeline?

Session is a storage and context layer. Streaming involves WebSocket protocol, chunk buffering, resumable streams, abort controllers, and broadcast — all of which are tightly coupled to Think's execution model. Keeping Session as pure storage makes it reusable (AIChatAgent could adopt it too) and keeps Think's streaming pipeline independent.

### Why tree structure for all messages, not just regeneration?

The `parent_id` column and recursive CTE add no overhead for linear conversations — `getHistory()` returns the same result as a flat `ORDER BY created_at`. But the tree structure enables:

- **Regeneration**: branch at any point, keep alternatives
- **Forking**: `SessionManager.fork()` copies a conversation up to a point
- **Sub-agent responses**: a parent agent can branch the conversation to try different approaches
- **Undo**: remove the last branch, previous version becomes active

These are all free once the tree is in place. Adding tree structure later would require a migration; starting with it costs nothing.

---

## What Session Doesn't Cover

These are handled by Think or the shared `agents/chat` layer. See [chat-improvements.md](./chat-improvements.md) for the extraction plan that moves duplicated code from AIChatAgent into `agents/chat` so Think can import rather than reimplement.

| Concern                 | Owner                                                    | Notes                                                                   |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Resumable streams       | `agents/chat` (`ResumableStream`)                        | Chunk buffering in `cf_ai_chat_stream_*` tables                         |
| Stream resume handshake | `agents/chat` (`StreamResumeHandler`)                    | Notify/ACK/replay pattern (extracted from both agents)                  |
| WebSocket protocol      | `agents/chat` (`ChatProtocolHandler`)                    | Protocol message dispatch (extracted from both agents)                  |
| Abort/cancel            | `agents/chat` (`AbortRegistry`)                          | Per-request `AbortController` (extracted from both agents)              |
| Tool state updates      | `agents/chat` (`findAndUpdateToolPart`)                  | Find tool part, match states, apply update (extracted from both agents) |
| Request context         | `agents/chat` (`RequestContextStore`)                    | Client tools, body persistence (extracted from both agents)             |
| Auto-continuation       | Think (`_continuation`, `_scheduleAutoContinuation`)     | 50ms coalesce, deferred queue (Think-specific)                          |
| Stream accumulation     | `agents/chat` (`StreamAccumulator`)                      | Build assistant message from chunks                                     |
| Message sanitization    | `agents/chat` (`sanitizeMessage`, `enforceRowSizeLimit`) | Applied before Session persistence                                      |
| Turn queue              | `agents/chat` (`TurnQueue`)                              | Serial turn execution with generation tracking                          |
| Continuation state      | `agents/chat` (`ContinuationState`)                      | Pending/active/deferred tracking                                        |
| Extensions              | Think (`ExtensionManager`)                               | Sandboxed Worker tools (Think-specific)                                 |
| Sub-agent RPC           | Think (`chat()`)                                         | `StreamCallback` interface (Think-specific)                             |

### SQLite table ownership

| Table                        | Owner                            | Purpose                                              |
| ---------------------------- | -------------------------------- | ---------------------------------------------------- |
| `assistant_messages`         | Session (`AgentSessionProvider`) | Tree-structured messages                             |
| `assistant_compactions`      | Session (`AgentSessionProvider`) | Compaction overlays                                  |
| `assistant_fts`              | Session (`AgentSessionProvider`) | FTS5 full-text search index                          |
| `assistant_config`           | Session (`AgentSessionProvider`) | Key-value config (Think config, client tools, etc.)  |
| `assistant_sessions`         | Session (`SessionManager`)       | Multi-session metadata (only if SessionManager used) |
| `cf_agents_context_blocks`   | Session (`AgentContextProvider`) | Context block storage                                |
| `cf_ai_chat_stream_metadata` | Think (`ResumableStream`)        | Stream replay metadata                               |
| `cf_ai_chat_stream_chunks`   | Think (`ResumableStream`)        | Stream replay chunks                                 |
| `cf_agents_runs`             | Agent (inherited)                | Durable fiber state                                  |
| `cf_agents_schedules`        | Agent (inherited)                | Scheduled tasks                                      |
