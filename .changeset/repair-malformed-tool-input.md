---
"@cloudflare/think": patch
---

Unwedge sessions corrupted by a malformed `tool_use.input`, and make the failure observable.

1. **Read-side repair gap.** Transcript repair already normalized a `null`/`undefined`/stringified-JSON tool input, but left an empty string `""`, an array, and other non-object primitives untouched — so a session that persisted one of those shapes before the write-side guard shipped kept 400ing forever with `tool_use.input: Input should be an object` (Anthropic rejects array inputs the same way it rejects `""`/`null`). `_normalizeToolInput` now delegates to the shared `normalizeToolInput`, collapsing any non-object input to `{}` so the pre-send repair pass rescues the session on its next turn.

2. **Observability.** An AI-SDK provider error surfaces as a stream error part, not a thrown exception, so it took the in-band `error` branch that emitted `message:error` but never `chat:request:failed`. That branch now also emits `chat:request:failed` (`stage: "stream"`), so observers and turn-count telemetry see the post-`beforeTurn`, in-stream failure class without needing to know whether the error threw or arrived as a chunk.
