# Sessions (Experimental)

The Session API provides persistent conversation storage for agents, with tree-structured messages, context blocks, compaction, full-text search, and AI-controllable tools. It runs entirely on Durable Object SQLite — no external database needed.

> **Experimental.** The Session API is under `agents/experimental/memory/session`. The API surface is stable but may evolve before graduating to the main package.

## Quick Start

```typescript
import { Agent } from "agents";
import { Session } from "agents/experimental/memory/session";

class MyAgent extends Agent {
  session = Session.create(this)
    .withContext("soul", {
      provider: { get: async () => "You are a helpful assistant." }
    })
    .withContext("memory", {
      description: "Learned facts about the user",
      maxTokens: 1100
    })
    .withCachedPrompt();

  async onMessage(message) {
    await this.session.appendMessage(message);
    const history = this.session.getHistory();
    const system = await this.session.freezeSystemPrompt();
    const tools = await this.session.tools();
    // Pass history, system prompt, and tools to your LLM
  }
}
```

## Session

`Session` manages a single conversation's messages, context blocks, and compaction state.

### Creating a Session

There are two ways to create a Session:

**Builder API (recommended)** — uses `Session.create(agent)` with a chainable builder. Context providers without an explicit `provider` option are auto-wired to SQLite.

```typescript
const session = Session.create(this)
  .withContext("soul", { provider: { get: async () => "You are helpful." } })
  .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
  .withCachedPrompt()
  .onCompaction(myCompactFn)
  .compactAfter(100_000);
```

**Direct constructor** — takes a `SessionProvider` and options directly. Used when you want full control over providers.

```typescript
import {
  AgentSessionProvider,
  AgentContextProvider
} from "agents/experimental/memory/session";

const session = new Session(new AgentSessionProvider(this), {
  context: [
    {
      label: "memory",
      description: "Notes",
      maxTokens: 500,
      provider: new AgentContextProvider(this, "memory")
    },
    { label: "soul", provider: { get: async () => "You are helpful." } }
  ]
});
```

### Builder Methods

All builder methods return `this` for chaining. Order doesn't matter — providers are resolved lazily on first use.

| Method                          | Description                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Session.create(agent)`         | Static factory. `agent` is any object with a `sql` tagged template method (i.e. your Agent/DO).                                                               |
| `.forSession(sessionId)`        | Namespace this session by ID. Required for multi-session isolation when not using SessionManager. Context provider keys and storage are scoped to this ID.    |
| `.withContext(label, options?)` | Add a context block. See [Context Blocks](#context-blocks).                                                                                                   |
| `.withCachedPrompt(provider?)`  | Enable system prompt persistence. The prompt is frozen on first use and survives DO hibernation/eviction. Without an explicit provider, auto-wires to SQLite. |
| `.onCompaction(fn)`             | Register a compaction function. See [Compaction](#compaction).                                                                                                |
| `.compactAfter(tokenThreshold)` | Auto-compact when estimated token count exceeds the threshold. Checked after each `appendMessage()`. Requires `.onCompaction()`.                              |

### Messages

Messages use the `SessionMessage` type — a minimal shape with `id`, `role`, `parts`, and optional `createdAt`. The Vercel AI SDK's `UIMessage` is structurally compatible and can be passed directly without conversion. The session stores messages in a tree structure via `parent_id`, enabling branching conversations.

```typescript
// Append — auto-parents to the latest leaf unless parentId is specified
await session.appendMessage(message);
await session.appendMessage(message, parentId);

// Update an existing message (matched by message.id)
session.updateMessage(message);

// Delete specific messages
session.deleteMessages(["msg-1", "msg-2"]);

// Clear all messages and skill state
session.clearMessages();
```

> **Note:** `appendMessage()` is `async` because it may trigger auto-compaction. The underlying storage write is synchronous (SQLite), but the compaction step involves an LLM call. All other write methods (`updateMessage`, `deleteMessages`, `clearMessages`) are synchronous.

#### Reading History

```typescript
// Linear history from root to the latest leaf
const messages = session.getHistory();

// History to a specific leaf (for branching)
const branch = session.getHistory(leafId);

