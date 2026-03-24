---
"@cloudflare/ai-chat": patch
---

Fix multi-tab tool continuations so only the originating connection waits for the pending resume handshake, while other tabs continue receiving live stream updates.
