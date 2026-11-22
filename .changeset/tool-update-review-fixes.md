---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

An approval given before a tool's final input arrives keeps the final input, a result for a tool-call id a later reply reused settles the later call, and a tool update no longer broadcasts an older copy of the streaming reply.
