---
"@cloudflare/think": minor
---

Think agents emit Cloudflare-native traces out of the box — zero configuration, no new API surface. Every turn's inference call is routed through `agents/observability/ai`, producing an `invoke_agent {agent class}` root span (carrying agent/conversation identity and `cloudflare.agents.turn.*` attributes: request id, trigger, admission, channel, continuation, generation) with `chat {model}` and `execute_tool {tool}` children in Workers Observability. Caller-provided `experimental_telemetry` merges over the injected metadata and still flows to the AI SDK's own telemetry when enabled. Drain loops now finalize the underlying model stream on early exit (in-stream error, stall abort, user abort) so operation spans close instead of leaking. On runtimes without the `tracing` API the tracer is a no-op.
