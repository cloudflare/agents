---
"@cloudflare/think": minor
---

Think agents emit Cloudflare-native traces out of the box with no new configuration. Every turn's inference call is routed through `agents/observability/ai`, producing an `invoke_agent {agent class}` root span with `chat {model}` and `execute_tool {tool}` children in Workers Observability. Think supplies the class name as `gen_ai.agent.name`, the named instance as `gen_ai.agent.id`, the opaque Durable Object ID as `gen_ai.conversation.id`, and `cloudflare.agents.turn.*` attributes. Caller telemetry remains authoritative and can override these defaults. Conversation and tool payloads are not attached to spans; gateway-backed model calls reference the AI Gateway log when the provider exposes its ID. Drain loops finalize the underlying model stream on early exit so operation spans close instead of leaking. On runtimes without the `tracing` API the tracer is a no-op.
