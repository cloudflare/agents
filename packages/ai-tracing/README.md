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
      conversationId: "conversation-123",
    },
  },
});
```

## Safety Defaults

The wrapper does not emit prompts, messages, system instructions, tool inputs, tool outputs, schemas, headers, provider options, raw model outputs, or raw error messages.

Only scalar attributes are emitted. Runtime/tool context attributes are opt-in through `wrapAISDK` config:

```ts
const traced = wrapAISDK(ai, {
  includeRuntimeContext: ["requestId"],
  includeToolsContext: {
    weather: ["defaultUnit"],
  },
});
```

## Not Supported

The v6 wrapper intentionally does not instrument:

- `embed` / `embedMany`
- `rerank`
- `Agent` / `ToolLoopAgent`
- automatic instrumentation or loader hooks
- prompt/message/tool-definition content capture

Use this as an explicit compatibility wrapper. A future AI SDK v7 integration should use the AI SDK telemetry lifecycle API instead of extending the v6 wrapper surface.
