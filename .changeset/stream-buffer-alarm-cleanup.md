---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Reclaim resumable-stream buffers from an alarm so idle chats don't leak storage (#1706)

Resumable-stream chunk buffers (`cf_ai_chat_stream_*`) were only swept lazily when a _subsequent_ stream completed. A chat that received a single turn and then went idle never triggered that sweep, so its buffers lingered in the Durable Object's SQLite for the lifetime of the DO.

`AIChatAgent` and `Think` now arm a scheduled cleanup alarm whenever a stream starts and whenever it finishes (completes or errors). Arming on start guarantees that a stream whose DO is evicted mid-flight and never reaches a finish still gets a future sweep instead of leaking. This is the safety net for the non-durable path (e.g. `chatRecovery: false`, the `AIChatAgent` default): those turns don't run inside `runFiber`, so there's no leftover `keepAlive` alarm and no fiber-recovery scan, and if the client never reconnects nothing else wakes the DO. (Durable `runFiber` turns already self-heal — the `keepAlive` alarm survives eviction, wakes the DO, and recovery finalizes the stream, which arms cleanup — so arming on start is belt-and-suspenders there.) The alarm sweeps aged buffers via the retention windows below and re-arms only while reclaimable rows remain, so a fully-swept DO stops waking itself. Arming is idempotent so high-turn-count chats never accumulate cleanup schedules; the in-callback re-arm uses a fresh (non-idempotent) row so it survives the one-shot deletion of the firing schedule. No per-turn Durable Object and no change to the session DO lifecycle are required.

Retention is now split into two short, purpose-specific windows instead of a single 24h threshold: completed/errored buffers are kept for a brief **10-minute** reconnect-and-replay grace (the assistant message is persisted separately, so the buffer is only needed to replay a just-finished stream or deliver a terminal error frame to a reconnecting client), while abandoned in-flight (`streaming`) rows are kept for **1 hour** so an interrupted turn has ample time to be resumed or recovered before its buffer is presumed dead. The abandoned-row sweep keys off **last chunk activity** rather than stream start time, so a long-running stream that is still emitting chunks is never reclaimed mid-flight.

`ResumableStream` gains `cleanup(now?)` (force a sweep, bypassing the lazy interval gate) and `hasReclaimableStreams()` to support alarm-driven cleanup.
