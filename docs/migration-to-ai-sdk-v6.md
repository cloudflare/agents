# Migration Guide: Upgrading Agents SDK to AI SDK v6

This guide helps you migrate your existing code from **AI SDK v5.x** to **AI SDK v6.x** when using the Agents SDK.

## Overview

AI SDK v6 introduces new capabilities like tool approval, but **migrating from v5 to v6 should be straightforward with minimal code changes** for most users.

## Installation

Update your dependencies to use the latest versions:

```bash
npm install ai@latest @ai-sdk/react@latest @ai-sdk/openai@latest
```

## Breaking Changes

### 1. Unified Tool Pattern (Client-Side Tools)

The Agents SDK now uses AI SDK v6's unified tool pattern. The old `AITool`, `toolsRequiringConfirmation`, and `experimental_automaticToolResolution` options are deprecated.

#### Before (v5 - Deprecated):

```typescript
// Client: Define client-side tools with AITool type
const clientTools: Record<string, AITool> = {
  getLocation: {
    description: "Get user location",
    parameters: { type: "object", properties: {} },
    execute: async () => navigator.geolocation.getCurrentPosition(...)
  },
  askConfirmation: {
    description: "Ask user for confirmation",
    parameters: { type: "object", properties: { message: { type: "string" } } }
    // No execute = requires confirmation
  }
};

useAgentChat({
  agent,
  tools: clientTools,
  experimental_automaticToolResolution: true,
  toolsRequiringConfirmation: ["askConfirmation"]
});

// Server: Convert client schemas to tools
const response = await this.onChatMessage(onFinish, { clientTools });
const tools = {
  ...serverTools,
  ...createToolsFromClientSchemas(clientTools)
};
```

#### After (v6 - Recommended):

```typescript
// Server: Define ALL tools on the server
const tools = {
  // Server-executed tool
  getWeather: tool({
    description: "Get weather for a city",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => fetchWeather(city)
  }),

  // Client-executed tool (no execute = client handles via onToolCall)
  getLocation: tool({
    description: "Get user location from browser",
    inputSchema: z.object({})
    // No execute function
  }),

  // Tool requiring approval (dynamic based on input)
  processPayment: tool({
    description: "Process a payment",
    inputSchema: z.object({ amount: z.number() }),
    needsApproval: async ({ amount }) => amount > 100,
    execute: async ({ amount }) => charge(amount)
  })
};

// Client: Handle client-side tools via onToolCall callback
useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName === "getLocation") {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject);
      });
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        }
      });
    }
  }
});
```

**Key benefits of the new pattern:**

- **Server-defined tools**: All tools are defined in one place on the server
- **Dynamic approval**: Use `needsApproval` to conditionally require user confirmation
- **Cleaner client code**: Use `onToolCall` callback instead of managing tool configs
- **Type safety**: Full TypeScript support with proper tool typing

### 2. `convertToModelMessages()` is now async

The `convertToModelMessages()` function is now asynchronous. Update all calls to await the result.

#### Before (v5):

```typescript
import { convertToModelMessages } from "ai";

const result = streamText({
  messages: convertToModelMessages(this.messages),
  model: openai("gpt-4o")
});
```

#### After (v6):

```typescript
import { convertToModelMessages } from "ai";

const result = streamText({
  messages: await convertToModelMessages(this.messages),
  model: openai("gpt-4o")
});
```

### 3. `CoreMessage` type removed

The `CoreMessage` type has been removed. Use `ModelMessage` instead, and replace `convertToCoreMessages()` with `convertToModelMessages()`.

#### Before (v5):

```typescript
import { convertToCoreMessages, type CoreMessage } from "ai";

const coreMessages: CoreMessage[] = convertToCoreMessages(messages);
```

#### After (v6):

```typescript
import { convertToModelMessages, type ModelMessage } from "ai";

const modelMessages: ModelMessage[] = await convertToModelMessages(messages);
```

### 4. `isToolUIPart` and `getToolName` behavior changed

In v5, `isToolUIPart` and `getToolName` only checked static tool parts. In v6, they now check **both static and dynamic tool parts**.

If you need the v5 behavior (static-only checks), use the new functions:

- `isToolUIPart` (v5) → `isStaticToolUIPart` (v6)
- `getToolName` (v5) → `getStaticToolName` (v6)

**For most Agents SDK users, no changes are needed** since the v6 behavior (checking both static and dynamic) is typically what you want.

### 5. `generateObject` mode option removed

The `mode` option for `generateObject` has been removed. Remove any `mode: "json"` or similar options.

#### Before (v5):

```typescript
const result = await generateObject({
  mode: "json",
  model,
  schema,
  prompt
});
```

#### After (v6):

```typescript
const result = await generateObject({
  model,
  schema,
  prompt
});
```

## Deprecations

### Agents SDK Deprecated APIs

