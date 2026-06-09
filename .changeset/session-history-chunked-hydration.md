---
"agents": patch
---

Fix SQLite memory amplification in `AgentSessionProvider.getHistory()` and add byte-budgeted history reads (#1710).

The history path query previously selected `m.*` inside its recursive CTE, so every message blob was materialized in SQLite's recursion queue AND its `ORDER BY` sorter — 2-3 transient copies of the entire transcript inside the SQLite allocator, which in workerd shares the isolate's memory budget with the JS heap. On large media-heavy sessions this exhausted the allocator and surfaced as `SQLITE_NOMEM` on every wake. The CTE now recurses over `(id, parent_id, depth)` only and content is fetched separately in bounded chunks via `json_each`, which streams without materializing the result set. Leaf detection similarly no longer drags content blobs through its sorter.

New session APIs for hosts that need to bound wake-time memory:

- `Session.getRecentHistory(maxContentBytes)` — returns the most recent messages on the active path that fit a byte budget (always at least the leaf), plus `truncated` and `totalContentBytes`. Backed by the optional `SessionProvider.getRecentHistory()`; falls back to a full read for providers that don't implement it.
- `Session.getHistoryRowStats()` — per-row stored sizes for the active path WITHOUT loading content (optional `SessionProvider.getHistoryRowStats()`), so oversized rows can be found and processed one at a time.

Also adds `chat:onstart:degraded`, `chat:hydration:windowed`, and `chat:media:evicted` observability event types emitted by `@cloudflare/think`.
