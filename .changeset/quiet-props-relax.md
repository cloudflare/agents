---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Allow interfaces as `Props`. `Agent`, `AIChatAgent`, `Think`, `Lifecycle` and the `getAgentByName` and routing options now constrain and default `Props` to `object` instead of `Record<string, unknown>`, which an interface cannot satisfy because it has no index signature.