The following Agents SDK APIs are deprecated in favor of the unified tool pattern:

| Deprecated                             | Replacement                                      |
| -------------------------------------- | ------------------------------------------------ |
| `AITool` type                          | Use AI SDK's `tool()` function on server         |
| `extractClientToolSchemas()`           | Define tools on server, no client schemas needed |
| `createToolsFromClientSchemas()`       | Define tools on server with `tool()`             |
| `toolsRequiringConfirmation` option    | Use `needsApproval` on server tools              |
| `experimental_automaticToolResolution` | Use `onToolCall` callback                        |
| `tools` option in `useAgentChat`       | Use `onToolCall` for client-side execution       |
| `addToolResult()`                      | Use `addToolOutput()`                            |

### `generateObject` and `streamObject` are deprecated

While still functional in v6, these functions are deprecated. The recommended approach is to use `generateText`/`streamText` with the `Output.object()` helper:

#### Before (v5):

```typescript
import { generateObject } from "ai";

const { object } = await generateObject({
  model: openai("gpt-4"),
  schema: z.object({ name: z.string() }),
  prompt: "Generate a name"
});
```

#### After (v6 recommended):

```typescript
import { generateText, Output, stepCountIs } from "ai";

const { output } = await generateText({
  model: openai("gpt-4"),
  output: Output.object({
    schema: z.object({ name: z.string() })
  }),
  stopWhen: stepCountIs(2),
  prompt: "Generate a name"
});
```

> **Note**: When using structured output with `generateText`, you must configure multiple steps with `stopWhen` because generating the structured output is itself a step.

## New Features in v6

### Agent Abstraction

AI SDK v6 introduces a new `Agent` interface and `ToolLoopAgent` class for building agents with full control over execution flow:

```typescript
import { ToolLoopAgent } from "ai";

const weatherAgent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  instructions: "You are a helpful weather assistant.",
  tools: {
    weather: weatherTool
  }
});

const result = await weatherAgent.generate({
  prompt: "What is the weather in San Francisco?"
});
```

### Tool Execution Approval

Request user confirmation before executing tools with the `needsApproval` option:

```typescript
import { tool } from "ai";

const paymentTool = tool({
  description: "Process a payment",
  inputSchema: z.object({
    amount: z.number(),
    recipient: z.string()
  }),
  needsApproval: async ({ amount }) => amount > 1000,
  execute: async ({ amount, recipient }) => {
    return await processPayment(amount, recipient);
  }
});
```

### Structured Output with Tool Calling

You can now generate structured output alongside multi-step tool calling:

```typescript
import { ToolLoopAgent, Output, tool } from "ai";

const agent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  tools: { weather: weatherTool },
  output: Output.object({
    schema: z.object({
      summary: z.string(),
      temperature: z.number(),
      recommendation: z.string()
    })
  })
});
```

### Reranking Support

AI SDK v6 adds native support for reranking documents:

```typescript
import { rerank } from "ai";
import { cohere } from "@ai-sdk/cohere";

const { ranking } = await rerank({
  model: cohere.reranking("rerank-v3.5"),
  documents: ["sunny day", "rainy afternoon", "snowy night"],
  query: "talk about rain",
  topN: 2
});
```

## Third-Party Provider Compatibility

Some third-party AI SDK providers may not yet support v6. If you encounter type errors with providers like `workers-ai-provider`, you may need to:

1. Wait for the provider to release a v6-compatible version
2. Use a type assertion as a temporary workaround:

```typescript
// Temporary workaround for incompatible providers
model: workersai("model-name") as unknown as Parameters<
  typeof streamText
>[0]["model"];
```

## Migration Checklist

### Package Updates

- Update `ai` package to `^6.0.0`
- Update `@ai-sdk/react` to `^3.0.0`
- Update `@ai-sdk/openai` (and other providers) to `^3.0.0`

### AI SDK Changes

- Add `await` to all `convertToModelMessages()` calls
- Replace `CoreMessage` with `ModelMessage`
- Replace `convertToCoreMessages()` with `convertToModelMessages()`
- Remove `mode` option from `generateObject` calls

### Agents SDK Tool Pattern Migration

- Move client tool definitions to server using `tool()` from "ai"
- Replace `tools` option with `onToolCall` callback in `useAgentChat`
- Replace `toolsRequiringConfirmation` with `needsApproval` on server tools
- Replace `experimental_automaticToolResolution` with `onToolCall`
- Replace `addToolResult()` calls with `addToolOutput()`
- Remove `createToolsFromClientSchemas()` usage

## Need Help?

- Check the [official AI SDK v6 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
- Check the [AI SDK v6 announcement](https://vercel.com/blog/ai-sdk-6)
- Check the [AI SDK documentation](https://sdk.vercel.ai/docs)
- Report issues on the [Agents SDK GitHub repository](https://github.com/cloudflare/agents/issues)
