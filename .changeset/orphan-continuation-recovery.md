---
"@cloudflare/think": patch
"agents": patch
---

Fix Think recovering an interrupted continuation as a duplicate assistant message; recovery now updates the continued message, keeping its earlier parts and metadata. See [Chat Recovery](https://github.com/cloudflare/agents/blob/main/docs/think/index.md#chat-recovery).
