---
"@cloudflare/think": minor
---

Add `StreamCallback.onInterrupted()` so a `chat()`-driven turn interrupted by recovery isn't silently abandoned

When a turn driven through `chat(userMessage, callback)` is interrupted and routed
into bounded recovery (a stream-stall watchdog abort), the scheduled continuation
runs in a **later isolate invocation without the original callback** — so neither
`onDone()` nor `onError()` ever fires for that callback. Because the isolate is
still alive, the RPC promise resolves **cleanly**, and a consumer that keys off the
clean resolve mis-reads it as success: it finalizes whatever partial it had
streamed. For the built-in messenger delivery this meant posting a **truncated**
answer as final, while the real recovered answer was produced later and broadcast
only to WebSocket connections.

`StreamCallback` now has an optional `onInterrupted?()` signal, emitted from the
stall→recovery branches of the RPC stream path instead of returning silently. It
means "not done, not a terminal error — a continuation owns the final outcome";
consumers should keep the channel open / show a recovering state / re-attach
rather than finalizing the partial. It is **optional**, so existing
`StreamCallback` implementers are unaffected.

Messenger delivery is wired to it: an interrupted reply now surfaces an
"interrupted, please retry" message instead of finalizing the truncated partial.

Note: a deploy/eviction interruption kills the isolate (and the callback) before
this can fire — the caller observes a transport break instead. `onInterrupted`
covers the in-isolate stall→recovery path.
