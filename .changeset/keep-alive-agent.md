---
"agents": minor
"@cloudflare/ai-chat": patch
---

Add experimental `keepAlive()` and `keepAliveWhile()` methods to the Agent class. Keeps the Durable Object alive via alarm heartbeats (every 30 seconds), preventing idle eviction during long-running work. `keepAlive()` returns a disposer function; `keepAliveWhile(fn)` runs an async function and automatically cleans up the heartbeat when it completes.

`AIChatAgent` now automatically calls `keepAliveWhile()` during `_reply()` streaming, preventing idle eviction during long LLM generations.