// Get a single message
const msg = session.getMessage("msg-1");

// Get the newest message
const latest = session.getLatestLeaf();

// Count messages in path
const count = session.getPathLength();
```

#### Branching

Messages form a tree. When you `appendMessage` with a `parentId` that already has children, you create a branch. Use `getBranches()` to get all child messages branching from a given point:

```typescript
// Get all child messages that branch from messageId (e.g. multiple responses to a user message)
const branches = session.getBranches(messageId);
```

This powers features like response regeneration — pass the user message ID to get both the original and regenerated responses. `getHistory(leafId)` walks the chosen path.

### Search

Full-text search over the conversation history using SQLite FTS5:

```typescript
const results = session.search("deployment Friday", { limit: 10 });
// Returns: Array<{ id, role, content, createdAt? }>
```

Uses porter stemming and unicode tokenization. The search covers all messages in the session.

> **Note:** `search()` throws if the session provider doesn't support search. The built-in `AgentSessionProvider` supports it.

### WebSocket Broadcasts

When the Session's `agent` object has a `broadcast()` method (all `Agent` subclasses do), the Session automatically broadcasts status events over WebSocket after each write operation:

- **`CF_AGENT_SESSION`** — phase (`"idle"` or `"compacting"`), `tokenEstimate`, `tokenThreshold`
- **`CF_AGENT_SESSION_ERROR`** — emitted on compaction failure

This allows connected clients to display real-time token usage and compaction status.

---

## Context Blocks

Context blocks are persistent key-value sections injected into the system prompt. Each block has a **label**, optional **description**, and a **provider** that determines its behavior.

### Provider Types

There are four provider types, detected by duck-typing:

| Provider                    | Interface                       | Behavior                                                                                         | AI Tool                                         |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **ContextProvider**         | `get()`                         | Read-only block in system prompt                                                                 | —                                               |
| **WritableContextProvider** | `get()` + `set()`               | Writable via AI                                                                                  | `set_context`                                   |
| **SkillProvider**           | `get()` + `load()` + `set?()`   | On-demand keyed documents. `get()` returns a metadata listing; `load(key)` fetches full content. | `load_context`, `unload_context`, `set_context` |
| **SearchProvider**          | `get()` + `search()` + `set?()` | Full-text searchable entries. `get()` returns a summary; `search(query)` runs FTS5.              | `search_context`, `set_context`                 |

All providers also support an optional `init(label)` method, called before first use with the block's label.

### Built-in Providers

**`AgentContextProvider`** — SQLite-backed writable context. This is what you get by default when using the builder without an explicit provider.

```typescript
import { AgentContextProvider } from "agents/experimental/memory/session";

// Explicit usage — key determines the SQLite row
new AgentContextProvider(this, "memory");
```

**`R2SkillProvider`** — Cloudflare R2 bucket for on-demand document loading. Skills are listed in the system prompt as metadata; the model loads full content on demand via `load_context`.

```typescript
import { R2SkillProvider } from "agents/experimental/memory/session";

Session.create(this).withContext("skills", {
  provider: new R2SkillProvider(env.SKILLS_BUCKET, { prefix: "skills/" })
});
```

Descriptions are stored in R2 custom metadata (`description` key).

**`AgentSearchProvider`** — SQLite FTS5 searchable context. Entries are indexed and searchable by the model via `search_context`.

```typescript
import { AgentSearchProvider } from "agents/experimental/memory/session";

Session.create(this).withContext("knowledge", {
  description: "Searchable knowledge base",
  provider: new AgentSearchProvider(this)
});
```

### Adding and Removing Context at Runtime

Blocks can be added and removed dynamically after initialization — useful for extensions:

```typescript
// Add a new block (auto-wires to SQLite if no provider given)
await session.addContext("extension-notes", {
  description: "From extension X",
  maxTokens: 500
});

// Remove it
session.removeContext("extension-notes");

// Rebuild the system prompt to reflect changes
await session.refreshSystemPrompt();
```

> **Note:** `addContext` and `removeContext` do NOT automatically update the frozen system prompt. You must call `refreshSystemPrompt()` afterward.

### Reading Context Blocks

```typescript
// Single block
const block = session.getContextBlock("memory");
// block: { label, description?, content, tokens, maxTokens?, writable, isSkill, isSearchable }

