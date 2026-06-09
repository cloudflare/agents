---
"@cloudflare/think": patch
"agents": patch
---

Support client tools on the Think sub-agent `chat()` RPC path (#1709)

`ChatOptions` now accepts `clientTools` (the same `ClientToolSchema[]` carried over the WebSocket chat protocol) and an `onClientToolCall` executor. This lets a parent agent that drives a Think sub-agent over `chat()` expose client-defined tools to the sub-agent and complete the tool round trip within the same turn:

```ts
await child.chat(message, callback, {
  signal,
  clientTools: [{ name: "get_user_timezone", parameters: { type: "object" } }],
  onClientToolCall: async ({ toolName, input }) =>
    runClientTool(toolName, input)
});
```

Without `onClientToolCall`, the schemas are still registered and the model's call is surfaced through the stream callback (execute-less), matching the WebSocket behavior. With it, the call is resolved inline so the turn can continue to completion — the RPC stream callback has no inbound result channel of its own.

Unlike the WebSocket path, the schemas and executor are kept per-turn and are NOT persisted: the executor is a live RPC reference that cannot survive an eviction, and there is no SPA to replay a `tool-result`. This keeps chat recovery correct — an eviction-interrupted client-tool call is repaired like a server tool (the model proceeds) rather than being mistaken for a pending human interaction and parking forever.

`agents/chat`'s `createToolsFromClientSchemas` gains an optional `{ execute }` delegate (and exports a new `ClientToolExecutor` type) to build the executable variant. Both additions are backward-compatible.
