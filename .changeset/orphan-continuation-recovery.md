---
"@cloudflare/think": patch
"agents": patch
---

Fix Think recovering an interrupted continuation as a duplicate assistant message; recovery now rebuilds the message it continues. Think now requires `agents` >=0.34.0. See [Chat Recovery](https://github.com/cloudflare/agents/blob/main/docs/think/index.md#chat-recovery).