// All blocks
const blocks = session.getContextBlocks();
```

### Writing to Context Blocks

```typescript
// Replace content entirely
await session.replaceContextBlock("memory", "User likes coffee.");

// Append content
await session.appendContextBlock("memory", "\nUser prefers dark roast.");
```

> **Note:** Writing to a context block updates the provider immediately but does NOT update the frozen system prompt snapshot. This is intentional — it preserves the LLM prefix cache. Call `refreshSystemPrompt()` when you want changes reflected in the prompt.

### System Prompt

The system prompt is built from all context blocks with headers and metadata:

```
══════════════════════════════════════════════
SOUL (Identity) [readonly]
══════════════════════════════════════════════
You are a helpful assistant.

══════════════════════════════════════════════
MEMORY (Learned facts) [45% — 495/1100 tokens]
══════════════════════════════════════════════
User likes coffee.
User prefers dark roast.
```

```typescript
// Freeze — first call renders and persists, subsequent calls return the cached value
const prompt = await session.freezeSystemPrompt();

// Refresh — re-render from current block state and persist
const updated = await session.refreshSystemPrompt();
```

The frozen prompt survives DO hibernation and eviction when `withCachedPrompt()` is enabled. After eviction, the next `freezeSystemPrompt()` call loads from SQLite rather than re-rendering.

### Skills (Load/Unload)

Skills are on-demand documents stored in a `SkillProvider` (e.g. R2). The model sees a metadata listing in the system prompt and can load full content on demand:

```typescript
// Unload a skill to free context space (rewrites the tool result in history)
session.unloadSkill("skills", "api-reference");

// Check what's currently loaded
const loaded = session.getLoadedSkillKeys(); // Set<"skills:api-reference">
```

After hibernation/eviction, loaded skills are reconstructed by scanning conversation history for `load_context` tool results. This means skill state survives restarts without additional storage.

> **Weird:** The skill restoration scans the entire conversation history looking for `load_context` tool invocations in assistant messages with `state: "output-available"`. When you unload a skill, it doesn't delete the tool result — it rewrites the `output` field to `"[skill unloaded: key]"` in-place. This means the original loaded content is permanently lost from history after unload.

---

## AI Tools

Session automatically generates tools based on the provider types of your context blocks. Pass these to your LLM alongside your own tools.

```typescript
const tools = await session.tools();
// Merge with your own tools:
const allTools = { ...tools, ...myTools };
```

### `set_context`

Generated when any writable block exists. Writes to regular blocks, skill blocks (keyed), or search blocks (keyed).

- For regular blocks: `{ label, content, action: "replace" | "append" }`
- For skill blocks: `{ label, key, content, description? }`
- For search blocks: `{ label, key, content }`

Enforces `maxTokens` limits. Returns a usage string like `"Written to memory. Usage: 45% (495/1100 tokens)"`.

### `load_context`

Generated when any skill block exists. Loads full content by key from a `SkillProvider`.

- Input: `{ label, key }`
- Returns the document content, or `"Not found: key"`

### `unload_context`

Generated alongside `load_context`. Frees context space by unloading a previously loaded skill.

- Input: `{ label, key }`
- Rewrites the tool result in conversation history to a short marker
- The skill remains available for re-loading

The tool's description dynamically lists currently loaded skills.

### `search_context`

Generated when any search block exists. Full-text search within a searchable context block.

- Input: `{ label, query }`
- Returns top 10 results by FTS5 rank, or `"No results found."`

### `session_search`

Available on `SessionManager` only (not on individual sessions). Searches across all sessions.

- Input: `{ query }`
- Returns results from all sessions, or `"No results found."`

Use `{ ...sessionTools, ...manager.tools() }` to give the model both per-session and cross-session tools.

---

## Compaction

Compaction summarizes older messages to keep conversations within token limits. Original messages are preserved in SQLite — the summary is a non-destructive overlay applied at read time.

### Setup

```typescript
import { createCompactFunction } from "agents/experimental/memory/utils/compaction-helpers";

