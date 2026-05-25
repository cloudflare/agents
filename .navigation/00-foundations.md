# 00 — Foundations

These files define the bedrock abstractions that everything else imports. Read them first so that later sections make sense without constant back-references.

---

## Event emitter (`core/events.ts`)

The codebase uses its own tiny event/disposable system rather than Node's EventEmitter. It underpins how state updates propagate inside an agent instance.

[`Disposable` interface and `DisposableStore`](../packages/agents/src/core/events.ts#L1-L52) — a resource-cleanup pattern: anything that should be torn down implements `Disposable`, and a `DisposableStore` lets you register multiple disposables and `.dispose()` them all at once. Used throughout the MCP client layer to clean up subscriptions.

[`Emitter<T>` class and `Event<T>` type](../packages/agents/src/core/events.ts#L30-L52) — a typed single-event emitter. `Event<T>` is just a function type `(listener) => Disposable`. You attach listeners and get back a `Disposable` to remove them. Keeps the API surface small and avoids the stringly-typed `on('event', fn)` pattern.

---

## Wire protocol message types (`src/types.ts`)

A tiny 13-line file, but it is the canonical source of truth for message type strings.

[`MessageType` enum](../packages/agents/src/types.ts#L1-L13) — defines the `CF_AGENT_*` constants that flow over WebSocket connections between browser clients and the agent. Every chat and tool message is tagged with one of these. The higher-level chat modules import from here rather than hard-coding strings.

---

## Email and RPC wire types (`src/index.ts` — type section)

Before the `Agent` class itself, `index.ts` opens with the exported types that describe the messages agents exchange with the outside world.

[Email types: `EmailSendBinding`, `SendEmailOptions`](../packages/agents/src/index.ts#L119-L155) — the shape of outgoing email sends via an email service binding.

[RPC wire types: `RPCRequest`, `StateUpdateMessage`, `RPCResponse`](../packages/agents/src/index.ts#L158-L228) — every callable method invocation between a browser client and agent travels as one of these. `StateUpdateMessage` is broadcast to all connected clients whenever state changes.

[`CallableMetadata` and the `callable()` decorator](../packages/agents/src/index.ts#L230-L469) — marking an agent method with `@callable()` makes it invocable over RPC. The decorator stores metadata (description, etc.) in a `WeakMap`; the Agent base class reads this during startup to build its dispatch table.

---

## Queue, Schedule, and Fiber type vocabulary (`src/index.ts` — type section cont.)

[`QueueItem<T>` and `Schedule<T>`](../packages/agents/src/index.ts#L481-L577) — the shapes stored in SQLite for queued callbacks and scheduled tasks respectively. A `Schedule` can be a one-shot future timestamp, a cron expression, or a delay.

[`ScheduleCriteria`](../packages/agents/src/index.ts#L578-L660) — filter options passed to `getSchedules()`: filter by callback name, schedule type, or time range.

[Fiber types: `FiberContext`, `FiberStatus`, `FiberInspection`, `StartFiberOptions`](../packages/agents/src/index.ts#L661-L755) — fibers are lightweight long-running async tasks that survive Durable Object hibernation. These types describe what gets persisted to SQLite and how callers interact with a fiber's lifecycle.

---

## MCP server metadata types (`src/index.ts`)

[`MCPServer`, `MCPServersState`, `AddMcpServerOptions`](../packages/agents/src/index.ts#L809-L900) — describe the set of MCP servers an agent is currently connected to (the `mcp` property exposed by the agent) and the options for connecting to a new one.

---

## Static agent configuration (`src/index.ts`)

[`AgentStaticOptions` interface](../packages/agents/src/index.ts#L1104-L1145) — a class-level options bag set via `static options = { ... }` on your agent subclass. Covers hibernation behaviour, default retry/backoff settings, and initial state. Read this before reading the `Agent` class so you know which knobs exist.

[`DEFAULT_AGENT_STATIC_OPTIONS` constant](../packages/agents/src/index.ts#L1063-L1103) — the defaults: hibernation on, modest retry limits.

---

## Serialization (`src/serializable.ts`)

Agents pass structured data over RPC. The serialization layer handles the translation to/from JSON-safe values.

[`Serializable` and `Deserializable` types](../packages/agents/src/serializable.ts#L1-L50) — generic constraints that ensure values round-trip through JSON without loss.

[`serialize()` / `deserialize()` helpers](../packages/agents/src/serializable.ts#L51-L175) — used internally by the Agent class when sending RPC arguments and responses. Worth knowing so you understand why certain argument types are rejected at the type level.

---

## Retry utilities (`src/retries.ts`)

[`RetryOptions` type and `withRetry()` function](../packages/agents/src/retries.ts#L1-L159) — an exponential-backoff retry wrapper with jitter. The `Agent` class exposes this as `this.retry()`, and the MCP client uses it for tool calls. The implementation lives here so it can also be imported independently.

---

## Miscellaneous utilities (`src/utils.ts`, `src/schedule.ts`)

[`camelToSnake()` and `isStub()` helpers](../packages/agents/src/utils.ts#L1-L35) — `camelToSnake` is used to normalise Durable Object class names into URL path segments. `isStub` checks whether you hold a real agent instance or a remote stub (needed to avoid infinite RPC loops).

[Schedule utilities](../packages/agents/src/schedule.ts#L1-L140) — helper functions for parsing, normalising, and formatting cron and delay expressions. Used internally by `schedule()`.

---

## Sub-agent routing types (`src/sub-routing.ts`)

[`SubAgentClass<T>` and `SubAgentStub<T>`](../packages/agents/src/index.ts#L421-L450) — TypeScript generics that let the type system know which methods are available on a remote sub-agent (facet). `SubAgentStub` automatically removes `async` and wraps return types in `Promise`, reflecting the RPC boundary.

[Sub-routing — path parsing, facet address encoding, and parent validation](../packages/agents/src/sub-routing.ts#L1-L300) and [Sub-routing — remaining helpers and exports](../packages/agents/src/sub-routing.ts#L301-L335) — path parsing and matching for facet addresses. A facet is identified by a path like `myAgent/facet/sessionId`; this module decodes and encodes those paths and verifies they belong to the correct parent agent.

---

## Agent tool types (`src/agent-tool-types.ts`, `src/agent-tools.ts`)

[`AgentToolDescriptor` and `AgentToolTypes`](../packages/agents/src/agent-tool-types.ts#L1-L158) — describes the shape of a tool as seen by the agent runtime: name, description, input schema, output schema. Used when exposing agent capabilities to other agents or to the MCP layer.

[`createAgentTools()` and related helpers](../packages/agents/src/agent-tools.ts#L1-L130) — builds the AI SDK `ToolSet` that lets one agent call another agent's `@callable()` methods as if they were ordinary AI tools.
