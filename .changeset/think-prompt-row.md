---
"@cloudflare/think": patch
"agents": patch
---

Think keeps each system prompt it records only on the session. A prompt frozen by an earlier release (the `_system_prompt` row, or a custom `withCachedPrompt()` store) is read and no longer written: it is what the turns from before the upgrade are sent, so regenerating one of those answers sends it again, after a refresh or an eviction too. A conversation started after the upgrade, or after the chat is cleared, never uses it. `Context`'s `promptStore` option is read only. See [Think context](https://developers.cloudflare.com/agents/harnesses/think/context/).