const session = Session.create(this)
  .withContext("memory", { maxTokens: 1100 })
  .onCompaction(
    createCompactFunction({
      summarize: (prompt) =>
        generateText({ model: myModel, prompt }).then((r) => r.text),
      protectHead: 3, // Keep first 3 messages (default: 3)
      tailTokenBudget: 20000, // Protect ~20K tokens at the tail (default: 20000)
      minTailMessages: 2 // Always keep at least 2 tail messages (default: 2)
    })
  )
  .compactAfter(100_000); // Auto-compact at 100K estimated tokens
```

### How It Works

1. **Protect head** — first N messages are never compacted (default 3)
2. **Protect tail** — walk backward from the end, accumulating tokens up to a budget (default 20K tokens)
3. **Align boundaries** — shift boundaries to avoid splitting tool call/result pairs
4. **Summarize middle** — send the middle section to an LLM with a structured format (Topic, Key Points, Current State, Open Items)
5. **Store overlay** — saved in `assistant_compactions` table, keyed by `fromMessageId` and `toMessageId`
6. **Iterative** — on subsequent compactions, the existing summary is passed to the LLM to update rather than replace

When `getHistory()` is called, compaction overlays are applied transparently — the compacted range is replaced by a synthetic message with id `compaction_<id>`.

### Manual Compaction

```typescript
// Run registered compaction function
const result = await session.compact();

// Or manage overlays directly
session.addCompaction("Summary of messages 1-50", "msg-1", "msg-50");
const overlays = session.getCompactions();
```

### Auto-Compaction

When `.compactAfter(threshold)` is set, `appendMessage()` checks the estimated token count after each write. If it exceeds the threshold, `compact()` is called automatically. Auto-compaction failure is non-fatal — the message is already saved.

> **Note:** Token estimation is heuristic (not tiktoken). It uses `max(chars/4, words*1.3)` with 4 tokens per-message overhead. This is intentional — tiktoken would add 80-120MB heap overhead, which exceeds Cloudflare Workers' 128MB limit.

> **Weird:** Compaction is iterative but single-overlay. Each new compaction extends from the earliest existing compaction's `fromMessageId` to the new end. So you always have at most one active compaction overlay per session, and it keeps growing. The previous compaction rows remain in the database but are superseded by the latest one (which covers a wider range). `getCompactions()` returns all of them, but `getHistory()` applies the latest one.

---

## SessionManager

`SessionManager` is a registry for multiple named sessions within a single Durable Object. It provides lifecycle management, convenience methods, and cross-session search.

### Creating a SessionManager

```typescript
import { SessionManager } from "agents/experimental/memory/session";

const manager = SessionManager.create(this)
  .withContext("soul", { provider: { get: async () => "You are helpful." } })
  .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
  .withCachedPrompt()
  .onCompaction(myCompactFn)
  .compactAfter(100_000)
  .withSearchableHistory("history");
```

Context blocks, prompt caching, and compaction settings are propagated to all sessions created through the manager. Provider keys are automatically namespaced by session ID (e.g. `memory_<sessionId>`).

### Builder Methods

| Method                          | Description                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SessionManager.create(agent)`  | Static factory.                                                                                                          |
| `.withContext(label, options?)` | Add context block template for all sessions.                                                                             |
| `.withCachedPrompt(provider?)`  | Enable prompt persistence for all sessions.                                                                              |
| `.onCompaction(fn)`             | Register compaction function for all sessions.                                                                           |
| `.compactAfter(tokenThreshold)` | Auto-compact threshold for all sessions.                                                                                 |
| `.withSearchableHistory(label)` | Add a cross-session searchable history block to every session. The model can search past conversations from any session. |

### Session Lifecycle

```typescript
// Create a new session
const info = manager.create("My Chat");
// info: { id, name, parent_session_id, model, source, input_tokens, output_tokens, estimated_cost, end_reason, created_at, updated_at }

// Create with metadata
const info2 = manager.create("My Chat", {
  parentSessionId: "parent-id",
  model: "claude-sonnet-4-20250514",
  source: "web"
});

// Get session metadata (null if not found)
const session = manager.get(sessionId);

// List all sessions (ordered by updated_at DESC)
const sessions = manager.list();

// Rename
manager.rename(sessionId, "New Name");

// Delete (clears messages too)
manager.delete(sessionId);
```

