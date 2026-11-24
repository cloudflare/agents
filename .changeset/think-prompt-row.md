---
"@cloudflare/think": patch
---

Think keeps its frozen system prompt only on the session and no longer writes a `_system_prompt` row. A row left by an earlier release is still carried forward, then removed at the next refresh. See [Think context](https://developers.cloudflare.com/agents/harnesses/think/context/).
