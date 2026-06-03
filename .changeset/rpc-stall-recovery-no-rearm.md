---
"@cloudflare/think": patch
---

fix(think): don't re-arm the auto-continuation barrier when an RPC stall routes into bounded recovery (#1667 follow-up)

The RPC streaming path (`_streamResultToRpcCallback`) re-armed the auto-continuation coalesce timer in its `finally` even on the stream-stall recovery early-returns (`scheduled`/`exhausted`), unlike the WebSocket `_streamResult` recovery paths which deliberately do a plain `_streamingAssistant = null` without re-arming. When a parallel tool batch had a pending continuation at the moment the stall watchdog fired, that re-arm could fire a second continuation alongside the alarm-scheduled recovery continuation — a spurious double model invocation on the turn queue. The RPC recovery early-returns now mirror the WebSocket path (plain clear, no re-arm); the scheduled recovery continuation re-runs the turn and its own stream finalize re-triggers the held barrier exactly once.