### Accessing Sessions

```typescript
// Get or create the Session instance for an ID
// Lazy — creates on first access, caches for subsequent calls
const session = manager.getSession(sessionId);
```

### Message Convenience Methods

These delegate to the underlying Session but also update the session's `updated_at` timestamp:

```typescript
// Append a single message
await manager.append(sessionId, message, parentId?);

// Add or update (upsert)
await manager.upsert(sessionId, message, parentId?);

// Batch append (auto-chains parent IDs)
await manager.appendAll(sessionId, messages, parentId?);

// Read history
const history = manager.getHistory(sessionId, leafId?);

// Message count
const count = manager.getMessageCount(sessionId);

// Clear messages
manager.clearMessages(sessionId);

// Delete specific messages
manager.deleteMessages(sessionId, ["msg-1"]);
```

### Forking

Fork a session at a specific message — copies history up to that point into a new session:

```typescript
const forked = await manager.fork(sessionId, atMessageId, "Forked Chat");
// forked.parent_session_id === sessionId
```

> **Weird:** Fork copies messages with new UUIDs, not the original IDs. This means message IDs in the forked session won't match the original. The fork also doesn't copy compaction overlays — the forked session starts clean with the materialized history.

### Compaction

```typescript
// Add a compaction overlay
manager.addCompaction(sessionId, summary, fromId, toId);

// Get overlays
const compactions = manager.getCompactions(sessionId);

// Compact and split — marks old session as ended, creates a continuation
const continuation = await manager.compactAndSplit(
  sessionId,
  summary,
  "Continued Chat"
);
// continuation.parent_session_id === sessionId
// Old session gets end_reason = "compaction"
```

`compactAndSplit` is different from regular compaction — it creates a new session with a summary message instead of an in-place overlay. The original session is marked with `end_reason: "compaction"`.

### Usage Tracking

```typescript
manager.addUsage(sessionId, inputTokens, outputTokens, cost);
// Increments input_tokens, output_tokens, and estimated_cost on the session row
```

### Cross-Session Search

```typescript
// Search across all sessions (FTS5)
const results = manager.search("deployment Friday", { limit: 20 });
// Returns: Array<{ id, role, content, createdAt }>

// Get tools for the model (includes session_search)
const tools = manager.tools();
```

> **Note:** `manager.search()` uses a separate FTS5 index (`assistant_fts`) from per-session search. Messages are indexed into this table by the `AgentSessionProvider` when appended. The `session_search` tool limits results to 10.

> **Weird:** `manager.search()` silently returns an empty array on FTS5 query errors (malformed queries, etc.) rather than throwing.

---

## Storage

All storage is in Durable Object SQLite. Tables are created lazily on first use.

### Tables

**`assistant_messages`** — Tree-structured messages.

| Column       | Type     | Notes                                                  |
| ------------ | -------- | ------------------------------------------------------ |
| `id`         | TEXT PK  | Message ID                                             |
| `session_id` | TEXT     | Empty string for single-session; set for multi-session |
| `parent_id`  | TEXT     | Parent message ID (null for roots)                     |
| `role`       | TEXT     | `user`, `assistant`, `system`                          |
| `content`    | TEXT     | JSON-serialized `SessionMessage`                       |
| `created_at` | DATETIME | Auto-set                                               |

**`assistant_compactions`** — Compaction overlays.

| Column            | Type     | Notes                    |
| ----------------- | -------- | ------------------------ |
| `id`              | TEXT PK  | Random UUID              |
| `session_id`      | TEXT     | Scoped to session        |
| `summary`         | TEXT     | LLM-generated summary    |
| `from_message_id` | TEXT     | Start of compacted range |
| `to_message_id`   | TEXT     | End of compacted range   |
| `created_at`      | DATETIME | Auto-set                 |

**`assistant_fts`** — FTS5 virtual table for message search. Tokenizer: `porter unicode61`.

