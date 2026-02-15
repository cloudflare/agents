# Gadgets — Facets, Isolation, and Structural Safety for Agents

Exploration of patterns for building sandboxed, structurally safe AI agents using experimental Cloudflare primitives: Durable Object Facets, Worker Loaders, and capability-based isolation.

## The Core Idea

Most agent frameworks treat security as a behavioral problem — "prompt the model to follow instructions and hope for the best." The Gadgets pattern treats it as a structural problem: **make it impossible for the agent to do harmful things, regardless of what the LLM decides.**

The key properties:

- Each agent workload runs in a **sandboxed context** that cannot talk to the internet — no `fetch()`, no `connect()`.
- External access is only possible through **Gatekeepers** — adapter objects that enforce security policies, require approval for side-effecting actions, and log everything.
- For bulk tasks (like processing emails), you create **isolated copies** per resource, so one instance literally cannot see another's data.

The fundamental invariant: _An agent never enables a human to do something the human couldn't do directly._

## Experimental Primitives

These patterns depend on three experimental Cloudflare APIs (enabled via `"experimental"` compatibility flag):

### `ctx.facets` — Child Durable Objects

Create isolated child DOs within a parent. Each facet has its own SQLite, its own execution context, and can only be reached through RPC. The parent controls the lifecycle.

```typescript
// Get or create a facet
const db = this.ctx.facets.get("database", () => ({
  class: this.ctx.exports.CustomerDatabase
}));

// Call methods on it (RPC — isolated storage)
const rows = await db.query("SELECT * FROM customers");

// Restart it
this.ctx.facets.abort("database", new Error("code changed"));

// Delete it (and its storage)
this.ctx.facets.delete("database");
```

### `ctx.exports` — Reference Exported Classes

Access other classes exported from the same Worker module. Used to get the class reference for facet creation without needing a separate service binding.

### `env.LOADER` — Dynamic Worker Loader

Load and execute code at runtime in a fresh V8 isolate with restricted bindings and no network access.

```typescript
const worker = env.LOADER.get(executionId, () => ({
  mainModule: "harness.js",
  modules: { "harness.js": harness, "user-code.js": agentCode },
  env: { db: loopbackBinding }, // only binding
  globalOutbound: null // no fetch()
}));
```

## What Facets Give You (vs. Separate DOs)

The agents SDK uses `getAgentByName()` to create separate Durable Objects. Facets are different in five important ways:

1. **Same-machine locality** — facet storage lives alongside the parent. No network hop for coordination.
2. **Lifecycle control** — the parent can `abort()` and `delete()` facets at will.
3. **Capability restriction** — the parent decides what `env` bindings a facet receives.
4. **Dynamic code** — via the Worker Loader, a facet can run completely different code from the parent.
5. **Isolated storage** — each facet gets its own SQLite database, separate from the parent's.

## Use Cases for the Agents SDK

### 1. Sub-Agents / Task Delegation

Facets enable a proper parent-child model. A coordinator spawns specialist facets (researcher, coder, reviewer). Parent controls their lifecycle — can cancel a runaway sub-agent. Each sub-agent has its own storage. No network hop for orchestration.

This maps to the "swarm" pattern (OpenAI Agents SDK, CrewAI), but with real isolation — not just prompt boundaries.

### 2. Multiple Chat Threads in One Agent

Currently `AIChatAgent` = one conversation per DO. Facets let a parent agent manage multiple chat rooms, each with its own isolated message history. Switch rooms, clear rooms, delete rooms — all under one DO.

### 3. Sandboxed Code / Tool Execution

Agent generates code → runs in a Worker Loader isolate with `globalOutbound: null` → only binding is a loopback to a gatekept resource. Cloudflare is uniquely positioned to offer this.

### 4. Approval Queues / Human-in-the-Loop

Every side-effecting action goes through a persistent approval queue. Actions are proposed (pending), reviewed by a human, then approved/rejected/reverted. The queue survives across sessions. The facet boundary ensures the agent cannot bypass the queue.

### 5. Speculative / Branching State

Main agent state in the parent. A facet represents a "branch" — speculative work. Multiple branches simultaneously. User previews, merges, or reverts.

### 6. Plugin / Extension System

Third-party code in facets. Each plugin isolated. Parent mediates. Hot-swap via `abort()` + recreate.

### 7. Per-Connection / Per-User Isolation

Each user gets a facet (their session). Session state isolated. Parent manages shared state.

## Prototype Examples

Four examples validate these patterns against the real Cloudflare runtime. All use `"experimental"` compat flag and work with the Vite plugin.

