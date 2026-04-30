# Sub-agents

Sub-agents are child Durable Objects colocated under a parent agent. Each sub-agent has its own isolated SQLite storage and its own WebSocket connections, but shares the parent's machine and is spawned, listed, and torn down through the parent. Clients reach a sub-agent directly via a nested URL; inside an agent, sub-agents are typed RPC stubs.

Use sub-agents when a single user or entity owns an open-ended set of long-lived agents — chats, documents, sessions, shards, projects — and you want each one to run in parallel with its own state while keeping one parent agent as the coordinator.

If you want a parent chat agent to dispatch another chat-capable agent during a
single turn and render that child's progress inline, use [Agent Tools](./agent-tools.md).
Agent tools are built on sub-agents, but add a parent-side run registry,
streaming `agent-tool-event` frames, replay, cancellation, and cleanup.

## Overview

```typescript
import { Agent, callable } from "agents";

export class Inbox extends Agent {
  @callable()
  async createChat() {
    const id = crypto.randomUUID();
    // Spawn a child Chat Durable Object under this Inbox.
    await this.subAgent(Chat, id);
    return id;
  }

  @callable()
  listChats() {
    return this.listSubAgents(Chat);
  }
}

export class Chat extends Agent {
  async say(text: string) {
    // Reach back up to the inbox by class — the framework fills in
    // the parent's instance name from `this.parentPath`.
    const inbox = await this.parentAgent(Inbox);
    await inbox.recordTurn(this.name, text);
  }
}
```

```tsx
// Client
import { useAgent } from "agents/react";

// Connect to the inbox for the sidebar:
const inbox = useAgent({ agent: "Inbox", name: userId });

// Connect to a specific chat child:
const chat = useAgent({
  agent: "Inbox",
  name: userId,
  sub: [{ agent: "Chat", name: chatId }]
});
```

The resulting URL for the chat connection is `/agents/inbox/{userId}/sub/chat/{chatId}`.

## Concepts

```
┌──────────────────────────────────────────────────────────┐
│  Inbox (Durable Object, "user-123")                      │
│  - parent of all chats for this user                     │
│  - owns chat list + shared memory                        │
│  - runs `onBeforeSubAgent` on every incoming /sub/ hop   │
└────┬─────────────────────┬───────────────────┬───────────┘
     │                     │                   │
     ▼                     ▼                   ▼
  Chat ("chat-a")      Chat ("chat-b")     Chat ("chat-c")
  - own SQLite         - own SQLite        - own SQLite
  - own WS clients     - own WS clients    - own WS clients
  - runs in parallel with siblings
```

### Colocation

Sub-agents (also called **facets**) live on the **same machine** as their parent. They are not independent Durable Objects scattered across the edge — they are colocated with the parent for RPC latency and shared-memory patterns. Two chats belonging to the same inbox can run in parallel because each is its own single-threaded isolate, but they all share the parent's physical location.

### Independent state

Each sub-agent has its own SQLite database and its own in-memory state. Writes from one sibling never leak into another. When a sub-agent is deleted with `deleteSubAgent()`, its storage is wiped.

### Scheduling

Sub-agents can schedule their own callbacks with `this.schedule()` and `this.scheduleEvery()`:

```typescript
export class Chat extends Agent {
  async onStart() {
    await this.scheduleEvery(60, "compactHistory");
  }

  async compactHistory() {
    // Runs inside the Chat sub-agent.
    // this.sql points at the Chat SQLite database.
  }
}
```

The top-level parent still owns the underlying Durable Object alarm because facets do not have independent alarm slots. The Agents SDK stores a logical owner path for the sub-agent schedule, wakes the parent when the alarm fires, then dispatches the callback back into the sub-agent. The callback runs with the sub-agent as `this`, so it uses the sub-agent's SQLite storage, state, `parentPath`, and `getCurrentAgent()` context.

`cancelSchedule()`, `getScheduleById()`, and `listSchedules()` also work inside sub-agents. They are scoped to the calling sub-agent — a sub-agent cannot cancel or list a sibling's schedules by id. To clear every schedule under a sub-agent (and any of its descendants), call `parent.deleteSubAgent(Cls, name)` from the parent. The older synchronous `getSchedule()` and `getSchedules()` APIs throw inside sub-agents because scheduled rows are stored on the top-level parent.

