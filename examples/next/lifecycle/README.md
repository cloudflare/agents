# Next: Durable Object lifecycle

An early-access, server-only example showing that `agents/lifecycle` works with
a plain Cloudflare `DurableObject`. It does not extend `Agent` or another SDK
base class.

```ts
export class DoAgent extends DurableObject<Env> {
  private readonly activity = new ActivityCapability(this.ctx.storage);
  private wake: { id: string; startedAt: string } | undefined;

  // WebSockets are opt-in: connections live in the WebSockets capability.
  private readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection) => connection.send("connected"),
      onMessage: (connection, message) => connection.send(`echo:${message}`)
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.activity)
    .use(this.webSockets);

  onStart() {
    // Runs once whenever this Durable Object enters memory, including after a
    // hibernating WebSocket wakes a fresh instance.
    this.wake = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString()
    };
  }

  onRequest() {
    return Response.json({
      name: this.lifecycle.name,
      wake: this.wake,
      activity: this.activity.getActivity()
    });
  }
}
```

The lifecycle starts `ActivityCapability` first, then calls the Durable Object's
`onStart()`. `onStart()` creates a per-wake identifier so HTTP and WebSocket
responses show which in-memory lifetime handled them.

`ActivityCapability` implements `DurableObjectCapability` and contributes
startup, request, and alarm behavior. It also exposes `getActivity()`, its own
ordinary API for reading the durable state it owns. Lifecycle hooks are how a
capability attaches to a host; they are not the limit of its API.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the named object `demo`:

```sh
# Host onRequest; also increments the capability's request count.
curl http://localhost:8787/agents/do-agent/demo

# Intercepted by ActivityCapability before the host onRequest.
curl http://localhost:8787/agents/do-agent/demo/stats
```

Connect a WebSocket to `ws://localhost:8787/agents/do-agent/demo`. The
`WebSockets` capability claims the upgrade, sends a connection snapshot, and
echoes each message. The socket uses Cloudflare's WebSocket Hibernation API, so
it remains connected while the Durable Object can leave memory. Lifecycle itself
does not model WebSockets — without the capability installed, upgrades are
declined.

Each normal HTTP request pushes a job into the Lifecycle queue due five
seconds later. The capability's `onJob` records it before the object's
`onAlarm` callback runs.
