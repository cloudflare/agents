---
"@cloudflare/ai-chat": minor
---

`AIChatAgent` now uses an event-driven auto-continuation barrier that parks
indefinitely on an incomplete parallel tool batch instead of force-continuing
after a fixed timeout.

Previously, when a turn ended with several parallel client tool calls and only
some results had arrived, `AIChatAgent` ran the completeness barrier _inside_
the continuation turn and polled for up to 60s
(`AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS`), after which it continued
inference against whatever results had landed — potentially a half-complete tool
batch. The barrier is now event-driven and runs _before_ the continuation is
enqueued (converging onto `@cloudflare/think`'s model): it fires only once every
result in the batch has arrived, re-arms as each sibling result is applied and
when a streaming turn finalizes, guards against double-fire, and is gated on no
active stream. There is **no orphan timeout** — a batch with a never-arriving
sibling now parks budget-free until it completes (the same way a turn already
parks on a pending HITL/client interaction) rather than force-continuing with
missing results.

This is a behavior change for the rare stuck-tool case: a result that never
arrives no longer triggers a continuation after 60s; it parks until the missing
result lands (or a later user turn / chat recovery repairs the transcript). A
parked continuation leaves the same on-disk signature as a HITL park, so a
deploy/crash mid-park recovers by re-arming rather than terminalizing.
