---
"agents": patch
"@cloudflare/think": patch
---

Reduce Think Durable Object SQLite reads during normal wakes and text-only turns.

Think now avoids automatic media-eviction scans until hydration has been windowed or an oversized appended message has been observed. The shared resumable stream buffer also avoids per-wake metadata-column introspection by creating new tables with the current columns and lazily migrating legacy tables only when a stream write needs it.
