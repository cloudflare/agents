# Next: websockets

One plain Cloudflare `DurableObject`, one interface, reached three ways. The
`WebSockets` capability from `agents/websockets` owns connections end to end
and speaks the Agent protocol for the host, so `useAgent` works against a
plain object on either transport, and the same `RpcTarget` is callable on
every wire.

```ts
export class RoomObject extends DurableObject<Env> {
  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, { request }) => {
        connection.setState({
          nick: nickFrom(connection, request),
          joinedAt: Date.now()
        });
      },
      onMessage: (connection, message) => {
        // The room's own frames. Identity and rpc frames never reach here.
      }
    },
    getConnectionTags: (connection, { request }) => [
      `nick:${nickFrom(connection, request)}`
    ],
    callables: new RoomCallables(this)
  });
  readonly lifecycle = Lifecycle.install(this).use(this.webSockets);
}
```

## Connect with `useAgent`, pick the wire

```tsx
const agent = useAgent({
  agent: "room-object",
  name: "lobby",
  transport: "websocket" // or "capnweb"
});
const room = agent.stub as RoomApi;
await room.say("alice", "hello"); // an rpc frame answered by RoomCallables
await agent.call("countdown", [3], {
  // a streaming callable
  stream: { onChunk: console.log }
});
```

| Transport     | Wire                                                   | Hibernates | What `stub` / `call()` do                             |
| ------------- | ------------------------------------------------------ | ---------- | ----------------------------------------------------- |
| `"websocket"` | Hibernating WebSocket, managed by PartySocket          | Yes        | Send `rpc` frames; the capability answers them        |
| `"capnweb"`   | The same frames through one Cap'n Web session (a pipe) | No         | Identical frames, identical answers, through the pipe |

Everything else about the hook is the same on both: `identified` flips when
the capability sends the identity frame, `onMessage` receives the room's own
frames (`history`, `join`, `message`, `leave`), reconnection and backoff are
PartySocket's. The demo page opens both transports side by side into the
same room so you can watch one broadcast reach both.

## The third way: a raw Cap'n Web session

The same `RoomCallables` is also served natively at `?__agents_rpc=capnweb`.
There is no Agent protocol on this wire, just the methods. It is what a CLI
or another Worker uses:

```ts
import { newWebSocketRpcSession } from "capnweb";

const rpc = newWebSocketRpcSession<RoomApi>(
  "wss://<host>/agents/room-object/lobby?__agents_rpc=capnweb"
);
await rpc.say("cli", "hi");
console.log(await rpc.history());
```

Build the URL by hand in browser code. `callablesRpcUrl` from
`agents/websockets` is server-side and pulls Node modules into a bundle.

## What else the room shows

- **Hibernation.** Idle members stay connected while the object leaves
  memory. Anything a later wake needs about a connection goes through
  `connection.setState()`; the `whoami` frame reads it back.
- **Tags.** `getConnectionTags` runs once at accept time and stays queryable
  through `getConnections(tag)` after any wake. `/members?nick=` resolves
  members by tag.
- **Pushing from outside a handler.** `POST /say` broadcasts from an HTTP
  request, the shape a webhook or scheduled job takes to reach clients.
- **One validation path.** Every write — socket frame, callable, HTTP —
  goes through `post()`, so nickname and message bounds apply everywhere.
- **`identity: false`** turns the identity frame off for hosts that speak
  their own protocol. `Agent` passes it.

This is a demo: anyone who knows a room name can join it. Put
authentication in front of `routeAgentRequest` before deploying something
like it.

## Run

```sh
pnpm install
pnpm run start
```

Open the page with `?room=lobby&nick=alice`. Over HTTP:

```sh
curl http://localhost:8787/agents/room-object/lobby/history
curl 'http://localhost:8787/agents/room-object/lobby/members?nick=alice@websocket'
curl -X POST http://localhost:8787/agents/room-object/lobby/say \
  -H "content-type: application/json" -d '{"text": "deploy finished", "nick": "ci"}'
```

## Test

```sh
pnpm test
```

The suite drives hibernating sockets, the Cap'n Web transport pipe, rpc
frames including a streamed result, and a native Cap'n Web session against
the worker in the Workers vitest pool.
