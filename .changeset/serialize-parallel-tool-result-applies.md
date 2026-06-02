---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

fix(think): serialize parallel client-tool result/approval applies so siblings aren't clobbered (#1649 follow-up)

The auto-continuation barrier added in #1651 stopped premature continuation, but a deeper race remained in Think. Each `tool-result`/`tool-approval` WebSocket message fired an independent read-modify-write of the whole assistant message, and `_applyToolUpdateToMessages` awaits a storage read before its write. When the model fanned out parallel tool calls, the concurrent applies all read the same `input-available` snapshot, each patched only its own part, and the last write clobbered its siblings back to `input-available`. The continuation barrier then timed out and the transcript-repair backstop errored the lost calls with "The tool call was interrupted before a result was recorded."

Applies are now chained off a serialization tail so each read-modify-write commits atomically in arrival order. `_pendingInteractionPromise` still tracks the newest link, so the barrier's single-slot wake-up transitively waits for every predecessor.

The same serialization is applied to `@cloudflare/ai-chat` defensively: its apply is currently synchronous (no await between the message read and the SQLite write), so it does not exhibit this clobber today, but the queue keeps the invariant safe if that ever changes.
