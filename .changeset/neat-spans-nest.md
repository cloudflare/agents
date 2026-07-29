---
"agents": patch
---

Use `wrapAISDK()` as the single AI SDK v6 and v7 tracing integration, removing the separate `createAISDKTelemetry()` callback adapter that could not preserve the `invoke_agent` parent hierarchy. Mark asynchronously decided AI SDK v7 top-level approval spans when they outlive their invocation.
