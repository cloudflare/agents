# Observability

Agents emit structured events for every significant operation — RPC calls, state changes, schedule execution, workflow transitions, MCP connections, and more. These events are published to [diagnostics channels](https://developers.cloudflare.com/workers/runtime-apis/nodejs/diagnostics-channel/) and are silent by default (zero overhead when nobody is listening).

## Event structure

Every event has three fields:

```ts
{
  type: "rpc",                        // what happened
  payload: { method: "getWeather" },  // details
  timestamp: 1758005142787            // when (ms since epoch)
}
```

## Channels

Events are routed to seven named channels based on their type:

| Channel            | Event types                                                                                                                                                      | Description                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `agents:state`     | `state:update`                                                                                                                                                   | State sync events                   |
| `agents:rpc`       | `rpc`, `rpc:error`                                                                                                                                               | RPC method calls and failures       |
| `agents:message`   | `message:request`, `message:response`, `message:clear`, `message:cancel`, `message:error`, `tool:result`, `tool:approval`                                        | Chat message and tool lifecycle     |
| `agents:schedule`  | `schedule:create`, `schedule:execute`, `schedule:cancel`, `schedule:retry`, `schedule:error`, `queue:retry`, `queue:error`                                       | Scheduled and queued task lifecycle |
| `agents:lifecycle` | `connect`, `destroy`                                                                                                                                             | Agent connection and teardown       |
| `agents:workflow`  | `workflow:start`, `workflow:event`, `workflow:approved`, `workflow:rejected`, `workflow:terminated`, `workflow:paused`, `workflow:resumed`, `workflow:restarted` | Workflow state transitions          |
| `agents:mcp`       | `mcp:client:preconnect`, `mcp:client:connect`, `mcp:client:authorize`, `mcp:client:discover`                                                                     | MCP client operations               |

## Subscribing to events

### Typed subscribe helper

The `subscribe()` function from `agents/observability` provides type-safe access to events on a specific channel:

```ts
import { subscribe } from "agents/observability";

const unsub = subscribe("rpc", (event) => {
  if (event.type === "rpc") {
    console.log(`RPC call: ${event.payload.method}`);
  }
  if (event.type === "rpc:error") {
    console.error(
      `RPC failed: ${event.payload.method} — ${event.payload.error}`
    );
  }
});

// Clean up when done
unsub();
```

The callback is fully typed — `event` is narrowed to only the event types that flow through that channel.

### Raw diagnostics_channel

You can also subscribe directly using the Node.js API:

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("agents:schedule", (event) => {
  console.log(event);
});
```

## Tail Workers (production)

In production, all diagnostics channel messages are automatically forwarded to [Tail Workers](https://developers.cloudflare.com/workers/observability/tail-workers/). No subscription code is needed in the agent itself — attach a Tail Worker and access events via `event.diagnosticsChannelEvents`:

```ts
export default {
  async tail(events) {
    for (const event of events) {
      for (const msg of event.diagnosticsChannelEvents) {
        // msg.channel is "agents:rpc", "agents:workflow", etc.
        // msg.message is the typed event payload
        console.log(msg.timestamp, msg.channel, msg.message);
      }
    }
  }
};
```

This gives you structured, filterable observability in production with zero overhead in the agent hot path.

## Custom observability

You can override the default implementation by providing your own `Observability` interface:

```ts
import { Agent } from "agents";
import type { Observability } from "agents/observability";

const myObservability: Observability = {
  emit(event) {
    // Send to your logging service, filter events, etc.
    if (event.type === "rpc:error") {
      myLogger.error(event.payload.method, event.payload.error);
    }
  }
};

class MyAgent extends Agent {
  override observability = myObservability;
}
```

Set `observability` to `undefined` to disable all event emission:

```ts
class MyAgent extends Agent {
  override observability = undefined;
}
```

## Event reference

### RPC events

| Type        | Payload                  | When                            |
| ----------- | ------------------------ | ------------------------------- |
| `rpc`       | `{ method, streaming? }` | A `@callable` method is invoked |
| `rpc:error` | `{ method, error }`      | A `@callable` method throws     |

### State events

| Type           | Payload | When                   |
| -------------- | ------- | ---------------------- |
| `state:update` | `{}`    | `setState()` is called |

### Message and tool events (`AIChatAgent`)

These events are emitted by `AIChatAgent` from `@cloudflare/ai-chat`. They track the chat message lifecycle, including client-side tool interactions.

| Type               | Payload                    | When                                |
| ------------------ | -------------------------- | ----------------------------------- |
| `message:request`  | `{}`                       | A chat message is received          |
| `message:response` | `{}`                       | A chat response stream completes    |
| `message:clear`    | `{}`                       | Chat history is cleared             |
| `message:cancel`   | `{ requestId }`            | A streaming request is cancelled    |
| `message:error`    | `{ error }`                | A chat stream fails                 |
| `tool:result`      | `{ toolCallId, toolName }` | A client tool result is received    |
| `tool:approval`    | `{ toolCallId, approved }` | A tool call is approved or rejected |

### Schedule and queue events

| Type               | Payload                                  | When                                         |
| ------------------ | ---------------------------------------- | -------------------------------------------- |
| `schedule:create`  | `{ callback, id }`                       | A schedule is created                        |
| `schedule:execute` | `{ callback, id }`                       | A scheduled callback starts                  |
| `schedule:cancel`  | `{ callback, id }`                       | A schedule is cancelled                      |
| `schedule:retry`   | `{ callback, id, attempt, maxAttempts }` | A scheduled callback is retried              |
| `schedule:error`   | `{ callback, id, error, attempts }`      | A scheduled callback fails after all retries |
| `queue:retry`      | `{ callback, id, attempt, maxAttempts }` | A queued callback is retried                 |
| `queue:error`      | `{ callback, id, error, attempts }`      | A queued callback fails after all retries    |

### Lifecycle events

| Type      | Payload            | When                                  |
| --------- | ------------------ | ------------------------------------- |
| `connect` | `{ connectionId }` | A WebSocket connection is established |
| `destroy` | `{}`               | The agent is destroyed                |

### Workflow events

| Type                  | Payload                         | When                           |
| --------------------- | ------------------------------- | ------------------------------ |
| `workflow:start`      | `{ workflowId, workflowName? }` | A workflow instance is started |
| `workflow:event`      | `{ workflowId, eventType? }`    | An event is sent to a workflow |
| `workflow:approved`   | `{ workflowId, reason? }`       | A workflow is approved         |
| `workflow:rejected`   | `{ workflowId, reason? }`       | A workflow is rejected         |
| `workflow:terminated` | `{ workflowId, workflowName? }` | A workflow is terminated       |
| `workflow:paused`     | `{ workflowId, workflowName? }` | A workflow is paused           |
| `workflow:resumed`    | `{ workflowId, workflowName? }` | A workflow is resumed          |
| `workflow:restarted`  | `{ workflowId, workflowName? }` | A workflow is restarted        |

### MCP events

| Type                    | Payload                                 | When                                         |
| ----------------------- | --------------------------------------- | -------------------------------------------- |
| `mcp:client:preconnect` | `{ serverId }`                          | Before connecting to an MCP server           |
| `mcp:client:connect`    | `{ url, transport, state, error? }`     | An MCP connection attempt completes or fails |
| `mcp:client:authorize`  | `{ serverId, authUrl, clientId? }`      | An MCP OAuth flow begins                     |
| `mcp:client:discover`   | `{ url?, state?, error?, capability? }` | MCP capability discovery succeeds or fails   |
