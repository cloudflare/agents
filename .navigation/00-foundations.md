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

[Internal facet connection bridge types, `SubAgentClass<T>`, `SubAgentStub<T>`, and the `callable()` decorator](../packages/agents/src/index.ts#L230-L469) — this range is dominated by internal plumbing for the facet (sub-agent) system: `FacetCapableCtx`, `SubAgentConnectionBridge`, `RootSubAgentConnectionBridge`, and `SubAgentWebSocketEndpoint` implement the per-connection message bridge between parent and child Durable Objects. `SubAgentClass<T>` and `SubAgentStub<T>` (L421-L445) are the public TypeScript types for referencing and calling a sub-agent. At the tail end (L451-L479), `callable()` (and its deprecated alias `unstable_callable`) is the method decorator that marks agent methods as RPC-invocable; it stores `CallableMetadata` in a `WeakMap` that the Agent base class reads to build its dispatch table.

---

## Queue, Schedule, and Fiber type vocabulary (`src/index.ts` — type section cont.)

[`QueueItem<T>` and `Schedule<T>`](../packages/agents/src/index.ts#L481-L577) — the shapes stored in SQLite for queued callbacks and scheduled tasks respectively. A `Schedule` can be a one-shot future timestamp, a cron expression, or a delay.

[`ScheduleCriteria` and `RootFacetRpcSurface`](../packages/agents/src/index.ts#L578-L660) — `ScheduleCriteria` (L578-L582) is the filter type passed to `getSchedules()`: filter by id, schedule type, or time range. The bulk of this range (L584-L655) is `RootFacetRpcSurface`, an internal RPC interface that facets call on their parent to delegate alarm-owning operations such as scheduling, keep-alive tokens, broadcast, and WebSocket connection management.

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

[JSON serialisability type constraints](../packages/agents/src/serializable.ts#L1-L50) — defines `SerializablePrimitive`, `NonSerializable`, and the recursive compile-time predicate `CanSerialize<T>` that rejects functions, symbols, bigints, Dates, Maps, Sets, and typed arrays. Also exports `SerializableValue` (the legacy recursive union) and `SerializableReturnValue`.

[RPC method type-checking helpers](../packages/agents/src/serializable.ts#L51-L175) — builds on the serialisability predicates to define `RPCMethod<T>`, `ClientParameters<T>`, and `AllSerializableValues<A>`. These constrain which methods can be decorated with `@callable()` and what argument/return types are allowed over RPC. The Agent class imports these to provide compile-time errors when a method's signature is not safely serialisable.

---

## Retry utilities (`src/retries.ts`)

[`RetryOptions` type and `withRetry()` function](../packages/agents/src/retries.ts#L1-L159) — an exponential-backoff retry wrapper with jitter. The `Agent` class exposes this as `this.retry()`, and the MCP client uses it for tool calls. The implementation lives here so it can also be imported independently.

---

## Miscellaneous utilities (`src/utils.ts`, `src/schedule.ts`)

[`INTERNAL_JS_STUB_PROPS`, `isInternalJsStubProp()`, and `camelCaseToKebabCase()` helpers](../packages/agents/src/utils.ts#L1-L35) — `INTERNAL_JS_STUB_PROPS` is a set of property names (e.g. `toJSON`, `then`, `constructor`) that JS runtimes and test frameworks probe on arbitrary objects; `isInternalJsStubProp()` uses it so RPC-stub Proxies return `undefined` for those probes instead of firing a spurious RPC call. `camelCaseToKebabCase()` normalises Durable Object class names into URL path segments used in facet routing.

[Schedule prompt and schema utilities](../packages/agents/src/schedule.ts#L1-L140) — provides `getSchedulePrompt()` (an LLM system-prompt snippet for a schedule-parsing component) and `scheduleSchema` (a Zod discriminated-union schema that an LLM response is validated against). Together they let an agent use `generateObject()` to parse natural-language scheduling requests into a structured `{ description, when }` object. Not used by the internal `schedule()` method; this is the AI-assisted scheduling helper for agent authors.

---

## Sub-agent routing types (`src/sub-routing.ts`)

[`SubAgentClass<T>` and `SubAgentStub<T>`](../packages/agents/src/index.ts#L421-L450) — TypeScript generics that let the type system know which methods are available on a remote sub-agent (facet). `SubAgentStub` automatically removes `async` and wraps return types in `Promise`, reflecting the RPC boundary.

[Sub-routing — path parsing, facet address encoding, and parent validation](../packages/agents/src/sub-routing.ts#L1-L300) and [Sub-routing — remaining helpers and exports](../packages/agents/src/sub-routing.ts#L301-L335) — path parsing and matching for facet addresses. A facet is identified by a path like `myAgent/facet/sessionId`; this module decodes and encodes those paths and verifies they belong to the correct parent agent.

---

## Agent tool types (`src/agent-tool-types.ts`, `src/agent-tools.ts`)

[Agent tool run lifecycle types](../packages/agents/src/agent-tool-types.ts#L1-L158) — defines the TypeScript vocabulary for orchestrating sub-agent tool runs: `AgentToolRunStatus` (starting/running/completed/error/aborted/interrupted), `AgentToolRunInfo`, `RunAgentToolOptions`, `RunAgentToolResult`, `AgentToolEvent` (streaming events emitted during a run), `AgentToolEventMessage`, `AgentToolChildAdapter` (the interface a chat-capable sub-agent must implement), and `AgentToolRunState` (the shape stored and broadcast to connected clients). Used by `Agent.runAgentTool()` and the `agentTool()` factory.

[`agentTool()` factory](../packages/agents/src/agent-tools.ts#L1-L130) — exports `agentTool(cls, options)`, which wraps a chat-capable sub-agent class into an AI SDK `Tool`. When the tool is invoked during a model turn, it dispatches `Agent.runAgentTool()` on the current agent, streams chunks, and returns the run summary or structured output. Also re-exports all types from `agent-tool-types.ts` for convenience.
