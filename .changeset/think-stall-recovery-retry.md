---
"@cloudflare/think": patch
---

Stream-stall recovery retries stalls before the first chunk and now calls `onChatRecovery`. See [Think lifecycle hooks](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md).
