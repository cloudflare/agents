# Composition model & registration flow

Type: grilling+prototype
Status: closed
Blocked by:

## Question

How does an independent primitive attach to and compose on a bare Durable
Object, with no blessed base class?

Settle the two halves of the model:

1. Instance shape — how a primitive is constructed (leaning: a plain instance
   over `ctx.storage`/`ctx`), and what its narrow interface looks like. What is
   the smallest interface a primitive must expose to be composable?
2. Registration flow — how a primitive contributes behavior that can only be
   dispatched from the exported Worker/DO's shared entrypoints (`fetch`,
   `webSocketMessage`, `webSocketClose`, `alarm`, queue consumer, `email`) and
   from Worker-level routing. Is the export assembled by a builder that collects
   primitives, or do primitives register into a DO-owned dispatcher at
   construction, or both?

Also state (even if only to defer to a fog ticket) how this model expects to
handle the storage-namespacing and shared-entrypoint-dispatch details, since the
Channels tracer bullet leans on dispatch and only lightly on owned storage — the
model must independently satisfy the owned-storage/migrations half.

Produce a prototype (stub interfaces + a rough bare-DO wiring sketch) to react to.

## Resolution

Prototype: [`prototypes/01-composition-model.ts`](../prototypes/01-composition-model.ts).

Two boundary layers, established as fact. The runtime delivers external events
to the **Worker** default export first (`fetch`, `email`, `queue`, `scheduled`,
`tail`); the **DO** is reached only via a stub. But the runtime delivers a
subset _directly to the DO instance_ — `fetch` (via stub), `webSocketMessage`/
`Close`/`Error`, `alarm` — bypassing the Worker. In particular ws message frames
and alarms can never be intercepted at the Worker or RPC'd in, so they MUST be
real methods on the DO instance. (Refs: durable-objects/api/base, /api/alarms,
/best-practices/websockets. Note: DO `alarm()` is not the Worker's `scheduled()`
/ Cron Triggers — different mechanism.)

1. Instance shape — a primitive is a plain object constructed `(ctx, deps)`.
   `ctx` is the raw DO substrate (universal, non-configuration). `deps` is an
   explicit typed manifest of env bindings **and** sibling primitives, named by
   role (not by binding name), so a primitive is reusable on a different DO.
   `env` is read only at the composition root. Storage namespacing is left to
   convention (opt-in prefix helper); hard capability walls are not pursued.

2. Narrow interface — optional DO-shaped methods (`fetch?`, `webSocketMessage?`,
   `webSocketClose?`, `webSocketError?`, `alarm?`). `fetch` returns
   `Response | undefined` (undefined = not mine). Routing/claiming metadata —
   which inbound event belongs to which primitive when several share an
   entrypoint — is deliberately NOT in the base interface; it is ticket 03.

3. Registration flow — a **thin, dispatch-only base class** `PrimitiveHost`, not
   a bare hand-delegating DO (this revised the initial leaning). The author
   `extends PrimitiveHost` and supplies one member, `build(ctx, env)`, returning
   the primitives array; the base installs the DO entrypoints and fans them out.
   This refines the "no blessed base class" constraint to "no _god_ base class":
   a base with zero domain behavior/state is allowed. Bright line — the moment
   domain behavior lands on `PrimitiveHost`, we have rebuilt Think. On the Worker
   side, a builder wraps the author's own handler (sandbox-sdk `bridge()` shape,
   verified): `?? next` chain-of-responsibility for `fetch`, single-owner /
   wrap-and-delegate for `email`/`queue`/`scheduled`. It forwards only the two
   Worker-in-path rows (ws-upgrade fetch, Worker-only events); never ws-frames or
   alarms.

Deferred (see map fog): storage namespacing; Worker→DO stub addressing;
alarm/schedule storage. ws multiplexing and the split-primitive two-halves
binding are ticket 03. The dispatch-only-base-class rule is recorded in
[ADR 0001](../../docs/adr/0001-dispatch-only-primitive-host.md).
