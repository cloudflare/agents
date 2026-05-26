# 01 — The Agent Class

The `Agent<Env, State, Props>` class in `packages/agents/src/index.ts` is the central abstraction of this entire repository. Every other package either extends it, wraps it, or depends on a stub of it. This section walks you through its lifecycle, storage, and async primitives.

The class is large (≈8 000 lines within `index.ts`). Rather than reading it linearly, follow the concepts below.

---

## Class definition and generic parameters

[`export class Agent<Env, State, Props>`](../packages/agents/src/index.ts#L1230-L1360) — the class signature and its three type parameters:

- **`Env`** — the Cloudflare Workers environment bindings (KV, D1, R2, other Workers, etc.)
- **`State`** — the shape of the agent's durable state. Must be JSON-serialisable. Defaults to `unknown`.
- **`Props`** — optional context passed at construction time (e.g. authenticated user info). Also persisted as JSON.

The class extends `PartyServer` from the `partyserver` package, which handles the Durable Object transport layer (WebSockets, hibernation). You rarely need to know the details of `PartyServer` directly; the Agent class wraps everything.

---

## `static options` and configuration

[`static options: AgentStaticOptions`](../packages/agents/src/index.ts#L1419-L1485) — override this on your subclass to change per-class defaults. The most commonly changed field is `hibernate: false` when you need the Durable Object to stay alive between requests rather than going to sleep.

---

## Lifecycle methods (override these in your subclass)

These are the hooks you implement. The base class provides no-op defaults, so you only override what you need.

[`onStart(props?: Props)`](../packages/agents/src/index.ts#L2159-L2300) — called once when the Durable Object is first created or when it wakes from hibernation. Good place to initialise SQL tables, set up MCP connections, or restore saved state.

[`onConnect(connection, ctx)`](../packages/agents/src/index.ts#L2013-L2128) — called when a new WebSocket client connects. `connection` has an `id`, and `ctx.request` gives you the original HTTP request (headers, URL).

[`onMessage(connection, message)`](../packages/agents/src/index.ts#L1887-L2012) — called for each WebSocket message. In the base `Agent` class this handles the built-in RPC and state-sync protocol; `AIChatAgent` and `Think` override it to add chat message routing.

[`onClose(connection, code, reason, wasClean)`](../packages/agents/src/index.ts#L2129-L2158) — called when a WebSocket disconnects.

[`onError(connectionOrError, error?)`](../packages/agents/src/index.ts#L2960-L2985) — called on transport errors. Overload: `onError(connection, error)` for per-connection errors, `onError(error)` for server-level errors. The default implementation logs and rethrows; override to handle gracefully.

[`onRequest(request)`](../packages/agents/src/index.ts#L1871-L1886) — called for plain HTTP requests to this agent (not WebSocket upgrades). Return a `Response`.

[`onEmail(email: AgentEmail)`](../packages/agents/src/index.ts#L2677-L2730) — called when this agent receives an inbound email (requires the email routing setup in `routeAgentEmail`).

---

## State management

[`get state(): State`](../packages/agents/src/index.ts#L1362-L1418) — read the current state. On first access, the state is hydrated from Durable Object storage. The getter merges `initialState` with persisted state.

[`setState(state: State)`](../packages/agents/src/index.ts#L2353-L2362) — replace the entire state and broadcast a `StateUpdateMessage` to all connected WebSocket clients. Does not do a partial merge — pass the whole next state object.

[`initialState` property](../packages/agents/src/index.ts#L1362-L1418) — override this (as a class field) to define the default value when no state is stored yet.

State is synced to all connected browser clients automatically. The `useAgent()` React hook subscribes to these updates so your UI re-renders when the agent changes state.

---

## SQL access

Every agent has a built-in SQLite database (Cloudflare's `SqlStorage` inside the Durable Object).

[`sql<T>(strings, ...values)` tagged template literal](../packages/agents/src/index.ts#L1486-L1560) — execute a SQL query and get back a typed array of rows. Parameters are bound safely (no injection risk). Returns synchronously because `SqlStorage` is synchronous in Workers.

```typescript
// Example usage
const rows = this.sql<{ id: string; value: number }>`
  SELECT id, value FROM my_table WHERE id = ${userId}
`;
```

The agent itself uses several internal tables (prefixed `cf_`); you can freely add your own tables. See `onStart()` for the standard pattern of creating tables if they don't exist.

[`SqlError` class](../packages/agents/src/index.ts#L242-L260) — thrown when a SQL query fails. Contains the original query text for debugging.

---

## Scheduling

[`schedule<T>(when, callback, payload?)`](../packages/agents/src/index.ts#L3916-L4078) — schedule a method call for the future. `when` can be:
- A `Date` or millisecond timestamp — run once at that time
- A delay string like `"5 minutes"` — run once after that duration
- A cron string like `"0 * * * *"` — run on a recurring cron schedule

`callback` is the name of a method on your agent. `payload` is an optional JSON-serialisable value passed to that method. Schedules survive hibernation and agent restarts.

[`getSchedules(criteria?)`](../packages/agents/src/index.ts#L4079-L4123) — list pending schedules. Synchronous.

[`cancelSchedule(id)`](../packages/agents/src/index.ts#L4124-L4135) — cancel a pending schedule by ID.

---

## Queuing

[`queue<T>(callback, payload?, options?)`](../packages/agents/src/index.ts#L3033-L3070) — enqueue a method call for serial processing. Unlike `schedule()`, the queue runs as fast as possible — each item is processed as soon as the previous one finishes. Persisted in SQLite.

[`dequeue(id)` and `dequeueAll()`](../packages/agents/src/index.ts#L3160-L3210) — manually remove items from the queue (for cases where you need to cancel work in flight).

---

## Retry

[`retry<T>(fn, options?)`](../packages/agents/src/index.ts#L3007-L3032) — retries an async function with exponential backoff. Options come from `RetryOptions` (see `src/retries.ts`). The agent also applies retry automatically to `schedule()` and `queue()` callbacks using the class-level `static options.retry` defaults.

---

## Fibers (long-running async tasks)

Fibers are the most advanced primitive. They let you run an `async function` that can outlive multiple Durable Object hibernation cycles — the fiber's stack is not actually suspended; instead the fiber's state machine is persisted and re-run from the last checkpoint.

[`startFiber(fn, options?)`](../packages/agents/src/index.ts#L4732-L4900) — start a new fiber. Returns a `FiberInspection` describing the fiber's current state. The function you pass receives a `FiberContext` with `signal` (AbortSignal), `id`, and helpers like `sleep()` and `waitFor()`.

[`listFibers(options?)`](../packages/agents/src/index.ts#L4488-L4565) — enumerate running and completed fibers. Useful for dashboards and debugging.

[`FiberContext`, `FiberStatus`, `FiberInspection`](../packages/agents/src/index.ts#L661-L755) — see the type definitions for the full API surface.

---

## MCP server management on the agent

[`addMcpServer(name, server, options?)`](../packages/agents/src/index.ts#L9331-L9430) — connect to an MCP server and make its tools available to your agent's AI calls. The server can be a binding (`env.MY_MCP`), an HTTP URL, or another Agent stub. Connections are persisted to SQLite so they survive hibernation.

[`getMcpServers()`](../packages/agents/src/index.ts#L9630-L9700) — returns the current `MCPServersState`, a snapshot of all connected servers and their statuses. This is also broadcast to connected clients so the UI can show connection state.

---

## Routing and the client stub

Agents are addressed by name within a Durable Object namespace. The runtime glue that routes an incoming HTTP/WebSocket request to the right agent lives outside the class:

[`routeAgentRequest<Env>(request, env, ctx, options?)`](../packages/agents/src/index.ts#L9836-L9937) — the top-level fetch handler for an agent namespace. Parses the request URL, looks up the Durable Object by name, and forwards the request. Put this in your Worker's `fetch` export (or use the Hono middleware — see section 08).

[`getAgentByName<T>(namespace, name, options?)`](../packages/agents/src/index.ts#L10019-L10033) — get a remote `AgentStub` by name. Useful when one agent needs to call another.

[`StreamingResponse`](../packages/agents/src/index.ts#L10034-L10114) — a helper for streaming raw bytes back from an agent RPC call. Used internally by `@callable()` methods that return streams.

---

## Internal agent wiring

The following ranges cover the internals of the `Agent` class that you rarely need to understand in day-to-day work, but are invaluable when debugging unexpected behaviour.

[`_ensureSchema()` — SQLite table creation and migrations](../packages/agents/src/index.ts#L1560-L1710) — creates all internal `cf_agents_*` tables (`cf_agents_state`, `cf_agents_mcp_servers`, `cf_agents_queues`, `cf_agents_schedules`, `cf_agents_workflows`, `cf_agents_runs`, `cf_agents_fibers`, `cf_agents_facet_runs`, `cf_agent_tool_runs`) and runs additive column migrations, gated by a schema version stored in `cf_agents_state`. Idempotent — skips DDL on established DOs whose schema is current. Followed by the Agent constructor body: initialises `MCPClientManager`, wires MCP observability/state-change listeners, and computes the `_persistenceHookMode` flag (new/old/none) that gates `onStateChanged`/`onStateUpdate` dispatch.

[Lifecycle method instrumentation — constructor wraps onRequest, onMessage, onConnect, onClose, onStart](../packages/agents/src/index.ts#L1710-L1870) — the constructor replaces each user-overridable lifecycle method with a closure that (1) runs `agentContext.run()` to establish the `AsyncLocalStorage` context that powers `getCurrentAgent()`, (2) handles sub-agent WebSocket forwarding before delegating to the user's override, (3) calls `_tryCatch` for consistent error handling. The `onMessage` wrapper also implements the built-in RPC and state-sync protocol, routing JSON frames to `_setStateInternal` or to the callable dispatch table before falling through to the user's `onMessage`.

[Wrapped onRequest, onMessage, onConnect, onClose, onStart implementations](../packages/agents/src/index.ts#L1870-L2160) — the closures installed by the constructor for each lifecycle hook. The `onConnect` wrapper sends the agent identity frame, current state, and MCP server list to newly connected clients; handles readonly/no-protocol flags; and replays agent-tool events. The `onStart` wrapper restores `_isFacet`, facet name, parent path, and sub-agent WebSocket connections from storage; runs `_checkRunFibers` and MCP reconnection; then calls the user's `onStart`. Also contains `_checkOrphanedWorkflows` (warns when workflow binding names have changed) and `_broadcastProtocol` (filters protocol frames away from no-protocol connections and facet-bridge sockets).

[State broadcast internals and connection flag helpers](../packages/agents/src/index.ts#L2299-L2435) — `_setStateInternal()`: persists the new state to `cf_agents_state`, broadcasts a `CF_AGENT_STATE` frame to protocol-enabled connections (excluding the source), then fires `onStateChanged`/`onStateUpdate` via `ctx.waitUntil`. Also covers `setState()` (the public API, checks readonly context), `_ensureConnectionWrapped()` (installs getter/setter overrides on the connection object to hide `_cf_`-prefixed internal flags from user code), and the readonly/no-protocol connection flag helpers (`setConnectionReadonly`, `isConnectionReadonly`, `_unsafe_getConnectionFlag`, `_unsafe_setConnectionFlag`).

[Queue processing loop](../packages/agents/src/index.ts#L3070-L3160) — the `while` loop that drains the SQLite queue table, calling each queued callback in turn. Includes retry logic and error recovery.

[Schedule SQL storage — create, update, and lookup helpers](../packages/agents/src/index.ts#L3350-L3649) and [Schedule cancellation and getSchedules internals](../packages/agents/src/index.ts#L3650-L3916) — how schedules are persisted to a `cf_agents_schedules` SQLite table and how the Durable Object `alarm()` handler fires them. The `schedule()` method picks the earliest scheduled time and sets the DO alarm accordingly.

[Fiber ledger reads — list, inspect, and query running fibers](../packages/agents/src/index.ts#L4488-L4732) and [startFiber implementation — persistence, execution, and error recovery](../packages/agents/src/index.ts#L4732-L5000) and [Fiber cleanup and hibernation handoff](../packages/agents/src/index.ts#L5000-L5133) — the fiber lifecycle: how `startFiber()` creates a ledger entry in `cf_agents_fibers`, how the fiber function runs inside a protected `try/catch` that stores the current step, and how `onStart()` recovers in-progress fibers after hibernation.

[Facet fiber recovery and scheduled callback dispatch into sub-agents](../packages/agents/src/index.ts#L5133-L5350) and [Alarm lifecycle, fetch() entry point, and broadcast helpers](../packages/agents/src/index.ts#L5350-L5649) and [Broadcast helpers continued and sub-agent routing setup](../packages/agents/src/index.ts#L5650-L5700) and [Sub-agent WebSocket connection bridging and routing helpers](../packages/agents/src/index.ts#L5700-L5999) — how sub-agents are created, how their Durable Object names are computed from the parent's path, and how parent-to-child RPC calls are routed.

[Sub-agent RPC invocation and facet initialisation as sub-agent](../packages/agents/src/index.ts#L6000-L6299) and [Agent identity accessors — name, parentPath, selfPath, parentAgent](../packages/agents/src/index.ts#L6300-L6599) and [Sub-agent instantiation, namespace resolution, and method binding](../packages/agents/src/index.ts#L6600-L6899) and [Sub-agent state management, registration, and cleanup](../packages/agents/src/index.ts#L6900-L7199) and [Agent factory methods — agent() and facets() entry points](../packages/agents/src/index.ts#L7200-L7499) and [Agent factory internals — state initialisation and prop binding](../packages/agents/src/index.ts#L7500-L7799) and [Agent tooling helpers and internal utility methods](../packages/agents/src/index.ts#L7800-L8099) and [addMcpServer — HTTP and SSE transport path](../packages/agents/src/index.ts#L8100-L8399) and [addMcpServer — connection establishment and callback host resolution](../packages/agents/src/index.ts#L8400-L8699) and [MCP connection state management and server discovery](../packages/agents/src/index.ts#L8700-L8999) and [MCP tool and resource registration; getMcpServers() (part 1)](../packages/agents/src/index.ts#L9000-L9299) and [MCP tool and resource registration; getMcpServers() (part 2)](../packages/agents/src/index.ts#L9300-L9330) — the `mcp` property, `addMcpServer()` implementation, SQLite persistence of server metadata, and the reconnection logic that runs in `onStart()`.

[addMcpServer() — RPC transport variant and EmailBridge wiring](../packages/agents/src/index.ts#L9330-L9629) and [getMcpServers(), createOAuthProvider(), and routeAgentRequest() internals](../packages/agents/src/index.ts#L9630-L9836) — `_onEmail()` implementation, how the email resolver is called, how replies are signed, and the internal routing helpers used by `routeAgentRequest()`.

---

## Vite integration shim (`src/vite.ts`)

[`vite.ts` re-exports](../packages/agents/src/vite.ts#L1-L25) — a minimal re-export shim for Vite-based projects. Because Vite cannot natively resolve the `agents` package (it uses Cloudflare Workers-specific module resolution), this file re-exports the public API in a format Vite can bundle. Import from `agents/vite` instead of `agents` when working in a Vite project.

---

## CLI tooling (`src/cli/`)

[`createCli()` function in `src/cli/create.ts`](../packages/agents/src/cli/create.ts#L1-L48) — a Yargs-based CLI with `init`, `dev`, `deploy`, and `mcp` subcommands. Currently all commands are stubs — they print "not implemented yet". This is infrastructure for a future `npx agents` development experience.

[CLI entry point in `src/cli/index.ts`](../packages/agents/src/cli/index.ts#L1-L6) — one line: imports and calls `createCli()`.

---

## Deprecated compatibility shims

[`src/ai-chat-agent.ts`](../packages/agents/src/ai-chat-agent.ts#L1-L6) — re-exports `AIChatAgent` from the `@cloudflare/ai-chat` package. Kept so old import paths don't break. New code should import from `@cloudflare/ai-chat` directly.

[`src/ai-chat-v5-migration.ts`](../packages/agents/src/ai-chat-v5-migration.ts#L1-L6) — re-exports the AI SDK v4→v5 migration helper from `@cloudflare/ai-chat`.

[`src/ai-react.tsx`](../packages/agents/src/ai-react.tsx#L1-L6) — re-exports `useAgentChat` from `@cloudflare/ai-chat/react`.

[`src/codemode/ai.ts`](../packages/agents/src/codemode/ai.ts#L1-L6) — throws an error directing users to import from `@cloudflare/codemode/ai` instead. The codemode tools moved to their own package.

---

## The client stub (`src/client.ts`)

On the browser side, `packages/agents/src/client.ts` implements the matching half of the RPC protocol.

[AgentClient types, RPC method types, and createStubProxy() factory](../packages/agents/src/client.ts#L1-L220) and [AgentClient constructor, WebSocket setup, and message handlers](../packages/agents/src/client.ts#L220-L430) and [AgentClient RPC dispatch, setState(), close(), and agentFetch() helper](../packages/agents/src/client.ts#L430-L545) — connects via WebSocket, sends RPC calls, receives state updates, and exposes the same API surface as the server-side agent. The `useAgent()` React hook wraps this.

[`useAgent()` React hook](../packages/agents/src/react.tsx#L1-L100) — the simplest way to use an agent from a React component. Returns `{ agent, state }` where `agent` is the stub and `state` is the latest broadcast state.

---

## Context propagation (`src/internal_context.ts`)

[`getCurrentAgent()` and `runWithAgentContext()`](../packages/agents/src/internal_context.ts#L1-L50) — uses `AsyncLocalStorage` to make the current agent instance available anywhere in the call stack without passing it explicitly. This is how `getCurrentAgent<MyAgent>()` works when called from nested helpers.
