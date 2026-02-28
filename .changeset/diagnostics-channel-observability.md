---
"agents": minor
---

Overhaul observability: `diagnostics_channel`, leaner events, error tracking.

### Breaking changes to `agents/observability` types

- **`BaseEvent`**: Removed `id` and `displayMessage` fields. Events now contain only `type`, `payload`, and `timestamp`. The `payload` type is now strict — accessing undeclared fields is a type error. Narrow on `event.type` before accessing payload properties.
- **`Observability.emit()`**: Removed the optional `ctx` second parameter.
- **`AgentObservabilityEvent`**: Split combined union types so each event has its own discriminant (enables proper `Extract`-based type narrowing). Added new error event types.

If you have a custom `Observability` implementation, update your `emit` signature to `emit(event: ObservabilityEvent): void`.

### diagnostics_channel replaces console.log

The default `genericObservability` implementation no longer logs every event to the console. Instead, events are published to named diagnostics channels using the Node.js `diagnostics_channel` API. Publishing to a channel with no subscribers is a no-op, eliminating logspam.

Seven named channels, one per event domain:

- `agents:state` — state sync events
- `agents:rpc` — RPC method calls and errors
- `agents:message` — message request/response/clear/cancel/error + tool result/approval
- `agents:schedule` — schedule and queue create/execute/cancel/retry/error events
- `agents:lifecycle` — connection and destroy events
- `agents:workflow` — workflow start/event/approve/reject/terminate/pause/resume/restart
- `agents:mcp` — MCP client connect/authorize/discover events

### New error events

Error events are now emitted at failure sites instead of (or alongside) `console.error`:

- `rpc:error` — RPC method failures (includes method name and error message)
- `schedule:error` — schedule callback failures after all retries exhausted
- `queue:error` — queue callback failures after all retries exhausted

### Reduced boilerplate

All 20+ inline `emit` blocks in the Agent class have been replaced with a private `_emit()` helper that auto-generates timestamps, reducing each call site from ~10 lines to 1.

### Typed subscribe helper

A new `subscribe()` function is exported from `agents/observability` with full type narrowing per channel:

```ts
import { subscribe } from "agents/observability";

const unsub = subscribe("rpc", (event) => {
  // event is fully typed as rpc | rpc:error
  console.log(event.payload.method);
});
```

### Tail Worker integration

In production, all diagnostics channel messages are automatically forwarded to Tail Workers via `event.diagnosticsChannelEvents` — no subscription needed in the agent itself.

### TracingChannel potential

The `diagnostics_channel` API also provides `TracingChannel` for start/end/error spans with `AsyncLocalStorage` integration, opening the door to end-to-end tracing of RPC calls, workflow steps, and schedule executions.
