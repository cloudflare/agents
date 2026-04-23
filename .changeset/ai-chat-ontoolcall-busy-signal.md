---
"@cloudflare/ai-chat": patch
---

Fix `useAgentChat()` going silent while an `onToolCall` handler is running. The server's `streamText` ends the stream as soon as the model emits a client-tool call, which dropped `status` back to `ready` and `isStreaming`/`isServerStreaming` to `false` for the full duration of the client-side `tool.execute()` — often a `fetch` taking several seconds. Consumers had no single flag that covered the whole "turn in progress" window. See [#1365](https://github.com/cloudflare/agents/issues/1365).

`useAgentChat()` now treats any unresolved client-side tool call on the latest assistant message as an active server-driven phase:

- `isServerStreaming` is `true` from the moment the tool part appears in `input-available` (with an active handler — `onToolCall` or a deprecated `tools` entry with `execute`) until it transitions out via `addToolOutput` / `addToolResult`.
- `isStreaming` (`status === "streaming" || isServerStreaming`) stays `true` across the whole tool round-trip, including the gap between the model emitting the call and the server pushing its continuation.
- `status` is untouched — it still means "user-initiated submission awaiting a response." Tools waiting for explicit user confirmation are excluded from the busy signal (nothing is happening until the user acts).

Consumer code simplifies to:

```tsx
const { isStreaming, status } = useAgentChat({ ... });
const isLoading = isStreaming || status === "submitted";
const showTypingIndicator = status === "submitted";
```

No API changes. Existing code that only looked at `status` behaves the same.
