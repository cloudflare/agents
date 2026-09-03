---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Replatform chat's resumable streams onto the `agents/streams` capability.

`ResumableStream` is now a thin adapter over `Streams`: chat's in-flight turn output lives in the shared durable chunk log (`cf_agents_streams` / `cf_agents_stream_chunks`), packed ~10 wire chunks per stored segment for write economy, with completion/error mapped onto stream settlement and retention keyed off the stream row's `updated_at` (sweeps no longer scan the chunk table). Existing `cf_ai_chat_stream_*` tables migrate wholesale — including an in-flight stream — on first construction after upgrade, then are dropped. `AIChatAgent` and `Think` expose the backing capability as `readonly streams`, so any `streams.read()` consumer on the same Durable Object can observe chat streams. The chat wire protocol, replay handshake, and recovery behavior are unchanged.
