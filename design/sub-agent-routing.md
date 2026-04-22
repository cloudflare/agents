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

They do **not** have independent alarms today — `schedule()` is unsupported on facets, and `keepAlive()` is a soft no-op.

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

- `schedule()` / `scheduleEvery()` / `cancelSchedule()` are unsupported on facets.
- `keepAlive()` is a soft no-op on facets.
- `deleteSubAgent()` is idempotent.
- Class names whose kebab-case equals `"sub"` are rejected (e.g. `Sub`, `SUB`,
  `Sub_`) because they collide with the `/sub/` URL separator.

## Design tradeoffs

- **Good:** direct child connections, low-latency parent↔child RPC, clean
  parent/index + child/leaf app structure.
- **Good:** parent-owned registry gives us strict gating and enumeration for free.
- **Tradeoff:** no independent alarms on facets yet.
- **Tradeoff:** `parentAgent(Cls)` only does the one-hop case; deeper ancestor
  lookup stays explicit.
