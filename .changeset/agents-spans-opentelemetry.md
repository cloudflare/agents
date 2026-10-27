---
"agents": minor
---

Agents SDK spans (agent lifecycle, `wrapAISDK`, Think) are now recorded through the OpenTelemetry API and register the Workers tracing bridge automatically; names and attributes are unchanged, and failures also set span status `ERROR`. See [Observability](https://github.com/cloudflare/agents/blob/main/docs/agents/observability.md#opentelemetry).
