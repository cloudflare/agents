# Dynamic agents (facets)

Dynamic agents are child Durable Objects **colocated under and supervised by** a parent agent, built on the runtime's facet primitive. Each child runs in its **own isolate** with its **own SQLite database**, but lives inside the parent's Durable Object: the parent spawns it, can abort or delete it, and is the only way to reach it. Inside an agent they are typed RPC stubs reached via `this.dynamicAgents`; clients reach one directly via a nested URL.

Use dynamic agents for code whose **class or lifecycle the parent owns**: dynamically-loaded or AI-generated code that has no wrangler binding, per-run tool agents, sandboxed components that need isolated storage plus supervised abort/restart. That is what the runtime built facets for.

Do **not** use dynamic agents to model an open-ended set of independent peers — many chats, documents, or sessions per user. Those want one top-level Durable Object each plus a per-user index; see [When to use dynamic agents](#when-to-use-dynamic-agents) and [`examples/next/chats`](https://github.com/cloudflare/agents/tree/main/examples/next/chats).

If you want a parent chat agent to dispatch another chat-capable agent during a
single turn and render that child's progress inline, use [Agent Tools](./agent-tools.md).
Agent tools are built on dynamic agents, but add a parent-side run registry,
streaming `agent-tool-event` frames, replay, cancellation, and cleanup.

> **Naming**: dynamic agents were previously called **sub-agents**. The
> `subAgent()` / `hasSubAgent()` / `listSubAgents()` / `abortSubAgent()` /
> `deleteSubAgent()` methods still work and now delegate to the same
> `this.dynamicAgents` capability; they are deprecated in place. The `/sub/`
> URL segment, `useAgent({ sub })`, and the `onBeforeSubAgent` hook are
> unchanged.

## Overview

```typescript
import { Agent, callable } from "agents";

export class Supervisor extends Agent {
  @callable()
  async runJob(runId: string, input: string) {
    // Spawn (or reattach to) an isolated child for this run. The child
    // gets its own isolate and its own SQLite database, colocated with
    // and supervised by this agent.
    const worker = await this.dynamicAgents.get(JobRunner, runId);
    return worker.execute(input);
  }

  @callable()
  cancelJob(runId: string) {
    // Stops the child immediately; its storage survives for inspection.
    this.dynamicAgents.abort(JobRunner, runId, new Error("cancelled"));
  }

  @callable()
  async cleanupJob(runId: string) {
    // Wipes the child's storage and registry entry.
    await this.dynamicAgents.delete(JobRunner, runId);
  }
}

export class JobRunner extends Agent {
  async execute(input: string) {
    // Runs in the child's own isolate; this.sql is the child's own DB.
    // Reach back up by class when needed:
    const supervisor = await this.parentAgent(Supervisor);
    // ...
  }
}
```

```tsx
// Client
import { useAgent } from "agents/react";

// Connect to the supervisor:
const supervisor = useAgent({ agent: "Supervisor", name: userId });

// Connect to a specific child:
const runner = useAgent({
  agent: "Supervisor",
  name: userId,
  sub: [{ agent: "JobRunner", name: runId }]
});
```

The resulting URL for the child connection is `/agents/supervisor/{userId}/sub/job-runner/{runId}`.

## Concepts

```
┌──────────────────────────────────────────────────────────┐
│  Supervisor (Durable Object, "user-123")                 │
│  - owns the registry and lifecycle of its children       │
│  - runs `onBeforeSubAgent` on every incoming /sub/ hop   │
│  - owns the one physical alarm and the WebSockets        │
└────┬─────────────────────┬───────────────────┬───────────┘
     │                     │                   │
     ▼                     ▼                   ▼
  JobRunner ("run-a")  JobRunner ("run-b")  CodemodeRuntime
  - own isolate        - own isolate        - own isolate
  - own SQLite         - own SQLite         - own SQLite
  - runs in parallel with siblings, on the same machine
```

### Facet semantics

Dynamic agents are backed by workerd **facets**. The properties below are what the runtime actually provides — several of them are the reason this is an isolation primitive rather than a scale-out primitive:

- **Separate isolate, same machine.** Each facet runs in its own isolate (its own JS heap), colocated with the parent for cheap RPC. The whole tree shares the parent's physical placement and moves or dies with it — facets never scatter across the edge.
- **Own SQLite database.** Each facet's storage is invisible to its siblings and to the parent's SQL. The facet databases are part of the parent Durable Object's overall storage, so the per-DO storage limit covers the whole tree.
- **No independent alarms.** Facets cannot set a physical alarm; the top-level parent owns the one alarm slot and the SDK routes scheduled callbacks back into children (see [Scheduling](#scheduling)).
- **Supervised lifecycle.** The parent can abort a child transitively (storage survives), delete it (storage wiped), and restart the same storage under a *different class* — a code upgrade on stable state. A broken facet breaks the whole actor, except when the parent itself aborted it.
- **Independent hibernation.** A facet hibernates and restarts independently of its parent, but cannot outlive the root Durable Object's placement.
- **Private addressability.** A facet is reachable only through its parent; siblings cannot see each other unless the parent passes references.
- **Bounded nesting.** Facet trees are limited in depth (currently four levels including the root).

### Independent state

Each dynamic agent has its own SQLite database and its own in-memory state. Writes from one sibling never leak into another. When a child is deleted with `this.dynamicAgents.delete()`, its storage is wiped.

### Scheduling

Dynamic agents can schedule their own callbacks with `this.schedule()` and `this.scheduleEvery()`:

```typescript
export class JobRunner extends Agent {
  async onStart() {
    await this.scheduleEvery(60, "checkpoint");
  }

  async checkpoint() {
    // Runs inside the child; this.sql points at the child's database.
  }
}
```

The top-level parent still owns the underlying Durable Object alarm because facets do not have independent alarm slots. The Agents SDK stores a logical owner path for the child's schedule, wakes the parent when the alarm fires, then dispatches the callback back into the child. The callback runs with the child as `this`, so it uses the child's SQLite storage, state, `parentPath`, and `getCurrentAgent()` context.

`cancelSchedule()`, `getScheduleById()`, and `listSchedules()` also work inside dynamic agents. They are scoped to the calling child — a child cannot cancel or list a sibling's schedules by id. To clear every schedule under a child (and any of its descendants), call `this.dynamicAgents.delete(Cls, name)` from the parent. The older synchronous `getSchedule()` and `getSchedules()` APIs throw inside dynamic agents because scheduled rows are stored on the top-level parent.

Calling `this.destroy()` inside a dynamic agent delegates the same teardown back to the parent: it cancels the child's parent-owned schedules (and descendants), removes the child from the parent's registry, and asks the runtime to wipe the child's storage. Because the underlying `ctx.facets.delete` call aborts the child's isolate, treat `this.destroy()` as fire-and-forget — it may not return cleanly to the caller.

### Durable execution and chat recovery

Dynamic agents can use `runFiber()` and Think's `chatRecovery` just like top-level agents. Fiber rows live in the child's own SQLite database, so recovery hooks run with the child as `this` and see the child's state, storage, `parentPath`, and `getCurrentAgent()` context.

Because facets do not have independent alarm slots, the top-level parent owns the physical alarm heartbeat for child fibers. The child still stores fiber rows and snapshots in its own SQLite database, while the parent stores a small root-side index of active facet fibers. When the parent alarm fires, it checks that index and routes recovery checks back into the owning child. Think's chat recovery can schedule its recovered continuation from inside the child; the parent owns the physical alarm and routes the continuation back to the child.

Dynamic agents can also start [Workflows](./workflows.md) with `this.runWorkflow()`. Workflow tracking is local to the child's SQLite database, and `AgentWorkflow.agent` routes RPC, callbacks, state updates, and broadcasts back to the originating child. Parent agents do not automatically list or control child-started workflows. Because the child stub only exposes user-defined child methods, add child wrapper methods for controls such as `getWorkflow()`, `approveWorkflow()`, or `terminateWorkflow()`, then call those wrappers through `await this.dynamicAgents.get(Child, name)`. If you pass `runWorkflow(..., { agentBinding })` from a child, use the root Agent binding name, not a child binding name.

For child workflow origins, `AgentWorkflow.agent` is RPC-only. Use it to call Agent methods, but use `routeSubAgentRequest()` or the nested `/agents/{parent}/{name}/sub/{child}/{name}` URL shape for external HTTP or WebSocket routing instead of `this.agent.fetch()`.

### Shared identity

Dynamic agents know who their parent is via `this.parentPath` (root-first ancestor chain) and `this.parentAgent(ParentClass)` (typed stub). A child with no parent (top-level agent) has `parentPath === []`.

## Server API

The capability lives at `this.dynamicAgents`. The legacy method names delegate to it and remain supported:

| Legacy (deprecated)             | Capability                            |
| ------------------------------- | ------------------------------------- |
| `this.subAgent(Cls, name)`      | `this.dynamicAgents.get(Cls, name)`   |
| `this.abortSubAgent(Cls, name)` | `this.dynamicAgents.abort(Cls, name)` |
| `this.deleteSubAgent(Cls, name)`| `this.dynamicAgents.delete(Cls, name)`|
| `this.hasSubAgent(Cls, name)`   | `this.dynamicAgents.has(Cls, name)`   |
| `this.listSubAgents(Cls?)`      | `this.dynamicAgents.list(Cls?)`       |

### `this.dynamicAgents.get(Cls, name)`

Get or create a dynamic agent. Lazy: the first call for `(Cls, name)` spawns the child; subsequent calls return the existing instance. Returns a typed RPC stub.

```typescript
const runner = await this.dynamicAgents.get(JobRunner, "run-abc");
await runner.ping();
```

The child class must:

- Extend `Agent`
- Be exported from the worker entry point (so `ctx.exports[Cls.name]` can find it)
- Does NOT need to be registered under `new_sqlite_classes` unless the same class is also bound as a top-level Durable Object elsewhere. Facet storage is created through the top-level parent.
- _Not_ share a name with the reserved token `"Sub"` (any class whose kebab-cased name equals `"sub"` is rejected; it would collide with the `/sub/` URL separator)

The parent class also has requirements that are implicit for normal usage but worth knowing if you hit the related error:

- Be bound as a Durable Object namespace in `wrangler.jsonc durable_objects.bindings`. (Top-level agents always are — this matters only if you try to call `dynamicAgents.get()` from a class that's exported but unbound.)
- Have its class name preserved by your bundler. The framework looks the parent up via `ctx.exports[this.constructor.name].idFromName(name)` to give the child its own `ctx.id.name`. If your bundler minifies class identifiers (e.g. esbuild without `keepNames: true`), `this.constructor.name` becomes a short id like `_a` and the lookup fails. The framework throws a descriptive error in that case pointing at the bundler config.

For code with **no static class at all** — dynamically-loaded or generated Durable Object classes from Worker Loader — mount the class as a facet directly with `ctx.facets.get`; see [`examples/next/dynamic-agents`](https://github.com/cloudflare/agents/tree/main/examples/next/dynamic-agents) for the supervised-gadget pattern.

### Notes for testing

Tests that use `@cloudflare/vitest-pool-workers` may need to list facet classes as test-only Durable Object bindings so `ctx.exports` provides a facet-compatible class value. Keep those facet classes out of `new_sqlite_classes`; the extra binding belongs only in test `wrangler.jsonc` files and is not a production Worker requirement.

### `this.dynamicAgents.delete(Cls, name)`

Abort a running child, cancel its pending schedules, and permanently wipe its storage. Idempotent — safe to call for a never-spawned or already-deleted child.

```typescript
await this.dynamicAgents.delete(JobRunner, "run-abc");
```

### `this.dynamicAgents.abort(Cls, name, reason?)`

Forcefully abort a running child without wiping its storage. The child stops executing immediately and will be restarted on next `dynamicAgents.get()` access.

```typescript
this.dynamicAgents.abort(JobRunner, "run-abc", new Error("quota exceeded"));
```

### `this.dynamicAgents.has(Cls | className, name)`

Check whether a child has been spawned and not deleted. Backed by a framework-maintained SQLite registry.

```typescript
if (!this.dynamicAgents.has(JobRunner, id)) {
  return new Response("not found", { status: 404 });
}
```

### `this.dynamicAgents.list(Cls?)`

List spawned children, optionally filtered by class. Returns `{ className, name, createdAt }` rows in creation order.

```typescript
const runs = this.dynamicAgents.list(JobRunner);
// → [{ className: "JobRunner", name: "...", createdAt: 1700... }, ...]
```

### `this.onBeforeSubAgent(req, { className, name })`

Override this middleware hook on the parent to gate, mutate, or short-circuit incoming `/sub/` requests **before** the framework wakes the child. Mirrors `onBeforeConnect` / `onBeforeRequest`.

Return one of:

| Return value | Effect                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `void`       | Forward the original request to the child (permissive)                 |
| `Request`    | Forward this modified request instead                                  |
| `Response`   | Short-circuit: send this response to the client, do not wake the child |

```typescript
export class Supervisor extends Agent {
  override async onBeforeSubAgent(_req, { className, name }) {
    // Strict-registry gate: only allow clients to reach children that
    // have actually been created by this agent.
    if (!this.dynamicAgents.has(className, name)) {
      return new Response(`${className} "${name}" not found`, {
        status: 404
      });
    }
  }
}
```

The hook receives the **original** request with its URL intact — including the `/sub/{class}/{name}` segment. The routing decision for which facet to wake is fixed at parse time; headers, body, method, and query string on a returned `Request` flow through to the child, but the **pathname** the child sees is always the tail after `/sub/{class}/{name}`.

WebSocket upgrade requests flow through this hook the same way as plain HTTP. If you return a mutated `Request`, keep the original `Upgrade: websocket` and `Sec-WebSocket-*` headers — cloning via `new Headers(req.headers)` and only adding or replacing entries is the safest recipe.

### `this.parentPath` and `this.selfPath`

Root-first ancestor chains. `parentPath` covers strict ancestors; `selfPath` includes the current agent.

```typescript
// Inside a JobRunner that was spawned by a Supervisor:
this.parentPath;
// → [{ className: "Supervisor", name: "user-123" }]

this.selfPath;
// → [{ className: "Supervisor", name: "user-123" }, { className: "JobRunner", name: "run-abc" }]
```

`parentPath` is **root-first**, so the direct parent is always `parentPath.at(-1)`. Top-level agents have `parentPath === []`.

### `this.parentAgent(Cls)`

Typed parent stub to the **immediate** parent, resolved from `parentPath`. Symmetric with `dynamicAgents.get(Cls, name)`: one opens a stub parent→child, the other opens a stub child→parent.

```typescript
const supervisor = await this.parentAgent(Supervisor);
await supervisor.recordProgress(this.name, "...");
```

The framework:

1. Verifies `Cls.name` matches the recorded direct-parent class (catches the "wrong class" mistake early).
2. If the direct parent is a top-level Durable Object, opens the namespace for the exported parent class and returns a stub for the recorded parent name.
3. If the direct parent is itself a facet, returns a proxy that routes method calls through the top-level root and then down the recorded facet path.

For grandparents and further ancestors that are top-level Durable Objects, iterate `this.parentPath` and call `getAgentByName(env.X, this.parentPath[i].name)` directly. Facet ancestors do not have their own `env` namespace binding; `parentAgent` is intentionally single-hop and only resolves the direct parent.

When `parentAgent()` returns a facet-parent proxy, RPC methods and normal HTTP `.fetch()` calls use the same internal bridge and do not run `onBeforeSubAgent`. WebSocket upgrade requests are not supported through `parentAgent().fetch()` yet because WebSocket handles cannot be serialized over RPC. Use externally routed sub-agent URLs for WebSocket connections.

| Capability              | `parentAgent(Cls)`             | External `/sub/...` routing                  |
| ----------------------- | ------------------------------ | -------------------------------------------- |
| Use case                | Internal child-to-parent calls | Client or worker requests into a child facet |
| RPC methods             | Yes                            | No                                           |
| Normal HTTP `.fetch()`  | Yes                            | Yes                                          |
| WebSocket upgrades      | No                             | Yes                                          |
| Runs `onBeforeSubAgent` | No                             | Yes                                          |

## Client API

### `useAgent({ sub: [...] })`

Extend any `useAgent` call with a `sub` chain to connect to a descendant facet:

```tsx
const runner = useAgent({
  agent: "Supervisor",
  name: userId,
  sub: [{ agent: "JobRunner", name: runId }]
});
```

- `agent` / `name` identify the **top-level** agent (the one bound in `env`).
- `sub` is a root-first array of `{ agent, name }` hops into descendants.
- The hook builds the URL `/agents/supervisor/{userId}/sub/job-runner/{runId}` and opens a WebSocket routed to the child.
- `.path` on the returned hook object gives you the full chain including the leaf.

Every other `useAgent` feature works as usual: `state` sync, `stub.method()` calls, `@callable` RPCs, `useAgentChat` on top of the returned socket.

### Direct HTTP and WebSocket URLs

Use `buildAgentPath()` to turn a root-first Agent identity into the canonical URL pathname used by both HTTP requests and WebSocket connections:

```typescript
import { buildAgentPath } from "agents";

const path = buildAgentPath(
  [
    { className: "Supervisor", name: userId },
    { className: "JobRunner", name: runId }
  ],
  { leafPath: "/callbacks/job" }
);

// /agents/supervisor/{userId}/sub/job-runner/{runId}/callbacks/job
```

Inside an Agent, pass `this.selfPath` directly. If the root Durable Object binding name differs from its class name, also pass `rootBinding` in the options. `buildAgentUrl()` adds a public origin, which is useful when registering callbacks, webhooks, approval URLs, or asynchronous job-completion URLs with an external system:

```typescript
import { buildAgentUrl } from "agents";

export class JobRunner extends Agent<Env> {
  callbackUrl() {
    return buildAgentUrl(this.env.PUBLIC_ORIGIN, this.selfPath, {
      leafPath: "/callbacks/job"
    });
  }

  override async onRequest(request: Request) {
    if (new URL(request.url).pathname === "/callbacks/job") {
      return this.handleJobCallback(request);
    }
    return new Response("Not found", { status: 404 });
  }
}
```

The Worker must pass the incoming request to `routeAgentRequest()`. Each ancestor's `onBeforeSubAgent` hook runs before the destination receives the request. For a dynamic-agent destination, the nested `/sub/...` routing segments are removed during forwarding, so its pathname is the `leafPath` suffix.

`buildAgentUrl()` accepts an HTTP(S) or WS(S) origin without a pathname, query, fragment, or credentials. Set callback query parameters through the returned URL's `searchParams`. If you use a custom routing prefix, pass the same value to both `buildAgentPath()` and `routeAgentRequest()`.

Root Agent names follow `routeAgentRequest`'s raw pathname-segment behavior and must already be externally routable. The `sub` segment is reserved in routing prefixes, class and binding names, and root Agent names. Descendant names are URL-encoded by the helper, so names containing spaces, Unicode, `/`, or URL-reserved characters round-trip safely.

### Custom routing

For fetch handlers that do their own top-level URL parsing, use `routeSubAgentRequest` to dispatch a request into a dynamic agent from an already-resolved parent stub:

```typescript
import { getAgentByName, routeSubAgentRequest } from "agents";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/api\/u\/([^/]+)(\/.*)$/);
    if (!match) return new Response("Not found", { status: 404 });

    const [, userId, rest] = match;
    const parent = await getAgentByName(env.Supervisor, userId);
    return routeSubAgentRequest(req, parent, { fromPath: rest });
  }
};
```

`fromPath` takes any pathname containing the sub-agent tail (something like `/sub/job-runner/run-abc/...`). When the destination is already represented as a root-first Agent path, pass the result of `buildAgentPath()` directly. The helper parses the first child hop, runs the parent's `onBeforeSubAgent` hook, and forwards into the facet.

### External typed RPC

From inside the parent DO, `this.dynamicAgents.get(Cls, name)` returns a typed stub. From **outside** the parent, use `getSubAgentByName`:

```typescript
import { getAgentByName, getSubAgentByName } from "agents";

const supervisor = await getAgentByName(env.Supervisor, userId);
const runner = await getSubAgentByName(supervisor, JobRunner, runId);

await runner.execute("hi");
```

`getSubAgentByName` returns an RPC-only Proxy — method calls work; `.fetch()` throws (use `routeSubAgentRequest` for HTTP/WS). Arguments and return values must be structured-cloneable.

## Lifecycle

### Creation

`dynamicAgents.get(Cls, name)` is lazy and idempotent:

- The first call for a name triggers the child's `onStart()`.
- Subsequent calls are no-ops and return the existing instance.
- The child is registered in the parent's `cf_agents_sub_agents` SQLite table.

### Access from a client

When a client connects to `/agents/{parent}/{name}/sub/{child}/{childName}`:

1. The request hits the top-level router and wakes the parent DO.
2. The parent's `onBeforeSubAgent` fires.
3. If the hook does not short-circuit, the framework resolves the facet (creating it on first access, unless the hook rejected with a `Response`).
4. The request is forwarded to the child, which handles the WebSocket upgrade or HTTP response.
5. The **parent owns the native WebSocket for the connection's lifetime.** Every subsequent frame wakes the root parent, which forwards it to the child over serializable RPC (the parent's own gating logic does not re-run per frame); replies come back the same way. The parent stays on the hot path — a design consequence of hibernation-safe sockets, and one more reason not to fan an unbounded number of busy WebSocket sessions through one parent.

### Deletion

`dynamicAgents.delete(Cls, name)` aborts any running instance, removes pending schedules for that child's tree, deletes its storage, and removes its registry entry. Idempotent.

### Hibernation

Dynamic agents hibernate when idle, same as any Durable Object. `this.name` is restored automatically from the facet's `ctx.id` (the runtime carries it across eviction). `this.parentPath` is persisted at facet init and restored on wake.

## Scheduling and durable work in dynamic agents

Dynamic agents can schedule their own callbacks and run durable fibers:

- `this.schedule()` / `this.scheduleEvery()` / `this.cancelSchedule()` work on a child.
- `this.getScheduleById()` / `this.listSchedules()` work on a child.
- `this.runFiber()` and Think `chatRecovery` work on a child.

The top-level parent still owns the physical alarm because facets do not have independent alarm slots. The Agents SDK stores the child owner path with each schedule row, wakes the parent, and routes the callback back into the child. `keepAlive()` and `keepAliveWhile()` work in dynamic agents by delegating their heartbeat ref to the top-level parent. `runFiber()` also works in dynamic agents: fiber rows and snapshots live in the child's own SQLite database, and the parent keeps a small root-side index so alarm housekeeping can route recovery checks back into idle children.

## Broadcasts

`this.broadcast(msg)` and `setState()`-driven broadcasts work the same way inside a dynamic agent as in a top-level agent — they go to the child's own WebSocket clients. Siblings do not see each other's broadcasts; reach them explicitly via RPC if needed. (The frames are physically sent by the root parent, which owns the native sockets.)

## When to use dynamic agents

The decision rule: **a facet is a child whose code or lifecycle the parent supervises and which must live inside the parent; an independent peer you address by name should be its own top-level Durable Object.**

| Situation                                                                       | Dynamic agents?                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Dynamically-loaded or AI-generated code needs durable, isolated storage          | Yes — the only way; there is no binding to give it     |
| Per-run tool agents with isolated scratch state, supervised abort, and cleanup   | Yes (see [Agent Tools](./agent-tools.md))              |
| A component needs isolated storage + independent abort, colocated with the agent | Yes (codemode runtimes, sandboxes, connector wrappers) |
| The parent should control what class runs over the child's storage (upgrades)    | Yes — restart the same storage under new code          |
| Many chats / documents / sessions per user                                       | **No** — one top-level DO each + a per-user index      |
| The children need independent geographic placement or scaling                    | No — top-level DOs                                     |
| The children need independent physical alarm slots                               | No — top-level DOs; revisit when facet alarms ship     |
| High-fan-out busy WebSocket sessions                                             | No — every frame wakes the one root parent             |

### The recommended many-chats pattern

One top-level Durable Object per chat, plus a per-user index DO the chats push their metadata into:

```typescript
// ChatAgent (one DO per chat) pushes on every write:
const user = await getAgentByName(this.env.UserAgent, userId);
await user.upsertChat({ chatId, title, lastMessage, updatedAt });

// UserAgent (per-user index) answers listing and cross-chat search
// from its own SQLite — no chat DO wakes up.
```

Each chat gets its own alarms, placement, and storage budget; deletion is one `destroy()`; and "search across all my chats" reads only the index. See [`examples/next/chats`](https://github.com/cloudflare/agents/tree/main/examples/next/chats) for the complete pattern with tests.

## Examples

- [`examples/next/dynamic-agents`](https://github.com/cloudflare/agents/tree/main/examples/next/dynamic-agents) — the headline use case: a supervisor stores user-submitted Durable Object code, loads it via Worker Loader, and runs it as facets with isolated storage, supervised abort, and code upgrades over stable state.
- [`examples/agents-as-tools`](https://github.com/cloudflare/agents/tree/main/examples/agents-as-tools) — per-run child agents as tools with inline streaming.
- [`examples/multi-ai-chat`](https://github.com/cloudflare/agents/tree/main/examples/multi-ai-chat) — a multi-session chat app built on facet children under one `Inbox`. It works and demonstrates the routing surface, but for many long-lived chats per user prefer the top-level-DO-per-chat pattern in [`examples/next/chats`](https://github.com/cloudflare/agents/tree/main/examples/next/chats) — see [When to use dynamic agents](#when-to-use-dynamic-agents).

## Related

- [Think sub-agents and programmatic turns](https://github.com/cloudflare/agents/blob/main/docs/think/sub-agents.md) — Think's `chat()` RPC method for streaming from a parent to a Think-based child
- [Agent Tools](./agent-tools.md) — run Think or `AIChatAgent` children as tools with inline streaming child timelines
- [Long-running agents](./long-running-agents.md) — how dynamic agents fit alongside `schedule`, `runFiber`, and workflows
- [Callable methods](./callable-methods.md) — `@callable` methods work unchanged on dynamic agents
- [Scheduling](./scheduling.md) — scheduling primitives for top-level and dynamic agents

## See also

- RFC: [sub-agents](https://github.com/cloudflare/agents/blob/main/design/rfc-sub-agents.md) — why sub-agents were added
- RFC: [sub-agent routing](https://github.com/cloudflare/agents/blob/main/design/rfc-sub-agent-routing.md) — external addressability, URL shape, `onBeforeSubAgent`
- Design doc: [sub-agent routing](https://github.com/cloudflare/agents/blob/main/design/sub-agent-routing.md) — current mechanics and invariants
