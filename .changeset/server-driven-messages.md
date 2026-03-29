---
"@cloudflare/ai-chat": minor
---

Add `onChatResponse` hook and client-side server-streaming indicators.

**Server: `onChatResponse` hook on `AIChatAgent`**

New protected method that fires after a chat turn completes and the assistant message has been persisted. The turn lock is released before the hook runs, so it is safe to call `saveMessages` from inside. Responses triggered from `onChatResponse` are drained sequentially via a built-in drain loop.

```typescript
protected async onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed") {
    this.broadcast(JSON.stringify({ streaming: false }));
  }
}
```

New exported type: `ChatResponseResult` with `message`, `requestId`, `continuation`, `status`, and `error` fields.

**Client: `isServerStreaming` and `isStreaming` on `useAgentChat`**

`isServerStreaming` is `true` when a server-initiated stream (from `saveMessages`, auto-continuation, or another tab) is active. Independent of the AI SDK's `status` which only tracks client-initiated requests.

`isStreaming` is a convenience flag: `true` when either the client-initiated stream (`status === "streaming"`) or a server-initiated stream is active.

**Behavioral fix: stream error propagation**

Non-abort reader errors in `_streamSSEReply` and `_sendPlaintextReply` now propagate correctly instead of being silently swallowed. The client receives `error: true` on the done message, and partial messages are not persisted. Previously, stream errors were silently treated as completions and partial content was persisted.
