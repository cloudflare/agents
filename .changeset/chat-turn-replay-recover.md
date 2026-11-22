---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A replayed chat-turn Task run hands its turn straight to chat recovery instead of going through the fiber recovery hook.
