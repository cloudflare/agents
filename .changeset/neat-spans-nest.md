---
"agents": patch
---

Use `wrapAISDK()` as the single AI SDK v6 and v7 tracing integration, removing the separate `createAISDKTelemetry()` callback adapter that could not preserve the `invoke_agent` parent hierarchy. Mark asynchronously decided AI SDK v7 top-level approval spans when they outlive their invocation.

Existing `createAISDKTelemetry()` users must:

- Remove it from `registerTelemetry()` and per-call telemetry integrations.
- Wrap the AI SDK namespace and call the wrapped functions instead:

  ```ts
  import * as ai from "ai";
  import { wrapAISDK } from "agents/observability/ai";

  const tracedAI = wrapAISDK(ai, {
    storeMessages: true,
    storeTools: true
  });

  await tracedAI.generateText(/* ... */);
  ```

- Update telemetry queries that use the removed callback-only `cloudflare.agents.call.id` or `cloudflare.agents.tool_context.*` attributes.
