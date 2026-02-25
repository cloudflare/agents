---
"@cloudflare/ai-chat": patch
---

Terminate the WebSocket chat transport stream when the abort signal fires so
clients exit the "streaming" state after stop/cancel.
