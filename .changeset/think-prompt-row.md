---
"@cloudflare/think": patch
"agents": patch
---

Think keeps each system prompt it records only on the session and no longer writes a `_system_prompt` row. A row left by an earlier release is kept as is: it is the prompt the turns before the upgrade were sent with, so regenerating one of those answers sends it again, after a refresh too. See [Think context](https://developers.cloudflare.com/agents/harnesses/think/context/).
