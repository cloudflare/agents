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

| Type                      | Payload                                                                  | When                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:request:failed`     | `{ requestId?, stage, messagesPersisted?, error }`                       | A Think chat request fails while parsing, persisting, running, or streaming                                                                                                                                                                                      |
| `chat:recovery:detected`  | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | An interrupted chat fiber is first observed                                                                                                                                                                                                                      |
| `chat:recovery:attempt`   | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | The framework begins a recovery attempt                                                                                                                                                                                                                          |
| `chat:recovery:scheduled` | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | A retry or continuation callback is scheduled                                                                                                                                                                                                                    |
| `chat:recovery:completed` | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }`          | Recovery completed successfully                                                                                                                                                                                                                                  |
| `chat:recovery:skipped`   | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind, reason? }` | Recovery was skipped because the conversation changed or was no longer recoverable                                                                                                                                                                               |
| `chat:recovery:failed`    | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind, reason? }` | Recovery ran but failed                                                                                                                                                                                                                                          |
| `chat:recovery:exhausted` | `{ incidentId, requestId, attempt, maxAttempts, recoveryKind, reason }`  | Recovery exceeded its configured attempt budget                                                                                                                                                                                                                  |
| `chat:stream:stalled`     | `{ requestId, timeoutMs }`                                               | The inactivity watchdog fired — no stream chunk arrived within `chatStreamStallTimeoutMs`. The turn then routes into bounded recovery; look for `chat:recovery:*`. See [Think configuration](https://github.com/cloudflare/agents/blob/main/docs/think/index.md) |

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

## OpenTelemetry

Libraries that instrument themselves with the
[OpenTelemetry API](https://opentelemetry.io/docs/languages/js/) (`@opentelemetry/api`)
record nothing on Workers until something registers an implementation of that
API. `registerOpenTelemetry()` registers one that writes Workers
[custom spans](https://developers.cloudflare.com/workers/observability/traces/):

```ts
import { registerOpenTelemetry } from "agents/observability";

registerOpenTelemetry();

export default {
  async fetch(request, env, ctx) {
    // ...
  }
} satisfies ExportedHandler<Env>;
```

Call it once at module scope, then enable traces in `wrangler.jsonc`:

```jsonc
{
  "observability": {
    "enabled": true,
    "traces": { "enabled": true, "head_sampling_rate": 1 }
  }
}
```

After that, OpenTelemetry spans from these sources become Workers spans:

- The MCP TypeScript SDK, which records a span per request and notification
  (`tools/call get-weather`, `initialize`, ...). This covers `createMcpHandler`,
  `McpAgent`, and MCP clients.
- AI SDK v6 `experimental_telemetry`.
- Your own spans from `trace.getTracer(...)`.

The Agents SDK records its own spans (agent lifecycle, `wrapAISDK`, Think)
through the OpenTelemetry API too, and registers the bridge automatically the
first time it records a span. A Worker that runs an Agent, Think,
or `wrapAISDK` therefore needs no `registerOpenTelemetry()` call. Call it
yourself to record OpenTelemetry spans that can start before any Agents SDK
span, for example in a Worker that only serves `createMcpHandler`.

If you register your own OpenTelemetry SDK at module scope, the Agents SDK's
spans go to that SDK instead, like any other OpenTelemetry instrumentation.

They sit in the same trace as the Agents SDK's spans and the automatic fetch,
KV, D1, and Durable Object spans, and they export through
`observability.traces.destinations` like every other Workers span. An MCP tool
call served by `createMcpHandler` looks like this:

```text
POST
  tools/call get-weather   {mcp.method.name: tools/call, gen_ai.tool.name: get-weather}
    kv_get                 {db.system.name: cloudflare-kv}
    look up forecast       {weather.city: Lisbon}
```

The Worker needs a runtime with `tracing.getActiveSpan()` (the 2026-09-25
release or later). Span IDs, status, and renames need the 2026-10-26 release;
on older runtimes those calls do nothing. Keep a single copy of
`@opentelemetry/api` in your dependency tree. The OpenTelemetry API refuses
registrations from a copy with a different version, and instrumentation that
loads a newer minor version than the one that registered sees no tracer.

`registerOpenTelemetry()` is safe to call more than once. When both an
OpenTelemetry context manager and tracer provider are already registered,
either by your own OpenTelemetry SDK setup or natively by the Workers runtime
once it supports the OpenTelemetry API, it leaves them in place and does
nothing. It throws when only one of the two is registered, because that
half-configured setup would detach spans from Workers tracing.

### What is recorded

Workers spans are smaller than OpenTelemetry spans. The bridge records what
Workers can represent and drops the rest instead of approximating it.

| OpenTelemetry                                      | On Workers                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `startActiveSpan()`                                | A span that is the active parent while the callback runs. You call `end()`.                                              |
| `startSpan()`                                      | A span under the current span. It becomes the active parent inside `context.with(trace.setSpan(ctx, span), fn)`.         |
| `trace.getActiveSpan()` outside your own spans     | The invocation span (`GET`, `POST`, ...). You can add attributes or rename it. `end()` has no effect.                    |
| String, number, and boolean attributes             | Recorded as is                                                                                                           |
| Array and other attribute values                   | Dropped, never serialized                                                                                                |
| `setStatus()`, `updateName()`, `recordException()` | Recorded. Status follows OpenTelemetry's rules: `UNSET` is ignored and `OK` is final.                                    |
| Span kind (`CLIENT`, `SERVER`, ...)                | The span is recorded without a kind. Workers spans have no kind, and the bridge does not invent an attribute.            |
| Links, events other than exceptions                | Dropped                                                                                                                  |
| Explicit end or exception timestamps               | Recorded at the time of the call                                                                                         |
| Explicit start timestamps                          | Not recorded. The call returns a non-recording span.                                                                     |
| A remote parent, `root: true`, or no parent        | Not recorded. The call returns a non-recording span that carries the parent's context, so no span gets a made-up parent. |
| A parent span from another request                 | Not recorded                                                                                                             |
| Spans outside a request (module scope)             | Not recorded                                                                                                             |
| Metrics, logs                                      | Not supported                                                                                                            |

The bridge registers no propagator, so `propagation.inject()` writes no
`traceparent`. The `traceFlags` of a span context do not reflect Workers
sampling; do not build `traceparent` headers from them.

When `context.with()` (or `context.bind()`) makes a span from `startSpan()` the
active span, the callback runs in the async context where that span started:
other `AsyncLocalStorage` values inside the callback are the ones from that
moment. Workers can only make a span the active parent from inside the async
context that opened it. In the usual pattern, where instrumentation starts a
span and activates it in the same function, the two contexts are the same.

The bridge reports each unsupported feature once through OpenTelemetry's
`diag` logger. The messages name the feature, never span names or values. To
see them:

```ts
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
```

## Agent initialization span

When Worker traces are enabled, every `Agent` constructor runs its setup —
method wrapping, schema creation, and MCP client manager initialization —
inside an `agent_initialization` span. Constructor-time child spans group under
this one stable parent instead of appearing as top-level clutter. The span
carries `cloudflare.agents.agent.name` (the agent class),
`cloudflare.agents.agent.id` (the named instance, omitted when the name is not
yet readable during construction), and `cloudflare.agents.operation.name`
(`agent_initialization`). Like the rest of the tracing in this package, it is
recorded through the OpenTelemetry API (see [OpenTelemetry](#opentelemetry)) and
is a no-op when no tracer is available.

## AI SDK tracing

`agents/observability/ai` instruments the Vercel AI SDK through the
OpenTelemetry API, which records Workers spans (see
[OpenTelemetry](#opentelemetry)). It projects the scalar subset supported by the
Workers `Span` API onto the current
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai).
Spans flow to Workers Observability and configured OTLP destinations. The
integration is a no-op when no tracer is available. `chat {model}` spans have
span kind `CLIENT`; the others are `INTERNAL`.

**Think agents are traced out of the box.** Enable
`observability.traces.enabled` in `wrangler.jsonc`; no Think option is required.
A turn gets an `invoke_agent {agent class}` operation span, `chat {model}` model
spans, and `execute_tool {tool}` spans. Think always supplies its durable
identity: `gen_ai.agent.name` is the class name, `gen_ai.agent.id` is the named
instance, and `gen_ai.conversation.id` is the opaque Durable Object ID. These
are defaults; `beforeTurn` can override `functionId` or the corresponding
metadata fields for applications with a different identity model. Payload
storage is off by default. Set `storeMessages` and/or `storeTools` on the Think
agent to opt in; these are wrapper settings, not span attributes.

### AI SDK v6 and v7

Wrap the SDK namespace and call the wrapped functions:

```ts
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";

const { generateText, streamText } = wrapAISDK(ai);
```

`wrapAISDK` supports AI SDK v6 and v7. It instruments `generateText`,
`streamText`, `generateObject`, and `streamObject`. You do not need to register a
telemetry integration for Agents tracing on AI SDK v7.

Span names use `{operation} {target}` and fall back to the bare operation past
64 UTF-8 bytes; the full target remains on its semantic attribute. A model
object is wrapped with the SDK's `wrapLanguageModel` helper, so provider work is
a `chat {model}` child of the `invoke_agent {agent}` operation span. Tool
execution is wrapped as `execute_tool {tool}`. Approval lifecycle segments
appear as bounded `tool_approval {tool}` children of an `execute_tool {tool}`
span, correlated by `gen_ai.tool.call.id` and carrying
`cloudflare.agents.tool.approval.state` (`requested`, `approved`, or `denied`).
They never remain open while waiting for a human across invocations. Stream
spans close on completion, cancellation, an in-band error, or early consumer
return. Async-generator tools stay open until iteration ends.

Pass `storeMessages: true` to write full input/output message arrays to `chat`.
The JSON follows the OpenTelemetry GenAI schemas: messages use `{ role, parts }`,
text and reasoning parts use `{ type, content }`, tool parts use `tool_call` /
`tool_call_response`, and every output message includes `finish_reason`. Pass
`storeTools: true` to write tool arguments and results to `execute_tool`:

```ts
const traced = wrapAISDK(ai, {
  storeMessages: true,
  storeTools: true
});
```

When a gateway-backed provider exposes its AI Gateway log ID through response
headers, provider metadata, or the Workers AI binding, the corresponding
`chat` span includes `cloudflare.ai_gateway.log.id`. The attribute is omitted
when no actual response exposes an ID; the wrapper does not infer one or make an
extra request.

### Identity

The AI SDK's canonical OpenTelemetry integration maps `functionId` to
`gen_ai.agent.name`. For direct `wrapAISDK` calls, `functionId` should therefore
be a low-cardinality logical agent name, not a request, user, session, or
Durable Object identifier. In v6, the other identity values are read from
`experimental_telemetry.metadata`; an explicit `agentName` takes precedence
over `functionId`.

Think sets all three fields automatically on every inference:

```text
gen_ai.agent.name      = this.constructor.name
gen_ai.agent.id        = this.name
gen_ai.conversation.id = this.ctx.id.toString()
```

For direct v6 wrapper calls, supply identity explicitly:

```ts
await generateText({
  model,
  prompt: "...",
  experimental_telemetry: {
    functionId: "booking-agent",
    metadata: {
      // Stable agent resource/instance identifier.
      agentId: "asst_123",
      agentVersion: "2026-07-01",
      conversationId: "conversation-123"
    }
  }
});
```

AI SDK v7 has no telemetry metadata bag. Put additional identity in
`runtimeContext` and explicitly include those fields:

```ts
await generateText({
  model,
  prompt: "...",
  runtimeContext: {
    conversationId: "conversation-123"
  },
  telemetry: {
    functionId: "booking-agent",
    includeRuntimeContext: {
      conversationId: true
    }
  }
});
```

### Emitted data

| Standard attributes                                                                | Source and scope                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`                                                            | `invoke_agent`, `chat`, or `execute_tool` on every span                                      |
| `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`                     | Explicit operation identity; Think defaults ID and name, but not version                     |
| `gen_ai.conversation.id`                                                           | Explicit operation conversation; Think defaults to its opaque Durable Object ID              |
| `gen_ai.provider.name`                                                             | Normalized provider on operation/model spans when known                                      |
| `gen_ai.output.type`                                                               | Requested `text` or `json` output on operation/model spans                                   |
| `gen_ai.request.model`                                                             | Requested model when known                                                                   |
| `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`              | Numeric request settings when supplied                                                       |
| `gen_ai.request.max_tokens`, `gen_ai.request.seed`, `gen_ai.request.top_k`         | Integer request settings when supplied                                                       |
| `gen_ai.request.stream`                                                            | `true` on streaming operations; omitted otherwise                                            |
| `gen_ai.request.temperature`, `gen_ai.request.top_p`                               | Numeric request settings when supplied                                                       |
| `gen_ai.response.id`, `gen_ai.response.model`                                      | Model-call response metadata when actually reported; never inferred from the requested model |
| `gen_ai.response.time_to_first_chunk`                                              | Model-call streaming latency in seconds                                                      |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`                          | Aggregate usage on operations and per-call usage on model spans                              |
| `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_read.input_tokens` | Provider cache usage when reported                                                           |
| `gen_ai.usage.reasoning.output_tokens`                                             | Reasoning output usage when reported                                                         |
| `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`                      | Tool identity; call ID also correlates approval lifecycle segments                           |
| `cloudflare.agents.tool.approval.state`                                            | Approval lifecycle segment: `requested`, `approved`, or `denied`                             |
| `gen_ai.input.messages`, `gen_ai.output.messages`                                  | Opt-in OTel-schema model messages on `chat`, including tool parts and output finish reasons  |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`                            | Opt-in tool arguments/results on `execute_tool`                                              |
| `user.id`                                                                          | Explicit v6 metadata key `user.id`                                                           |
| `error.type`                                                                       | Low-cardinality error class; raw error messages are never recorded                           |

The wrapper also emits a small vendor namespace where no standard equivalent
exists:

| Attribute                                                                               | Meaning                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `cloudflare.ai_gateway.log.id`                                                          | AI Gateway log reference on `chat`, when exposed by the actual response |
| `cloudflare.agents.integration.name`                                                    | Instrumentation source (`ai-sdk`)                                       |
| `cloudflare.agents.operation.name`                                                      | Original SDK operation (`streamText`, `doStream`, `tool.execute`, etc.) |
| `cloudflare.agents.response.finish_reason`                                              | One finish reason as a scalar                                           |
| `cloudflare.agents.tool.count`                                                          | Precomputed tool-call count for dashboards                              |
| `cloudflare.agents.usage.total_tokens`                                                  | Provider total, or input plus output when both are known                |
| `cloudflare.agents.runtime_context.{key}`                                               | Explicitly included scalar runtime context                              |
| `cloudflare.agents.metadata.{key}`                                                      | Other scalar v6 telemetry metadata                                      |
| `cloudflare.agents.turn.{request_id,trigger,admission,channel,continuation,generation}` | Think turn context, from v6 metadata or v7 runtime context              |
| `cloudflare.agents.canceled`                                                            | Recognized cancellation, not a failure                                  |
| `cloudflare.agents.span.truncated`                                                      | Span closed by its invocation ending before the work finished           |

`gen_ai.response.finish_reasons` and `gen_ai.request.stop_sequences` are arrays
in OTel. Workers' custom `Span.setAttribute` currently accepts only a string,
number, or boolean, so the wrapper omits those attributes rather than placing
JSON text under an array-typed key. Failures set span status `ERROR` without a
description and emit `error.type`; the raw error message is never recorded.
Cancellations leave the status unset.

### Context and safety

Payload storage is explicit and off by default. `storeMessages` writes only
`gen_ai.input.messages` / `gen_ai.output.messages` on `chat`; when the message
attribute exceeds its budget, the wrapper repeatedly drops the oldest
unprotected message (index 2), preserving the first two messages and newest
tail. `storeTools` writes only `gen_ai.tool.call.arguments` /
`gen_ai.tool.call.result` on `execute_tool`. The flags themselves are never
written to telemetry metadata or spans.

System instructions that the AI SDK presents to the model as a system-role chat
message remain in `gen_ai.input.messages`, which OTel explicitly permits for
instructions that are part of chat history. The wrapper does not separately
copy the raw `system` parameter into `gen_ai.system_instructions`. Schemas,
request headers, provider options, and raw error messages are never recorded.
The optional AI Gateway reference is a bounded opaque log ID; response headers
and provider metadata themselves are not recorded. Metadata and context values
must be scalar; objects and arrays are dropped.

For v6, only `experimental_context` exists. Configure its allowlist on the
wrapper:

```ts
const traced = wrapAISDK(ai, {
  includeRuntimeContext: ["requestId", "tenantId"]
});

await traced.generateText({
  model,
  prompt: "Will I need an umbrella?",
  experimental_context: {
    requestId: "req-123",
    tenantId: "tenant-42"
  }
});
```

For v7, put application context in `runtimeContext` and select telemetry-visible
keys with the AI SDK's boolean-map allowlist:

```ts
await generateText({
  model,
  prompt: "Will I need an umbrella?",
  runtimeContext: { requestId: "req-123", tenantId: "tenant-42" },
  telemetry: {
    includeRuntimeContext: {
      requestId: true,
      tenantId: true
    }
  }
});
```

Do not include tokens, credentials, user input, or other secrets. Context
filtering reduces accidental exposure; it is not a security boundary.
