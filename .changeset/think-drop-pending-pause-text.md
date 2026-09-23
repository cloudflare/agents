---
"@cloudflare/think": patch
---

Resolving a paused execution no longer leaves stale pending-state text in the transcript (#2054).

After a `kind: "durable-pause"` action or a Codemode approval parks, the model can reply in the same turn ("Once approved, the change will be applied."). `approveExecution()` and `rejectExecution()` replaced the paused output but kept that reply, so the continuation read a transcript that contradicted the outcome. The text and reasoning parts after the resolved tool part are now removed from that assistant message; earlier content and later tool and file parts are kept. When the outcome lands while the parking turn is still streaming, the cleanup runs once that turn is persisted, before the next model call (the continuation or a user turn queued ahead of it). The pending cleanup is kept in Durable Object storage, so it survives a restart in between.
