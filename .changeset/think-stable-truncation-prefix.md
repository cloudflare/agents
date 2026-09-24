---
"@cloudflare/think": patch
---

Keep the prompt-cache prefix stable across turns when older messages are truncated (#2200). The read-time truncation cutoff moved forward every turn, so each turn rewrote a message near the end of the cached prefix. Think now cuts at a multiple of 8 messages, keeping at least the 4 most recent messages whole and rewriting the prefix about once every 4 turns instead of every turn. Set the new `truncationStep` class field to change the step, or to `1` to restore the previous cut-every-turn behavior for models with a small context window. Media eviction and compaction were measured and already rewrite the prefix once per message or compaction.
