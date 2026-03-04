# RFC: Sub-Agents

Status: proposed

## The problem

A single Agent is one Durable Object with one SQLite database. That's fine for simple cases, but many real applications need internal structure:

- **Isolation** — A code sandbox agent needs a database that the LLM cannot access directly. If the agent's own SQLite holds both the approval queue and the customer data, there's no structural enforcement — the LLM can bypass the queue by writing SQL. You need a separate storage boundary.

- **Multiplicity** — A chat application needs many rooms, each with its own message history and LLM context. Stuffing all rooms into one SQLite with a `room_id` column works, but there's no isolation between rooms, no independent lifecycle, and the parent agent becomes a god object that manages every room's state.

- **Parallel work** — An analysis agent wants to fan out a question to three specialist personas, each making independent LLM calls with their own system prompts and history. Running these sequentially is slow. Running them in parallel within a single agent means shared mutable state and no isolation between the personas.

- **Bounded context** — A gatekeeper agent needs to enforce that all database mutations go through an approval queue. If the database lives in the same agent, enforcement is a convention ("don't call `this.sql` directly"). You want it to be structural — the agent literally has no path to the data except through a typed interface.

All of these require the same primitive: child Durable Objects colocated with the parent, each with their own isolated SQLite, callable via typed RPC. The workerd runtime provides the building blocks (`ctx.facets`, `ctx.exports`), but the Agents SDK doesn't expose them. We need a first-class abstraction for this.

## The proposal

Two complementary APIs, both exported from `agents/experimental/subagent`:

### `SubAgent` — base class for child DOs

```typescript
import { SubAgent } from "agents/experimental/subagent";

export class SearchAgent extends SubAgent<Env> {
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
```

`SubAgent` extends partyserver's `Server`, inheriting `this.sql`, `this.ctx`, `this.name`, WebSocket hibernation, and connection management. It adds three methods: `subAgent()`, `abortSubAgent()`, `deleteSubAgent()` — so sub-agents can themselves have children (nested facets).

Sub-agents do **not** need wrangler.jsonc entries. They are instantiated through `ctx.facets` and referenced via `ctx.exports`. The class must be exported from the worker entry point with its original name — `export { Foo as Bar }` breaks the lookup because we use `cls.name` for reflection.

### `withSubAgents()` — mixin for parent Agents

```typescript
import { Agent } from "agents";
import { withSubAgents, SubAgent } from "agents/experimental/subagent";

export class SearchAgent extends SubAgent<Env> {
  /* ... */
}

const SubAgentParent = withSubAgents(Agent);

export class MyAgent extends SubAgentParent<Env> {
  async doStuff() {
    const searcher = await this.subAgent(SearchAgent, "main");
    const results = await searcher.search("hello");
  }
}
```

The mixin adds the same three methods (`subAgent`, `abortSubAgent`, `deleteSubAgent`) to any base class — `Agent`, `AIChatAgent`, `McpAgent`, or any future variant. This avoids shipping sub-agent machinery in the base `Agent` class, which would require all users to enable the `experimental` compat flag.

The mixin works with `withSubAgents(AIChatAgent)` just as well as `withSubAgents(Agent)`, composing cleanly with the existing class hierarchy.

### `SubAgentStub<T>` — typed RPC stubs

When `this.subAgent(SearchAgent, "main")` returns, the result is a `SubAgentStub<SearchAgent>` — a mapped type that exposes all user-defined public methods as async RPC calls, while hiding `Server`/`SubAgent` internals (`fetch`, `onStart`, `sql`, `broadcast`, etc.).

The blocklist (`SubAgentInternals`) is explicit: if `Server` or `SubAgent` gains new methods, they must be added to the list. This is a maintenance burden but keeps the type simple and predictable — an allowlist would be harder to reason about because it would need to track what partyserver adds over time.

### Initialization

`_getSubAgent` does two things:

1. `ctx.facets.get(name, () => ({ class: exports[cls.name] }))` — creates or retrieves the facet
2. A set-name fetch (`/cdn-cgi/partyserver/set-name/`) — triggers `Server` initialization, which calls `onStart()` on first access

