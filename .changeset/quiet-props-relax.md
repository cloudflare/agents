---
"agents": patch
"@cloudflare/ai-chat": patch
---

Allow interfaces with named fields to be used as startup props for `Agent`, `AIChatAgent`, legacy `McpAgent`, `Lifecycle`, `getAgentByName`, and Agent routing. Props generics now use an `object` constraint while their defaults remain `Record<string, unknown>`.
