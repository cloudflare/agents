---
"@cloudflare/ai-tracing": minor
---

Initial release of `@cloudflare/ai-tracing`: Cloudflare-native tracing helpers for AI agents. `@cloudflare/ai-tracing/ai-sdk` exports `wrapAISDK` (AI SDK v6 wrapper instrumenting `generateText` / `streamText` / `generateObject` / `streamObject`, provider `doGenerate` / `doStream` calls, and tool execution) and `createAISDKTelemetry` (AI SDK v7 telemetry lifecycle adapter for `registerTelemetry`). Spans follow the OpenTelemetry GenAI semantic conventions and emit only scalar, non-sensitive attributes by default.
