---
"agents": patch
---

Agents SDK spans (agent lifecycle, `wrapAISDK`, Think) now set span status `error` on failure, where the Workers runtime supports `Span.setStatus()`; attributes are unchanged. See [Observability](https://github.com/cloudflare/agents/blob/main/docs/agents/observability.md#ai-sdk-tracing).
