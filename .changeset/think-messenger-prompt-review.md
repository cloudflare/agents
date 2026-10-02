---
"@cloudflare/think": patch
"agents": patch
---

Messenger replies hold the thread lock and retain queued follow-ups during slow delivery; typing updates are serialized and settle before reply text arrives. See [Think messengers](https://github.com/cloudflare/agents/blob/main/docs/think/messengers.md).
