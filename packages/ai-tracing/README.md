# @cloudflare/ai-tracing

Cloudflare-native tracing helpers for AI agents.

## AI SDK Wrapper

`@cloudflare/ai-tracing/ai-sdk` exports an explicit Vercel AI SDK v6-compatible wrapper:

```ts
import * as ai from "ai";
import { wrapAISDK } from "@cloudflare/ai-tracing/ai-sdk";

const { generateText, streamText } = wrapAISDK(ai);
```

The wrapper instruments only the common agent text-generation path:

- `generateText`
- `streamText`
- `generateObject`
- `streamObject`

For each operation it creates a root `gen_ai.operation` span. When `wrapLanguageModel` is available, it also wraps `params.model` to create child `gen_ai.chat` spans around provider `doGenerate` / `doStream` calls. For `generateText` and `streamText`, it wraps `params.tools.*.execute` to create `gen_ai.execute_tool` spans.

Stream spans stay open until the returned stream is consumed, cancelled, errors, or is returned early.

## AI SDK v7 Telemetry

For AI SDK v7, use the telemetry lifecycle adapter instead of wrapping the SDK namespace:

```ts
import { registerTelemetry } from "ai";
import { createAISDKTelemetry } from "@cloudflare/ai-tracing/ai-sdk";

registerTelemetry(createAISDKTelemetry());
```

The v7 adapter instruments the same text/object generation operations through AI SDK telemetry callbacks. It creates operation, language-model, and tool-execution spans, correlated with safe `ai.call.id` / `ai.tool.call_id` attributes.

For v7 runtime/tool context, use AI SDK telemetry inclusion on each call. AI SDK v7 filters `runtimeContext` and `toolsContext` before telemetry integrations receive events; the adapter emits scalar fields that the SDK includes in the telemetry event and drops object/array values:

```ts
await streamText({
  model,
  prompt: "...",
  runtimeContext: {
    requestId: "req-123",
    tenantId: "tenant-1",
    privateObject: { token: "not emitted" }
  },
  telemetry: {
    functionId: "support-agent",
    includeRuntimeContext: {
      requestId: true,
      tenantId: true,
      privateObject: true
    },
    includeToolsContext: {
      weather: {
        defaultUnit: true
      }
    }
  },
  toolsContext: {
    weather: {
      defaultUnit: "fahrenheit",
      privateObject: { token: "not emitted" }
    }
  },
  tools: {
    weather: tool({
      contextSchema: z.object({
        defaultUnit: z.string(),
        privateObject: z.object({ token: z.string() })
      }),
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }, { context }) => ({
        city,
        unit: context.defaultUnit
      })
    })
  }
});
```

This emits `ai.runtime_context.requestId`, `ai.runtime_context.tenantId`, and `ai.tool_context.weather.defaultUnit`, but not the object-valued fields.

`onEnd` and `onFinish` are both handled as operation finalizers for compatibility with the evolving v7 telemetry type names.

## Agent and Conversation Attributes

`gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`, and `gen_ai.conversation.id` are read from the AI SDK's own `experimental_telemetry` option, per call — there is no `wrapAISDK` config for these:

```ts
await generateText({
  model,
  prompt: "...",
  experimental_telemetry: {
    // Falls back to gen_ai.agent.name when metadata.agentName is absent.
    functionId: "support-agent",
    metadata: {
      agentId: "agent-123",
      agentVersion: "2026-07-01",
      conversationId: "conversation-123"
    }
  }
});
```

## Safety Defaults

The wrapper does not emit prompts, messages, system instructions, tool inputs, tool outputs, schemas, headers, provider options, raw model outputs, or raw error messages.

Only scalar attributes are emitted. Runtime/tool context attributes are opt-in through `wrapAISDK` config:

```ts
const traced = wrapAISDK(ai, {
  includeRuntimeContext: ["requestId"],
  includeToolsContext: {
    weather: ["defaultUnit"]
  }
});
```

For v7, do not pass context allowlists to `createAISDKTelemetry()`. Use AI SDK's per-call `telemetry.includeRuntimeContext` and `telemetry.includeToolsContext` instead, as shown above.

## Not Supported

The v6 wrapper intentionally does not instrument:

- `embed` / `embedMany`
- `rerank`
- `Agent` / `ToolLoopAgent`
- automatic instrumentation or loader hooks
- prompt/message/tool-definition content capture

Use this as an explicit compatibility wrapper. AI SDK v7 support uses the SDK telemetry lifecycle API instead of extending the v6 wrapper surface.
