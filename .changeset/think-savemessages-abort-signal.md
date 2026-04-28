---
"@cloudflare/think": patch
---

Add `options.signal` to `Think.saveMessages` and `Think.continueLastTurn` for external cancellation of programmatic turns, plus protected `abortRequest(id)` / `abortAllRequests()` methods to replace bracket access into the private `_aborts` registry ([#1406](https://github.com/cloudflare/agents/issues/1406)).

`saveMessages` and `continueLastTurn` accept a second `SaveMessagesOptions` argument:

```typescript
const result = await this.saveMessages(messages, { signal: controller.signal });
if (result.status === "aborted") {
  // Inference loop terminated mid-stream; partial chunks persisted.
}
```

The signal is linked to Think's per-turn `AbortController` for the duration of the call. When it aborts:

- the inference loop's signal aborts (the same path `chat-request-cancel` takes);
- partial chunks already streamed are persisted to the resumable stream;
- `saveMessages` resolves with `{ status: "aborted" }`;
- `onChatResponse` fires with `status: "aborted"`.

Pre-aborted signals short-circuit before any model work runs. Listeners are detached cleanly when the turn finishes, so passing the same long-lived `AbortSignal` to many turns (e.g. a parent chat-turn signal driving multiple sub-agent calls) is safe and leak-free.

`abortRequest(id, reason?)` and `abortAllRequests()` are protected entry points for DO subclasses (e.g. RPC-driven helpers) that want to cancel turns without tracking ids — they replace the historical `(this as unknown as { _aborts: ... })._aborts.destroyAll()` workaround used by helper-as-sub-agent implementations.

`SaveMessagesResult.status` now includes `"aborted"` alongside `"completed"` and `"skipped"`. Existing callers that only switch on `"completed"` are unaffected.

**Limitations.**

- `AbortSignal` cannot cross Durable Object RPC. Construct the controller inside the DO that calls `saveMessages`. To bridge a parent's intent into a child DO, return a `ReadableStream` from the child whose `cancel` callback aborts a per-turn controller — `examples/agents-as-tools` shows the canonical pattern.
- The signal lives in memory only. If the DO hibernates mid-turn and `chatRecovery` is enabled, the recovered turn calls `continueLastTurn()` internally without the original signal — an abort fired after restart has no effect on the recovered turn.

See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the motivating use case.
