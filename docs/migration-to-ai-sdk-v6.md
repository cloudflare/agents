# Migrating from AI SDK v5 to v6

This guide covers the changes needed when upgrading from AI SDK v5 to v6 with `@cloudflare/ai-chat`.

## Installation

```bash
npm install ai@latest @ai-sdk/react@latest @ai-sdk/openai@latest
```

## Breaking changes

### 1. `convertToModelMessages()` is now async

Add `await` to all calls:

```typescript
// v5
const result = streamText({
  messages: convertToModelMessages(this.messages),
  model: openai("gpt-4o")
});

// v6
const result = streamText({
  messages: await convertToModelMessages(this.messages),
  model: openai("gpt-4o")
});
```

### 2. `CoreMessage` removed

Replace `CoreMessage` with `ModelMessage` and `convertToCoreMessages()` with `convertToModelMessages()`:

```typescript
// v5
import { convertToCoreMessages, type CoreMessage } from "ai";

// v6
import { convertToModelMessages, type ModelMessage } from "ai";
```

### 3. Tool pattern: server-side tools (recommended)

v6 introduces `needsApproval` and the `onToolCall` callback. For most apps, define tools on the server with `tool()` from `"ai"` for full Zod type safety:

**Before (v5):**

```typescript
// Client defined tools with AITool type
useAgentChat({
  agent,
  tools: clientTools,
  experimental_automaticToolResolution: true,
  toolsRequiringConfirmation: ["askConfirmation"]
});
```

**After (v6):**

```typescript
// Server: all tools defined here
const tools = {
  getWeather: tool({
    description: "Get weather",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => fetchWeather(city)
  }),
  getLocation: tool({
    description: "Get user location",
    inputSchema: z.object({})
    // No execute -- client handles via onToolCall
  }),
  processPayment: tool({
    description: "Process payment",
    inputSchema: z.object({ amount: z.number() }),
    needsApproval: async ({ amount }) => amount > 100,
    execute: async ({ amount }) => charge(amount)
  })
};

// Client: handle tools via callbacks
useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName === "getLocation") {
      const pos = await getPosition();
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: { lat: pos.coords.latitude, lng: pos.coords.longitude }
      });
    }
  }
});
```

**Dynamic client tools (SDK/platform pattern):**

If you are building an SDK or platform where tools are defined dynamically by the embedding application at runtime, the `tools` option on `useAgentChat` and `createToolsFromClientSchemas()` on the server are still fully supported:

```typescript
// Server: accept whatever tools the client sends
const tools = {
  ...createToolsFromClientSchemas(options.clientTools),
  ...serverTools
};

// Client: register tools dynamically
useAgentChat({
  agent,
  tools: dynamicTools,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    const tool = dynamicTools[toolCall.toolName];
    if (tool?.execute) {
      const output = await tool.execute(toolCall.input);
      addToolOutput({ toolCallId: toolCall.toolCallId, output });
    }
  }
});
```

### 4. `generateObject` mode option removed

Remove `mode: "json"` or similar from `generateObject` calls.

### 5. `isToolUIPart` and `getToolName` now include dynamic tools

In v6, these check both static and dynamic tool parts. For the old behavior, use `isStaticToolUIPart` and `getStaticToolName`. Most users do not need to change anything.

## Deprecated APIs

| Deprecated                             | Replacement                                               |
| -------------------------------------- | --------------------------------------------------------- |
| `toolsRequiringConfirmation`           | [`needsApproval`](./human-in-the-loop.md) on server tools |
| `experimental_automaticToolResolution` | [`onToolCall`](./client-tools-continuation.md) callback   |
| `addToolResult()`                      | `addToolOutput()` or `addToolApprovalResponse()`          |

**Not deprecated:** `AITool`, `createToolsFromClientSchemas()`, `extractClientToolSchemas()`, and the `tools` option on `useAgentChat` are supported for SDK/platform use cases where tools are defined dynamically at runtime.

## Migration checklist

**Packages:**

- `ai` to `^6.0.0`
- `@ai-sdk/react` to `^3.0.0`
- `@ai-sdk/openai` (and other providers) to `^3.0.0`

**Code changes:**

- Add `await` to all `convertToModelMessages()` calls
- Replace `CoreMessage` with `ModelMessage`
- Replace `convertToCoreMessages()` with `convertToModelMessages()`
- Remove `mode` from `generateObject` calls
- Move static tool definitions to server using `tool()` (recommended for most apps)
- Use `onToolCall` in `useAgentChat` for client-side tool execution
- Replace `toolsRequiringConfirmation` with `needsApproval`
- Replace `addToolResult()` with `addToolOutput()` or `addToolApprovalResponse()`

## Further reading

- [Official AI SDK v6 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
- [Human in the Loop](./human-in-the-loop.md) -- `needsApproval` and `addToolApprovalResponse`
- [Client Tools](./client-tools-continuation.md) -- `onToolCall` and auto-continuation
