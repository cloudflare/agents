# Sub-agent Routing

How the shipped sub-agent / facet system works **today**.

See also:

- [`rfc-sub-agents.md`](./rfc-sub-agents.md) — why sub-agents were added
- [`rfc-sub-agent-routing.md`](./rfc-sub-agent-routing.md) — why external addressability shipped the way it did

## The model

Sub-agents are child Durable Objects created via `parent.subAgent(Cls, name)`.
They are implemented on top of workerd facets (`ctx.facets`) and have:

- their own isolated SQLite storage
- their own in-memory state
- their own WebSocket clients (once addressed through `/sub/...`)
- colocation with the parent on the same machine

They do **not** have independent alarm slots today. Sub-agent `schedule()` and
`scheduleEvery()` calls are logical child schedules stored in the top-level
parent's scheduler table with an owner path. When the parent alarm fires, the
SDK routes the due callback back through the facet tree and executes it inside
the owning sub-agent.

## Addressing

The URL shape is nested under the parent:

```
/agents/{parent-class}/{parent-name}/sub/{child-class}/{child-name}
```

The parent DO is always woken first. Its `onBeforeSubAgent(req, { className, name })`
hook can:

- allow the request through (`void`)
- mutate the request (`Request`)
- short-circuit with a response (`Response`)

After a WebSocket upgrade, frames flow directly to the child facet.

## Parent-owned registry

Each parent maintains a small framework-owned registry in SQLite as a side effect of:

- `subAgent()` — insert-or-ignore
- `deleteSubAgent()` — delete

This powers:

- `hasSubAgent(ClsOrName, name)`
- `listSubAgents(ClsOrName?)`
- strict-registry gates in `onBeforeSubAgent`

Applications can keep their own metadata tables (titles, previews, permissions),
but the registry is the source of truth for whether a child exists.

## Ancestor identity

At facet init time, the parent passes a root-first ancestor chain into the child:

```ts
this.parentPath; // ancestors only
this.selfPath; // ancestors + self
```

Example:

```
Tenant("acme")
  └─ Inbox("alice")
       └─ Chat("chat-123")
```

Inside `Chat`:

```ts
this.parentPath;
// [
//   { className: "Tenant", name: "acme" },
//   { className: "Inbox",  name: "alice" }
// ]
```

`parentPath` is **root-first**, so the direct parent is always the **last**
entry, not the first.

## `parentAgent(Cls)`

`Agent#parentAgent(Cls)` is the one-hop inverse of `subAgent(Cls, name)`:

- child → direct parent
- typed RPC stub
- runtime check that `Cls.name` matches the direct parent class
- resolves the namespace binding from `env[Cls.name]`

For grandparents and further ancestors, use `parentPath[i]` plus
`getAgentByName(...)` directly.

This API intentionally assumes the common \"binding name matches class name\"
convention. If a binding uses a different name in `wrangler.jsonc`, use
`getAgentByName(env.MY_BINDING, this.parentPath.at(-1)!.name)` directly.

## Broadcasts and state sync

Originally, facets were treated as RPC-only and broadcast paths no-op'd when
`_isFacet` was set. That assumption stopped being true once clients could
connect directly to facets through sub-agent routing.

Today:

- `this.broadcast(...)` inside a facet sends to the facet's own WS clients
- `setState()` broadcasts state updates from the facet to its own clients
- MCP server state broadcasts also reach the facet's own clients

The parent does **not** receive those broadcasts automatically — talk to it via
RPC if you need parent-side side effects.

## Lifecycle caveats

- `schedule()` / `scheduleEvery()` / `cancelSchedule()` work on facets, but the
  top-level parent owns the physical alarm.
- `getScheduleById()` / `listSchedules()` work on facets by delegating to the
  top-level parent.
- `getSchedule()` / `getSchedules()` are deprecated synchronous storage reads
  and throw on facets.
- `keepAlive()` and `keepAliveWhile()` work on facets by delegating their
  heartbeat ref to the top-level parent. Facets still do not get an independent
  physical alarm slot.
- `runFiber()` works on facets. Fiber rows and snapshots live in the child
  SQLite database, while the root parent keeps a small index of active facet
  fibers so alarm housekeeping can route recovery checks back into idle
  children.
- Think chat recovery works on facets; recovered continuations can schedule from
  the child and are routed through the top-level parent's alarm.
- `deleteSubAgent()` is idempotent and removes pending schedules for that
  descendant tree before deleting the facet.
- Class names whose kebab-case equals `"sub"` are rejected (e.g. `Sub`, `SUB`,
  `Sub_`) because they collide with the `/sub/` URL separator.

## Design tradeoffs

- **Good:** direct child connections, low-latency parent↔child RPC, clean
  parent/index + child/leaf app structure.
- **Good:** parent-owned registry gives us strict gating and enumeration for free.
- **Good:** sub-agent code can use the normal scheduling API even though the
  parent owns the runtime alarm.
- **Tradeoff:** no independent physical alarms on facets yet; the root parent
  multiplexes schedules for the whole facet tree.
- **Tradeoff:** `parentAgent(Cls)` only does the one-hop case; deeper ancestor
  lookup stays explicit.
