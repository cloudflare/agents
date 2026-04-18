# RFC: Sub-Agents

Status: accepted

## The problem

A single Agent is one Durable Object with one SQLite database. That's fine for simple cases, but many real applications need internal structure:

- **Isolation** — A code sandbox agent needs a database that the LLM cannot access directly. If the agent's own SQLite holds both the approval queue and the customer data, there's no structural enforcement — the LLM can bypass the queue by writing SQL. You need a separate storage boundary.

- **Multiplicity** — A chat application needs many rooms, each with its own message history and LLM context. Stuffing all rooms into one SQLite with a `room_id` column works, but there's no isolation between rooms, no independent lifecycle, and the parent agent becomes a god object that manages every room's state.

- **Parallel work** — An analysis agent wants to fan out a question to three specialist personas, each making independent LLM calls with their own system prompts and history. Running these sequentially is slow. Running them in parallel within a single agent means shared mutable state and no isolation between the personas.

- **Bounded context** — A gatekeeper agent needs to enforce that all database mutations go through an approval queue. If the database lives in the same agent, enforcement is a convention ("don't call `this.sql` directly"). You want it to be structural — the agent literally has no path to the data except through a typed interface.

All of these require the same primitive: child Durable Objects colocated with the parent, each with their own isolated SQLite, callable via typed RPC. The workerd runtime provides the building blocks (`ctx.facets`, `ctx.exports`), but the Agents SDK needs a first-class abstraction for this.

## The design

Sub-agent management is built directly into the `Agent` base class. There is no separate `SubAgent` class — any `Agent` can be mounted as either a top-level Durable Object (via wrangler bindings) or as a child facet (via `this.subAgent()`). The behavior adapts based on how the agent is instantiated.

### API

Three methods on `Agent`:

```typescript
import { Agent } from "agents";

export class SearchAgent extends Agent<Env> {
  onStart() {
    this
      .sql`CREATE TABLE IF NOT EXISTS cache (q TEXT PRIMARY KEY, result TEXT)`;
  }

  async search(query: string): Promise<Result[]> {
    const cached = this.sql`SELECT * FROM cache WHERE q = ${query}`;
    if (cached.length) return cached;
    // ... fetch, cache, return
  }
}

export class MyAgent extends Agent<Env> {
  async doStuff() {
    const searcher = await this.subAgent(SearchAgent, "main");
    const results = await searcher.search("hello");
  }
}
```

- **`subAgent(cls, name)`** — get or create a named child facet. Returns a typed RPC stub. The child class must extend `Agent` and be exported from the worker entry point.
- **`abortSubAgent(name, reason?)`** — forcefully stop a running child. Pending RPC calls receive the reason as an error. Transitively aborts the child's own children. The child restarts on the next `subAgent()` call.
- **`deleteSubAgent(name)`** — abort the child, then permanently wipe its storage. Transitively deletes the child's own children. Irreversible.

Both parents and children use `Agent`. A child agent can itself call `this.subAgent()` to create nested facets.

### `SubAgentStub<T>` — typed RPC stubs

When `this.subAgent(SearchAgent, "main")` returns, the result is a `SubAgentStub<SearchAgent>` — a mapped type that exposes all user-defined public methods as async RPC calls, while hiding `Agent` / `Server` / `DurableObject` internals.

The exclusion uses `keyof Agent` — any method defined on `Agent` itself is hidden from the stub. This means new methods added to `Agent` are automatically excluded without maintaining a manual blocklist. Only user-defined methods on the subclass are exposed.

### `SubAgentClass<T>` — constructor type

The `SubAgentClass<T>` type uses `env: never` as a variance trick. Since `never` is assignable to every type, any `Agent<SomeEnv>` subclass satisfies the constraint regardless of its `Env` type parameter. The actual `env` is provided by the runtime when instantiating the facet, not by the caller.

### Initialization

`subAgent()` does two things:

1. `ctx.facets.get(name, () => ({ class: exports[cls.name] }))` — creates or retrieves the facet
2. A set-name fetch (`/cdn-cgi/partyserver/set-name/`) — triggers `Server` initialization, which calls `onStart()` on first access

