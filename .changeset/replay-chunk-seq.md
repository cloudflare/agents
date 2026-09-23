---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat stream chunk frames now carry a per-stream `seq`, and `useAgentChat` skips replayed continuation chunks it has already applied. Reconnecting during a tool continuation previously replayed the whole continuation onto the assistant message that already held it, so its text appeared twice.