Calling `this.destroy()` inside a sub-agent delegates the same teardown back to the parent: it cancels the sub-agent's parent-owned schedules (and descendants), removes the sub-agent from the parent's registry, and asks the runtime to wipe the sub-agent's storage. Because the underlying `ctx.facets.delete` call aborts the sub-agent's isolate, treat `this.destroy()` as fire-and-forget — it may not return cleanly to the caller.

### Durable execution and chat recovery

Sub-agents can use `runFiber()` and Think's `chatRecovery` just like top-level agents. Fiber rows live in the sub-agent's own SQLite database, so recovery hooks run with the sub-agent as `this` and see the sub-agent's state, storage, `parentPath`, and `getCurrentAgent()` context.

Because facets do not have independent alarm slots, the top-level parent owns the physical alarm heartbeat for sub-agent fibers. The sub-agent still stores fiber rows and snapshots in its own SQLite database, while the parent stores a small root-side index of active facet fibers. When the parent alarm fires, it checks that index and routes recovery checks back into the owning sub-agent. Think's chat recovery can schedule its recovered continuation from inside the sub-agent; the parent owns the physical alarm and routes the continuation back to the child.

### Shared identity

Sub-agents know who their parent is via `this.parentPath` (root-first ancestor chain) and `this.parentAgent(ParentClass)` (typed stub). A sub-agent with no parent (top-level agent) has `parentPath === []`.

## Server API

### `this.subAgent(Cls, name)`

Get or create a sub-agent. Lazy: the first call for `(Cls, name)` spawns the child; subsequent calls return the existing instance. Returns a typed RPC stub.

```typescript
const chat = await this.subAgent(Chat, "chat-abc");
await chat.ping();
```

The child class must:

- Extend `Agent`
- Be exported from the worker entry point (so `ctx.exports[Cls.name]` can find it)
- Be registered under `new_sqlite_classes` in `wrangler.jsonc`
- _Not_ share a name with the reserved token `"Sub"` (any class whose kebab-cased name equals `"sub"` is rejected; it would collide with the `/sub/` URL separator)

The parent class also has requirements that are implicit for normal usage but worth knowing if you hit the related error:

