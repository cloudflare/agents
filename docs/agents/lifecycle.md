# Durable Object lifecycle

> **Experimental.** Everything exported from `agents/lifecycle` — and the
> capabilities built on it, including `Scheduler` — may change between
> releases while the composition surface stabilizes.

`agents/lifecycle` lets reusable durable capabilities work in both `Agent` and a
plain Cloudflare Durable Object. It uses composition: your class extends the
platform `DurableObject`, then constructs a lifecycle with `this`.

## Plain Durable Object

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

export class MyObject extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  onStart(): void {
    // Runs once per in-memory object lifetime, before work is handled.
  }

  onRequest(request: Request): Response {
    return new Response(`Hello from ${this.lifecycle.name}: ${request.url}`);
  }

  onAlarm(): void {
    // Runs once per alarm invocation, after due jobs are driven.
  }
}
```

The side-effect-named static factory constructs the lifecycle and installs the
runtime-facing `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`, and
`webSocketError` handlers. Do not define forwarding versions of those methods.
Implement the semantic callbacks instead.

The expanded equivalent is available when useful:

```ts
readonly lifecycle = new Lifecycle(this);

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  this.lifecycle.installHandlers();
}
```

Route named objects from the outer Worker when you want URL routing:

```ts
import { routeAgentRequest } from "agents";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

The default URL shape is `/agents/:binding/:name`. Direct
`env.MY_OBJECT.getByName(name).fetch(request)` calls work as well.

`Agent` already constructs this lifecycle (and installs the `WebSockets`
capability for its connections). Existing Agent classes continue to override
`onStart`, `onRequest`, `onConnect`, `onMessage`, `onClose`, and `onError`
normally.

## Request call path

The lifecycle-installed `fetch` is the request handler. It offloads each
request to the installed capabilities, which act as middleware: the first
capability registered that matches the request handles it by returning a
`Response`. A capability that returns `undefined` passes the request on to
the next capability, and a request no capability claims falls through to the
host's `onRequest`.

```text
routeAgentRequest(request)
└─ named Durable Object stub.fetch(request)
   └─ lifecycle-installed fetch
      ├─ lifecycle startup capabilities
      ├─ host onStart
      ├─ capability middleware, in registration order
      │  └─ first Response handles the request
      └─ host onRequest
```

A warm object skips startup but still offers every request to its middleware.
There is no `next()` today: a capability either handles a request or declines
it, and cannot wrap or observe a downstream response.

## Reusable capabilities

A capability implements only the phases it needs:

```ts
import type { DurableObjectCapability } from "agents/lifecycle";

class AuditLog implements DurableObjectCapability {
  constructor(private readonly storage: DurableObjectStorage) {}

  onStart(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        message TEXT NOT NULL
      )
    `);
  }

  onRequest({ request }: { request: Request }): Response | undefined {
    if (new URL(request.url).pathname.endsWith("/health")) {
      return new Response("ok");
    }
  }
}
```

Install it before startup:

```ts
export class MyObject extends DurableObject<Env> {
  private readonly audit = new AuditLog(this.ctx.storage);
  readonly lifecycle = Lifecycle.install(this).use(this.audit);

  onRequest(): Response {
    return new Response("application response");
  }
}
```

Capabilities run in registration order. Startup runs every hook
sequentially. Request handling is middleware dispatch: it stops at the first
returned `Response`, and returning `undefined` passes the request on. A phase
failure propagates, and failed startup can be retried.

A capability installed with `{ fallback: true }` dispatches after every
non-fallback capability, whenever it was installed. This is for a host's
catch-all: `Agent` installs its WebSockets capability as a fallback, so a
subclass that installs request or upgrade middleware from its own
constructor still runs first, even though `Agent`'s constructor ran earlier.

Capabilities extending `LifecycleCapability` receive one standard service
surface: storage, readiness, startup state, the job queue, a host
invocation boundary, best-effort events, and capability routing.
Host-specific bindings, authentication, and protocol adapters remain explicit
constructor dependencies. Lifecycle never grants a capability the complete
host implicitly.

Capability hooks run outside host context, but user callbacks run through
`this.lifecycle.runInHostContext(fn)` inside the host invocation context.
Scheduler dispatches its registered callbacks through this boundary, and a
future capability that calls user code should do the same.

## The job queue

Lifecycle owns the Durable Object's queue of durable work and its single
physical alarm. A job is a serialisable callback address — the owning
capability plus a function name — with a due time and a payload. A capability
that needs future work pushes a job and implements `onJob()`:

```ts
import {
  LifecycleCapability,
  type LifecycleJobContext
} from "agents/lifecycle";

