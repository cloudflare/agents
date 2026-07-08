---
"agents": minor
---

Add `agents/observability/ai` with `wrapAISDK` for AI SDK v6 and `createAISDKTelemetry` for AI SDK v7. Instrumented operations produce Cloudflare-native spans using the scalar OpenTelemetry GenAI attributes supported by Workers: `invoke_agent {agent}`, `chat {model}`, and `execute_tool {tool}` spans with request settings, token usage, scalar finish reasons, tool-call IDs, and model-call time to first chunk. Failures and cancellations are classified without recording prompts, messages, tool content, schemas, headers, provider options, raw outputs, or raw error messages. The underlying Workers tracing adapter remains internal.