The set-name fetch is the same pattern used by `getAgentByName` / `getServerByName`. It's a no-op if the child is already initialized. `onStart()` runs lazily on first `subAgent()` call, not eagerly on parent construction.

### Validation

The class name is checked against `ctx.exports` before attempting facet creation. If the class isn't exported from the worker entry point, a clear error is thrown:

```
Sub-agent class "Foo" not found in worker exports.
Make sure the class is exported from your worker entry point
and the export name matches the class name.
```

This catches the common mistake of forgetting to export the class, or using `export { Foo as Bar }` (which breaks the `cls.name` lookup).

### Wiring

Sub-agents do **not** need wrangler.jsonc entries — no bindings, no migrations. They are instantiated through `ctx.facets` and referenced via `ctx.exports`. The only requirement is that the class is exported from the worker entry point with its original name.

## Patterns established

Four `experimental/gadgets-*` examples demonstrate the API:

### Fan-out / fan-in (`gadgets-subagents`)

`CoordinatorAgent` (extends `AIChatAgent`) spawns three `PerspectiveAgent` sub-agents in parallel, each making independent LLM calls with different system prompts. Results are gathered via `Promise.all()` and synthesized. Each sub-agent persists its analysis history in its own SQLite.

### Multi-room chat (`gadgets-chat`)

`OverseerAgent` (extends `Agent`) manages a room registry. Each room is a `ChatRoom` sub-agent with its own message history and LLM context. The parent proxies WebSocket messages to the active room and manages stream relay between sub-agent and client. Deleting a room calls `this.deleteSubAgent()` — the sub-agent and its storage are permanently removed.

### Isolated database (`gadgets-sandbox`)

`SandboxAgent` (extends `AIChatAgent`) uses a `CustomerDatabase` sub-agent for data isolation. Dynamic Worker isolates (via Worker Loader) can only reach the database through a `DatabaseLoopback` WorkerEntrypoint that proxies back to the parent, which delegates to the sub-agent. Three layers of isolation: no network, single binding, sub-agent boundary.

### Gated access (`gadgets-gatekeeper`)

`GatekeeperAgent` (extends `AIChatAgent`) uses a `CustomerDatabase` sub-agent that the LLM cannot access directly. All mutations go through an approval queue. The sub-agent boundary makes this structurally enforceable — the agent has no path to the data except through the sub-agent's RPC methods.

### The Loopback pattern

When dynamic Worker isolates (from `env.LOADER`) need to call back to a sub-agent, they can't hold a sub-agent stub directly — they can only have `ServiceStub` bindings. The pattern is:

1. Create a `WorkerEntrypoint` (e.g. `DatabaseLoopback`) that proxies to the parent Agent
2. The parent delegates to the sub-agent via `this.subAgent()`
3. Pass the WorkerEntrypoint as a binding to the dynamic isolate

Chain: `dynamic isolate -> WorkerEntrypoint -> parent Agent -> sub-agent`

## The alternatives considered

### A. Separate `SubAgent` class + `withSubAgents` mixin (original proposal)

The original design had a separate `SubAgent` base class for children and a `withSubAgents()` mixin to add management methods to parents. The rationale was to avoid requiring the `experimental` compat flag for users who don't use sub-agents.

Rejected because:

- **Two classes for the same thing** — `SubAgent` and `Agent` had nearly identical capabilities (both extended `Server`, both had `this.sql`, etc.). The distinction was confusing.
- **Mixin ergonomics were poor** — `const Parent = withSubAgents(AIChatAgent); export class MyAgent extends Parent<Env, State>` is awkward compared to just `extends AIChatAgent<Env, State>`.
- **The compat flag concern was overstated** — users who don't call `subAgent()` are unaffected by the methods existing on `Agent`. (At the time of this RFC, the `experimental` flag was needed at runtime when `ctx.facets` was accessed; `ctx.facets` / `ctx.exports` have since graduated out of the `experimental` flag.)

