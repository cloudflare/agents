# Durable Object lifecycle

`agents/lifecycle` lets reusable durable capabilities work in both `Agent` and a
plain Cloudflare Durable Object. It uses composition: your class extends the
platform `DurableObject`, then constructs a lifecycle with `this`.

## Plain Durable Object

```ts
import { DurableObject } from "cloudflare:workers";
import { DurableObjectLifecycle } from "agents/lifecycle";

export class MyObject extends DurableObject<Env> {
  readonly lifecycle = DurableObjectLifecycle.install(this);

  onStart(): void {
    // Runs once per in-memory object lifetime, before work is handled.
  }

  onRequest(request: Request): Response {
    return new Response(`Hello from ${this.lifecycle.name}: ${request.url}`);
  }

  onAlarm(): void {
    // Runs after lifecycle components process the alarm.
  }
}
```

The side-effect-named static factory constructs the lifecycle and installs the
runtime-facing `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`, and
`webSocketError` handlers. Do not define forwarding versions of those methods.
Implement the semantic callbacks instead.

The expanded equivalent is available when useful:

```ts
readonly lifecycle = new DurableObjectLifecycle(this);

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  this.lifecycle.installHandlers();
}
```

Route named objects from the outer Worker when you want URL routing:

```ts
import { routeDurableObjectRequest } from "agents/lifecycle";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeDurableObjectRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

The default URL shape is `/objects/:binding/:name`. Direct
`env.MY_OBJECT.getByName(name).fetch(request)` calls work as well.

`Agent` already constructs this lifecycle. Existing Agent classes continue to
override `onStart`, `onRequest`, `onConnect`, `onMessage`, `onClose`, and
`onError` normally.

## Request call path

```text
routeAgentRequest(request)
└─ named Durable Object stub.fetch(request)
   └─ lifecycle-installed fetch
      ├─ lifecycle startup components
      ├─ host onStart
      ├─ lifecycle request components
      │  └─ first Response wins
      └─ host onRequest
```

A warm object skips startup but still offers every request to its components.

## Reusable components

A capability implements only the phases it needs:

```ts
import type { DurableObjectLifecycleComponent } from "agents/lifecycle";

class AuditLog implements DurableObjectLifecycleComponent {
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
  readonly lifecycle = DurableObjectLifecycle.install(this).use(this.audit);

  onRequest(): Response {
    return new Response("application response");
  }
}
```

Components run in registration order. Startup and alarms run every hook
sequentially. Request handling stops at the first returned `Response`. A phase
failure propagates, and failed startup can be retried.

Pass dependencies to a component explicitly. A component should not receive an
entire Agent merely to reach storage, bindings, authentication, observability,
or protocol methods.

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
requires initialized components starts the lifecycle explicitly:

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
