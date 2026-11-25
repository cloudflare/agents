---
"agents": patch
"@cloudflare/think": patch
---

Think's context follows one rule for what the model is sent. A block the model writes itself with `set_context` is never sent back to it; the tool call is the record. A block your code writes with `setBlock()` or `appendToBlock()` is sent once, after the next user message. The prompt is rebuilt from the blocks at the first turn after any compaction: Think now also does this after `addCompaction()`, and ThinkHarness after it compacts. See [Think context](https://developers.cloudflare.com/agents/harnesses/think/context/).
