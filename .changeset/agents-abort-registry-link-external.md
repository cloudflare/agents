---
"agents": patch
---

Add `AbortRegistry.linkExternal(id, signal)` for connecting external `AbortSignal`s to per-request abort controllers, and add `"aborted"` to the `SaveMessagesResult.status` union ([#1406](https://github.com/cloudflare/agents/issues/1406)).

`linkExternal` is the integration point for callers that drive a chat turn programmatically and want to cancel it from outside without knowing the internally-generated request id (the helper-as-sub-agent pattern, where a parent's `AbortSignal` from the AI SDK tool `execute` needs to land inside a sub-agent's `saveMessages` call). When the external signal aborts, the registry's controller for `id` is cancelled — the same path `chat-request-cancel` takes over the WebSocket. The returned detacher must be called in `finally` to avoid leaking listeners on long-lived parent signals.

`SaveMessagesResult.status` now includes `"aborted"` alongside `"completed"` and `"skipped"`. Existing callers that only switch on `"completed"` are unaffected; turns cancelled via the new signal API surface as `"aborted"` rather than `"completed"`.

Also exposes `SaveMessagesOptions` from `agents/chat` for use by `@cloudflare/think` and `@cloudflare/ai-chat` typed APIs. `AbortRegistry.cancel(id, reason?)` now accepts an optional reason that flows through to `signal.reason` on the cancelled controller.

See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the motivating use case.
