# Durable Object lifecycle

The `agents/lifecycle` entry point provides the Durable Object substrate used by
`Agent`. It includes:

- `Server`, a PartyServer-compatible Durable Object base class;
- `getServerByName()` and `routePartykitRequest()` routing helpers;
- WebSocket connection types and helpers;
- `DurableObjectLifecycle`, which composes reusable durable components.

Existing `Agent` applications do not need to construct this lifecycle. Use it
when building a capability that should work in an `Agent` and in another
Durable Object class.

## Lifecycle components

A component can participate in startup, HTTP request handling, alarms, and
explicit disposal:

```ts
import { Server, type DurableObjectLifecycleComponent } from "agents/lifecycle";

class AuditLog implements DurableObjectLifecycleComponent {
  constructor(private readonly storage: DurableObjectStorage) {}

  onStart() {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  onRequest({ request }: { request: Request }) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/audit-health")) {
      return new Response("ok");
    }
  }

  onAlarm() {
    this.storage.sql.exec(
      "DELETE FROM audit_log WHERE created_at < ?",
      Date.now() - 30 * 24 * 60 * 60 * 1000
    );
  }
}

export class MyDurableObject extends Server<Env> {
  private readonly audit = new AuditLog(this.ctx.storage);

  protected override get lifecycleComponents() {
    return [this.audit];
  }

  override onRequest() {
    return new Response("application response");
  }
}
```

The component collection is resolved before the first startup phase, after
derived class fields have initialized. It then remains fixed for that in-memory
Durable Object instance.

Hooks run with these policies:

| Phase       | Behavior                                                        |
| ----------- | --------------------------------------------------------------- |
| `onStart`   | Components run sequentially in declaration order.               |
| `onRequest` | The first returned `Response` handles the request.              |
| `onAlarm`   | Every component runs sequentially in declaration order.         |
| `onDispose` | Every component runs in reverse order; failures are aggregated. |

A failure stops startup, request, or alarm processing and is propagated to the
host. Startup can be retried. Disposal is idempotent and attempts every cleanup
hook.

## Explicit dependencies

Lifecycle contexts contain only data for that phase. Pass storage, bindings,
configuration, observability, and protocol adapters to a component when you
construct it. Do not pass the complete host object merely so the component can
reach unrelated methods.

This keeps the same component usable in different composition roots:

```ts
const component = new AuditLog(ctx.storage);
```

## Native Durable Object classes

`DurableObjectLifecycle` can also be used without `Server`. In that case, the
host delegates each applicable entry point explicitly:

```ts
import { DurableObject } from "cloudflare:workers";
import { DurableObjectLifecycle } from "agents/lifecycle";

export class MyDurableObject extends DurableObject<Env> {
  private readonly audit = new AuditLog(this.ctx.storage);
  private readonly lifecycle = new DurableObjectLifecycle(() => [this.audit]);

  async fetch(request: Request): Promise<Response> {
    await this.lifecycle.start({ props: undefined });
    const handled = await this.lifecycle.request({ request });
    return handled ?? new Response("application response");
  }

  async alarm(): Promise<void> {
    await this.lifecycle.start({ props: undefined });
    await this.lifecycle.alarm();
  }
}
```

`onDispose` is not an eviction callback. The Workers runtime does not notify a
Durable Object before ordinary isolate eviction. Call `lifecycle.dispose()`
only from an explicit deletion or shutdown path owned by your application.

Native Durable Object RPC methods also bypass `fetch()`. An RPC method that
requires initialized components must call `lifecycle.start()` or use a host
base class that guards RPC entry points.

## Alarm ownership

Lifecycle components can react to an alarm, but they do not independently own
the physical Durable Object alarm. A Durable Object has one next alarm
timestamp. The host remains responsible for arbitrating that timestamp when
multiple components, such as schedules and managed fibers, need wakeups.
