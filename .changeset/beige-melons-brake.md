---
"@cloudflare/ai-chat": patch
"agents": patch
---

fix: eagerly load this.mcp.jsonSchema in ai chat agent

fixes https://github.com/cloudflare/agents/issues/718

Because of hibernation, our preloaded this.mcp.jsonSchema can be lost when the DO wakes up again. We should probably move this helper into anotherl ibrary. Until then, a patch is to eagerly load it when an ai chat agent starts up.

We also throw the error only if there's an active mcp connection.
