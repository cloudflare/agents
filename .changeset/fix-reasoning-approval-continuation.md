---
"@cloudflare/ai-chat": patch
---

Fixed approval auto-continuation streams so reasoning chunks keep a valid `reasoning-start` before `reasoning-delta` sequence when continuing from an assistant message that already has reasoning, and preserve the continuation reasoning in the final persisted message.