**`assistant_sessions`** — Session registry (SessionManager only).

| Column              | Type     | Notes                      |
| ------------------- | -------- | -------------------------- |
| `id`                | TEXT PK  | Random UUID                |
| `name`              | TEXT     | Display name               |
| `parent_session_id` | TEXT     | For forks/splits           |
| `model`             | TEXT     | Optional model identifier  |
| `source`            | TEXT     | Optional source identifier |
| `input_tokens`      | INTEGER  | Cumulative input tokens    |
| `output_tokens`     | INTEGER  | Cumulative output tokens   |
| `estimated_cost`    | REAL     | Cumulative cost            |
| `end_reason`        | TEXT     | `"compaction"` when split  |
| `created_at`        | DATETIME | Auto-set                   |
| `updated_at`        | DATETIME | Updated on message ops     |

**`cf_agents_context_blocks`** — Persistent context block storage (`AgentContextProvider`).

**`cf_agents_search_entries`** + **`cf_agents_search_fts`** — Searchable context entries and FTS5 index (`AgentSearchProvider`).

---

## Custom Providers

You can implement any of the four provider interfaces to plug in your own storage:

```typescript
// Read-only context
const myProvider: ContextProvider = {
  get: async () => "Static content here"
};

// Writable context (enables set_context tool)
const myWritable: WritableContextProvider = {
  get: async () => fetchFromMyDB(),
  set: async (content) => saveToMyDB(content)
};

// Skill provider (enables load_context tool)
const mySkills: SkillProvider = {
  get: async () => "- api-ref: API Reference\n- guide: User Guide",
  load: async (key) => fetchDocument(key),
  set: async (key, content, description) =>
    saveDocument(key, content, description) // optional
};

// Search provider (enables search_context tool)
const mySearch: SearchProvider = {
  get: async () => "42 entries indexed",
  search: async (query) => searchMyIndex(query),
  set: async (key, content) => indexContent(key, content) // optional
};
```

You can also implement `SessionProvider` to replace the SQLite storage entirely:

```typescript
const myStorage: SessionProvider = {
  getMessage(id) { ... },
  getHistory(leafId?) { ... },
  getLatestLeaf() { ... },
  getBranches(messageId) { ... },
  getPathLength(leafId?) { ... },
  appendMessage(message, parentId?) { ... },
  updateMessage(message) { ... },
  deleteMessages(messageIds) { ... },
  clearMessages() { ... },
  addCompaction(summary, fromId, toId) { ... },
  getCompactions() { ... },
  searchMessages(query, limit) { ... } // optional
};
```

---

## Postgres (External Database)

The built-in providers use Durable Object SQLite. If you need session data in an external Postgres database — for cross-DO queries, analytics, or shared state — use `PostgresSessionProvider` and `PostgresContextProvider`.

These work with any Postgres-compatible database (PlanetScale, Neon, Supabase, etc.) via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for connection pooling.

### Setup

#### 1. Create a Postgres database

Use any Postgres provider. For PlanetScale:
- Create a database at [planetscale.com](https://planetscale.com)
- Go to **Connect** → copy the connection string

#### 2. Create a Hyperdrive config

```bash
npx wrangler hyperdrive create my-session-db \
  --connection-string="postgresql://user:password@host:port/dbname"
```

Copy the returned Hyperdrive ID.

#### 3. Create the tables

The Postgres user typically won't have `CREATE TABLE` permissions. Run this once in your database console:

```sql
CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent ON assistant_messages (parent_id);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_session ON assistant_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_fts ON assistant_messages USING GIN (content_tsv);

CREATE TABLE IF NOT EXISTS assistant_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  from_message_id TEXT NOT NULL,
  to_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
  label TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cf_agents_search_entries (
  label TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (label, key)
);
CREATE INDEX IF NOT EXISTS idx_search_entries_fts ON cf_agents_search_entries USING GIN (content_tsv);
```

#### 4. Configure wrangler

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<your-hyperdrive-id>"
    }
  ],
  "placement": {
    "region": "aws:us-east-1"  // match your database region
  }
}
```

#### 5. Wire it up

```typescript
import { Agent, callable } from "agents";
import {
  Session,
  PostgresSessionProvider,
  PostgresContextProvider,
  PostgresSearchProvider,
  type PostgresConnection
} from "agents/experimental/memory/session";
import { Client } from "pg";

