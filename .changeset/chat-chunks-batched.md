---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat turns store their stream chunks one per sequence number in batches of ten, with fewer storage reads per write. Recovery work units (`maxRecoveryWork`, `ctx.work`) now count ten stored chunks each; a tool call no longer counts as a unit of its own. See [Recovery work units](https://developers.cloudflare.com/agents/api-reference/chat-agents/#recovery-work-units).