### B. Separate entry point without `experimental/` prefix

Would suggest the API is stable. At the time of this RFC, the Agents SDK API was still stabilizing around `ctx.facets` and `ctx.exports` (which were behind the `experimental` compat flag in workerd at the time). Keeping the methods on `Agent` directly lets the stability signal come from the `@experimental` JSDoc tag on the methods rather than an import path.

### C. Use `DurableObject` directly instead of extending `Server`

Sub-agents could extend plain `DurableObject` instead of `Agent` (which extends `Server`). Lighter — no WebSocket machinery, no state sync, no MCP client. But:

- `this.sql` is genuinely useful for sub-agents that store data (which is most of them)
- The set-name initialization pattern already exists in `Server`
- Since sub-agents are now just `Agent`, they get the full Agent feature set for free — scheduling, state sync, callable methods, etc.
- Consistency between parent and child reduces cognitive load
- The unused features have zero runtime cost until called

### D. Allowlist instead of `keyof Agent` exclusion for `SubAgentStub`

Instead of excluding `Agent` methods, we could require developers to register exposed methods. Rejected — the current approach (exclude everything on `Agent`, expose everything else) is zero-boilerplate and automatically adapts as `Agent` gains new methods.

## Testing

The sub-agent API has a full test suite in `packages/agents/src/tests/sub-agent.test.ts` covering:

- Creation and RPC
- Persistence and isolation (parent and child have separate SQLite)
- Multiple sub-agents with independent state
- Abort and delete lifecycle
- Nested sub-agents (child spawning grandchild)
- Streaming callbacks via `RpcTarget`
- Missing export error guard
- Sub-agent name propagation

Type-level tests in `packages/agents/src/tests-d/sub-agent-stub.test-d.ts` verify that `SubAgentStub` correctly exposes user methods and hides `Agent` internals.

## Open questions

### Graduating from `experimental`

The methods are on `Agent` but marked `@experimental` in JSDoc. The underlying workerd primitives (`ctx.facets`, `ctx.exports`) have graduated out of the `experimental` compat flag. Graduation of the Agents SDK API itself is now gated only on sufficient real-world usage.

### State sync between parent and sub-agent

Sub-agents don't participate in the parent's `setState()` broadcast. If a sub-agent's data changes, the parent must explicitly re-sync. The gadgets examples handle this by calling `this.setState()` after sub-agent RPCs. A reactive pattern (sub-agent notifies parent of changes) might be worth exploring.

### Cross-machine sub-agents

Facets are colocated — the child runs on the same machine as the parent. A future extension could support remote sub-agents via standard DO stubs, but the API and failure modes would be very different.

### Discovery and introspection

A parent has no way to list its active sub-agents or query their health. There's no `listSubAgents()` or `getSubAgentStatus(name)`. The parent must track its own children in its own storage.

### Resource limits

There's no cap on how many sub-agents a parent can spawn, how deep the nesting can go, or how much total storage the tree consumes. Workerd may impose its own limits, but the SDK doesn't surface or enforce them.

## Unsolved problems

### Orchestration

No framework-level support for coordinating sub-agents. The parent is responsible for fan-out/fan-in, error handling, and result synthesis. The gadgets examples hard-code these patterns. A general orchestration primitive doesn't exist yet.

### Tracing and observability

When a parent calls a sub-agent, which calls the LLM, which triggers a tool, which calls another sub-agent — there's no connected trace. Each sub-agent is an opaque RPC call. The `agents/observability` module has no awareness of the sub-agent tree. Needs trace ID propagation through facet calls.

### Error propagation and resilience

No retry logic, no circuit breaker, no structured error types for sub-agent failures. The retries design (`design/retries.md`) covers retry primitives but none are wired into sub-agent calls.

## The decision

Accepted. Sub-agent management methods (`subAgent`, `abortSubAgent`, `deleteSubAgent`) are built into the `Agent` base class. The separate `SubAgent` class and `withSubAgents` mixin have been removed. `SubAgentClass` and `SubAgentStub` types are exported from the main `agents` entry point.
