---
"@cloudflare/ai-chat": patch
"agents": patch
---

`AIChatAgent`'s legacy message lift, hydration, `get-messages` body, merged queued messages and provider tool payload truncation move out of the class into modules, with no change in behaviour.
