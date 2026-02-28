---
"agents": patch
---

Replace `console.log`-based observability with `node:diagnostics_channel`.

### What changed

The default `genericObservability` implementation no longer logs every event to the console. Instead, events are published to named diagnostics channels using the Node.js `diagnostics_channel` API. Publishing to a channel with no subscribers is a no-op, which eliminates the logspam problem where every state update, RPC call, schedule execution, and workflow event would unconditionally hit stdout.

Seven named channels, one per event domain:

- `agents:state` — state sync events
- `agents:rpc` — RPC method calls (including streaming)
- `agents:message` — message request/response/clear
- `agents:schedule` — schedule create/execute/cancel and retry events
- `agents:lifecycle` — connection and destroy events
- `agents:workflow` — workflow start/event/approve/reject/terminate/pause/resume/restart
- `agents:mcp` — MCP client connect/authorize/discover events

### Typed subscribe helper

A new `subscribe()` function is exported from `agents/observability` that provides full type narrowing per channel:

```ts
import { subscribe } from "agents/observability";

const unsub = subscribe("rpc", (event) => {
  // event is fully typed: { type: "rpc", payload: { method: string, streaming?: boolean }, ... }
  console.log(event.payload.method);
});

// Clean up when done
unsub();
```

### Tail Worker integration (production observability)

In production, all messages published to any diagnostics channel are automatically forwarded to Tail Workers. No subscription code is needed in the agent itself — just attach a Tail Worker and access events via `event.diagnosticsChannelEvents`:

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

This means you get structured, filterable observability in production with zero overhead in the agent's hot path.

### TracingChannel potential

The `diagnostics_channel` API also provides `TracingChannel`, which expresses start/end/error spans for async operations with `AsyncLocalStorage` integration. This opens the door to tracing RPC calls, workflow steps, and schedule executions end-to-end — correlating nested operations via request IDs stored in async context — without any manual instrumentation in user code.
