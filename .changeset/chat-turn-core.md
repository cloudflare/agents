---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` now run on one shared turn core. `Think` stops a recovery the user cancels while it is running and no longer runs a request cancelled while it waited in the queue, and `AIChatAgent` no longer waits a second for a tool result whose tool call does not exist.
