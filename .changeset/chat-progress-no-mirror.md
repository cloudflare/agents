---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat turns no longer write the recovery progress marker to a KV key when a stream ends or a sub-agent's output is credited: one storage write less per turn.
