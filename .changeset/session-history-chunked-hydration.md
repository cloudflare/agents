---
"agents": patch
---

Fix SQLite memory amplification in `AgentSessionProvider.getHistory()` and add byte-budgeted history reads (#1710).

The history path query previously selected `m.*` inside its recursive CTE, so every message blob was materialized in SQLite's recursion queue AND its `ORDER BY` sorter — 2-3 transient copies of the entire transcript inside the SQLite allocator, which in workerd shares the isolate's memory budget with the JS heap. On large media-heavy sessions this exhausted the allocator and surfaced as `SQLITE_NOMEM` on every wake. The CTE now recurses over `(id, parent_id, depth)` only and content is fetched separately in bounded chunks via `json_each`, which streams without materializing the result set. Leaf detection similarly no longer drags content blobs through its sorter.

New session APIs for hosts that need to bound wake-time memory:

- `Session.getRecentHistory(maxContentBytes, minRecentMessages?)` — returns the most recent messages on the active path that fit a byte budget (always at least the leaf, and at least `minRecentMessages` rows when provided — rows are individually capped at write time, so the floor keeps memory bounded), plus `truncated` and `totalContentBytes`. Backed by the optional `SessionProvider.getRecentHistory()`; falls back to a full read for providers that don't implement it, reporting the real serialized size and warning once that the budget cannot be enforced.
- `Session.getHistoryRowStats()` — per-row stored sizes AND roles for the active path WITHOUT loading content (optional `SessionProvider.getHistoryRowStats()`), so oversized rows can be found and processed one at a time.
- `Session.internal_rewriteMessage()` — maintenance write path that skips the full-history token-estimate status broadcast of a public `updateMessage()`, for framework passes (media eviction) that rewrite many rows with bounded memory.

Bounded init reads: the init-time loaded-skill restore scan is now skipped entirely when no skill-capable context provider is configured, and when one is, it reads row stats and fetches assistant messages ONE AT A TIME instead of materializing the full transcript (full-read fallback for providers without row stats). Content hydration chunks are additionally bounded by cumulative stored bytes (4MB), not just row count, removing the 50-near-cap-rows worst case.

Also adds `chat:onstart:degraded`, `chat:hydration:windowed`, and `chat:media:evicted` observability event types emitted by `@cloudflare/think`.
