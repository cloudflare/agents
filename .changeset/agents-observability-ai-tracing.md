---
"agents": minor
---

Add `agents/observability/ai` with `wrapAISDK` for AI SDK v6 and `createAISDKTelemetry` for AI SDK v7. Instrumented operations produce OpenTelemetry GenAI spans: `invoke_agent {agent}` roots with `chat {model}` and `execute_tool {tool}` children, request parameters, token usage, finish reasons, tool-call IDs, and time to first chunk. Failures and cancellations are classified without recording prompts, messages, tool content, schemas, headers, provider options, raw outputs, or raw error messages. The underlying Workers tracing adapter remains internal.
