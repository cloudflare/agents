# Demystifying the Agent class

The core of the `agents` library is the exported `Agent` class. Following the pattern from [Durable Objects](https://developers.cloudflare.com/durable-objects/api/), the main API for developers is to extend the `Agent` so those classes inherit all the built-in features. While this effectively is a supercharged primitive that allows developers to only write the logic they need in their agents, it obscures the inner workings.

This document tries to bridge that gap, empowering any developer aiming to get started writing agents to get the full picture and avoid common pitfalls. The snippets shown here are primarily illustrative and don't necessarily represent best practices. For a more in-depth look at the inner workings of the `Agent` class, check out the [API reference](https://developers.cloudflare.com/agents/api-reference/) and the [source code](https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts).

# What is the Agent?

`Agent` directly extends Cloudflare's `DurableObject`, so every Agent is a globally addressable, single-threaded compute instance with durable KV/SQLite storage. If you are unfamiliar with the platform primitive, start with [What are Durable Objects](https://developers.cloudflare.com/durable-objects/).

Each Agent composes a `Lifecycle` instance. The lifecycle installs request, alarm, and hibernating WebSocket entry points while the Agent supplies semantic callbacks and higher-level features:

```text
DurableObject
└── Agent
    └── owns Lifecycle
```

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

### Alarms

`Lifecycle` owns the Agent's physical Durable Object alarm because schedules, keep-alive, fibers, sub-agents, and other capabilities share the same alarm slot. Do not override `alarm()` or call `this.ctx.storage.setAlarm()` from an Agent feature; one caller could overwrite another feature's wake-up.

Use `this.schedule()` for named Agent callbacks. A reusable capability with its own durable work implements `getNextAlarm()` and `onAlarm()`, then calls `this.lifecycle.alarms.rearm()` after its durable state changes. See [Durable Object lifecycle](./lifecycle.md#shared-alarm-ownership) and [Scheduling](./scheduling.md).

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

## Layer 1: lifecycle composition

`Agent` uses `Lifecycle.install(this)`, an explicit side-effect-named factory that constructs the lifecycle and installs the platform-facing `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`, and `webSocketError` handlers. Agent subclasses implement semantic callbacks instead of a second base class:

```ts
class MyAgent extends Agent {
  onStart() {
    // Runs once per in-memory lifetime before work is handled.
  }

  onRequest(request: Request) {
    return new Response(`Hello from ${request.url}`);
  }

  onConnect(connection: Connection) {
    connection.send("connected");
  }
}
```

Lifecycle WebSockets always use Cloudflare's Hibernation API. Idle clients stay connected while the Durable Object can leave memory; constructor fields and `onStart` run again when a message wakes it. Persist anything needed across wakes in storage or `connection.state`.

Reusable capabilities can be installed through `this.lifecycle.use(capability)`. Capabilities start before Agent startup, can intercept requests before `onRequest`, and process alarms before `onAlarm`. See [Durable Object lifecycle](./lifecycle.md).

### Identity

Since [2026-03-15](https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/), Workers exposes the name used by `idFromName()` or `getByName()` as `ctx.id.name`, including in alarm handlers. Agents and Agent facets use named IDs, and `this.name` projects that native identity.

For migration, lifecycle can read an existing `__ps_name` value written by an older release. It never writes a duplicate name. Raw IDs, `idFromString()`, and names over 1,024 bytes do not provide native identity. Alarms created before 2026-03-15 must be rescheduled from a named fetch or RPC handler.

## Layer 2: Agent

The `Agent` class directly extends `DurableObject`, composes the lifecycle above, and provides opinionated primitives for stateful, schedulable, and observable agents that can communicate via RPC, WebSockets, and (even!) email.

### `this.state` and `this.setState()`

One of the core features of `Agent` is **automatic state persistence**. Developers define the shape of their state via the generic parameter and `initialState` (which is only used if no state exists in storage), and the Agent handles loading, saving, and broadcasting state changes (using its lifecycle-managed WebSocket connections).

`this.state` is a getter that lazily loads state from storage (SQL). **State is persisted across DO evictions** when it's updated with `this.setState()`, which automatically serializes the state and writes it back to storage.  
There's also `this.onStateChanged` that you can override to react to state changes.

```ts
class MyAgent extends Agent<Env, { count: number }> {
  initialState = { count: 0 };

  increment() {
    this.setState({ count: this.state.count + 1 });
  }

  onStateChanged(state, source) {
    console.log("State updated:", state);
  }
}
```

State is stored in the `cf_agents_state` SQL table. State messages are sent with `type: "cf_agent_state"` (both from the client and the server). Since the `agents` provides [JS and React clients](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/#synchronizing-state), real-time state updates are available out of the box.

Protocol messages (`CF_AGENT_IDENTITY`, `CF_AGENT_STATE`, `CF_AGENT_MCP_SERVERS`) are sent automatically on connect and broadcast on changes. You can suppress these per connection by overriding `shouldSendProtocolMessages(connection, ctx)` — see [Protocol Message Control](./http-websockets.md#protocol-message-control) for details.

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

`agents` take Durable Objects RPC one step forward by implementing RPC through WebSockets, so clients can also call methods on the Agent directly. To make a method callable through WS, developers can use the `@callable` decorator. Methods can return a serializable value or stream chunks (when using `@callable({ streaming: true })`).

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

Agents support scheduled execution of methods by wrapping the Durable Object's `alarm()`. The available methods are `this.schedule`, `this.getScheduleById`, `this.listSchedules`, `this.cancelSchedule`, and the deprecated synchronous `this.getSchedule` / `this.getSchedules`. Schedules can be one-time, delayed, or recurring (using cron expressions).

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
    await this.addMcpServer("GitHub", "https://mcp.example.com/sse");
  }
}
```

### Email Handling

Agents can send and receive emails using Cloudflare's [Email Service](https://developers.cloudflare.com/email-service/).

Use `this.sendEmail()` with your `send_email` binding for outbound email:

```ts
class MyAgent extends Agent {
  @callable()
  async sendWelcome(to: string) {
    return this.sendEmail({
      binding: this.env.EMAIL,
      to,
      from: "support@yourdomain.com",
      subject: "Welcome!",
      text: "Thanks for signing up."
    });
  }

  async onEmail(email: AgentEmail) {
    console.log("Received email from:", email.from);
    console.log("Subject:", email.headers.get("subject"));

    await this.replyToEmail(email, {
      fromName: "My Agent",
      body: "Thanks for your email!"
    });
  }
}
```

To route emails to your Agent, use `routeAgentEmail` in your Worker's email handler:

```ts
import { routeAgentEmail } from "agents";
import { createAddressBasedEmailResolver } from "agents/email";

export default {
  async email(message, env, ctx) {
    await routeAgentEmail(message, env, {
      resolver: createAddressBasedEmailResolver("my-agent")
    });
  }
};
```

For more details on `sendEmail()`, routing inbound mail, resolvers, and secure reply flows, see the [Email Service guide](./email.md).

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

`Agent.onError` handles both WebSocket errors and other Agent errors. It is called with a `Connection` or `unknown` error.

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

### `this.keepAlive`

`this.keepAlive()` prevents the Durable Object from being evicted due to inactivity by holding an alarm-backed heartbeat ref. Returns a disposer function to stop the heartbeat. For scoped work, use `this.keepAliveWhile(fn)` which automatically cleans up when the function completes. See [Keeping the Agent Alive](./scheduling.md#keeping-the-agent-alive) for full documentation.

### `this.runFiber` and `this.startFiber`

`this.runFiber()` runs checkpointable work with crash recovery. `this.startFiber()` durably accepts background work with idempotency, status inspection, cancellation, and retained terminal records.

```ts
const receipt = await this.startFiber(
  "process-webhook",
  async (ctx) => {
    ctx.stash({ webhookId });
    await processWebhook(webhookId, { signal: ctx.signal });
  },
  { idempotencyKey: `webhook:${webhookId}`, waitForCompletion: true }
);

const current = await this.inspectFiber(receipt.fiberId);
await this.cancelFiber(receipt.fiberId, "Superseded");
if (current?.status === "interrupted") {
  await this.resolveFiber(receipt.fiberId, { status: "completed" });
}
await this.deleteFibers({
  status: ["completed", "error", "aborted"],
  settledBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
});
```

Use `runFiber()` when the caller waits for the result. Use `startFiber()` when
the caller needs an immediate durable receipt and may retry with the same
idempotency key. Add `waitForCompletion: true` when the caller should wait for
the accepted job to reach a terminal status while still deduping retries. Use
`onFiberRecovered()` to decide what an interrupted managed fiber means for your
application; return a recovery result to update the retained status record.
`resolveFiber()` is for externally resolving `interrupted` rows only.

### Routing

Use `getAgentByName` for named RPC stubs and `routeAgentRequest` for `/agents/:class/:name` HTTP and WebSocket routing.

```ts
const stub = await getAgentByName(env.MY_DO, "foo");
// ...

const res = await routeAgentRequest(request, env);

if (res) return res;

return Response("Not found", { status: 404 });
```
