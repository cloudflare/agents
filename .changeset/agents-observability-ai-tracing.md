---
"agents": minor
---

Add `agents/observability/ai` with `wrapAISDK` for AI SDK v6 and `createAISDKTelemetry` for AI SDK v7. Both project Cloudflare-native `invoke_agent {agent}`, `chat {model}`, and `execute_tool {tool}` spans using the scalar OpenTelemetry GenAI attributes supported by Workers, including request settings, token usage, finish reasons, tool-call IDs, model-call time to first chunk, and bounded AI SDK v6 tool-approval lifecycle spans. When an actual gateway response exposes an AI Gateway log ID, the corresponding `chat` span includes `cloudflare.ai_gateway.log.id`; it is omitted otherwise. Prompts, messages, model output, tool arguments/results, schemas, request headers, provider options, and raw error messages are never attached to spans. The underlying Workers tracing adapter remains internal.
