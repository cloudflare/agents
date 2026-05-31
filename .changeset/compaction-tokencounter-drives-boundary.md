---
"agents": patch
---

Compaction: the Session's `tokenCounter` now also drives the bundled `createCompactFunction`'s boundary ("what to compress") decision, not just the fire/no-fire trigger. Fixes #1593.

Previously a `tokenCounter` configured on `Session.compactAfter()` only influenced _whether_ compaction fired; the boundary walk inside `createCompactFunction` still used the Workers-safe `chars/4` heuristic. On tool-heavy agent histories that heuristic under-counts badly, so the configured tail budget covered the entire history and `compressEnd <= compressStart` — compaction fired every turn but silently returned `null`, never shortening history (strictly worse than not configuring it).

Now the Session passes its counter to the compaction function via a new `CompactContext` argument, and `createCompactFunction` uses it for the tail-budget walk when no explicit `tokenCounter` was given on `CompactOptions`. So a single `tokenCounter` on `compactAfter()` drives both "should we compact?" and "what should we compact?". When the trigger fires but compaction still returns `null` (e.g. no counter configured and the heuristic protects everything), the Session logs a one-time warning instead of looping silently.

`CompactFunction` gains an optional second `context?: CompactContext` argument (backward compatible — existing one-arg functions are unaffected).

Note: the flowed counter is invoked per-message during the tail walk. A tokenizer-style counter gives accurate per-message budgeting; a usage-only counter that reports a fixed whole-prompt total degrades the tail budget to `minTailMessages` (compaction still runs and context stays bounded, but the byte budget is effectively ignored). For precise budgeting with such counters, pass an explicit per-message `CompactOptions.tokenCounter`.
