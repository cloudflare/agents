---
"agents": patch
"@cloudflare/think": patch
---

Stop storing compaction summaries that clients echo back, and hide duplicates already stored (#1984). See [Sessions](https://github.com/cloudflare/agents/blob/main/docs/agents/sessions.md).
