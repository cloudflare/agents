---
"agents": patch
"@cloudflare/think": patch
---

Preserve structured tool output shapes when truncating older messages or oversized persisted rows, preventing custom `toModelOutput` handlers from crashing or mis-replaying compacted results.

Also harden Think's workspace `read` tool so legacy raw-string read outputs replay as text instead of stalling subsequent turns.
