---
"@cloudflare/ai-chat": patch
---

Fix active streams losing UI state after reconnect and dead streams after DO hibernation.

- Send `replayComplete` signal after replaying stored chunks for live streams, so the client flushes accumulated parts to React state immediately instead of waiting for the next live chunk.
- Detect orphaned streams (restored from SQLite after hibernation with no live LLM reader) via `_isLive` flag on `ResumableStream`. On reconnect, send `done: true`, complete the stream, and reconstruct/persist the partial assistant message from stored chunks.
- Client-side: flush `activeStreamRef` on `replayComplete` (keeps stream alive for subsequent live chunks) and on `done` during replay (finalizes orphaned streams).