class Cleanup extends LifecycleCapability {
  constructor() {
    super("cleanup");
  }

  async scheduleCleanup(time: number): Promise<void> {
    await this.lifecycle.jobs.push({ id: "cleanup", fn: "sweep", time });
  }

  async onJob({ job }: LifecycleJobContext): Promise<void> {
    // job.fn === "sweep"; returning nothing completes the job.
    await this.lifecycle.storage.delete("cleanup:marker");
  }
}
```

The queue is ordered by timestamp, and every queue mutation re-arms the
physical alarm automatically — there is no explicit rearm call. When the
alarm fires, Lifecycle drives due jobs in due order as an event loop, then
runs host `onAlarm()`, then re-arms from queue state. Before driving any job
it arms a deadman pre-alarm so an isolate death mid-drive still wakes the
object to resume.

A job's drive result decides what happens next: returning nothing completes
and deletes it, `{ rescheduleAt }` suspends it until a future time, and
`"yield"` leaves it due so the object wakes again immediately. Lifecycle also
owns dispatch retries: a job's `retry` options bound in-process attempts,
platform-class failures (a superseded isolate after a deploy, a memory-limit
reset) preserve the job for a fresh invocation, and a terminal application
failure reaches the owner's `onJobError()`, whose result decides advancement.

A job pushed with `exclusive: true` suppresses ordinary alarm candidates
while it is pending — Agent's deferred destroy uses this so a condemned
object cannot be kept alive by other work. A `singleflight` job is skipped
while a previous run is still in flight, until it crosses its hung timeout.
The host pushes jobs through `lifecycle.jobs` and implements the same
`onJob()` hook (a host job's terminal failure completes it; the host
re-derives its jobs from durable state). Capabilities do not depend on
Scheduler or
on each other merely to receive wakes.

## Capability events

Capabilities publish best-effort telemetry through their standard service
surface. Lifecycle assigns the capability source from the stable ID passed to
`super()`:

```ts
class Cleanup extends LifecycleCapability {
  constructor() {
    super("cleanup");
  }

  reportRemoval(key: string): void {
    this.lifecycle.events.emit("cleanup:remove", { key });
  }
}
```

Lifecycle publishes events from a plain Lifecycle Object to the existing
`agents:*` diagnostics channels according to the event type. Delivery is
best-effort, runs outside ambient host context, and does not fail the emitting
capability when a telemetry sink throws. Persist an outbox in the capability
when delivery is part of the durable business operation.

## Capability routing

Every `LifecycleCapability` also receives `lifecycle.routes`. `toRoot()` routes
a message to the matching capability ID on the root Lifecycle; `to(address, …)`
routes to another addressed Lifecycle; `retire(retirement)` announces that a
routed subtree no longer exists, and every installed capability's
`onRouteRetired` drops the durable work it mirrors for those owners. Lifecycle
owns the generic envelope and dispatch.

The transport is provided by a capability: at most one installed capability
implements `provideRouteTransport(inbound)`, returning the object's address and
`toRoot`/`to` senders. `DynamicAgents` is that capability — it walks the
parent/child tree one hop at a time over the hosts' `_cf_lifecycle` aperture,
the one native-RPC entry point routed capabilities need
(`_cf_lifecycle(envelope) { return this.lifecycle.route(envelope); }`). The
`inbound.deliver()` side delivers envelopes locally; envelopes handed over
while startup runs wait, in order, until it completes, so a capability that
starts early can address one that starts later.

An envelope marked `bootstrap: true` reaches its capability before the
Lifecycle has started (`context.started === false`); the capability writes
whatever startup must observe — a child's identity, for example — and starts
the object itself with `lifecycle.ready()`. Once started, a bootstrap envelope
is an ordinary route.

Scheduler and Tasks use routing for children: a child's Scheduler sends
owner-scoped CRUD to the root Scheduler, which routes due callbacks back to the
matching child. Child schedules live as jobs in the root's queue. Neither
capability implements traversal; both implement `onRouteRetired`.

Capabilities also receive narrow platform services alongside storage and
sockets: `facets` (`ctx.facets`, for colocated children), `exports` (class
lookup and loopback namespaces from `ctx.exports`), `object` (the routed name,
class name, and identity comparison), and `waitUntil`. The whole
`DurableObjectState` is never handed to a capability.

## Explicit disposal

`lifecycle.dispose()` calls each capability's optional `dispose()` method in
reverse installation order. This phase releases live resources such as MCP
transports and listeners. It does not delete capability tables. An explicit
Lifecycle Object destruction disposes live resources once, then calls
`storage.deleteAll()` once for all shared durable state. Eviction calls neither.

## Lifecycle Object context

`agents/lifecycle` exports the `LifecycleObject` interface for a
`DurableObject` with an installed `Lifecycle` and the semantic hooks Lifecycle
dispatches. This is a host type, not the batteries-included `Agent` class
exported from `agents`.

Lifecycle establishes the `getCurrentAgent()` context only while it invokes
host hooks. Capability hooks run outside that ambient context and use their own
`this`, hook arguments, and explicitly supplied dependencies.

```ts
import { getCurrentAgent } from "agents/lifecycle";