The set-name fetch is the same pattern used by `getAgentByName` / `getServerByName`. It's a no-op if the child is already initialized. This means `onStart()` runs lazily on first `subAgent()` call, not eagerly on parent construction.

### Validation

`_validateSubAgentExport` is a synchronous check that the class exists in `ctx.exports`. It runs before the async `_getSubAgent` so that the error is thrown synchronously in the caller's scope. Without this separation, a missing export would surface as an unhandled promise rejection in the workerd runtime, which is noisy and hard to debug.

### Lifecycle

- **`abortSubAgent(name)`** — forcefully stops a running child. Pending RPC calls receive the abort reason as an error. Transitively aborts the child's own children. The child restarts on the next `subAgent()` call.
- **`deleteSubAgent(name)`** — aborts the child, then permanently wipes its storage. Transitively deletes the child's own children. Irreversible.

Both are thin wrappers around `ctx.facets.abort()` and `ctx.facets.delete()`.

## Patterns established

Four `experimental/gadgets-*` examples demonstrate the API in production-like scenarios:

### Fan-out / fan-in (`gadgets-subagents`)

Parent spawns three `PerspectiveAgent` sub-agents in parallel, each making independent LLM calls with different system prompts. Results are gathered and synthesized. Each sub-agent persists its analysis history in its own SQLite.

### Multi-room chat (`gadgets-chat`)

`OverseerAgent` manages a room registry. Each room is a `ChatRoom` sub-agent with its own message history and LLM context. The parent proxies WebSocket messages to the active room and manages stream relay between sub-agent and client.

### Isolated database (`gadgets-sandbox`)

`SandboxAgent` uses a `CustomerDatabase` sub-agent for data isolation. Dynamic Worker isolates (via Worker Loader) can only reach the database through a `DatabaseLoopback` WorkerEntrypoint that proxies back to the parent, which delegates to the sub-agent. Three layers of isolation: no network, single binding, sub-agent boundary.

### Gated access (`gadgets-gatekeeper`)

`GatekeeperAgent` uses a `CustomerDatabase` sub-agent that the LLM cannot access directly. All mutations go through an approval queue. The sub-agent boundary makes this structurally enforceable — the agent has no path to the data except through the sub-agent's RPC methods.

### The Loopback pattern

When dynamic Worker isolates (from `env.LOADER`) need to call back to a sub-agent, they can't hold a sub-agent stub directly — they can only have `ServiceStub` bindings. The pattern is:

1. Create a `WorkerEntrypoint` (e.g. `DatabaseLoopback`) that proxies to the parent Agent
2. The parent delegates to the sub-agent via `this.subAgent()`
3. Pass the WorkerEntrypoint as a binding to the dynamic isolate

Chain: `dynamic isolate -> WorkerEntrypoint -> parent Agent -> sub-agent`

## The alternatives

### A. Bake sub-agent support into the base `Agent` class

The simplest API — every Agent automatically has `this.subAgent()`. But this would require every user to enable the `experimental` compat flag, even if they never use sub-agents. The flag enables several unrelated experimental features in workerd, so requiring it universally is too broad.

### B. Separate entry point (`agents/subagent`) without `experimental/` prefix

This would suggest the API is stable. It isn't — it depends on `ctx.facets` and `ctx.exports`, which are behind the `experimental` compat flag in workerd. The `experimental/` path segment makes the stability guarantee (or lack thereof) visible in the import.

### C. Use `DurableObject` directly instead of extending `Server`

Sub-agents could extend plain `DurableObject` instead of partyserver's `Server`. This would be lighter — no WebSocket machinery, no `sql` helper, no `broadcast()`. But:

- `this.sql` is genuinely useful for sub-agents that store data (which is most of them)
- The set-name initialization pattern already exists in `Server`
- Consistency with the parent `Agent` (which also extends `Server`) reduces cognitive load
- The unused WebSocket methods have zero runtime cost until called

### D. Allowlist instead of blocklist for `SubAgentStub`

Instead of listing internal methods to hide, we could list user methods to expose. But an allowlist would require developers to register their methods somewhere (a decorator, a type parameter, a static property). The blocklist approach means any public method on a `SubAgent` subclass is automatically available via RPC — zero boilerplate.

