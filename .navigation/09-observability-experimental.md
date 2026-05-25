# 09 — Observability and Experimental Features

This section covers two areas: the observability system (how to instrument agents in production) and the experimental features (memory/session management and WebMCP) that are still under active development.

---

## Observability (`src/observability/`)

The observability system uses Node.js `diagnostics_channel` — a zero-overhead pub/sub mechanism. When no subscriber is registered, event emission costs nothing (no objects allocated, no function calls). When you attach a subscriber, you get structured events from every operation inside the agent.

### Event type definitions

[`BaseEvent<T, Payload>` type in `base.ts`](../packages/agents/src/observability/base.ts#L1-L28) — the envelope wrapping every event. Carries `agentClass` (the class name), `agentName` (the instance name), `payload`, and `timestamp`.

[`AgentObservabilityEvent` union type in `agent.ts`](../packages/agents/src/observability/agent.ts#L1-L79) — the full set of events emitted by the Agent class. Discriminated by the `type` field:

- `state:update` — state changed, with old and new values
- `rpc` / `rpc:error` — a `@callable()` method was invoked
- `message:request/response/clear/cancel/error` — WebSocket message lifecycle
- `tool:result` / `tool:approval` — tool execution outcomes
- `schedule:created/cancelled/fired/error` — schedule events
- `queue:enqueued/processed/error` — queue events
- `submission:started/completed/error` — programmatic `submitMessages()` turns
- `workflow:started/completed/error` — workflow events
- `email:receive/reply/send` — email events
- `connect` / `disconnect` / `destroy` — connection lifecycle

[`MCPObservabilityEvent` union type in `mcp.ts`](../packages/agents/src/observability/mcp.ts#L1-L39) — events from the MCP client layer: pre-connect, connect, authorize (OAuth), discover, close. Useful for tracking which external MCP servers your agent is connecting to.

### The observability API

[`Observability` interface and `channels` object in `index.ts`](../packages/agents/src/observability/index.ts#L1-L129) — `channels` is a plain object mapping event category strings to `diagnostics_channel.Channel` instances. `genericObservability` is the default implementation that publishes to these channels.

[`subscribe<K>(channelName, listener)` function](../packages/agents/src/observability/index.ts#L70-L129) — type-safe subscription. The generic parameter `K` constrains the listener type so TypeScript knows which event type the channel emits. Returns a dispose function to unsubscribe.

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

[`Session` class](../packages/agents/src/experimental/memory/session/session.ts#L1-L703) — the main object. Represents a single conversation thread.

[`Session.create(provider, options)` static builder](../packages/agents/src/experimental/memory/session/session.ts#L1-L100) — the entry point. Use the builder chain: `.withContext(block)`, `.withCachedPrompt(text)`, `.withTools(tools)`, `.withSearch(provider)`.

Key methods:
- `getContext()` — returns the full system prompt including context blocks
- `getHistory()` — returns the message array
- `append(message)` — add a message
- `update(id, message)` — update an existing message
- `search(query)` — FTS search across history
- `compact(model)` — summarise old messages to save context window space

### Session provider interface (`session/provider.ts`)

[`SessionProvider` interface](../packages/agents/src/experimental/memory/session/provider.ts#L1-L92) — the storage abstraction. Any backend that implements these methods can back the session system. Methods: `getMessage`, `getHistory`, `getLatestLeaf`, `getBranches`, `appendMessage`, `updateMessage`, `searchMessages`, `addCompaction`.

### Context blocks (`session/context.ts`)

[`ContextConfig`, `ContextBlock`, `ContextBlocks` types and class](../packages/agents/src/experimental/memory/session/context.ts#L1-L866) — context blocks are named slots in the system prompt that hold persistent data the LLM can read and (optionally) write. Each block has a `label`, a `description`, a `provider` (how to fetch the content), and a `maxTokens` budget. The `ContextBlocks` class manages the full set for a session.

### Session manager (`session/manager.ts`)

[`SessionManager` class](../packages/agents/src/experimental/memory/session/manager.ts#L1-L494) — coordinates multiple sessions. Useful for multi-user or multi-conversation agents. Tracks active sessions, handles session creation and cleanup.

### Storage providers (`session/providers/`)

[`AgentSessionProvider` in `providers/agent.ts`](../packages/agents/src/experimental/memory/session/providers/agent.ts#L1-L397) — stores sessions in the agent's own SQLite. The simplest option; zero external dependencies.

[`AgentContextProvider` in `providers/agent-context.ts`](../packages/agents/src/experimental/memory/session/providers/agent-context.ts#L1-L55) — read-only context provider backed by agent state. Useful for exposing agent state as a context block.

[`PostgresSessionProvider` in `providers/postgres.ts`](../packages/agents/src/experimental/memory/session/providers/postgres.ts#L1-L340) — stores sessions in a Postgres database. Enables shared history across multiple agent instances or geographic regions.

[`PostgresContextProvider` in `providers/postgres-context.ts`](../packages/agents/src/experimental/memory/session/providers/postgres-context.ts#L1-L47) — reads context blocks from Postgres.

[`PostgresSearchProvider` in `providers/postgres-search.ts`](../packages/agents/src/experimental/memory/session/providers/postgres-search.ts#L1-L81) — implements `SearchProvider` using Postgres full-text search (`tsvector` / `to_tsquery`).

### Compaction utilities (`utils/`)

[`estimateTokens(text)` in `utils/tokens.ts`](../packages/agents/src/experimental/memory/utils/tokens.ts#L1-L84) — a fast (no model call) token count estimate. Uses a word-count heuristic calibrated against common LLM tokenisers.

[`compactMessages()` in `utils/compaction.ts`](../packages/agents/src/experimental/memory/utils/compaction.ts#L1-L101) — takes a message array and returns a summarised version that fits within a token budget, preserving the most recent messages verbatim.

[Compaction helpers in `utils/compaction-helpers.ts`](../packages/agents/src/experimental/memory/utils/compaction-helpers.ts#L1-L493) — lower-level utilities: selecting which messages to compact, formatting them for summarisation, and merging the summary back in.

### Session index and utility re-exports

[`session/index.ts` — exports](../packages/agents/src/experimental/memory/session/index.ts#L1-L68) — the public surface of the session module. Re-exports `Session`, `SessionProvider`, `ContextBlocks`, `SessionManager`, all provider classes, and the search/skill interfaces.

[`memory/index.ts` — top-level exports](../packages/agents/src/experimental/memory/index.ts#L1-L17) — the package-level entry point. Re-exports everything from `session/index.ts` plus the utils.

[`utils/index.ts`](../packages/agents/src/experimental/memory/utils/index.ts#L1-L23) — re-exports `estimateTokens`, `compactMessages`, and the compaction helpers for use outside the session module.

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

[`registerWebMcp(tools, options?)` function](../packages/agents/src/experimental/webmcp.ts#L1-L100) — registers an array of `ModelContextTool` objects with the browser's model context. Each tool has a `name`, `description`, JSON schema for inputs, and an `execute` function.

[`McpHttpClient` class](../packages/agents/src/experimental/webmcp.ts#L146-L566) — an HTTP transport wrapper that bridges the browser-side WebMCP protocol to an HTTP MCP server. Used when the browser needs to proxy tool calls to a remote endpoint.

[`ModelContextTool` interface](../packages/agents/src/experimental/webmcp.ts#L1-L50) — the shape of a tool registered with `navigator.modelContext`: `name`, `description`, JSON Schema `schema`, and `execute(input) => Promise<unknown>`.

[`WebMcpLogger` interface](../packages/agents/src/experimental/webmcp.ts#L50-L100) — diagnostic logging interface for WebMCP events. Pass your own implementation to trace registration, discovery, and invocation.

---

## AI SDK type compatibility (`src/ai-types.ts`)

[`ai-types.ts` — AI SDK type shims](../packages/agents/src/ai-types.ts#L1-L5) — a tiny file that re-exports type aliases to keep the agents package compatible with both AI SDK v4 and v5 type shapes. If you see unexpected type errors when mixing agent code with AI SDK code, check here first.
