---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix AI SDK v7 telemetry, which produced spans with no token counts, no finish reason, no tool results and zero durations.

Spans that must not outlive their invocation now close at the end of it rather than at the first `await`. Closing at the handoff ended every WebSocket-turn span before its result existed, so every finish-time attribute was dropped. A span still open when its invocation ends is closed and marked `cloudflare.agents.span.truncated` instead of passing as complete, approval spans decided asynchronously included. A chat turn owns its own boundary rather than its caller's, so a turn that is not awaited — an ack-and-return submit, or an auto-continuation fired from a timer — is no longer cut short by the handler that started it. `generateText` is bounded on the same terms as `streamText`, and a turn that fails or is cancelled keeps the usage it already reported.

`chat` and `execute_tool` spans sit under their `invoke_agent` operation span on v7, where they were previously emitted as unrelated roots, and `tool_approval` segments sit under `execute_tool`.

v7 has no telemetry metadata bag, so identity and turn context arrive through `runtimeContext` and `telemetry.includeRuntimeContext`. Reserved keys project onto the attributes v6 already emits, so a query written against v6 traces still matches v7 ones; other included keys pass through as `cloudflare.agents.runtime_context.{key}`, and context the caller did not mark stays off the span.
