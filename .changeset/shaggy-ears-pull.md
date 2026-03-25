---
"@cloudflare/ai-chat": patch
---

Fix waitForIdle race and relax test assertion

Make waitForIdle robust against races by looping until \_chatTurnQueue is stable (capture the current promise, await it, and repeat if it changed). Update the related test: rename it to reflect behavior and relax the assertion to accept 1–2 started request IDs (documenting the nondeterministic coalescing window under load), since rapid auto-continued tool results may coalesce or form sequential turns depending on timing.
