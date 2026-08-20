Status: accepted

# Durable Object lifecycle composition

## Problem

`Agent` historically inherited Durable Object routing and WebSocket behavior
from PartyServer while implementing every higher-level capability directly in
the base class. That made capabilities such as MCP difficult to reuse in a
plain Durable Object.

An earlier extraction introduced an Agent-only lifecycle and a broad hidden
host interface. It reduced code in `Agent`, but a capability still could not be
constructed independently and installed into another Durable Object.

## Decision

Vendor the required PartyServer runtime from
[`cloudflare/partykit@f0a2e97d`](https://github.com/cloudflare/partykit/commit/f0a2e97d233f24545b2648aec2ed6a191e11074e)
directly into `packages/agents/src/lifecycle` under its ISC license. Do not
publish a separate PartyServer package and do not retain a `Server` base class.

A class extends the platform `DurableObject` directly and constructs one
`DurableObjectLifecycle`:

```ts
import { DurableObject } from "cloudflare:workers";
import { DurableObjectLifecycle } from "agents/lifecycle";

export class MyObject extends DurableObject<Env> {
  readonly lifecycle = DurableObjectLifecycle.install(this);

  onStart() {}

  onRequest(request: Request) {
    return new Response(request.url);
  }

  onAlarm() {}
}
```

The side-effect-named `install(this)` factory constructs the lifecycle and
explicitly installs platform `fetch`, `alarm`, `webSocketMessage`,
`webSocketClose`, and `webSocketError`. The expanded `new ...` plus
`installHandlers()` form remains available. The class implements semantic
callbacks rather than forwarding runtime handlers manually.

`Agent` follows the same composition:

```text
DurableObject
└── Agent
    └── owns DurableObjectLifecycle
```

There is one lifecycle implementation and no nominally distinct server class.

## Components

Reusable capabilities implement only phases they need:

```ts
interface DurableObjectLifecycleComponent<Props> {
  onStart?(context: { props: Props | undefined }): void | Promise<void>;
  onRequest?(context: {
    request: Request;
  }): Response | undefined | void | Promise<Response | undefined | void>;
  onAlarm?(): void | Promise<void>;
}
```

A host can install and add a component in one field initializer:

```ts
readonly lifecycle = DurableObjectLifecycle.install(this).use(this.mcp);
```

Dependencies such as storage, bindings, clocks, authentication, observability,
and protocol publication are supplied explicitly when constructing the
component. Components do not receive the whole Agent through an implicit host
registry.

Phase policy is fixed:

- component startup runs sequentially in registration order, followed by the
  host's `onStart`;
- requests stop at the first component `Response`, otherwise the host's
  `onRequest` runs;
- component alarms run sequentially in registration order, followed by the
  host's `onAlarm`;
- a failure stops the phase and propagates;
- failed startup can be retried.

There is no disposal phase. Workers provide no eviction callback, so cleanup
that must happen explicitly belongs on the capability itself, such as
`MCPClientManager.close()`.

## WebSockets

Lifecycle WebSockets always use Cloudflare's Hibernation API. An idle socket
must not keep the Durable Object active and billed. There is no configuration
for an in-memory mode.

The lifecycle accepts sockets with `DurableObjectState.acceptWebSocket`, stores
connection metadata in WebSocket attachments, and dispatches wakes through the
host's `onConnect`, `onMessage`, `onClose`, and `onError` callbacks.

## Identity

For supported objects, native `ctx.id.name` is authoritative. Cloudflare makes
it available for `idFromName()` and `getByName()`, including alarm handlers.
Agents and Agent facets use named IDs.

The lifecycle never writes a duplicate name and does not support deprecated
naming headers or bootstrap RPCs. It performs one read of the historical
`__ps_name` key only when native identity is absent, allowing objects created by
older PartyServer releases to migrate.

If neither source exists, the error explains that:

- the object must be addressed with `idFromName()` or `getByName()`;
- local Wrangler/workerd and the compatibility date should be current;
- `newUniqueId()`, `idFromString()`, and names over 1,024 bytes do not expose a
  name;
- alarms created before 2026-03-15 must be rescheduled from a named fetch or RPC
  handler.

## Native RPC

Native Durable Object RPC bypasses `fetch`; no library can transparently
intercept arbitrary RPC methods. An RPC implementation that needs startup calls:

```ts
async myRpcMethod() {
  await this.lifecycle.start();
  // initialized work
}
```

Agent's internal RPC wrappers already enforce this boundary.

## Non-goals

- AI turns are not generic Durable Object lifecycle phases.
- Components do not independently own the single physical alarm timestamp.
- The lifecycle does not offer alternate dispatch policies, middleware `next()`
  semantics, an in-memory WebSocket mode, or speculative teardown hooks.
