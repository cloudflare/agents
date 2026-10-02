---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Settle approved tool calls that never ran once the conversation moves past them, so later turns don't send unresolved tool calls (#2382). See [Human in the loop](https://github.com/cloudflare/agents/blob/main/docs/agents/human-in-the-loop.md).
