---
"@cloudflare/ai-chat": patch
---

`waitForIdle` and `waitUntilStable` now also drain in-flight submits that have passed the concurrency decision but haven't yet entered the turn queue (i.e. submits mid-`persistMessages`). Previously these helpers only awaited `_turnQueue.waitForIdle()`, which could return while a submit was still tracked in `_pendingEnqueueCount` — racing with anything that called them (tests, recovery code, callers waiting for quiescence).

Fixes a long-standing flake in the `merge concatenates overlapping queued user messages into one follow-up turn` test. The test's stream durations are also bumped (10×100ms → 15×150ms) to give the WS dispatch enough headroom under CI load to bump `_latestOverlappingSubmitSequence` before the first turn finishes.