- Be bound as a Durable Object namespace in `wrangler.jsonc durable_objects.bindings`. (Top-level agents always are — this matters only if you try to call `subAgent()` from a class that's exported but unbound.)
- Have its class name preserved by your bundler. The framework looks the parent up via `ctx.exports[this.constructor.name].idFromName(name)` to give the child its own `ctx.id.name`. If your bundler minifies class identifiers (e.g. esbuild without `keepNames: true`), `this.constructor.name` becomes a short id like `_a` and the lookup fails. The framework throws a descriptive error in that case pointing at the bundler config.

### `this.deleteSubAgent(Cls, name)`

Abort a running sub-agent, cancel its pending schedules, and permanently wipe its storage. Idempotent — safe to call for a never-spawned or already-deleted child.

```typescript
await this.deleteSubAgent(Chat, "chat-abc");
```

### `this.abortSubAgent(Cls, name, reason?)`

Forcefully abort a running sub-agent without wiping its storage. The child stops executing immediately and will be restarted on next `subAgent()` access.

```typescript
this.abortSubAgent(Chat, "chat-abc", new Error("quota exceeded"));
```

### `this.hasSubAgent(Cls | className, name)`

Check whether a child has been spawned and not deleted. Backed by a framework-maintained SQLite registry.

```typescript
if (!this.hasSubAgent(Chat, id)) {
  return new Response("not found", { status: 404 });
}
```

### `this.listSubAgents(Cls?)`

List spawned sub-agents, optionally filtered by class. Returns `{ className, name, createdAt }` rows in creation order.

```typescript
const chats = this.listSubAgents(Chat);
// → [{ className: "Chat", name: "...", createdAt: 1700... }, ...]
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
export class Inbox extends Agent {
  override async onBeforeSubAgent(_req, { className, name }) {
    // Strict-registry gate: only allow clients to reach chats that
    // have actually been created via `createChat`.
    if (!this.hasSubAgent(className, name)) {
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
// Inside a Chat that was spawned by an Inbox:
this.parentPath;
// → [{ className: "Inbox", name: "user-123" }]

this.selfPath;
// → [{ className: "Inbox", name: "user-123" }, { className: "Chat", name: "chat-abc" }]
```

`parentPath` is **root-first**, so the direct parent is always `parentPath.at(-1)`. Top-level agents have `parentPath === []`.

### `this.parentAgent(Cls)`

Typed RPC stub to the **immediate** parent, resolved from `parentPath`. Symmetric with `subAgent(Cls, name)`: one opens a stub parent→child, the other opens a stub child→parent.

```typescript
const inbox = await this.parentAgent(Inbox);
await inbox.recordTurn(this.name, "...");
```

The framework:

1. Verifies `Cls.name` matches the recorded direct-parent class (catches the "wrong class" mistake early).
2. Looks up the namespace in `env[Cls.name]` and opens a stub on the recorded parent name.

For grandparents and further ancestors, iterate `this.parentPath` and call `getAgentByName(env.X, this.parentPath[i].name)` directly. `parentAgent` is intentionally single-hop.

If the binding name does not match the class name (for example `{ class_name: "Inbox", name: "MY_INBOX" }` in `wrangler.jsonc`), skip the helper and call `getAgentByName(env.MY_INBOX, this.parentPath.at(-1)!.name)` directly.

## Client API

### `useAgent({ sub: [...] })`

Extend any `useAgent` call with a `sub` chain to connect to a descendant facet:

```tsx
const chat = useAgent({
  agent: "Inbox",
  name: userId,
  sub: [{ agent: "Chat", name: chatId }]
});
```

- `agent` / `name` identify the **top-level** agent (the one bound in `env`).
- `sub` is a root-first array of `{ agent, name }` hops into descendants.
- The hook builds the URL `/agents/inbox/{userId}/sub/chat/{chatId}` and opens a direct WebSocket to the `Chat` child.
- `.path` on the returned hook object gives you the full chain including the leaf.

Every other `useAgent` feature works as usual: `state` sync, `stub.method()` calls, `@callable` RPCs, `useAgentChat` on top of the returned socket.

### Direct HTTP / custom routing

For fetch handlers that do their own top-level URL parsing, use `routeSubAgentRequest` to dispatch a request into a sub-agent from an already-resolved parent stub:

```typescript
import { getAgentByName, routeSubAgentRequest } from "agents";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/api\/u\/([^/]+)(\/.*)$/);
    if (!match) return new Response("Not found", { status: 404 });

    const [, userId, rest] = match;
    const parent = await getAgentByName(env.Inbox, userId);
    return routeSubAgentRequest(req, parent, { fromPath: rest });
  }
};
```

`fromPath` takes the sub-agent tail (something like `/sub/chat/chat-abc/...`). The helper parses it, runs the parent's `onBeforeSubAgent` hook, and forwards into the facet.

### External typed RPC

From inside the parent DO, `this.subAgent(Cls, name)` returns a typed stub. From **outside** the parent, use `getSubAgentByName`:

```typescript
import { getAgentByName, getSubAgentByName } from "agents";

const inbox = await getAgentByName(env.Inbox, userId);
const chat = await getSubAgentByName(inbox, Chat, chatId);

await chat.addMessage({ role: "user", content: "hi" });
```

`getSubAgentByName` returns an RPC-only Proxy — method calls work; `.fetch()` throws (use `routeSubAgentRequest` for HTTP/WS). Arguments and return values must be structured-cloneable.

## Lifecycle

### Creation

`subAgent(Cls, name)` is lazy and idempotent:

- The first call for a name triggers the child's `onStart()`.
- Subsequent calls are no-ops and return the existing instance.
- The child is registered in the parent's `cf_agents_sub_agents` SQLite table.

### Access from a client

When a client connects to `/agents/{parent}/{name}/sub/{child}/{childName}`:

1. The request hits the top-level router and wakes the parent DO.
2. The parent's `onBeforeSubAgent` fires.
3. If the hook does not short-circuit, the framework resolves the facet (creating it on first access, unless the hook rejected with a `Response`).
4. The request is forwarded to the child, which handles the WebSocket upgrade or HTTP response.
5. After the upgrade, subsequent WebSocket frames flow **directly** to the child — the parent is no longer on the hot path.

### Deletion

`deleteSubAgent(Cls, name)` aborts any running instance, removes pending schedules for that sub-agent tree, deletes its storage, and removes its registry entry. Idempotent.

### Hibernation

Sub-agents hibernate when idle, same as any Durable Object. `this.name` is restored automatically from the facet's `ctx.id` (the runtime carries it across eviction). `this.parentPath` is persisted during `_cf_initAsFacet` and restored on wake.

## Scheduling and durable work in sub-agents

Sub-agents can schedule their own callbacks and run durable fibers:

- `this.schedule()` / `this.scheduleEvery()` / `this.cancelSchedule()` work on a sub-agent.
- `this.getScheduleById()` / `this.listSchedules()` work on a sub-agent.
- `this.runFiber()` and Think `chatRecovery` work on a sub-agent.

The top-level parent still owns the physical alarm because facets do not have independent alarm slots. The Agents SDK stores the child owner path with each schedule row, wakes the parent, and routes the callback back into the child. `keepAlive()` and `keepAliveWhile()` work in sub-agents by delegating their heartbeat ref to the top-level parent. `runFiber()` also works in sub-agents: fiber rows and snapshots live in the child's own SQLite database, and the parent keeps a small root-side index so alarm housekeeping can route recovery checks back into idle children.

## Broadcasts

`this.broadcast(msg)` and `setState()`-driven broadcasts work the same way inside a sub-agent as in a top-level agent — they go to the sub-agent's own WebSocket clients. Siblings do not see each other's broadcasts; reach them explicitly via RPC if needed.

## When to use sub-agents

| Situation                                                                          | Sub-agents?                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| One user owns an open-ended set of long-lived contexts (chats, docs, sessions)     | Yes                                                |
| You want each context to run in parallel with isolated state                       | Yes                                                |
| You want a single parent DO to own the index, the shared memory, and the lifecycle | Yes                                                |
| You need a worker pool, scatter/gather, or ephemeral task isolation                | Often yes                                          |
| You have a single conversation per user and no need for per-context isolation      | No — just use one agent                            |
| The children need independent geographic placement                                 | No — top-level DOs instead                         |
| The children need their own logical scheduled callbacks or chat recovery           | Yes                                                |
| The children need independent physical alarm slots                                 | No — top-level DOs; revisit when facet alarms ship |

## Example

See [`examples/multi-ai-chat`](https://github.com/cloudflare/agents/tree/main/examples/multi-ai-chat) for a complete multi-session chat app:

- `Inbox` is a top-level agent per user — owns the chat list, shared memory, and the strict-registry gate.
- `Chat` is an `AIChatAgent` facet. Each chat runs in parallel; storage is isolated.
- Server spawns via `this.subAgent(Chat, id)`; client connects via `useAgent({ sub: [...] })`.
- Shared-memory tools inside the chat use `this.parentAgent(Inbox)` to write into the parent.

## Related

- [Think sub-agents and programmatic turns](./think/sub-agents.md) — Think's `chat()` RPC method for streaming from a parent to a Think-based child
- [Agent Tools](./agent-tools.md) — run Think or `AIChatAgent` sub-agents as tools with inline streaming child timelines
- [Long-running agents](./long-running-agents.md) — how sub-agents fit alongside `schedule`, `runFiber`, and workflows
- [Callable methods](./callable-methods.md) — `@callable` methods work unchanged on sub-agents
- [Scheduling](./scheduling.md) — scheduling primitives for top-level agents and sub-agents

## See also

- RFC: [sub-agents](https://github.com/cloudflare/agents/blob/main/design/rfc-sub-agents.md) — why sub-agents were added
- RFC: [sub-agent routing](https://github.com/cloudflare/agents/blob/main/design/rfc-sub-agent-routing.md) — external addressability, URL shape, `onBeforeSubAgent`
- Design doc: [sub-agent routing](https://github.com/cloudflare/agents/blob/main/design/sub-agent-routing.md) — current mechanics and invariants