### [`gadgets-gatekeeper`](./gadgets-gatekeeper/) — Approval Queue + Facet Isolation

An AI agent manages a customer database where reads are free but writes require human approval. The database is a facet with isolated SQLite. The parent owns the approval queue and can only reach customer data through the facet's RPC methods.

**Findings:**

- `ctx.facets.get()` works with the Vite plugin — no issues with creation, RPC, or isolated storage.
- Facets don't need `wrangler.jsonc` bindings or migrations — they're children of the parent DO.
- Workers RPC exposes all public methods on DurableObject subclasses, but TypeScript types for stubs don't reflect custom methods — need a typed interface + cast.

### [`gadgets-sandbox`](./gadgets-sandbox/) — Dynamic Code Execution via Worker Loader

The AI agent writes JavaScript code that runs in a dynamic Worker isolate. The isolate has no internet (`globalOutbound: null`) — its only binding is a `DatabaseLoopback` WorkerEntrypoint that proxies back to a database facet. Console output captured via Tail API.

**Findings:**

- `worker_loaders` works with the Vite plugin. `LOADER: WorkerLoader` is correctly typed in generated `env.d.ts`.
- The loopback pattern (WorkerEntrypoint with `ctx.props` proxying to the parent's facet) is necessary because dynamic isolates can hold ServiceStubs but not facet stubs directly.
- `ctx.exports` is available on WorkerEntrypoints in the experimental runtime but not in stable typings — needs `@ts-expect-error`.

### [`gadgets-subagents`](./gadgets-subagents/) — Parallel Sub-Agent Facets

A coordinator spawns three perspective facets (Technical Expert, Business Analyst, Devil's Advocate). Each independently calls the LLM and stores analysis in its own SQLite. Coordinator synthesizes with `Promise.all()`.

**Findings:**

- Multiple named facets work correctly with independent storage.
- Facets can call Workers AI — the AI binding is available inside facets.
- `Promise.all()` on facet RPC gives real parallel execution.

### [`gadgets-chat`](./gadgets-chat/) — Multiple Chat Rooms via Facets

A chat app with rooms — each room is a facet. Create, switch, clear, delete rooms. Each room stores messages in its own isolated SQLite. The parent uses `streamText()` with incremental `setState()` for token-by-token streaming to the UI.

**Findings:**

- Dynamic facet creation/deletion works. `ctx.facets.delete()` removes the facet and its storage.
- Facet stubs are `Fetcher`s — `facet.fetch(request)` returns streaming Responses. But for chat streaming, doing the LLM call in the parent (which owns the WebSocket) and using the facet as a message store was the simplest reliable approach.
- `AIChatAgent` as a facet doesn't work well yet — its WebSocket/streaming machinery assumes it owns the connection. A headless mode or streaming-over-RPC would fix this.

## Proposed SDK Integration — Three Layers

### Layer 1: Raw Facet Primitives (on Agent base class)

```typescript
this.facet<T>("name", factory); // get or create
this.abortFacet("name", reason); // restart
this.deleteFacet("name"); // destroy
```

Thin wrappers on `ctx.facets`. Useful for all use cases. Doesn't impose any pattern.

### Layer 2: Gatekeeper + ApprovalQueue Interfaces

```typescript
interface Gatekeeper<Session, Action> extends DurableObject {
  describe(): Promise<ResourceDescription>;
  startSession(queue: ApprovalQueue<Action>): Promise<Session>;
  applyAction(action: Action): Promise<void>;
  rejectAction(action: Action): Promise<void>;
  revertAction(action: Action): Promise<void>;
}
```

Shipped as interfaces. Anyone implements `Gatekeeper` for their service. The SDK provides `ApprovalQueue` (persistent SQLite, state machine, UI hooks). Works independently of facets.

### Layer 3: Tool-Level Approval Integration

Generalize `AIChatAgent`'s `needsApproval` into a persistent approval queue that survives across conversations, supports revert, and works with facet-isolated resources. Bridge per-tool-call approval (message-level) with the Gatekeeper pattern (system-level).

## Priority Assessment

1. **Sub-agent facets** — Real isolation + lifecycle control + no network hop. No other agent framework offers this.
2. **Gatekeeper / permissions model** — Security is Cloudflare's brand. Agents that are _structurally safe_ rather than _behaviorally safe_. The approval queue is the entry point; the full Gatekeeper protocol is the end state.
3. **Multi-thread chat** — One conversation per DO is limiting today.
4. **Sandboxed execution** — Unique Cloudflare capability via Worker Loader.

Items 1 and 4 depend on `ctx.facets` and Worker Loader stabilizing. Item 2 can be built incrementally — the approval queue works today, the Gatekeeper adapter protocol layers on top as facets mature.

## Other Patterns Worth Exploring

Beyond facets and isolation, the Gadgets architecture surfaced several patterns that could be valuable in the Agents SDK independently:

### Typed Storage (ORM over Durable Object KV)

A type-safe abstraction over Durable Object sync KV storage that provides:

- **Collections** with typed primary keys (string or number, with hex-encoded integer sorting for correct ordering)
- **Unique and non-unique secondary indexes** — declare an index function, the library maintains it automatically on put/delete
- **Singletons** — typed key-value pairs with defaults (e.g. `storage.codeVersion.get()` returns a number, not `unknown`)
- **Reactive subscribers** — `collection.subscribe(observer)` fires on add/update/remove, enabling real-time push to connected clients
- **Transactions** via `transactionSync()`

This sits between the raw `this.ctx.storage.sql` API and a full ORM. The agents SDK currently offers `this.sql` (template tag over SQLite) and `this.state` (single JSON blob). A typed collection layer would fill the gap for agents that need structured data with indexes and reactive updates — without the weight of a SQL schema.

### Reactive Subscriptions on Storage

The Gadgets Overseer pushes real-time updates to clients by subscribing to storage changes at the collection level. When a record is added, updated, or removed, subscribers are notified synchronously within the same transaction.

The agents SDK broadcasts `this.state` changes to all WebSocket connections. The subscription-on-storage pattern is more granular — you can subscribe to specific collections (e.g. "notify me when a new chat message is added" without re-sending the entire state). This would reduce WebSocket bandwidth for agents with large or frequently-changing state.

### Code Versioning with CRDTs

The Gadgets architecture uses Yjs CRDTs for code versioning — a log of incremental updates with periodic snapshots, plus merge/revert semantics. Changes are "proposed" per chat thread and only committed when the user explicitly merges.

This could generalize to any agent that produces artifacts (documents, configs, plans, database migrations) that users want to review before committing. The pattern: agent proposes changes → changes stored as a diff → user previews → user merges or reverts → committed state updates. Each step is auditable.

### Bidirectional Object-Capability RPC

The Gadgets system uses Cap'n Web — a bidirectional RPC protocol with promise pipelining, pass-by-reference functions, and explicit stub disposal. Key capabilities:

- **Promise pipelining** — call methods on a not-yet-resolved stub without awaiting. Reduces round trips.
- **Pass functions by reference** — pass a callback over RPC. The receiver gets a stub that calls back to the original. Enables subscription patterns where the server calls the client.
- **Stub disposal** — explicit `Symbol.dispose()` to prevent server-side resource leaks.

The agents SDK uses JSON-over-WebSocket for client-server communication and Workers RPC for inter-DO calls. Cap'n Web's capabilities (especially pass-by-reference and pipelining) would enable richer interaction patterns — like a facet returning a stub that the client can call directly, or subscription callbacks that don't require polling.

### Gatekeeper Adapter Protocol

Beyond the ApprovalQueue (covered above), the full Gatekeeper protocol defines a hierarchy for wrapping external services:

- **Vendor** (service-level) — "Google", "GitHub". Handles OAuth flow, URL pattern matching, TypeScript type definitions for the API.
- **User** (account-level) — a specific user's credentials for a vendor. Returns DO classes for specific resources.
- **Gatekeeper** (resource-level) — wraps a single resource (a Google Doc, a GitHub repo). Manages sessions, actions, observations.

Each level is a separate interface. A complete Gatekeeper implementation for a service (e.g. Google Workspace) would provide: OAuth connection flow, URL-to-resource resolution, typed RPC bindings for the resource, action submission with human approval, and revert support. This is the most ambitious pattern — it's a full "adapter framework" for external services — but it's also the one that would make Cloudflare agents genuinely safe to connect to sensitive APIs.

### Dynamic Worker Loading for Plugins

The Worker Loader enables a plugin model where third-party code runs in fresh V8 isolates with:

- **No network access** (`globalOutbound: null`)
- **Explicit bindings only** — the host decides what the plugin can reach
- **Capability-based credentials** — plugins get `AuthorizedHttpClient` bindings that inject OAuth tokens transparently, never exposing raw credentials
- **Fresh isolate per execution** — no state leakage between runs

This could power a tool/skill marketplace where users install community-contributed agent tools without trusting the code. Each tool runs sandboxed with only the bindings it declared. The host (Agent SDK) provides credential injection via WorkerEntrypoint loopbacks.
