---
"agents": minor
---

Add `agents/observability/ai` with `wrapAISDK` for AI SDK v6 and `createAISDKTelemetry` for AI SDK v7. Both project Cloudflare-native `invoke_agent {agent}`, `chat {model}`, and `execute_tool {tool}` spans using scalar OpenTelemetry GenAI attributes, including request settings, token usage, finish reasons, tool-call IDs, model-call time to first chunk, bounded AI SDK v6 approval lifecycle spans, and conditional AI Gateway log references. Payload storage is opt-in: `storeMessages` writes full input/output message arrays to `chat` (including tool calls, dropping oldest messages past the budget while protecting the first two), and `storeTools` writes arguments/results to `execute_tool`. The flags themselves are never emitted as span attributes. Schemas, request headers, provider options, and raw errors remain excluded.
