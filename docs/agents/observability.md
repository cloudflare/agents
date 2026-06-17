# Observability

Agents emit structured events for every significant operation — RPC calls, state changes, schedule execution, workflow transitions, MCP connections, and more. These events are published to [diagnostics channels](https://developers.cloudflare.com/workers/runtime-apis/nodejs/diagnostics-channel/) and are silent by default (zero overhead when nobody is listening).

## Event structure

Every event has these fields:

```ts
{
  type: "rpc",                        // what happened
  agent: "MyAgent",                   // which agent class emitted it
  name: "user-123",                   // which agent instance (Durable Object name)
  payload: { method: "getWeather" },  // details
  timestamp: 1758005142787            // when (ms since epoch)
}
```

`agent` and `name` identify the source agent — `agent` is the class name and `name` is the Durable Object instance name.

## Channels

Events are routed to named channels based on their type:

| Channel             | Event types                                                                                                                                                              | Description                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `agents:state`      | `state:update`                                                                                                                                                           | State sync events                                                      |
| `agents:rpc`        | `rpc`, `rpc:error`                                                                                                                                                       | RPC method calls and failures                                          |
| `agents:message`    | `message:request`, `message:response`, `message:clear`, `message:cancel`, `message:error`, `tool:result`, `tool:approval`                                                | Chat message and tool lifecycle                                        |
| `agents:chat`       | `chat:request:failed`, `chat:recovery:*`, `chat:stream:stalled`, `chat:context:compacted`                                                                                | Chat request, recovery, stream-stall, and context-compaction lifecycle |
| `agents:transcript` | `chat:transcript:repaired`                                                                                                                                               | Transcript repair events                                               |
| `agents:fiber`      | `fiber:run:*`, `fiber:recovery:*`                                                                                                                                        | Durable fiber lifecycle                                                |
| `agents:agent_tool` | `agent_tool:recovery:*`                                                                                                                                                  | Parent/child agent-tool recovery                                       |
| `agents:schedule`   | `schedule:create`, `schedule:execute`, `schedule:cancel`, `schedule:retry`, `schedule:error`, `schedule:duplicate_warning`, `queue:create`, `queue:retry`, `queue:error` | Scheduled and queued task lifecycle                                    |
| `agents:lifecycle`  | `connect`, `disconnect`, `destroy`                                                                                                                                       | Agent connection and teardown                                          |
| `agents:workflow`   | `workflow:start`, `workflow:event`, `workflow:approved`, `workflow:rejected`, `workflow:terminated`, `workflow:paused`, `workflow:resumed`, `workflow:restarted`         | Workflow state transitions                                             |
| `agents:mcp`        | `mcp:client:preconnect`, `mcp:client:connect`, `mcp:client:authorize`, `mcp:client:discover`, `mcp:client:close`                                                         | MCP client operations                                                  |
| `agents:email`      | `email:receive`, `email:reply`                                                                                                                                           | Email processing                                                       |

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

The typed helper uses camelCase keys, so agent-tool recovery is `subscribe("agentTool", ...)`. Raw diagnostics channel subscribers should use the emitted channel name, `agents:agent_tool`.

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

### Chat recovery events

| Type                      | Payload                                                                  | When                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:request:failed`     | `{ requestId?, stage, messagesPersisted?, error }`                       | A Think chat request fails while parsing, persisting, running, or streaming                                                                                                                                                                                                                                                               |
| `chat:recovery:detected`  | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | An interrupted chat fiber is first observed                                                                                                                                                                                                                                                                                               |
| `chat:recovery:attempt`   | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | The framework begins a recovery attempt                                                                                                                                                                                                                                                                                                   |
| `chat:recovery:scheduled` | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | A retry or continuation callback is scheduled                                                                                                                                                                                                                                                                                             |
| `chat:recovery:completed` | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | Recovery completed successfully                                                                                                                                                                                                                                                                                                           |
| `chat:recovery:skipped`   | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind, reason? }` | Recovery was skipped because the conversation changed or was no longer recoverable                                                                                                                                                                                                                                                        |
| `chat:recovery:failed`    | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind, reason? }` | Recovery ran but failed                                                                                                                                                                                                                                                                                                                   |
| `chat:recovery:exhausted` | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind, reason }`  | Recovery exceeded its configured attempt budget                                                                                                                                                                                                                                                                                           |
| `chat:stream:stalled`     | `{ requestId, timeoutMs }`                                               | The inactivity watchdog fired — no stream chunk arrived within `chatStreamStallTimeoutMs`. With `chatRecovery` on (the default) the turn then routes into bounded recovery (look for `chat:recovery:*`); with recovery off it terminalizes. See [Think configuration](https://github.com/cloudflare/agents/blob/main/docs/think/index.md) |

`recoveryKind` is `"retry"` when recovery replays an unanswered user turn and `"continue"` when it continues a partial assistant turn.

### Chat context events

| Type                     | Payload                                       | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:context:compacted` | `{ reason, shortened, requestId?, attempt? }` | Think compacted the session to handle a context-window overflow. `reason` is `"proactive"` (the `contextOverflow.proactive` guard fired before a step) or `"reactive"` (`contextOverflow.reactive` fired after an overflow). `shortened` is whether compaction actually reduced history — `false` means a retry would overflow again. See [Context-window overflow recovery](https://github.com/cloudflare/agents/blob/main/docs/think/index.md#context-window-overflow-recovery). |

### Transcript events

| Type                       | Payload                                                            | When                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:transcript:repaired` | `{ requestId?, removedToolCalls, normalizedInputs, toolCallIds? }` | Think repairs a persisted transcript before sending it to the provider. `removedToolCalls` counts orphaned tool calls healed (preserved as errored results, not deleted); it also fires if an incomplete tool call survives repair and is dropped by the `ignoreIncompleteToolCalls` backstop. `normalizedInputs` counts stringified/missing tool inputs that were repaired. |

### Fiber events

| Type                      | Payload                                                                | When                                 |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `fiber:run:started`       | `{ fiberId, fiberName, managed? }`                                     | A durable fiber starts               |
| `fiber:run:completed`     | `{ fiberId, fiberName, managed?, elapsedMs? }`                         | A durable fiber completes            |
| `fiber:run:failed`        | `{ fiberId, fiberName, managed?, error, elapsedMs? }`                  | A durable fiber throws               |
| `fiber:run:interrupted`   | `{ fiberId, fiberName, managed?, recoveryReason, elapsedMs? }`         | Startup finds an interrupted fiber   |
| `fiber:recovery:detected` | `{ fiberId, fiberName, managed?, recoveryReason, elapsedMs? }`         | Recovery sees an interrupted fiber   |
| `fiber:recovery:attempt`  | `{ fiberId, fiberName, managed?, recoveryReason }`                     | A recovery hook starts               |
| `fiber:recovery:handled`  | `{ fiberId, fiberName, managed?, recoveryReason, status, elapsedMs? }` | Recovery handling completes          |
| `fiber:recovery:skipped`  | `{ fiberId, fiberName, managed?, reason, elapsedMs? }`                 | A recovery scan skips remaining work |
| `fiber:recovery:failed`   | `{ fiberId, fiberName, managed?, error, reason?, elapsedMs? }`         | A recovery hook fails                |

### Agent-tool recovery events

| Type                           | Payload                                             | When                                                         |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| `agent_tool:recovery:begin`    | `{ runCount, totalTimeoutMs? }`                     | Parent recovery starts scanning stale agent-tool runs        |
| `agent_tool:recovery:row`      | `{ runId, agentType, status, reason?, elapsedMs? }` | One stale run is reconciled                                  |
| `agent_tool:recovery:deadline` | `{ runId, agentType, elapsedMs? }`                  | Total recovery deadline is exhausted before inspecting a row |
| `agent_tool:recovery:complete` | `{ runCount, elapsedMs? }`                          | Parent recovery finishes scanning rows                       |
| `agent_tool:recovery:failed`   | `{ error }`                                         | Parent recovery fails unexpectedly                           |

### Schedule and queue events

| Type                         | Payload                                  | When                                         |
| ---------------------------- | ---------------------------------------- | -------------------------------------------- |
| `schedule:create`            | `{ callback, id }`                       | A schedule is created                        |
| `schedule:execute`           | `{ callback, id }`                       | A scheduled callback starts                  |
| `schedule:cancel`            | `{ callback, id }`                       | A schedule is cancelled                      |
| `schedule:retry`             | `{ callback, id, attempt, maxAttempts }` | A scheduled callback is retried              |
| `schedule:error`             | `{ callback, id, error, attempts }`      | A scheduled callback fails after all retries |
| `schedule:duplicate_warning` | `{ callback, count, type }`              | Duplicate schedules detected for a callback  |
| `queue:create`               | `{ callback, id }`                       | A task is enqueued                           |
| `queue:retry`                | `{ callback, id, attempt, maxAttempts }` | A queued callback is retried                 |
| `queue:error`                | `{ callback, id, error, attempts }`      | A queued callback fails after all retries    |

### Lifecycle events

| Type         | Payload                          | When                                  |
| ------------ | -------------------------------- | ------------------------------------- |
| `connect`    | `{ connectionId }`               | A WebSocket connection is established |
| `disconnect` | `{ connectionId, code, reason }` | A WebSocket connection is closed      |
| `destroy`    | `{}`                             | The agent is destroyed                |

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

| Type                    | Payload                                      | When                                                                               |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `mcp:client:preconnect` | `{ serverId }`                               | Before connecting to an MCP server                                                 |
| `mcp:client:connect`    | `{ url, transport, state, error? }`          | An MCP connection attempt completes or fails                                       |
| `mcp:client:authorize`  | `{ serverId, authUrl, clientId? }`           | An MCP OAuth flow begins                                                           |
| `mcp:client:discover`   | `{ url?, state?, error?, capability? }`      | MCP capability discovery succeeds or fails                                         |
| `mcp:client:close`      | `{ url, transport?, state, error?, phase? }` | An MCP connection is closed (`phase` is `"terminate-session"` or `"client-close"`) |

### Email events

| Type            | Payload                  | When                  |
| --------------- | ------------------------ | --------------------- |
| `email:receive` | `{ from, to, subject? }` | An email is received  |
| `email:reply`   | `{ from, to, subject? }` | A reply email is sent |
