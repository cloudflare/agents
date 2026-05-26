# 09 — Observability and Experimental Features

This section covers two areas: the observability system (how to instrument agents in production) and the experimental features (memory/session management and WebMCP) that are still under active development.

---

## Observability (`src/observability/`)

The observability system uses Node.js `diagnostics_channel` — a zero-overhead pub/sub mechanism. When no subscriber is registered, event emission costs nothing (no objects allocated, no function calls). When you attach a subscriber, you get structured events from every operation inside the agent.

### Event type definitions

[`BaseEvent<T, Payload>` type in `base.ts`](../packages/agents/src/observability/base.ts#L1-L28) — the envelope wrapping every event. Carries `agent` (the class name), `name` (the Durable Object instance name), `payload`, and `timestamp`. Both `agent` and `name` are optional so the same type can be used in non-agent contexts.

[`AgentObservabilityEvent` union type in `agent.ts`](../packages/agents/src/observability/agent.ts#L1-L79) — the full set of events emitted by the Agent class. Discriminated by the `type` field:

- `state:update` — state changed
- `rpc` / `rpc:error` — an RPC method was invoked or failed
- `message:request/response/clear/cancel/error` — WebSocket message lifecycle
- `tool:result` / `tool:approval` — tool execution outcomes
- `schedule:create/execute/cancel/retry/error/duplicate_warning` — schedule events
- `queue:create/retry/error` — queue events
- `submission:create/status/error` — programmatic `submitMessages()` turns
- `workflow:start/event/approved/rejected/terminated/paused/resumed/restarted` — workflow lifecycle events
- `email:receive/reply/send` — email events
- `connect` / `disconnect` / `destroy` — connection lifecycle

[`MCPObservabilityEvent` union type in `mcp.ts`](../packages/agents/src/observability/mcp.ts#L1-L39) — events from the MCP client layer: pre-connect, connect, authorize (OAuth), discover, close. Useful for tracking which external MCP servers your agent is connecting to.

### The observability API

[`Observability` interface and `channels` object in `index.ts`](../packages/agents/src/observability/index.ts#L1-L129) — `channels` is a plain object mapping category keys (`state`, `rpc`, `message`, `schedule`, `lifecycle`, `workflow`, `mcp`, `email`) to `diagnostics_channel.Channel` instances. `genericObservability` is the default implementation that routes each event to the correct channel via `getChannel()`. Also defines `ObservabilityEvent` (union of all event types) and `ChannelEventMap` (maps each channel key to its specific event type for type-safe subscriptions).

[`subscribe<K>(channelKey, callback)` function](../packages/agents/src/observability/index.ts#L70-L129) — type-safe subscription. The generic parameter `K` is a key of `ChannelEventMap`, which constrains the callback so TypeScript knows which event type the channel carries (e.g. subscribing to `"rpc"` gives a typed `rpc | rpc:error` event). Internally prefixes the key with `"agents:"` to form the full channel name. Returns a dispose function to unsubscribe.

Example usage:
```typescript
import { subscribe } from "agents/observability";
const dispose = subscribe("agent", (event) => {
  if (event.type === "rpc") {
    console.log(`RPC call: ${event.payload.method}`);
  }
});
```

---

## Experimental: memory and session system

`packages/agents/src/experimental/memory/` — an experimental long-term memory layer that sits on top of an agent's SQLite storage (or Postgres for multi-agent deployments). Provides conversation history with branching, full-text search, compaction, and pluggable context blocks.

**Status: experimental — API may change.**

### Core types (`session/types.ts`)

[`SessionMessage`, `SessionMessagePart`, `SessionOptions` types](../packages/agents/src/experimental/memory/session/types.ts#L1-L43) — the message schema. `SessionMessage` has an ID, role, array of `SessionMessagePart` (text, tool calls, results), and `createdAt`. `SessionOptions` configures context blocks and the prompt store.

### Session class (`session/session.ts`)

[Session class — constructor, create() builder, and builder chain methods](../packages/agents/src/experimental/memory/session/session.ts#L1-L240) and [Session — history reads, broadcast helpers, and write methods](../packages/agents/src/experimental/memory/session/session.ts#L240-L500) and [Session — compact(), context-block accessors, skill management, system prompt, search, and tools()](../packages/agents/src/experimental/memory/session/session.ts#L500-L703) — the main object. Represents a single conversation thread.

[`Session.create(provider)` static builder](../packages/agents/src/experimental/memory/session/session.ts#L1-L100) — the entry point. Accepts either a `SqlProvider` (an Agent with a `sql` method, for auto-wired SQLite) or a `SessionProvider` directly. Use the builder chain: `.withContext(label, options?)`, `.withCachedPrompt(provider?)`, `.onCompaction(fn)`, `.compactAfter(threshold)`, `.forSession(id)`.

Key methods:
- `freezeSystemPrompt()` / `refreshSystemPrompt()` — get or rebuild the system prompt with all context blocks rendered
- `getHistory(leafId?)` — returns the message path from root to leaf
- `appendMessage(message, parentId?)` — add a message; triggers auto-compaction if threshold is set
- `updateMessage(message)` — update an existing message
- `search(query)` — search across history via the storage provider
- `compact()` — run the registered compaction function and store the result as an overlay
- `tools()` — returns the AI tool set (`set_context`, `load_context`, `unload_context`, `search_context`) wired to the session's context blocks

### Session provider interface (`session/provider.ts`)

[`SessionProvider` interface](../packages/agents/src/experimental/memory/session/provider.ts#L1-L92) — the storage abstraction. Any backend that implements these methods can back the session system. Read methods: `getMessage`, `getHistory` (root-to-leaf path with compaction overlays applied), `getLatestLeaf`, `getBranches`, `getPathLength`. Write methods: `appendMessage`, `updateMessage`, `deleteMessages`, `clearMessages`. Compaction: `addCompaction`, `getCompactions`. Optional search: `searchMessages`. Also defines `SearchResult` and `StoredCompaction` value types.

### Context blocks (`session/context.ts`)

[context.ts — ContextProvider, WritableContextProvider, ContextConfig, ContextBlock interfaces, and ContextBlocks class constructor](../packages/agents/src/experimental/memory/session/context.ts#L1-L200) and [ContextBlocks — load(), addBlock(), removeBlock(), setBlock(), skill management (setSkill, loadSkill, unloadSkill), and search entry management](../packages/agents/src/experimental/memory/session/context.ts#L200-L480) and [ContextBlocks — toSystemPrompt(), captureSnapshot(), freezeSystemPrompt(), refreshSystemPrompt(), and tools() setup](../packages/agents/src/experimental/memory/session/context.ts#L480-L700) and [ContextBlocks tools — set_context, load_context, unload_context, and search_context implementations](../packages/agents/src/experimental/memory/session/context.ts#L700-L866) — context blocks are named slots in the system prompt that hold persistent data the LLM can read and (optionally) write. Each block has a `label`, a `description`, a `provider` (how to fetch the content), and a `maxTokens` budget. Providers can be read-only (`ContextProvider`), writable (`WritableContextProvider`), skill-based (`SkillProvider`), or searchable (`SearchProvider`). The `ContextBlocks` class manages the full set for a session.

### Session manager (`session/manager.ts`)

[SessionManager — class setup, factory, builder methods, and lazy init helpers](../packages/agents/src/experimental/memory/session/manager.ts#L1-L200) and [SessionManager — getSession(), create(), get/list/delete/rename, and message helpers](../packages/agents/src/experimental/memory/session/manager.ts#L200-L380) and [SessionManager — branching, compaction, usage tracking, search, and tools](../packages/agents/src/experimental/memory/session/manager.ts#L380-L494) — coordinates multiple sessions. Useful for multi-user or multi-conversation agents. Tracks active sessions, handles session creation and cleanup.

### Storage providers (`session/providers/`)

[AgentSessionProvider — SQL schema, getMessage(), getHistory(), and getLatestLeaf()](../packages/agents/src/experimental/memory/session/providers/agent.ts#L1-L200) and [AgentSessionProvider — appendMessage(), updateMessage(), searchMessages(), and addCompaction()](../packages/agents/src/experimental/memory/session/providers/agent.ts#L200-L397) — stores sessions in the agent's own SQLite. The simplest option; zero external dependencies.

[`AgentContextProvider` in `providers/agent-context.ts`](../packages/agents/src/experimental/memory/session/providers/agent-context.ts#L1-L55) — a `WritableContextProvider` backed by the agent's own SQLite (`cf_agents_context_blocks` table). Used by the `Session` builder to auto-wire context blocks and the system prompt store when no explicit provider is given.

[PostgresSessionProvider — connection setup, schema creation, and read methods](../packages/agents/src/experimental/memory/session/providers/postgres.ts#L1-L180) and [PostgresSessionProvider — write methods, compaction, and transaction helpers](../packages/agents/src/experimental/memory/session/providers/postgres.ts#L180-L340) — stores sessions in a Postgres database. Enables shared history across multiple agent instances or geographic regions.

[`PostgresContextProvider` in `providers/postgres-context.ts`](../packages/agents/src/experimental/memory/session/providers/postgres-context.ts#L1-L47) — reads context blocks from Postgres.

[`PostgresSearchProvider` in `providers/postgres-search.ts`](../packages/agents/src/experimental/memory/session/providers/postgres-search.ts#L1-L81) — implements `SearchProvider` using Postgres full-text search (`tsvector` / `to_tsquery`).

### Compaction utilities (`utils/`)

[`estimateStringTokens(text)` and `estimateMessageTokens(messages)` in `utils/tokens.ts`](../packages/agents/src/experimental/memory/utils/tokens.ts#L1-L84) — fast (no model call) token count estimates. `estimateStringTokens` uses a hybrid heuristic (max of character-based and word-based estimates) to handle both dense content and prose. `estimateMessageTokens` walks an array of `SessionMessage` objects, summing per-part estimates plus a per-message overhead constant. Avoids real tokenizers (e.g. tiktoken) because they cost ~80-120MB of heap, which exceeds Cloudflare Worker memory limits.

[`truncateOlderMessages()` in `utils/compaction.ts`](../packages/agents/src/experimental/memory/utils/compaction.ts#L1-L101) — a read-time truncation utility. Takes a message array and returns a copy with tool outputs and long text parts trimmed in older messages, leaving the most recent `keepRecent` messages (default: 4) fully intact. Used in `assembleContext()` before sending history to the LLM to avoid blowing the context window with verbose tool outputs.

[compaction-helpers — isCompactionMessage, tool-pair alignment, and boundary functions](../packages/agents/src/experimental/memory/utils/compaction-helpers.ts#L1-L160) and [compaction-helpers — token-budget tail protection and sanitizeToolPairs()](../packages/agents/src/experimental/memory/utils/compaction-helpers.ts#L160-L300) and [compaction-helpers — computeSummaryBudget(), buildSummaryPrompt(), and createCompactFunction()](../packages/agents/src/experimental/memory/utils/compaction-helpers.ts#L300-L493) — lower-level utilities: selecting which messages to compact, formatting them for summarisation, and merging the summary back in.

### Session index and utility re-exports

[`session/index.ts` — exports](../packages/agents/src/experimental/memory/session/index.ts#L1-L68) — the public surface of the session module. Re-exports `Session`, `SessionProvider`, `ContextBlocks`, `SessionManager`, all provider classes, and the search/skill interfaces.

[`memory/index.ts` — top-level exports](../packages/agents/src/experimental/memory/index.ts#L1-L17) — the package-level entry point. Re-exports everything from `session/index.ts` plus the utils.

[`utils/index.ts`](../packages/agents/src/experimental/memory/utils/index.ts#L1-L23) — re-exports `estimateStringTokens`, `estimateMessageTokens`, token constants, `truncateOlderMessages`, and the compaction helpers (`createCompactFunction`, `buildSummaryPrompt`, `computeSummaryBudget`, `sanitizeToolPairs`, etc.) for use outside the session module.

### Postgres adapter base (`session/providers/postgres-adapter.ts`)

[`PostgresAdapterBase` class](../packages/agents/src/experimental/memory/session/providers/postgres-adapter.ts#L1-L76) — shared base class for the Postgres providers. Manages the database connection, handles reconnection on failure, and provides a `query()` method with automatic retry. Both `PostgresSessionProvider` and `PostgresContextProvider` extend this.

### Skills (`session/skills.ts`)

[`SkillProvider` interface and `R2SkillProvider` class](../packages/agents/src/experimental/memory/session/skills.ts#L1-L111) — skills are reusable prompt fragments stored externally (e.g. in an R2 bucket). The `R2SkillProvider` fetches them by name and injects them into the system prompt.

### Full-text search (`session/search.ts`)

[`SearchProvider` interface and `AgentSearchProvider` class](../packages/agents/src/experimental/memory/session/search.ts#L1-L169) — `AgentSearchProvider` implements in-memory fuzzy search over the message history. Suitable for small histories; use `PostgresSearchProvider` for large-scale deployments.

---

## Experimental: WebMCP (`src/experimental/webmcp.ts`)

WebMCP is an experimental browser API that exposes MCP tools through `navigator.modelContext`. It lets a web page register tools that LLMs running in browser extensions or dedicated AI apps can discover and call.

**Status: experimental — follows the evolving WebMCP browser API specification.**

[Browser API type declarations](../packages/agents/src/experimental/webmcp.ts#L1-L100) — module-level JSDoc and the TypeScript ambient declarations that model Chrome's `navigator.modelContext` API: `ModelContextToolAnnotations`, `ModelContextClient`, `ModelContextTool` (the shape of a tool registered with `navigator.modelContext`: `name`, `description`, `inputSchema`, and `execute`), `ModelContextRegisterToolOptions`, `ModelContext`, and the global `Navigator` interface extension. None of these are exported — they are local type scaffolding.

[`WebMcpLogger` interface and default/silent logger constants](../packages/agents/src/experimental/webmcp.ts#L103-L145) — `WebMcpLogger` is the exported diagnostic logging interface (`info`, `warn`, `error`). The module creates two built-in implementations: `DEFAULT_LOGGER` (prefixes output with `[webmcp-adapter]`) and `SILENT_LOGGER` (no-op). Pass your own `WebMcpLogger` via `WebMcpOptions.logger`, or set `quiet: true` for the silent variant.

[McpHttpClient — constructor, initialize(), listTools(), and callTool()](../packages/agents/src/experimental/webmcp.ts#L146-L290) — internal HTTP transport wrapper (not exported). Wraps the MCP SDK `Client` + `StreamableHTTPClientTransport` to connect to a remote MCP endpoint, paginate through tools, and call them. Also handles dynamic headers (`getHeaders`) and per-request timeouts. `listenForChanges()` wires up `tools/list_changed` notifications.

[WebMcpOptions, WebMcpHandle, and registerWebMcp() signature](../packages/agents/src/experimental/webmcp.ts#L290-L440) — exported public API types. `WebMcpOptions` configures the adapter (URL, headers, watch mode, prefix, timeout, logger, callbacks). `WebMcpHandle` is the return value: exposes the currently registered tool names, `refresh()`, `dispose()`, and `disposed`.

[registerWebMcp() — tool registration, sync logic, watch setup, and return handle](../packages/agents/src/experimental/webmcp.ts#L440-L566) — the implementation of `registerWebMcp()`. Initialises the `McpHttpClient`, performs the initial tool sync, optionally sets up watch-mode for `tools/list_changed` notifications, and returns a `WebMcpHandle`. If `navigator.modelContext` is absent (non-Chrome), returns a no-op handle immediately without making any network requests.

---

## AI SDK type compatibility (`src/ai-types.ts`)

[`ai-types.ts` — deprecated compatibility shim](../packages/agents/src/ai-types.ts#L1-L5) — re-exports `IncomingMessage` and `OutgoingMessage` from `@cloudflare/ai-chat/types` and merges the `MessageType` enum from both `@cloudflare/ai-chat` and the agents package. Emits a deprecation warning at import time: all AI Chat modules have moved to `@cloudflare/ai-chat` and this file will be removed in the next major version.
