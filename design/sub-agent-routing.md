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

`buildAgentPath(path, options?)` is the canonical serializer for this wire
format. It accepts the same root-first `{ className, name }[]` shape exposed by
`Agent#selfPath`, owns class conversion and name encoding, and can append a
pathname suffix. When the root Durable Object binding and class names differ,
`rootBinding` supplies the routing namespace. `buildAgentUrl(origin, path, options?)` adds
an HTTP(S) or WS(S) origin. The resulting address is transport-neutral: HTTP
requests and WebSocket upgrades use the same pathname.

The parent DO is always woken first. Its `onBeforeSubAgent(req, { className, name })`
hook can:

- allow the request through (`void`)
- mutate the request (`Request`)
- short-circuit with a response (`Response`)

After a WebSocket upgrade, the root parent keeps the native socket. Every
frame wakes the root, which forwards it to the child over RPC without
re-running `onBeforeSubAgent`; replies come back the same way.

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

The SDK also passes an explicit `id` to `ctx.facets.get()` so lifecycle identity can
resolve `this.name` from `ctx.id.name` inside the facet. That ID is derived from
the top-level root/supervisor namespace, not the immediate parent, because the
immediate parent may itself be a facet and is not expected to expose namespace
helpers such as `idFromName`.

## `parentAgent(Cls)`

`Agent#parentAgent(Cls)` is the one-hop inverse of `subAgent(Cls, name)`:

- child → direct parent
- typed parent stub
- runtime check that `Cls.name` matches the direct parent class
- resolves a top-level parent from `env[Cls.name]` or the Worker `exports`
  namespace
- resolves a facet parent through a root bridge that walks the recorded facet
  path one hop at a time

For grandparents and further ancestors that are top-level Durable Objects, use
`parentPath[i]` plus `getAgentByName(...)` directly. Facet ancestors are not
individually bound in `env`, and `parentAgent()` intentionally stays a one-hop
direct-parent helper.

Top-level parent resolution prefers `env[Cls.name]` and falls back to the
Worker `exports` namespace. This supports custom Durable Object binding names
as long as the parent class is exported under its class name.

Facet-parent stubs expose normal HTTP `.fetch()` calls through the same root
bridge as RPC methods. These internal calls do not run `onBeforeSubAgent`.
WebSocket upgrade requests are not supported through `parentAgent().fetch()`
yet because WebSocket handles cannot be serialized over RPC. Use externally
routed sub-agent URLs for WebSocket connections.

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
- `keepAlive()` and `keepAliveWhile()` work on facets: the facet's `KeepAlive`
  heartbeat is a job in the facet's own queue, woken through the root's wake
  job for that facet path ([alarm-coordination.md](./alarm-coordination.md)).
  Facets still do not get an independent physical alarm slot.
- `runFiber()` works on facets. Fiber rows, snapshots and the recovery wake
  live in the child's own storage, and the root wakes the child the same way
  ([fibers.md](./fibers.md)).
- Think chat recovery works on facets; recovered continuations can schedule from
  the child and are routed through the top-level parent's alarm.
- `deleteSubAgent()` is idempotent and removes pending schedules for that
  descendant tree before deleting the facet.
- Class names whose kebab-case equals `"sub"` are rejected (e.g. `Sub`, `SUB`,
  `Sub_`) because they collide with the `/sub/` URL separator.

## Platform limits (measured)

Measured on a deployment on 23 Nov 2026, on a plain Durable Object with a
facet class from the same Worker. The design has to stay inside these.

- **Depth.** A facet tree is at most 4 deep including the root: a root, its
  facets, their facets and one more level. The fourth `ctx.facets.get()` throws
  `Facet nesting depth limit exceeded`. A session's object can therefore hold
  three levels of sub-agents, and a nested agent-tool chain over facets stops
  there.
- **One isolate.** A facet runs in its parent's isolate, on the same thread,
  and shares its `globalThis` and its 128 MB. Facets isolate data, not memory
  or CPU: two facets each running CPU work take about twice as long together,
  and a facet that runs out of memory resets the parent and every sibling.
- **Resets.** A facet that throws keeps running. A facet that calls
  `ctx.abort()` is reset alone; the root keeps its instance, old stubs to that
  facet fail for good and a fresh `ctx.facets.get()` starts a new instance. A
  root `ctx.abort()` resets the whole tree.
- **Storage.** Each facet has its own SQLite database, isolated both ways and
  deleted with the facet. Nothing commits parent and facet rows together, and
  the runtime cannot list facets, which is why the parent keeps the registry.
  A write in a facet follows the same rule as in a root: it is lost to a reset
  that comes before any I/O unless `storage.sync()` ran first. A write the
  facet made before its RPC returned to the parent survived a root reset
  straight after the call.
- **No alarm.** `setAlarm()` in a facet rejects with `Facets currently cannot
  set alarms.`, and one that is not awaited breaks that facet instance. A facet
  is woken only by a call from its parent. No capability may call `setAlarm`
  in a facet.
- **Sockets.** The root owns every socket and forwards events to the facet. A
  hibernatable socket a facet accepted itself did wake only the facet, but
  after a deploy it stopped answering without a close frame (2 runs of 2),
  while a root's hibernated sockets survive a deploy.
- **Calls.** A call from parent to facet takes about 0 ms and is not a
  subrequest hop. A `ReadableStream` returned over RPC errors with
  `ReadableStream received over RPC disconnected prematurely.` when its
  producer resets, so a reader needs a cursor and must attach again.

Not measured: how facets are billed, how their CPU is accounted, and whether
an object's facets share a storage total.

## Design tradeoffs

- **Good:** direct child connections, low-latency parent↔child RPC, clean
  parent/index + child/leaf app structure.
- **Good:** parent-owned registry gives us strict gating and enumeration for free.
- **Good:** sub-agent code can use the normal scheduling API even though the
  parent owns the runtime alarm.
- **Tradeoff:** no independent physical alarms on facets; the root parent
  multiplexes wakes for the whole facet tree.
- **Tradeoff:** three levels of sub-agents at most, and one memory limit for
  the tree (see [Platform limits](#platform-limits-measured)).
- **Tradeoff:** `parentAgent(Cls)` only does the one-hop case; deeper ancestor
  lookup stays explicit.
