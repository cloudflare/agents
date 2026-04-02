# Session Search

Demonstrates searchable context blocks using the `SearchProvider` interface and `AgentSearchProvider` backed by DO SQLite FTS5.

> ⚠️ **Experimental** — this API will break between releases.

## What is a SearchProvider?

A `SearchProvider` extends `ContextProvider` with full-text search capabilities. It fits into the context provider hierarchy:

| Provider                  | Methods                           | Behavior                                                         |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `ContextProvider`         | `get()`                           | Readonly block in system prompt                                  |
| `WritableContextProvider` | `get()`, `set()`                  | Writable via `set_context` tool                                  |
| `SkillProvider`           | `get()`, `load()`, `set?()`       | Metadata in prompt, `load_context` + `set_context` tools         |
| **`SearchProvider`**      | **`get()`, `search()`, `set?()`** | **Searchable via `search_context`, indexable via `set_context`** |

The provider shape determines behavior — no flags needed. If a provider has a `search()` method, it's a `SearchProvider`.

## SearchProvider Interface

```typescript
interface SearchProvider extends ContextProvider {
  /** Full-text search. Called by the search_context tool. */
  search(query: string): Promise<string | null>;
  /** Index content under a key. Called by the set_context tool. */
  set?(key: string, content: string): Promise<void>;
}
```

All providers receive their block label via `init(label)` during setup — no need to pass the label at construction time.

## AgentSearchProvider

`AgentSearchProvider` is the built-in implementation using Durable Object SQLite with FTS5 full-text search.

```typescript
import {
  Session,
  AgentSearchProvider
} from "agents/experimental/memory/session";

Session.create(this)
  .withContext("soul", {
    provider: { get: async () => "You are a helpful assistant." }
  })
  .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
  .withContext("knowledge", {
    description: "Searchable knowledge base",
    provider: new AgentSearchProvider(this)
  })
  .withCachedPrompt();
```

### How it works

1. **Indexing** — the model calls `set_context("knowledge", { key: "meeting-notes", content: "..." })` to index content. Each entry has a unique key. Re-indexing the same key replaces the previous content.

2. **Searching** — the model calls `search_context("knowledge", { query: "deployment" })` to find relevant entries. Uses FTS5 with porter stemming and implicit AND for multi-word queries.

3. **System prompt** — the block renders with a summary of indexed entries and a hint to use `search_context`:
   ```
   ══════════════════════════════════════════════
   KNOWLEDGE (Searchable knowledge base — use search_context to search)
   ══════════════════════════════════════════════
   3 entries indexed. Recent:
   - meeting-notes
   - design-doc
   - api-spec
   ```

### Storage

Content is stored in two SQLite tables within the Durable Object:

- `cf_agents_search_entries` — the actual content (label, key, content, timestamps)
- `cf_agents_search_fts` — FTS5 virtual table for full-text search

## Cross-Session Search with SessionManager

For multi-chat agents, `SessionManager` can expose conversation history search across all sessions:

```typescript
import { SessionManager } from "agents/experimental/memory/session";

SessionManager.create(this)
  .withContext("memory", { maxTokens: 1100 })
  .withSearchableHistory("history") // searches messages across all sessions
  .withCachedPrompt();
```

The model sees a `HISTORY` block and can call `search_context("history", { query: "..." })` to find messages from any session. This is readonly — you can't write to conversation history via `set_context`.

## Generated Tools

Tools are auto-wired based on provider capabilities:

- **`set_context("knowledge", { key, content })`** — index content under a key (when provider has `set`)
- **`search_context("knowledge", { query })`** — full-text search (when provider has `search`)
- **`set_context("memory", { content })`** — write to regular context blocks
- **`load_context("skills", { key })`** — load skill content (for `SkillProvider` blocks)

## The Example

A chat agent with a searchable knowledge block. Tell the model facts and it indexes them. Ask questions and it searches for relevant information.

1. Tell the model: "Remember that the deployment is scheduled for Friday"
2. The model calls `set_context` to index this information
3. Later, ask: "When is the deployment?"
4. The model calls `search_context` to find the answer

## Setup

```bash
npm install
npm start
```
