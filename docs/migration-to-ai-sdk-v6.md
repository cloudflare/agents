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

### 3. Tool pattern: define everything on the server

v6 introduces `needsApproval` and the `onToolCall` callback, replacing the old client-side tool definitions:

**Before (v5):**

```typescript
// Client defined tools with AITool type
useAgentChat({
  agent,
  tools: clientTools,
  experimental_automaticToolResolution: true,
  toolsRequiringConfirmation: ["askConfirmation"]
});

// Server converted client schemas
const tools = {
  ...serverTools,
  ...createToolsFromClientSchemas(clientTools)
};
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

### 4. `generateObject` mode option removed

Remove `mode: "json"` or similar from `generateObject` calls.

### 5. `isToolUIPart` and `getToolName` now include dynamic tools

In v6, these check both static and dynamic tool parts. For the old behavior, use `isStaticToolUIPart` and `getStaticToolName`. Most users do not need to change anything.

## Deprecated APIs

| Deprecated                             | Replacement                                               |
| -------------------------------------- | --------------------------------------------------------- |
| `AITool` type                          | `tool()` from "ai" on the server                          |
| `extractClientToolSchemas()`           | Define tools on server                                    |
| `createToolsFromClientSchemas()`       | Define tools on server with `tool()`                      |
| `toolsRequiringConfirmation`           | [`needsApproval`](./human-in-the-loop.md) on server tools |
| `experimental_automaticToolResolution` | [`onToolCall`](./client-tools-continuation.md) callback   |
| `tools` option in `useAgentChat`       | [`onToolCall`](./client-tools-continuation.md)            |
| `addToolResult()`                      | `addToolOutput()` or `addToolApprovalResponse()`          |

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
- Move client tool definitions to server using `tool()`
- Replace `tools` option with `onToolCall` in `useAgentChat`
- Replace `toolsRequiringConfirmation` with `needsApproval`
- Replace `addToolResult()` with `addToolOutput()` or `addToolApprovalResponse()`
- Remove `createToolsFromClientSchemas()` usage

## Further reading

- [Official AI SDK v6 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
- [Human in the Loop](./human-in-the-loop.md) -- `needsApproval` and `addToolApprovalResponse`
- [Client Tools](./client-tools-continuation.md) -- `onToolCall` and auto-continuation
