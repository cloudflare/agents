# Demistifying the Agent class

The core of the `agents` library is the exported `Agent` class. Following the pattern from Durable Objects, the main API for developers is to extend the `Agent` so those classes inherit all the built-in features. While this effectively is a supercharged primitive that allows developers to only write the logic they need in their agents, it obscures the inner workings.

This document tries to bridge that gap, empowering any developer aiming to get started writing agents to get the full picture and avoid common pitfalls. The snippets shown here are primarily illustrative and don't necessarily represent best practices.

# What is the Agent?

The `Agent` class is an extension of `DurableObject`. That is to say, they _are_ **Durable Objects**. If you're not familiar with Durable Objects, it is highly recommended that you read ["What are Durable Objects"](https://developers.cloudflare.com/durable-objects/) but at their core, Durable Objects are globally addressable (each instance has a unique ID) single-threaded compute instances with long term storage (KV/SQLite).  
That being said, `Agent` does **not** extend `DurableObject` directly but instead `Server`. `Server` is a class provided by [PartyKit](https://github.com/cloudflare/partykit/tree/main/packages/partyserver).

You can visualize the logic as a Matryoshka doll: **DurableObject** -> **Server** -> **Agent**.

## Layer 0: Durable Object

This won't cover Durable Objects in detail, but it's good to know what primitives they expose so we understand how the outer layers make use of them. The Durable Object class comes with:

### `constructor`

```ts
constructor(ctx: DurableObjectState, env: Env) {}
```

The Workers runtime always calls the constructor to handle things internally. This means 2 things:

1. While the constructor is called every time the DO is initalized, the signature is fixed. Developers **can't add or update parameters from the constructor**.
2. Insted of instantiating the class manually, developers must use the binding APIs and do it through the [DurableObjectNamespace](https://developers.cloudflare.com/durable-objects/api/namespace/).

### RPC

By writing a Durable Object class which inherits from the built-in type DurableObject, public methods on the Durable Objects class are exposed as RPC methods, which developers can call using a DurableObjectStub from a Worker.

```ts
// This instance could've been active, hibernated,
// not initialized or maybe had never even been created!
const stub = env.MY_DO.getByName("foo");

// We can call any public method of the class since. The runtime
// **ensures** the constructor is called for us if the instance wasn't active.
await stub.bar();
```

### `fetch()`

Durable Objects can take a `Request` from a Worker and send a `Response` back. This can **only** be done through the [`fetch`](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/#invoking-the-fetch-handler) method (which the developer must implement).

### WebSockets

Durable Objects include first-class support for [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). A DO can accept a WebSocket it receives from a `Request` in `fetch` and forget about it. The base class provides methods that developers can implement that are called as call backs. They effectively replace the need for event listeners.

The base class provides `webSocketMessage(ws, message)`, `webSocketClose(ws, code, reason, wasClean)` and `webSocketError(ws , error)`.

```ts
export class MyDurableObject extends DurableObject {
  async fetch(request) {
    // Creates two ends of a WebSocket connection.
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Calling `acceptWebSocket()` connects the WebSocket to the Durable Object, allowing the WebSocket to send and receive messages.
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    // echo back the messages
    ws.send(msg);
  }
}
```

### `this.ctx`

The base `DurableObject` class sets the [DurableObjectState](https://developers.cloudflare.com/durable-objects/api/state/) into `this.ctx`. There are a lot of interesting methods and properites, but we'll focus on `this.ctx.storage`.

### `this.ctx.storage`

[DurableObjectStorage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) is the main interface with the DO's persistence mechanisms, which include both a KV and SQLITE **synchronous** APIs.

```ts
const sql = this.ctx.storage.sql;
const kv = this.ctx.storage.kv;

// An example of a synchronous SQL query
const rows = sql.exec("SELECT * FROM contacts WHERE country = ?", "US");

// And an example of the synchronous KV
const token = kv.get("someToken");
```

### `this.ctx.env`

Lastly, it's worth mentioning that the DO also has the Worker `Env` in `this.env`.

## Layer 1: Partykit `Server`

Now that you've seen what Durable Objects come with out-of-the-box, what [PartyKit](https://github.com/cloudflare/partykit)'s `Server` (package `partyserver`) implements will be clearer. It's an **opinionated `DurableObject` wrapper that improves DX by hiding away DO pritmives in favor of more developer friendly callbacks**.

An important note is that `Server` **does NOT make use any of the DO storage** so you will not see extra operations.

### Addressing

`partyserver` exposes helper to address your DOs instead of manually through your bindings. This allows `partyserver` to implement several improvements, including a unique URL routing scheme for your DOs (e.g. `<your-worker>/servers/:durableClass/:durableName`).

Compare this to the DO addressing [example above](#RPC).

```ts
// Note the await here!
const stub = await getServerByName(env.MY_DO, "foo");

// We can still call RPC methods.
await stub.bar();
```

Since we have a URL addressing scheme, we also get access to `routePartykitRequest()`.

```ts
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Behind the scenes, PartyKit normalizes your DO binding names
    // and tries to do some pattern matching.
    const res = await routePartykitRequest(request, env);

    if (res) return res;

    return Respones("Not found", { status: 404 });
  }
```

You can have a look at [the implementation](https://github.com/cloudflare/partykit/blob/main/packages/partyserver/src/index.ts#L122) if you're interested.

### `onStart`

The extra plumbing that `Server` includes on addressing allows it to expose an `onStart` callback that is **executed everytime the DO starts up** (the DO was evicted, hibernated or never created at all) and **before any `fetch` or RPC**.

```ts
class MyServer extends Server {
  onStart() {
    // Some initialization logic that you wish
    // to run everytime the DO is started up.
    const sql = this.ctx.storage.sql;
    sql.exec(`...`);
  }
}
```

### `onRequest` and `onConnect`

`Server` already implements `fetch` for the underlying Durable Object and exposes 2 different callbacks that developers can make use of, `onRequest` and `onConnect` for HTTP requests and incoming WS connections, respectively (**WebSocket connections are accepted by default**).

```ts
class MyServer extends Server {
  async onRequest(request: Request) {
    const url = new URL(request.url);

    return new Response(`Hello from ${url.origin}!`);
  }

  async onConnect(conn, ctx) {
    const { request } = ctx;
    const url = new URL(request.url);

    // Connections are a WebSocket wrapper
    conn.send(`Hello from ${url.origin}!`);
  }
}
```

### WebSockets

Just as `onConnect` is the callback for every new conneciton, `Server` also provides wrappers on top of the default callbacks from teh `DurableObject` class: `onMessage`, `onClose` and `onError`.

There's also `this.broadcast` that sends a WS message to all connected clients (no magic, just a loop over `this.getConnections()`!).

### `this.name`

It's hard to get a Durable Object's `name` from within it. `partyserver` tries to make it available in `this.name` but it's not a perfect solution. Read more about it [here](https://github.com/cloudflare/workerd/issues/2240).

## Layer 2: Agent
