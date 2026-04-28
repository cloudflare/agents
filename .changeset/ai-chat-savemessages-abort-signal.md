---
"@cloudflare/ai-chat": patch
---

Add `options.signal` to `AIChatAgent.saveMessages` and `continueLastTurn` for external cancellation of programmatic turns, plus protected `abortRequest(id)` / `abortAllRequests()` methods ([#1406](https://github.com/cloudflare/agents/issues/1406)).

`saveMessages` and `continueLastTurn` accept a second `SaveMessagesOptions` argument:

```typescript
const result = await this.saveMessages(messages, { signal: controller.signal });
if (result.status === "aborted") {
  // Inference loop terminated mid-stream; partial chunks persisted.
}
```

The signal is linked to AIChatAgent's per-turn `AbortController` and produces the same end state as a `chat-request-cancel` WebSocket message: the inference loop's signal aborts, partial chunks persist, the result reports `status: "aborted"`, and `onChatResponse` fires with the same status. Pre-aborted signals short-circuit before any model work runs. Listeners are detached cleanly when the turn finishes, so the same long-lived signal can be passed to many turns without leaking.

`abortRequest(id, reason?)` and `abortAllRequests()` are protected entry points for subclasses that want to cancel turns without tracking ids.

`SaveMessagesResult.status` now includes `"aborted"` alongside `"completed"` and `"skipped"`. Existing callers that only switch on `"completed"` are unaffected.

**Limitations.**

- `AbortSignal` cannot cross Durable Object RPC. Construct the controller inside the DO that calls `saveMessages`.
- The signal lives in memory only. If the DO hibernates mid-turn and `chatRecovery` is enabled, the recovered turn runs without the original signal.

See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the motivating use case.
