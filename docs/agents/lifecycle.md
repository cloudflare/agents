# Durable Object lifecycle

`agents/lifecycle` turns a Cloudflare Durable Object into an Agent through
composition. Your class extends the platform `DurableObject`, then installs a
lifecycle with `this`. Reusable capabilities work in both these composable
Agents and the batteries-included `Agent` class exported from `agents`.

## Composable Agent

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

Pass durable dependencies to a capability explicitly. A capability should not
use ambient context merely to reach storage, bindings, authentication,
observability, or protocol methods.

## Current Agent context

Lifecycle runs capability hooks and Agent user hooks in the context of the
current Agent. Capability `onStart` hooks still run before the Agent's
`onStart`; ambient context identifies the host but does not imply that host
startup has completed. Each capability restores the state it owns.

Shared code that cannot capture a particular instance can read the current
context from `agents/lifecycle`:

```ts
import {
  getCurrentAgent,
  type DurableObjectCapability
} from "agents/lifecycle";

function currentRequestOrigin(): string | undefined {
  const { request } = getCurrentAgent();
  return request ? new URL(request.url).origin : undefined;
}

class RequestAudit implements DurableObjectCapability {
  onRequest(): void {
    console.log(currentRequestOrigin());
  }
}
```

`getCurrentAgent().agent` defaults to `ComposableAgent`: a `DurableObject`
with an installed `Lifecycle` and its semantic hooks. Pass your concrete class
when shared code needs its additional APIs:

```ts
const { agent } = getCurrentAgent<MyAgent>();
```

Context values follow the invocation:

- `onStart` and `onAlarm`: `agent`;
- `onRequest`: `agent` and `request`;
- `onConnect`: `agent`, `connection`, and the upgrade `request`;
- `onMessage`, `onClose`, and `onError`: `agent` and `connection`.

`getConnectionTags(connection, { request })` remains argument-driven because it
already receives both values explicitly. The batteries-included `Agent` class
adds context for callables, chat turns, email, schedules, fibers, and detached
work. The root `agents` package continues to export `getCurrentAgent` as an
alias for compatibility.

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
