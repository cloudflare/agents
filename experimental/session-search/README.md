# Session Search

Demonstrates searchable context blocks using the `AgentSearchProvider` backed by DO SQLite FTS5.

> ⚠️ **Experimental** — this API will break between releases.

## How It Works

The `SearchProvider` extends `ContextProvider` with `search()` for full-text search and a keyed `set()` for indexing content. The model indexes information via `set_context` and retrieves it via `search_context`.

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

### Provider Hierarchy

| Provider                  | Methods                       | Behavior                                                     |
| ------------------------- | ----------------------------- | ------------------------------------------------------------ |
| `ContextProvider`         | `get()`                       | Readonly block in system prompt                              |
| `WritableContextProvider` | `get()`, `set()`              | Writable via `set_context` tool                              |
| `SkillProvider`           | `get()`, `load()`, `set?()`   | Metadata in prompt, `load_context` + `set_context` tools     |
| `SearchProvider`          | `get()`, `search()`, `set?()` | Searchable via `search_context`, indexable via `set_context` |

### Generated Tools

- **`set_context`** — index content with a key: `set_context("knowledge", { key: "meeting-notes", content: "..." })`
- **`search_context`** — full-text search: `search_context("knowledge", { query: "deployment" })`

## The Example

Tell the model some facts, then ask questions about them. The model will:

1. Index the information using `set_context` with the knowledge block
2. Search for relevant information using `search_context` when you ask questions

## Setup

```bash
npm install
npm start
```
