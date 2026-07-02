---
"agents": minor
---

Add Cloudflare-native AI tracing to observability. `agents/observability` now exports a tracer built on the Workers runtime `tracing` API (`tracer`, `createTracer`, and span types; no-op on runtimes without the API), and the new `agents/observability/ai` entry exports `wrapAISDK` (AI SDK v6 wrapper instrumenting `generateText` / `streamText` / `generateObject` / `streamObject`, provider `doGenerate` / `doStream` calls, and tool execution) and `createAISDKTelemetry` (AI SDK v7 telemetry lifecycle adapter for `registerTelemetry`). Spans follow the OpenTelemetry GenAI semantic conventions and emit only scalar, non-sensitive attributes by default.
