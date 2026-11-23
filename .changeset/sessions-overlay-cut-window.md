---
"agents": patch
---

Sessions applies a compaction overlay when a byte-budgeted `getRecentHistory()` or a path longer than 10,001 rows stops the read before the overlay's start, so long compacted chats in Think and `AIChatAgent` no longer send raw history to the model (#2871), and path reads no longer scan every row in the session. See [Sessions](https://developers.cloudflare.com/agents/api-reference/sessions/#compaction).
