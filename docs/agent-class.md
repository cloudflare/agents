# Demystifying the Agent class

The core of the `agents` library is the exported `Agent` class. Following the pattern from [Durable Objects](https://developers.cloudflare.com/durable-objects/api/), the main API for developers is to extend the `Agent` so those classes inherit all the built-in features. While this effectively is a supercharged primitive that allows developers to only write the logic they need in their agents, it obscures the inner workings.

This document tries to bridge that gap, empowering any developer aiming to get started writing agents to get the full picture and avoid common pitfalls. The snippets shown here are primarily illustrative and don't necessarily represent best practices. For a more in-depth look at the inner workings of the `Agent` class, check out the [API reference](https://developers.cloudflare.com/agents/api-reference/) and the [source code](https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts).

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

1. While the constructor is called every time the DO is initialized, the signature is fixed. Developers **can't add or update parameters from the constructor**.
2. Instead of instantiating the class manually, developers must use the binding APIs and do it through the [DurableObjectNamespace](https://developers.cloudflare.com/durable-objects/api/namespace/).

### RPC

By writing a Durable Object class which inherits from the built-in type `DurableObject`, public methods are exposed as RPC methods, which developers can call using a [DurableObjectStub from a Worker](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/#invoking-methods-on-a-durable-object).

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

Durable Objects include first-class support for [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). A DO can accept a WebSocket it receives from a `Request` in `fetch` and forget about it. The base class provides methods that developers can implement that are called as callbacks. They effectively replace the need for event listeners.

The base class provides `webSocketMessage(ws, message)`, `webSocketClose(ws, code, reason, wasClean)` and `webSocketError(ws , error)` ([API](https://developers.cloudflare.com/workers/runtime-apis/websockets)).

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

### `alarm()`

HTTP and RPC requests are not the only entrypoints for a DO. Alarms allow developers to schedule an event to trigger at a later time. Whenever the next alarm is due, the runtime will call the `alarm()` method, which is left to the developer to implement.

To schedule an alarm, you can use the `this.ctx.storage.setAlarm()` method. For more information, check [the documentation](https://developers.cloudflare.com/durable-objects/api/alarms/).

### `this.ctx`

The base `DurableObject` class sets the [DurableObjectState](https://developers.cloudflare.com/durable-objects/api/state/) into `this.ctx`. There are a lot of interesting methods and properties, but we'll focus on `this.ctx.storage`.

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

Lastly, it's worth mentioning that the DO also has the Worker `Env` in `this.env`. Read more [here](https://developers.cloudflare.com/workers/runtime-apis/bindings).

## Layer 1: Partykit `Server`

Now that you've seen what Durable Objects come with out-of-the-box, what [PartyKit](https://github.com/cloudflare/partykit)'s `Server` (package `partyserver`) implements will be clearer. It's an **opinionated `DurableObject` wrapper that improves DX by hiding away DO primitives in favor of more developer friendly callbacks**.

An important note is that `Server` **does NOT persist to the DO storage** so you will not see extra storage operations by using it.

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

    return Response("Not found", { status: 404 });
  }
```

You can have a look at [the implementation](https://github.com/cloudflare/partykit/blob/main/packages/partyserver/src/index.ts#L122) if you're interested.

### `onStart`

The extra plumbing that `Server` includes on addressing allows it to expose an `onStart` callback that is **executed every time the DO starts up** (the DO was evicted, hibernated or never created at all) and **before any `fetch` or RPC**.

```ts
class MyServer extends Server {
  onStart() {
    // Some initialization logic that you wish
    // to run every time the DO is started up.
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

Just as `onConnect` is the callback for every new connection, `Server` also provides wrappers on top of the default callbacks from the `DurableObject` class: `onMessage`, `onClose` and `onError`.

There's also `this.broadcast` that sends a WS message to all connected clients (no magic, just a loop over `this.getConnections()`!).

### `this.name`

It's hard to get a Durable Object's `name` from within it. `partyserver` tries to make it available in `this.name` but it's not a perfect solution. Read more about it [here](https://github.com/cloudflare/workerd/issues/2240).

## Layer 2: Agent

Now finally, the `Agent` class. `Agent` extends `Server` and provides opinionated primitives for stateful, schedulable, and observable agents that can communicate via RPC, WebSockets, and (even!) email.

### `this.state` and `this.setState()`

One of the core features of `Agent` is **automatic state persistence**. Developers define the shape of their state via the generic parameter and `initialState` (which is only used if no state exists in storage), and the Agent handles loading, saving, and broadcasting state changes (check `Server`'s `this.broadcast()` above).

`this.state` is a getter that lazily loads state from storage (SQL). **State is persisted across DO evictions** when it's updated with `this.setState()`, which automatically serializes the state and writes it back to storage.  
There's also `this.onStateUpdate` that you can override to react to state changes.

```ts
class MyAgent extends Agent<Env, { count: number }> {
  initialState = { count: 0 };

  increment() {
    this.setState({ count: this.state.count + 1 });
  }

  onStateUpdate(state, source) {
    console.log("State updated:", state);
  }
}
```

State is stored in the `cf_agents_state` SQL table. State messages are sent with `type: "cf_agent_state"` (both from the client and the server). Since the `agents` provides [JS and React clients](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/#synchronizing-state), real-time state updates are available out of the box.

### `this.sql`

The Agent provides a convenient `sql` template tag for executing queries against the Durable Object's SQL storage. It constructs parameterized queries and executes them. This uses the **synchronous** SQL API from `this.ctx.storage.sql`.

```ts
class MyAgent extends Agent {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT
      )
    `;

    const userId = "1";
    const userName = "Alice";
    this.sql`INSERT INTO users (id, name) VALUES (${userId}, ${userName})`;

    const users = this.sql<{ id: string; name: string }>`
      SELECT * FROM users WHERE id = ${userId}
    `;
    console.log(users); // [{ id: "1", name: "Alice" }]
  }
}
```

### RPC and Callable Methods

`agents` take Durable Objects RPC one step forward by implementing RPC through WebSockets, so clients can also call methods on the Agent directly. To make a method callable through WS, developers can use the `@callable` decorator. Methods can return a serializable value or a stream (when using `@callable({ stream: true })`).

```ts
class MyAgent extends Agent {
  @callable({ description: "Add two numbers" })
  async add(a: number, b: number) {
    return a + b;
  }
}
```

Clients can invoke this method by sending a WebSocket message:

```json
{
  "type": "rpc",
  "id": "unique-request-id",
  "method": "add",
  "args": [2, 3]
}
```

For example, with the provided `React` client it's as easy as:

```ts
const { stub } = useAgent({ name: "my-agent" });
const result = await stub.add(2, 3);
console.log(result); // 5
```

### `this.queue` and friends

Agents include a built-in task queue for deferred execution. This is useful for offloading work or retrying operations. The available methods are `this.queue`, `this.dequeue`, `this.dequeueAll`, `this.dequeueAllByCallback`, `this.getQueue`, and `this.getQueues`.

```ts
class MyAgent extends Agent {
  async onConnect() {
    // Queue a task to be executed later
    await this.queue("processTask", { userId: "123" });
  }

  async processTask(payload: { userId: string }, queueItem: QueueItem) {
    console.log("Processing task for user:", payload.userId);
  }
}
```

Tasks are stored in the `cf_agents_queues` SQL table and are automatically flushed in sequence. If a task succeeds, it's automatically dequeued.

### `this.schedule` and friends

Agents support scheduled execution of methods by wrapping the Durable Object's `alarm()`. The available methods are `this.schedule`, `this.getSchedule`, `this.getSchedules`, `this.cancelSchedule`. Schedules can be one-time, delayed, or recurring (using cron expressions).

Since DOs only allow one alarm at a time, the `Agent` class works around this by managing multiple schedules in SQL and using a single alarm.

```ts
class MyAgent extends Agent {
  async foo() {
    // Schedule at a specific time
    await this.schedule(new Date("2025-12-25T00:00:00Z"), "sendGreeting", {
      message: "Merry Christmas!"
    });

    // Schedule with a delay (in seconds)
    await this.schedule(60, "checkStatus", { check: "health" });

    // Schedule with a cron expression
    await this.schedule("0 0 * * *", "dailyTask", { type: "cleanup" });
  }

  async sendGreeting(payload: { message: string }) {
    console.log(payload.message);
  }

  async checkStatus(payload: { check: string }) {
    console.log("Running check:", payload.check);
  }

  async dailyTask(payload: { type: string }) {
    console.log("Daily task:", payload.type);
  }
}
```

Schedules are stored in the `cf_agents_schedules` SQL table. Cron schedules automatically reschedule themselves after execution, while one-time schedules are deleted.

### `this.mcp` and friends

`Agent` includes a multi-server MCP client. This enables your Agent to interact with external services that expose MCP interfaces. The MCP client is properly documented [here](https://developers.cloudflare.com/agents/model-context-protocol/mcp-client-api/).

```ts
class MyAgent extends Agent {
  async onConnect() {
    // Add an MCP server
    await this.addMcpServer(
      "GitHub",
      "https://mcp.example.com/sse",
      "https://my-worker.example.workers.dev", // callback host for OAuth
      "agents" // routing prefix
    );
  }
}
```

### Email Handling

Agents can receive and reply to emails using Cloudflare's [Email Routing](https://developers.cloudflare.com/email-routing/email-workers/).

```ts
class MyAgent extends Agent {
  async onEmail(email: AgentEmail) {
    console.log("Received email from:", email.from);
    console.log("Subject:", email.headers.get("subject"));

    const raw = await email.getRaw();
    console.log("Raw email size:", raw.length);

    // Reply to the email
    await this.replyToEmail(email, {
      fromName: "My Agent",
      subject: "Re: " + email.headers.get("subject"),
      body: "Thanks for your email!",
      contentType: "text/plain"
    });
  }
}
```

To route emails to your Agent, use `routeAgentEmail` in your Worker's email handler:

```ts
export default {
  async email(message, env, ctx) {
    await routeAgentEmail(message, env, {
      resolver: createAddressBasedEmailResolver("my-agent")
    });
  }
};
```

### Context Management

`agents` wraps all your methods with an `AsyncLocalStorage` to maintain context throughout the request lifecycle. This allows you to access the current agent, connection, request, or email (depending of what event is being handled) from anywhere in your code:

```ts
import { getCurrentAgent } from "agents";

function someUtilityFunction() {
  const { agent, connection, request, email } = getCurrentAgent();

  if (agent) {
    console.log("Current agent:", agent.name);
  }

  if (connection) {
    console.log("WebSocket connection ID:", connection.id);
  }
}
```

### `this.onError`

`Agent` extends `Server`'s `onError` so it can be used to handle errors that are not necessarily WebSocket errors. It is called with a `Connection` or `unknown` error.

```ts
class MyAgent extends Agent {
  onError(connectionOrError: Connection | unknown, error?: unknown) {
    if (error) {
      // WebSocket connection error
      console.error("Connection error:", error);
    } else {
      // Server error
      console.error("Server error:", connectionOrError);
    }

    // Optionally throw to propagate the error
    throw connectionOrError;
  }
}
```

### `this.destroy`

`this.destroy()` drops all tables, deletes alarms, clears storage, and aborts the context. To ensure that the DO is fully evicted, `this.ctx.abort()` is called, which throws an uncatchable error that will show up in your logs (read more about it [here](https://developers.cloudflare.com/durable-objects/api/state/#abort)).

```ts
class MyAgent extends Agent {
  async onStart() {
    console.log("Agent is starting up...");
    // Initialize your agent
  }

  async cleanup() {
    // This wipes everything!
    await this.destroy();
  }
}
```

### Routing

The `Agent` class re-exports PartyKit's [addressing helpers](#addressing) as `getAgentByName` and `routeAgentRequest`.

```ts
// Same API as getServerByName
const stub = await getAgentByName(env.MY_DO, "foo");
// ...

// Same API as routeServerRequest
const res = await routeAgentRequest(request, env);

if (res) return res;

return Response("Not found", { status: 404 });
```
