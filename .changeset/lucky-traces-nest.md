---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Keep AI SDK v7 `chat` and `execute_tool` spans under their `invoke_agent` operation span, record requested, approved, and denied `tool_approval` segments under `execute_tool`, and give v7 turns the same span attributes v6 records. The namespace wrapper establishes parent context before model or tool work without restoring unrelated `AsyncLocalStorage` state such as provider or tool authorization.

Spans that must not outlive their invocation now close at the end of that invocation rather than at the first `await`. Closing at the handoff ended every WebSocket-turn span before its result existed, so token counts, finish reason, response id and model, time to first chunk, AI Gateway log id, tool results, and error classification were all dropped, and durations reported as zero. A span that is still open when its invocation ends is closed and marked `cloudflare.agents.span.truncated` instead of passing as complete.

Work that does not run inside the handler that started it declares its own boundary: `ctx.waitUntil` bodies and queue drains, which outlive their handler, and chat turns in both Think and AIChatAgent. A turn is one unit of traced work and owns its boundary rather than borrowing its caller's — a handler that awaits its turn ends at the same moment anyway, while one that acks and returns, or an auto-continuation fired from a coalescing timer, would otherwise close every span in a turn that is still running.

On v7, turn metadata moved from `telemetry.metadata` to `runtimeContext`. The wrapper now projects the keys a caller marks through `telemetry.includeRuntimeContext`, so `cloudflare.agents.turn.*` and agent identity no longer disappear on v7; other included keys pass through as `cloudflare.agents.runtime_context.{key}`.
