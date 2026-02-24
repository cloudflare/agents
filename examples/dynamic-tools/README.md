# Dynamic Tools

Demonstrates dynamic client-defined tools — the **SDK/platform pattern** where tools are registered at runtime by the embedding application, not known by the server at deploy time.

## The pattern

This example shows how to build a chat agent where:

1. The **server** is generic infrastructure — it accepts whatever tools the client sends
2. The **client** defines tools dynamically (schemas + execute functions)
3. Tool schemas are automatically sent to the server via the WebSocket protocol
4. The LLM calls the tools, and results are routed back to the client for execution

This is the same architecture you would use when building an **SDK or platform** where third-party developers define tools in their embedding application.

## Key code

### Server (`src/server.ts`)

The server uses `createToolsFromClientSchemas()` to convert client-provided schemas into AI SDK tools:

```typescript
import { createToolsFromClientSchemas } from "@cloudflare/ai-chat";

async onChatMessage(_onFinish, options) {
  const result = streamText({
    model: workersai("@cf/zai-org/glm-4.7-flash"),
    tools: createToolsFromClientSchemas(options?.clientTools),
    // ...
  });
  return result.toUIMessageStreamResponse();
}
```

### Client (`src/client.tsx`)

The client passes tools via the `tools` option on `useAgentChat`:

```typescript
import { useAgentChat, type AITool } from "@cloudflare/ai-chat/react";

const tools: Record<string, AITool> = {
  getPageTitle: {
    description: "Get the current page title",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ title: document.title })
  }
};

const { messages, sendMessage } = useAgentChat({
  agent,
  tools
});
```

## Run it

```bash
npm install && npm start
```

## When to use this vs server-side tools

- **Server-side tools** (`tool()` from `"ai"`): Best for most apps. Full Zod type safety, simpler code, tools defined in one place. Use `onToolCall` for client-side execution.
- **Dynamic client tools** (this pattern): Best for SDKs, platforms, and multi-tenant systems where the tool surface is determined by the embedding application at runtime.

## Related examples

- [`ai-chat`](../ai-chat/) — Server-side tools with `tool()`, approval, and `onToolCall`
- [`playground`](../playground/) — Kitchen-sink showcase of all SDK features
