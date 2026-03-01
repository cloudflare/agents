---
"agents": minor
"@cloudflare/ai-chat": patch
---

Add experimental `keepAlive()` method to the Agent class. Keeps the Durable Object alive via alarm heartbeats (every 30 seconds), preventing idle eviction during long-running work. Returns a disposer function to stop the heartbeat.

`AIChatAgent` now automatically calls `keepAlive()` during `_reply()` streaming, preventing idle eviction during long LLM generations.