// Wrap pg Client to match the PostgresConnection interface
function wrapPgClient(client: Client): PostgresConnection {
  return {
    async execute(query, args) {
      let idx = 0;
      const pgQuery = query.replace(/\?/g, () => `$${++idx}`);
      const result = await client.query(pgQuery, args ?? []);
      return { rows: result.rows };
    }
  };
}

class MyAgent extends Agent<Env> {
  private _session?: Session;
  private _pgClient?: Client;

  private async getConnection(): Promise<PostgresConnection> {
    if (!this._pgClient) {
      this._pgClient = new Client({
        connectionString: this.env.HYPERDRIVE.connectionString
      });
      await this._pgClient.connect();
    }
    return wrapPgClient(this._pgClient);
  }

  private async getSession(): Promise<Session> {
    if (this._session) return this._session;

    const conn = await this.getConnection();
    const sessionId = this.ctx.id.toString();

    this._session = Session.create(
      new PostgresSessionProvider(conn, sessionId)
    )
      .withContext("memory", {
        description: "Learned facts",
        maxTokens: 1100,
        provider: new PostgresContextProvider(conn, `memory_${sessionId}`)
      })
      .withCachedPrompt(
        new PostgresContextProvider(conn, `_prompt_${sessionId}`)
      );

    return this._session;
  }
}
```

### How it works

When `Session.create()` receives a `SessionProvider` instead of a `SqlProvider`, it skips all SQLite auto-wiring. This means:

- **Context blocks need explicit providers.** No auto-wiring to SQLite — each `withContext()` call needs a `provider` option, or the block will be read-only with no storage.
- **`withCachedPrompt()` needs an explicit provider.** Pass a `PostgresContextProvider` to persist the frozen system prompt.
- **Broadcaster is skipped.** WebSocket status broadcasts (`CF_AGENT_SESSION` events) only work with `SqlProvider`-based sessions.
- **All Session methods are async.** `getHistory()`, `getMessage()`, etc. return Promises since the underlying storage is async.

### PostgresConnection interface

```typescript
interface PostgresConnection {
  execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
```

The providers use `?` placeholders internally. When wrapping `pg`, convert to `$1, $2, $3` (see the `wrapPgClient` helper above). Any Postgres driver with a compatible `execute()` method works.

### Search

`PostgresSessionProvider` uses Postgres full-text search via a generated `tsvector` column and GIN index. The migration above includes both — search works out of the box with English stemming and ranking via `ts_rank`.

---

## Utilities

Exported from `agents/experimental/memory/utils`:

### Token Estimation

```typescript
import {
  estimateStringTokens,
  estimateMessageTokens
} from "agents/experimental/memory/utils/tokens";

estimateStringTokens("Hello world"); // heuristic: max(chars/4, words*1.3)
estimateMessageTokens(messages); // sum with 4 tokens per-message overhead
```

### Compaction Helpers

```typescript
import {
  createCompactFunction,
  isCompactionMessage,
  sanitizeToolPairs,
  alignBoundaryForward,
  alignBoundaryBackward,
  findTailCutByTokens,
  computeSummaryBudget,
  buildSummaryPrompt,
  COMPACTION_PREFIX
} from "agents/experimental/memory/utils/compaction-helpers";
```

- `createCompactFunction(options)` — Full compaction implementation. See [Compaction](#compaction).
- `isCompactionMessage(msg)` — Check if a message is a compaction overlay (id starts with `compaction_`).
- `sanitizeToolPairs(messages)` — Fix orphaned tool call/result pairs after compaction. Removes orphaned results and adds stub results for calls whose results were dropped.
- `alignBoundaryForward/Backward(messages, idx)` — Shift a boundary index to avoid splitting tool call/result groups.
- `findTailCutByTokens(messages, headEnd, budget, minMessages)` — Find where to stop compressing using a token budget.
- `computeSummaryBudget(messages)` — 20% of compressed content tokens (minimum 100).
- `buildSummaryPrompt(messages, previousSummary, budget)` — Structured prompt for LLM summarization.

---

## Exports

Everything is exported from `agents/experimental/memory/session`:

```typescript
import {
  // Core
  Session,
  SessionManager,

  // Providers
  AgentSessionProvider,
  AgentContextProvider,
  AgentSearchProvider,
  R2SkillProvider,
  PostgresSessionProvider,
  PostgresContextProvider,
  PostgresSearchProvider,

  // Type guards
  isWritableProvider,
  isSkillProvider,
  isSearchProvider,

  // Types
  type SessionMessage,
  type SessionMessagePart,
  type SessionContextOptions,
  type SessionInfo,
  type SessionManagerOptions,
  type SessionOptions,
  type ContextBlock,
  type ContextConfig,
  type ContextProvider,
  type WritableContextProvider,
  type SkillProvider,
  type SearchProvider,
  type SearchResult,
  type SessionProvider,
  type StoredCompaction,
  type SqlProvider,
  type PostgresConnection
} from "agents/experimental/memory/session";
```

Compaction utilities from `agents/experimental/memory/utils/compaction-helpers`:

```typescript
import {
  createCompactFunction,
  isCompactionMessage,
  sanitizeToolPairs,
  COMPACTION_PREFIX,
  type CompactResult,
  type CompactOptions
} from "agents/experimental/memory/utils/compaction-helpers";
```

Token utilities from `agents/experimental/memory/utils/tokens`:

```typescript
import {
  estimateStringTokens,
  estimateMessageTokens
} from "agents/experimental/memory/utils/tokens";
```

---

## Gotchas and Quirks

Things that might surprise you:

1. **Lazy initialization.** Sessions created with the builder don't initialize until first use. The first call to any method (e.g. `getHistory()`) triggers `_ensureReady()`, which creates SQLite tables, resolves providers, loads context blocks, and restores skill state from history. This means the first operation is slower than subsequent ones.

2. **Snapshot freezing is sticky.** `freezeSystemPrompt()` caches the result. Writing to a context block does NOT update the cached snapshot — you must explicitly call `refreshSystemPrompt()`. This is deliberate (LLM prefix cache optimization), but easy to miss.

3. **`appendMessage` is async, other writes are sync.** `appendMessage` is async only because it may trigger auto-compaction (which calls an LLM). The actual SQLite write is synchronous. `updateMessage`, `deleteMessages`, and `clearMessages` are all synchronous.

4. **Skills survive hibernation via history scanning.** On initialization, the session scans the entire conversation history looking for `load_context` tool results to reconstruct which skills are loaded. This is clever but means initialization cost scales with conversation length.

5. **Compaction overlays are superseding, not stacking.** Each compaction extends from the earliest existing `fromMessageId`. So you always have one effective overlay that keeps growing. Old compaction rows remain in the database but are unused. `getCompactions()` returns all rows, which can be confusing.

6. **Search is silently absent.** `session.search()` throws if the provider doesn't support search, but `manager.search()` swallows FTS5 errors and returns `[]`. The `searchMessages` method on `SessionProvider` is optional (`searchMessages?`).

7. **Fork copies with new IDs.** When forking via `SessionManager.fork()`, all messages get new UUIDs. If you're storing message IDs externally (e.g. for bookmarks), they won't survive a fork.

8. **`removeContext` doesn't fire skill unload callbacks.** If you remove a context block that had loaded skills, the skill tracking is cleaned up but the conversation history is NOT rewritten. The tool results from those skills remain in history with their full content.

9. **FTS5 query sanitization.** Both `AgentSearchProvider.search()` and `SessionManager.search()` quote individual words to prevent FTS5 syntax injection. This means you can't use FTS5 operators like `OR`, `NOT`, or `NEAR` — they'll be treated as literal search terms.

10. **Auto-compaction failure is silent.** When `compactAfter` triggers and the compaction function throws, the error is emitted via WebSocket broadcast but the `appendMessage` call still succeeds. The message is saved; only the compaction is skipped.