function currentRequestOrigin(): string | undefined {
  const { request } = getCurrentAgent();
  return request ? new URL(request.url).origin : undefined;
}

export class MyObject extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  onRequest(): Response {
    return Response.json({ origin: currentRequestOrigin() });
  }
}
```

Pass the concrete host class when shared host code needs its additional APIs:

```ts
const { agent: object } = getCurrentAgent<MyObject>();
```

Host context values follow the invocation:

- `onStart` and `onAlarm`: object;
- `onRequest`: object and request;
- `WebSockets` capability handlers `onConnect`: object, connection, and
  upgrade request;
- `WebSockets` capability handlers `onMessage`, `onClose`, and `onError`:
  object and connection.

`getConnectionTags(connection, { request })` remains argument-driven because it
already receives both values explicitly. The root `agents` package continues
to export `getCurrentAgent()` for the `Agent` class as a compatibility alias.

## WebSockets are an opt-in capability

Lifecycle itself does not model WebSockets. Hosts that want connections
install the `WebSockets` capability, which owns the subsystem end to end —
it claims upgrades, accepts hibernating sockets, dispatches handlers inside
the host invocation boundary, and answers `getConnections()`:

```ts
import { WebSockets } from "agents/websockets";

export class MyObject extends DurableObject<Env> {
  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection) => {
        connection.setState({ authenticated: true });
      },
      onMessage: (connection, message) => {
        connection.send(`echo:${message}`);
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.webSockets);
}
```

Without the capability installed, WebSocket upgrades are declined.

The capability can also serve remote methods: pass an `RpcTarget` as
`callables` and its prototype methods become the complete remote interface,
served over a Cap'n Web session (`?__agents_rpc=capnweb`). An `Agent` adds
no new surface for this — its `@callable()`-decorated methods are its
interface, served on every wire: natively over the legacy JSON RPC protocol
and, through the decorator-derived target, over the Cap'n Web endpoint.

Connections use Cloudflare's WebSocket Hibernation API. Idle clients remain
connected while the Durable Object can leave memory; when a message wakes the
object, its constructor and lifecycle startup run again before `onMessage`.
State needed after a wake must be stored durably or through
`connection.setState()`. There is no non-hibernating mode.

A socket another object owns can be bridged in: the owner's capability sends
`bridged:connect` / `bridged:message` / `bridged:close` messages to this
capability's route (`lifecycle.route({ capability: "websockets", … })`) with a
link for the operations that must travel back, and the capability presents the
socket as a connection the handlers and `getConnections()` see like any other.
This is how a dynamic agent's sockets, which live on its parent, reach the
child's handlers. A routed (child) Lifecycle owns no platform sockets, so there
the bridged connections are the only ones.

## Native RPC

Native Durable Object RPC does not pass through `fetch`. An RPC method that
requires initialized capabilities starts the lifecycle explicitly:

```ts
async runTask(): Promise<void> {
  await this.lifecycle.start();
  // initialized work
}
```

Agent's internal RPC entry points already enforce this boundary.

## Object names

Use `idFromName()` or `getByName()`. The lifecycle reads the authoritative name
from `ctx.id.name` and exposes it as `lifecycle.name`.

For migration only, the lifecycle can read an existing `__ps_name` record
written by an older PartyServer release. It never writes that key. Deprecated
name headers and bootstrap methods are not supported.

If a name cannot be resolved, the error covers named addressing, updating local
Wrangler/workerd and the compatibility date, unsupported raw IDs and oversized
names, and rescheduling alarms created before 2026-03-15.
