---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

`AIChatAgent` and `Think` now run on one shared turn core and follow the same rules: a reply that was cut off is stored with its unanswered tool calls settled, so the chat never waits on a tool call nothing will answer; a request's tools apply when its turn starts; and a request cancelled in the queue never runs.
