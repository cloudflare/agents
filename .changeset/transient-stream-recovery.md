---
"@cloudflare/think": patch
"agents": patch
---

Harden transient chat recovery across Think and AI Chat, including retry budgeting, cancellation, terminal error delivery, and recovery after restarts. See the [`agents/chat` recovery helpers](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md).
