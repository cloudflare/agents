---
"agents": patch
"@cloudflare/think": patch
---

`onChatResponse` still fires, with `recovered: true`, for a turn persisted just before a Durable Object reset (#2266, #1842). See [Think lifecycle hooks](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md).
