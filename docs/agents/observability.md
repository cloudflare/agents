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

## Agent initialization span

When Worker traces are enabled, every `Agent` constructor runs its setup —
method wrapping, schema creation, and MCP client manager initialization —
inside an `agent_initialization` span. Constructor-time child spans group under
this one stable parent instead of appearing as top-level clutter. The span
carries `cloudflare.agents.agent.name` (the agent class),
`cloudflare.agents.agent.id` (the named instance, omitted when the name is not
yet readable during construction), and `cloudflare.agents.operation.name`
(`agent_initialization`). Like the rest of the tracing in this package, it is a
no-op when the runtime has no native tracing capability.

## AI SDK tracing

`agents/observability/ai` instruments the Vercel AI SDK with Workers' native
custom spans. It projects the scalar subset supported by the Workers `Span` API
onto the current
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai).
Spans flow to Workers Observability and configured OTLP destinations. The
integration is a no-op when the runtime has no native tracing capability.

**Think agents are traced out of the box.** Enable
`observability.traces.enabled` in `wrangler.jsonc`; no Think option is required.
A turn gets an `invoke_agent {agent class}` operation span, `chat {model}` model
spans, and `execute_tool {tool}` spans. Think always supplies its durable
identity: `gen_ai.agent.name` is the class name, `gen_ai.agent.id` is the named
instance, and `gen_ai.conversation.id` is the opaque Durable Object ID. These
are defaults; `beforeTurn` can override `functionId` or the corresponding
metadata fields for applications with a different identity model. Think records
no conversation content by default; set `recordInputs = true` and/or
`recordOutputs = true` on the agent to attach prompts, output, and tool
inputs/outputs to the spans (records PII — see
[Opt-in content recording](#opt-in-content-recording-records-pii)).

### AI SDK v6

Wrap the SDK namespace:

```ts
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";

const { generateText, streamText } = wrapAISDK(ai);
```

`wrapAISDK` instruments `generateText`, `streamText`, `generateObject`, and
`streamObject`. Span names use `{operation} {target}` and fall back to the bare
operation past 64 UTF-8 bytes; the full target remains on its semantic
attribute. A model object is wrapped with the SDK's `wrapLanguageModel` helper,
so provider work is a `chat {model}` child of the operation span. Tool
execution is wrapped as `execute_tool {tool}`. Stream spans close on completion,
cancellation, an in-band error, or early consumer return. Async-generator tools
stay open until iteration ends.

### AI SDK v7

AI SDK v7 ships a first-class telemetry lifecycle. Register the adapter once and
every `generateText`, `streamText`, `generateObject`, and `streamObject` call is
instrumented:

```ts
import { registerTelemetry } from "ai";
import { createAISDKTelemetry } from "agents/observability/ai";

registerTelemetry(createAISDKTelemetry());
```

Or scope it to a single call through `experimental_telemetry`:

```ts
import { createAISDKTelemetry } from "agents/observability/ai";

await generateText({
  model,
  prompt: "...",
  experimental_telemetry: {
    integrations: [createAISDKTelemetry()]
  }
});
```

The v7 adapter uses `cloudflare.agents.call.id` to correlate operation, model,
and tool spans. Its execution hooks keep provider work under the `chat` span and
nested work performed by a tool under the `execute_tool` span. It handles both
`onEnd` and `onAbort` terminal paths. `wrapAISDK` and `createAISDKTelemetry`
project into the same span schema, so the two SDK versions are dashboard-
compatible.

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
| `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`                      | Tool identity; call ID only when available                                                   |
| `gen_ai.input.messages`, `gen_ai.output.messages`                                  | Opt-in (PII) chat inputs/outputs; omitted unless `recordInputs`/`recordOutputs` is set       |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`                            | Opt-in (PII) tool inputs/outputs; omitted unless `recordInputs`/`recordOutputs` is set       |
| `user.id`                                                                          | Explicit v6 metadata key `user.id`                                                           |
| `error.type`                                                                       | Low-cardinality error class; raw error messages are never recorded                           |

The adapter also emits a small vendor namespace where no standard equivalent
exists:

| Attribute                                                                               | Meaning                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `cloudflare.agents.integration.name`                                                    | Instrumentation source (`ai-sdk`)                                       |
| `cloudflare.agents.operation.name`                                                      | Original SDK operation (`streamText`, `doStream`, `tool.execute`, etc.) |
| `cloudflare.agents.call.id`                                                             | AI SDK v7 callback correlation ID                                       |
| `cloudflare.agents.response.finish_reason`                                              | One finish reason as a scalar                                           |
| `cloudflare.agents.tool.count`                                                          | Precomputed tool-call count for dashboards                              |
| `cloudflare.agents.usage.total_tokens`                                                  | Provider total, or input plus output when both are known                |
| `cloudflare.agents.runtime_context.{key}`                                               | Explicitly included scalar runtime context                              |
| `cloudflare.agents.tool_context.{tool}.{key}`                                           | Explicitly included scalar context on the executed tool span            |
| `cloudflare.agents.metadata.{key}`                                                      | Other scalar v6 telemetry metadata                                      |
| `cloudflare.agents.turn.{request_id,trigger,admission,channel,continuation,generation}` | Think turn context                                                      |
| `cloudflare.agents.canceled`                                                            | Recognized cancellation, not a failure                                  |

`gen_ai.response.finish_reasons` and `gen_ai.request.stop_sequences` are arrays
in OTel. Workers' custom `Span.setAttribute` currently accepts only a string,
number, or boolean, so the adapter omits those attributes rather than placing
JSON text under an array-typed key. Similarly, span status is state rather than
an attribute: failures emit `error.type`, but the adapter does not invent an
`otel.status_code` attribute when Workers exposes no custom-span status setter.

### Context and safety

By default the adapters emit no conversation content. Prompts, messages, model
output, and tool inputs/outputs are not recorded unless you explicitly opt in
(see [Opt-in content recording](#opt-in-content-recording-records-pii) below).
The dedicated top-level `system` parameter, schemas, headers, provider options,
and raw error messages are never recorded under any configuration. (A
`system`-role entry inside the `messages` array is part of the conversation and
is recorded when `recordInputs` is set.) Metadata and context values must be
scalar; objects and arrays are dropped.

#### Opt-in content recording (records PII)

Chat inputs/outputs and tool inputs/outputs can be attached to the spans behind
an explicit opt-in. **This content is potentially PII and is recorded only when
the corresponding flag is `true`; both default to `false`.** Enable it only
where recording raw conversation content in Workers Observability is acceptable.

The flag names mirror the AI SDK's own `TelemetrySettings`:

- `recordInputs` — records each model call's chat inputs (prompt/messages) on
  its `chat` span (`gen_ai.input.messages`) and tool arguments on the
  `execute_tool` span (`gen_ai.tool.call.arguments`).
- `recordOutputs` — records each model call's output (text/object/tool calls) on
  its `chat` span (`gen_ai.output.messages`) and the tool result on the
  `execute_tool` span (`gen_ai.tool.call.result`), on the success path only —
  never on error or abort.

Each value is serialized to JSON and truncated to a safe byte cap with a
`…[truncated]` marker, so a large prompt cannot blow up the span.

For v6, set the flags on the wrapper, or per call via `experimental_telemetry`
(a per-call flag is authoritative and can opt in **or** out):

```ts
const traced = wrapAISDK(ai, { recordInputs: true, recordOutputs: true });

await traced.generateText({
  model,
  prompt: "Will I need an umbrella?",
  // Per-call override wins over the wrapper default.
  experimental_telemetry: { recordInputs: false }
});
```

For v7, pass the flags to `createAISDKTelemetry`:

```ts
const telemetry = createAISDKTelemetry({
  recordInputs: true,
  recordOutputs: true
});
```

Think exposes the same `recordInputs`/`recordOutputs` flags (both off by
default) as agent fields; set either to `true` on an agent to record that
content for every turn. See
[Think configuration](https://github.com/cloudflare/agents/blob/main/docs/think/index.md).

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

For v7, the AI SDK filters runtime and per-tool context before the adapter sees
it. Its allowlists are boolean maps, not arrays:

```ts
await generateText({
  model,
  prompt: "Will I need an umbrella?",
  runtimeContext: { requestId: "req-123", tenantId: "tenant-42" },
  toolsContext: {
    weather: { defaultUnit: "celsius", cacheHit: true }
  },
  telemetry: {
    includeRuntimeContext: {
      requestId: true,
      tenantId: true
    },
    includeToolsContext: {
      weather: {
        defaultUnit: true,
        cacheHit: true
      }
    }
  }
});
```

Do not include tokens, credentials, user input, or other secrets. Context
filtering reduces accidental exposure; it is not a security boundary.
