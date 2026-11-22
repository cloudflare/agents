---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

A waiting message is never dropped (only a clear discards it), a large message with a large body can wait, a request that ends before its turn can be resumed by request id, and Think closes the stream after a stop found while routing a stall.
