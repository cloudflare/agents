# Next: websockets

An early-access, server-only example showing `WebSockets` from
`agents/websockets` installed on a plain Cloudflare `DurableObject`. It does
not extend `Agent` or another SDK base class.

```ts
export class RoomObject extends DurableObject<Env> {
  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, { request }) => {
        connection.setState({ nick: nickFrom(request), joinedAt: Date.now() });
      },
      onMessage: (connection, message) => {
        // Runs inside the host invocation boundary, on whichever instance
        // the platform woke for this frame.
      },
      onClose: (connection, code, reason, wasClean) => {}
    },
    getConnectionTags: (_connection, { request }) => [
      `nick:${nickFrom(request)}`
    ],
    callables: new RoomCallables(this)
  });
  readonly lifecycle = Lifecycle.install(this).use(this.webSockets);
}
```

Lifecycle itself does not model WebSockets. Installing the capability is
what makes upgrades succeed: it claims them, accepts sockets with the
Hibernation API, dispatches the handlers inside the host invocation
boundary, reciprocates close handshakes, and answers `getConnections()` and
`getConnection(id)`. Without it, upgrades are declined.

The room shows four things:

- **Hibernation.** Idle members stay connected while the Durable Object
  leaves memory. When a frame wakes it, the constructor and lifecycle startup
  run again before `onMessage`. Anything a later wake needs about a
  connection goes through `connection.setState()`; in-memory fields are
  gone. The `whoami` frame reads that state back.
- **Tags.** `getConnectionTags` runs once at accept time and the tags stay
  queryable after any wake through `getConnections(tag)`. The `/members?nick=`
  route resolves members by tag without reading each connection's state.
- **Pushing from outside a handler.** `POST /say` broadcasts from an HTTP
  request, which is the shape a webhook, alarm, or scheduled job takes to
  reach connected clients.
- **Callables.** The same room is served as remote methods over a Cap'n Web
  session: pass an `RpcTarget` as `callables` and its prototype methods become
  the complete remote interface at `?__agents_rpc=capnweb`. Methods run
  through the host boundary, so `say()` broadcasts to the hibernating members
  like a handler does. Callable sessions are non-hibernating: while a client
  holds one open, the object stays in memory.

## Run

```sh
pnpm install
pnpm run dev
```

Join the room `lobby` with two terminals (`websocat` or any WebSocket
client):

```sh
websocat 'ws://localhost:8787/agents/room-object/lobby?nick=alice'
# paste: {"type":"say","text":"hello"}
# paste: {"type":"whoami"}
```

Read and write the same room over HTTP:

```sh
curl http://localhost:8787/agents/room-object/lobby/history
curl http://localhost:8787/agents/room-object/lobby/members
curl 'http://localhost:8787/agents/room-object/lobby/members?nick=alice'

# Broadcasts to every connected member.
curl -X POST http://localhost:8787/agents/room-object/lobby/say \
  -H "content-type: application/json" \
  -d '{"text": "deploy finished", "nick": "ci"}'
```

Call the room as methods from any JavaScript client:

```ts
import { newWebSocketRpcSession } from "capnweb";
import { callablesRpcUrl } from "agents/websockets";

const rpc = newWebSocketRpcSession<{
  say(nick: string, text: string): Promise<unknown>;
  history(): Promise<unknown[]>;
  members(): Promise<unknown[]>;
}>(callablesRpcUrl("ws://localhost:8787/agents/room-object/lobby"));

await rpc.say("cli", "hi from rpc");
console.log(await rpc.history());
```

## Test

```sh
pnpm test
```

The suite drives real hibernating sockets and a Cap'n Web session against
the worker in the Workers vitest pool.
