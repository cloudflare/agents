---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Reconcile reused tool-call IDs one-to-one so later assistant messages and tool outputs stay attached to the correct turn.
