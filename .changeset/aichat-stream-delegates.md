---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Remove the test-only stream delegates from `AIChatAgent` and the `_cleanupStreamBuffers` callback from both hosts. A cleanup alarm left by an old version now finds no callback; the next stream start reclaims the stream rows instead.