The tradeoff is maintenance: new internal methods on `Server` or `SubAgent` must be added to `SubAgentInternals`. This is a small cost for a large ergonomic win.

## Open questions

### Graduating from `experimental`

The `agents/experimental/subagent` import path signals instability. Graduation requires:

1. `ctx.facets` and `ctx.exports` leaving the `experimental` compat flag in workerd
2. Sufficient real-world usage to validate the API shape
3. A migration path for the import change (re-export from the old path with a deprecation warning)

### Testing

There are currently no automated tests for sub-agents in `packages/agents/src/tests/`. The `experimental/gadgets-*` examples serve as integration tests but aren't run in CI. Adding vitest tests that exercise `subAgent()`, `abortSubAgent()`, `deleteSubAgent()`, and the typed stub would increase confidence before graduation. This likely requires `@cloudflare/vitest-pool-workers` with the `experimental` compat flag enabled.

### State sync between parent and sub-agent

Sub-agents don't participate in the parent's `setState()` broadcast. If a sub-agent's data changes (e.g. a new message in a chat room), the parent must explicitly re-sync. The gadgets examples handle this by having the parent call `this.setState()` after sub-agent RPCs. A reactive pattern (sub-agent notifies parent of changes) might be worth exploring.

### Cross-machine sub-agents

Facets are colocated — the child runs on the same machine as the parent. This is a feature (low latency, no network hops) but also a limitation. A future extension could support remote sub-agents via standard DO stubs, but the API and failure modes would be very different.

### `SubAgent` inheriting WebSocket machinery

Every `SubAgent` inherits `onConnect`, `onMessage`, `broadcast`, etc. from `Server`. None of the current examples use WebSocket connections on sub-agents — they're pure RPC targets. If this remains the common case, a lighter base class might be appropriate. But premature optimization here risks needing two base classes (`SubAgent` and `SubAgentWithWebSockets`) for minimal benefit.

## Unsolved problems

Sub-agents solve isolation and multiplicity. They don't yet address several harder problems that emerge once you have a tree of cooperating agents:

### Orchestration

There's no framework-level support for coordinating sub-agents. The parent is responsible for deciding which sub-agents to call, in what order, whether to run them in parallel, how to combine results, and what to do when one fails. The gadgets examples hard-code these patterns (fan-out/fan-in in `gadgets-subagents`, sequential proxying in `gadgets-chat`). A general orchestration primitive — workflow graphs, dependency resolution, conditional branching — doesn't exist yet. It's unclear whether this belongs in the SDK or in userland.

### Tracing and observability

When a parent agent calls a sub-agent, which calls the LLM, which triggers a tool, which calls another sub-agent — there's no trace that connects these steps. Each sub-agent is an opaque RPC call from the parent's perspective. The `agents/observability` module emits events for the top-level agent but has no awareness of the sub-agent tree.

What we'd want: a trace ID that propagates from parent to child, spans for each sub-agent RPC, and a way to correlate LLM calls across the hierarchy. This probably needs integration with the observability system and possibly workerd-level trace propagation through facet calls.

### Error propagation and resilience

If a sub-agent's RPC fails, the parent gets a rejected promise. There's no retry logic, no circuit breaker, no structured error type that distinguishes "sub-agent crashed" from "LLM returned an error" from "tool execution failed." The `abortSubAgent` / `deleteSubAgent` lifecycle is all-or-nothing — there's no graceful degradation.

The retries design (`design/retries.md`) covers retry primitives for the SDK, but none of that is wired into sub-agent calls yet.

### Discovery and introspection

A parent has no way to list its active sub-agents, query their health, or inspect their state. You can call `subAgent(Cls, name)` if you know the name, but there's no `listSubAgents()` or `getSubAgentStatus(name)`. The parent must track its own children in its own storage — which every gadgets example does manually.

### Resource limits

There's no cap on how many sub-agents a parent can spawn, how deep the nesting can go, or how much total storage the tree consumes. A runaway agent could create thousands of facets. Workerd may impose its own limits, but the SDK doesn't surface or enforce them.

## The decision

_To be filled in after discussion._
