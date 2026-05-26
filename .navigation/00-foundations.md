# 00 — Foundations

These files define the bedrock abstractions that everything else imports. Read them first so that later sections make sense without constant back-references.

---

## Event emitter (`core/events.ts`)

The codebase uses its own tiny event/disposable system rather than Node's EventEmitter. It underpins how state updates propagate inside an agent instance.

[`Disposable` interface and `DisposableStore`](../packages/agents/src/core/events.ts#L1-L52) — a resource-cleanup pattern: anything that should be torn down implements `Disposable`, and a `DisposableStore` lets you register multiple disposables and `.dispose()` them all at once. Used throughout the MCP client layer to clean up subscriptions.

[`Event<T>` type and `Emitter<T>` class](../packages/agents/src/core/events.ts#L30-L52) — `Event<T>` (L28, just above) is a function type `(listener) => Disposable`; `Emitter<T>` (L30) implements it with a `Set`-backed listener list. You attach listeners and get back a `Disposable` to remove them. Keeps the API surface small and avoids the stringly-typed `on('event', fn)` pattern.

---

## Wire protocol message types (`src/types.ts`)

A tiny 13-line file, but it is the canonical source of truth for message type strings.

[`MessageType` enum](../packages/agents/src/types.ts#L1-L13) — defines the `CF_AGENT_*` constants that flow over WebSocket connections between browser clients and the agent. Every chat and tool message is tagged with one of these. The higher-level chat modules import from here rather than hard-coding strings.

---

## Email and RPC wire types (`src/index.ts` — type section)

Before the `Agent` class itself, `index.ts` opens with the exported types that describe the messages agents exchange with the outside world.

[Email types: `EmailSendBinding`, `SendEmailOptions`](../packages/agents/src/index.ts#L119-L155) — the shape of outgoing email sends via an email service binding.

[RPC wire types: `RPCRequest`, `StateUpdateMessage`, `RPCResponse`](../packages/agents/src/index.ts#L158-L228) — every callable method invocation between a browser client and agent travels as one of these. `StateUpdateMessage` is broadcast to all connected clients whenever state changes.

[`CallableMetadata`, `SqlError`, and internal facet connection bridge types through `callable()` decorator](../packages/agents/src/index.ts#L230-L469) — the range opens with `CallableMetadata` (L230-L235) and its backing `callableMetadata` WeakMap (L237), followed by `SqlError` (L242-L252). The bulk of the range is internal plumbing for the facet (sub-agent) system: `FacetCapableCtx`, `SubAgentPathInvokeEndpoint`, `SubAgentConnectionBridge`, `RootSubAgentConnectionBridge`, and `SubAgentWebSocketEndpoint` implement the per-connection message bridge between parent and child Durable Objects. `SubAgentClass<T>` and `SubAgentStub<T>` (L421-L445) are the public TypeScript types for referencing and calling a sub-agent. At the tail end (L451-L479), `callable()` (and its deprecated alias `unstable_callable`) is the method decorator that marks agent methods as RPC-invocable; it writes into the `callableMetadata` WeakMap that the Agent base class reads to build its dispatch table.

---

## Queue, Schedule, and Fiber type vocabulary (`src/index.ts` — type section cont.)

[`QueueItem<T>`, `Schedule<T>`, and internal storage row types](../packages/agents/src/index.ts#L481-L577) — public shapes for queued callbacks (`QueueItem`) and scheduled tasks (`Schedule`); a `Schedule` can be a one-shot timestamp, a cron expression, a delay, or a repeating interval. The remainder of the range contains internal SQLite row shapes (`ScheduleStorageRow`, `FacetRunStorageRow`, `AgentToolRunStorageRow`) and `DeferredAgentToolFinish` that the Agent class uses internally.

[`ScheduleCriteria` and `RootFacetRpcSurface`](../packages/agents/src/index.ts#L578-L660) — `ScheduleCriteria` (L578-L582) is the filter type passed to `getSchedules()`: filter by id, schedule type, or time range. The bulk of this range (L584-L655) is `RootFacetRpcSurface`, an internal RPC interface that facets call on their parent to delegate alarm-owning operations such as scheduling, keep-alive tokens, broadcast, and WebSocket connection management.

[Fiber types: `FiberContext`, `FiberStatus`, `FiberInspection`, `StartFiberOptions`, and related](../packages/agents/src/index.ts#L661-L755) — fibers are lightweight long-running async tasks that survive Durable Object hibernation. The range covers the full fiber type vocabulary: `FiberContext` (execution context with `stash()`/`signal`), `FiberStatus`, `StartFiberOptions`, `FiberInspection`, `StartFiberResult`, `FiberRecoveryResult`, `ListFibersOptions`, `DeleteFibersOptions`, the internal `FiberLedgerRow` SQLite shape, and `FiberRecoveryContext` (passed to `onFiberRecovered` after a DO restart).

---

## MCP server metadata types (`src/index.ts`)

[`MCPServerMessage`, `MCPServersState`, `MCPServer`, `AddMcpServerOptions`, and identity constants](../packages/agents/src/index.ts#L809-L900) — the range opens with `MCPServerMessage` (the WebSocket broadcast type) then defines `MCPServersState` and `MCPServer` which describe the set of MCP servers an agent is connected to, and `AddMcpServerOptions` / `AddRpcMcpServerOptions` for connecting to new servers. The tail of the range (L874-L900) contains internal implementation constants: `DEFAULT_KEEP_ALIVE_INTERVAL_MS`, sub-agent identity version strings, and SQLite schema constants used by the Agent class.

---

## Static agent configuration (`src/index.ts`)

[`AgentStaticOptions` interface and internal retry helpers](../packages/agents/src/index.ts#L1104-L1145) — `AgentStaticOptions` (L1104-L1116) is the class-level options bag set via `static options = { ... }` on your agent subclass, covering hibernation, identity broadcast, hung-schedule timeout, keep-alive interval, and retry defaults. The rest of the range (L1118-L1145) contains the internal helpers `parseRetryOptions` and `resolveRetryConfig` used by the queue/schedule alarm handlers.

[`DEFAULT_AGENT_STATIC_OPTIONS` constant and `ResolvedAgentOptions` interface](../packages/agents/src/index.ts#L1063-L1103) — the defaults (hibernation on, `sendIdentityOnConnect` on, `hungScheduleTimeoutSeconds` 30, modest retry limits), followed by the `ResolvedAgentOptions` interface (L1087-L1096) which is the fully-resolved version of those options with no optional fields.

---

## Serialization (`src/serializable.ts`)

Agents pass structured data over RPC. The serialization layer handles the translation to/from JSON-safe values.

[JSON serialisability type constraints](../packages/agents/src/serializable.ts#L1-L50) — defines `SerializablePrimitive`, `NonSerializable`, and the recursive compile-time predicate `CanSerialize<T>` that rejects functions, symbols, bigints, Dates, Maps, Sets, and typed arrays. Also exports `SerializableValue` (the legacy recursive union) and `SerializableReturnValue`.

[RPC method type-checking helpers](../packages/agents/src/serializable.ts#L51-L175) — builds on the serialisability predicates to define `RPCMethod<T>`, `ClientParameters<T>`, and `AllSerializableValues<A>`. These constrain which methods can be decorated with `@callable()` and what argument/return types are allowed over RPC. The Agent class imports these to provide compile-time errors when a method's signature is not safely serialisable.

---

## Retry utilities (`src/retries.ts`)

[`RetryOptions`, `validateRetryOptions`, `jitterBackoff`, `tryN`, and `isErrorRetryable`](../packages/agents/src/retries.ts#L1-L159) — the full retry utility module. `RetryOptions` (L1-L11) is the public options type. `validateRetryOptions` (L32-L66) checks option values eagerly at enqueue/schedule time. `jitterBackoff` (L78-L85) computes the "Full Jitter" exponential delay. `tryN` (L96-L140) is the core retry loop: it runs a function up to `n` times with jittered backoff, used internally by the Agent as `this.retry()` and by the MCP client. `isErrorRetryable` (L148-L158) tests Cloudflare DO error flags.

---

## Miscellaneous utilities (`src/utils.ts`, `src/schedule.ts`)

[`INTERNAL_JS_STUB_PROPS`, `isInternalJsStubProp()`, and `camelCaseToKebabCase()` helpers](../packages/agents/src/utils.ts#L1-L35) — `INTERNAL_JS_STUB_PROPS` is a set of property names (e.g. `toJSON`, `then`, `constructor`) that JS runtimes and test frameworks probe on arbitrary objects; `isInternalJsStubProp()` uses it so RPC-stub Proxies return `undefined` for those probes instead of firing a spurious RPC call. `camelCaseToKebabCase()` normalises Durable Object class names into URL path segments used in facet routing.

[Schedule prompt and schema utilities](../packages/agents/src/schedule.ts#L1-L140) — provides `getSchedulePrompt()` (an LLM system-prompt snippet for a schedule-parsing component) and `scheduleSchema` (a Zod discriminated-union schema that an LLM response is validated against). Together they let an agent use `generateObject()` to parse natural-language scheduling requests into a structured `{ description, when }` object. Not used by the internal `schedule()` method; this is the AI-assisted scheduling helper for agent authors.

---

## Sub-agent routing types (`src/sub-routing.ts`)

[`SubAgentClass<T>` and `SubAgentStub<T>`](../packages/agents/src/index.ts#L421-L450) — TypeScript generics that let the type system know which methods are available on a remote sub-agent (facet). `SubAgentStub` automatically removes `async` and wraps return types in `Promise`, reflecting the RPC boundary.

[Sub-routing — `parseSubAgentPath`, `routeSubAgentRequest`](../packages/agents/src/sub-routing.ts#L1-L300) and [Sub-routing — `getSubAgentByName` and exports](../packages/agents/src/sub-routing.ts#L301-L335) — external addressability helpers for sub-agents (facets). The first range defines `SUB_PREFIX`, `SubAgentPathMatch`, `parseSubAgentPath` (URL → `{ childClass, childName, remainingPath }`), and `routeSubAgentRequest` (the sub-agent analog of `routeAgentRequest` for custom fetch handlers). The second range contains `getSubAgentByName` (returns a typed RPC stub that proxies method calls through the parent via a stateless per-call bridge, the sub-agent analog of `getAgentByName`).

---

## Agent tool types (`src/agent-tool-types.ts`, `src/agent-tools.ts`)

[Agent tool run lifecycle types](../packages/agents/src/agent-tool-types.ts#L1-L158) — defines the TypeScript vocabulary for orchestrating sub-agent tool runs: `AgentToolRunStatus` (starting/running/completed/error/aborted/interrupted), `AgentToolRunInfo`, `RunAgentToolOptions`, `RunAgentToolResult`, `AgentToolEvent` (streaming events emitted during a run), `AgentToolEventMessage`, `AgentToolChildAdapter` (the interface a chat-capable sub-agent must implement), and `AgentToolRunState` (the shape stored and broadcast to connected clients). Used by `Agent.runAgentTool()` and the `agentTool()` factory.

[`agentTool()` factory](../packages/agents/src/agent-tools.ts#L1-L130) — exports `agentTool(cls, options)`, which wraps a chat-capable sub-agent class into an AI SDK `Tool`. When the tool is invoked during a model turn, it dispatches `Agent.runAgentTool()` on the current agent, streams chunks, and returns the run summary or structured output. Also re-exports all types from `agent-tool-types.ts` for convenience.
