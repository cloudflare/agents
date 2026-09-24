---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat stream chunk frames now carry a `seq` that keeps counting across streams restarted under the same request (an overflow retry), and `useAgentChat` skips replayed continuation chunks it has already applied. Reconnecting during a tool continuation previously replayed the whole continuation onto the assistant message that already held it, so its text appeared twice.
