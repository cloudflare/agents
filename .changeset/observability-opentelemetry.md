---
"agents": minor
---

Add `registerOpenTelemetry()` to `agents/observability`, which records spans from OpenTelemetry-instrumented libraries (the MCP SDK, AI SDK telemetry, your own tracers) as Workers trace spans. See [Observability](https://github.com/cloudflare/agents/blob/main/docs/agents/observability.md#opentelemetry).
