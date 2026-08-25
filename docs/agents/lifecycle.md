# Durable Object lifecycle

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
    // Runs after lifecycle capabilities process the alarm.
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

`Agent` already constructs this lifecycle. Existing Agent classes continue to
override `onStart`, `onRequest`, `onConnect`, `onMessage`, `onClose`, and
`onError` normally.

## Request call path

```text
routeAgentRequest(request)
└─ named Durable Object stub.fetch(request)
   └─ lifecycle-installed fetch
      ├─ lifecycle startup capabilities
      ├─ host onStart
      ├─ lifecycle request capabilities
      │  └─ first Response wins
      └─ host onRequest
```

A warm object skips startup but still offers every request to its capabilities.

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

  onAlarm(): void {
    this.storage.sql.exec("DELETE FROM audit_log");
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

Capabilities run in registration order. Startup and alarms run every hook
sequentially. Request handling stops at the first returned `Response`. A phase
failure propagates, and failed startup can be retried.

Capabilities extending `LifecycleCapability` receive one standard service
surface: storage, readiness, alarm coordination, best-effort events, and
capability routing. Host-specific bindings, authentication, and protocol
adapters remain explicit constructor dependencies. Lifecycle never grants a
capability the complete host implicitly.

## Shared alarm ownership

Lifecycle owns the Durable Object's single physical alarm. A capability that
needs a future wake-up keeps its work in its own durable storage and implements
`getNextAlarm()`:

```ts
import { LifecycleCapability, type AlarmContribution } from "agents/lifecycle";

class Cleanup extends LifecycleCapability {
  constructor() {
    super("cleanup");
  }

  async getNextAlarm(): Promise<AlarmContribution> {
    return (await this.lifecycle.storage.get<number>("cleanup:next")) ?? null;
  }

  async onAlarm(): Promise<void> {
    const next = await this.lifecycle.storage.get<number>("cleanup:next");
    if (next === undefined || next > Date.now()) return;
    await this.lifecycle.storage.delete("cleanup:next");
  }

  async scheduleCleanup(time: number): Promise<void> {
    await this.lifecycle.storage.put("cleanup:next", time);
    await this.lifecycle.alarms.rearm();
  }
}
```

Lifecycle selects the earliest contribution from every capability and the
host. It runs all capability `onAlarm()` hooks, then host `onAlarm()`, then
recalculates the physical alarm. Capabilities do not depend on Scheduler or on
each other merely to receive alarm wakes.

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
routes to another addressed Lifecycle. Lifecycle owns the generic envelope and
dispatch. A host with child objects supplies the transport internally.

Agent uses this for facet schedules: Scheduler sends owner-scoped CRUD to the
root Scheduler and routes due callbacks back to the matching facet Scheduler.
Existing rows remain in the root `cf_agents_schedules` table. Scheduler does not
implement facet traversal, and Agent exposes only one internal generic Lifecycle
route aperture.

## Explicit disposal

`lifecycle.dispose()` calls each capability's optional `dispose()` method in
reverse installation order. This phase releases live resources such as MCP
transports and listeners. It does not delete capability tables. An explicit
Lifecycle Object destruction disposes live resources once, then calls
`storage.deleteAll()` once for all shared durable state. Eviction calls neither.

A contribution can be `{ time, exclusive: true }` when its wake time must
replace ordinary wake candidates, such as a pending teardown. This changes only
which physical alarm is armed; when that alarm fires, normal capability and host
hook order still applies. Hosts can implement `getNextAlarm()` for alarm work
that has not yet been extracted into a capability.

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
- `onConnect`: object, connection, and upgrade request;
- `onMessage`, `onClose`, and `onError`: object and connection.

`getConnectionTags(connection, { request })` remains argument-driven because it
already receives both values explicitly. The root `agents` package continues
to export `getCurrentAgent()` for the `Agent` class as a compatibility alias.

## WebSockets always hibernate

The lifecycle always uses Cloudflare's WebSocket Hibernation API. Idle clients
remain connected while the Durable Object can leave memory. When a message
wakes the object, its constructor and lifecycle startup run again before
`onMessage`.

State needed after a wake must be stored durably or through connection state:

```ts
onConnect(connection: Connection): void {
  connection.setState({ authenticated: true });
}

onMessage(connection: Connection<{ authenticated: boolean }>): void {
  console.log(connection.state?.authenticated);
}
```

There is no non-hibernating mode.

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
