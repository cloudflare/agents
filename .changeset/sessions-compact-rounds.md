---
"agents": patch
---

Sessions: `compact()` hands the compaction function at most the oldest 4 MiB of the visible history, so a long session that never compacted compacts in rounds instead of failing to load. See [Sessions](https://developers.cloudflare.com/agents/api-reference/sessions/#compaction).
