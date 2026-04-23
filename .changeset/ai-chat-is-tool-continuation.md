---
"@cloudflare/ai-chat": patch
---

Add `isToolContinuation: boolean` to `useAgentChat()` so consumers can disambiguate a fresh user-initiated `status === "submitted"` from one driven by a server-pushed tool continuation. See [#1365](https://github.com/cloudflare/agents/issues/1365).

`status` already tracks the whole tool round-trip (`submitted` → `streaming` → `ready`) after `addToolOutput` / `addToolApprovalResponse`, on purpose — that's what [#1157](https://github.com/cloudflare/agents/issues/1157) asked for and what many loading-spinner UIs now rely on. But some consumers want a typing indicator *only* for new user messages, not for mid-turn continuations, and previously had to inspect message history to tell them apart.

`isToolContinuation` is `true` from the moment `addToolOutput` / `addToolApprovalResponse` kicks off an auto-continuation until the continuation stream closes (or is aborted by `stop()`). It is `false` otherwise — including during cross-tab server broadcasts, which surface via `isServerStreaming` only.

```tsx
const { status, isStreaming, isToolContinuation } = useAgentChat({ ... });

const isLoading = isStreaming || status === "submitted";
const showTypingIndicator = status === "submitted" && !isToolContinuation;
```

Purely additive — no change to `status`, `isServerStreaming`, or `isStreaming` semantics.
