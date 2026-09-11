# Next: dynamic agents on a plain Durable Object

An early-access, server-only example showing `DynamicAgents` from
`agents/dynamic-agents` installed on a plain Cloudflare `DurableObject`. A
`Workspace` spawns `Notebook` children: each notebook runs in its own isolate
with its own SQLite database, colocated with and supervised by the workspace.
Neither class extends `Agent`.

```ts
export class Workspace extends DurableObject<Env> {
  readonly children = new DynamicAgents({
    onBeforeChild: (request, child) =>
      this.children.has(Notebook, child.name)
        ? undefined
        : new Response("No such notebook", { status: 404 })
  });
  readonly lifecycle = Lifecycle.install(this).use(this.children);

  _cf_lifecycle(envelope: LifecycleRouteEnvelope) {
    return this.lifecycle.route(envelope);
  }

  async onRequest() {
    const notebook = await this.children.get(Notebook, "todo");
    return Response.json({ notes: await notebook.listNotes() });
  }
}

export class Notebook extends DurableObject<Env> {
  readonly children = new DynamicAgents();
  readonly webSockets = new WebSockets({ handlers: { onMessage } });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.children)
    .use(this.webSockets, { fallback: true });

  _cf_lifecycle(envelope: LifecycleRouteEnvelope) {
    return this.lifecycle.route(envelope);
  }
}
```

The capability takes no wiring beyond one line on each host: the
`_cf_lifecycle` method is the native-RPC aperture routed capabilities travel
through. Everything else — storage for the child registry, the facet
primitive, the route transport other capabilities use to reach the root,
the physical alarm children have none of — comes from the Lifecycle it is
installed on. Install it first, before capabilities that route to children
and before `WebSockets`.

HTTP requests and WebSocket upgrades to
`/agents/workspace/{workspace}/sub/notebook/{name}/...` are forwarded to the
notebook by the capability after `onBeforeChild` allows them. A notebook's
sockets stay on the workspace (a child owns no platform sockets) and are
bridged into the notebook's own `WebSockets` capability, so its handlers,
`getConnections()`, and `connection.setState()` work like any other host's.

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the workspace `demo`:

```sh
# Create a notebook (spawns the child; idempotent).
curl -X POST http://localhost:8787/agents/workspace/demo/notebooks/todo

# Add a note through the forwarded HTTP route.
curl -X POST http://localhost:8787/agents/workspace/demo/sub/notebook/todo/notes \
  -H "content-type: application/json" -d '{"text": "buy milk"}'

# Read the notebook.
curl http://localhost:8787/agents/workspace/demo/sub/notebook/todo

# Open a WebSocket to the notebook and send `note:hello`; every client of
# that notebook receives the new note.
websocat ws://localhost:8787/agents/workspace/demo/sub/notebook/todo

# Abort the notebook (notes survive), or delete it (notes are wiped).
curl -X POST http://localhost:8787/agents/workspace/demo/notebooks/todo/abort
curl -X DELETE http://localhost:8787/agents/workspace/demo/notebooks/todo
```

## Test

```sh
pnpm test
```

The tests run the worker in the Workers test pool and drive spawn, forwarded
HTTP, bridged WebSockets, the child gate, abort, and delete.

For the `Agent`-hosted API (`this.dynamicAgents`), and for running
user-submitted code with no static class, see
[`../dynamic-agents`](../dynamic-agents) and the
[dynamic agents guide](../../../docs/agents/sub-agents.md).
