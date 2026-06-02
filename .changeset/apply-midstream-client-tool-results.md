---
"@cloudflare/think": patch
---

fix(think): apply client-tool results that arrive mid-stream so they aren't dropped (#1649 follow-up)

The serialization fix in #1657 stopped parallel results from clobbering each other, but a deeper window remained: during a streaming turn the assistant message lives only in the in-flight `StreamAccumulator` until `_persistAssistantMessage` writes it at the turn boundary. The `tool-input-available` chunk is broadcast to the client mid-stream, so a fast client can resolve the tool and send `cf_agent_tool_result` before the message is ever persisted. `_applyToolUpdateToMessages` only scanned durable storage, so the apply silently no-op'd, the end-of-stream persist then wrote `input-available`, and the auto-continuation's transcript repair errored the call with "The tool call was interrupted before a result was recorded."

`_applyToolUpdateToMessages` now applies the update to the in-flight accumulator (in place, so it rides into the eventual persist) in addition to durable storage, mirroring `@cloudflare/ai-chat`'s `_streamingMessage` handling. The accumulator is exposed via `_streamingAssistant` for the duration of each streaming turn and cleared on every exit path and on `resetTurnState`. Applying to both locations is monotonic, so a stall-recovery partial persist can't downgrade an already-applied result back to `input-available`.
