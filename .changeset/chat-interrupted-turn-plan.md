---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A chat turn found interrupted after a restart is planned the same way in both hosts: the turn's question that is still the latest message is answered again, the latest reply is continued, and a turn whose conversation moved on is skipped without scheduling anything.
