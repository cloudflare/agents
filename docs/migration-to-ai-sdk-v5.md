# Migration Guide: Upgrading to Agents SDK v0.1.0 with AI SDK v5

This guide helps you migrate your existing code to **Agents SDK v0.1.0** (`agents/ai-chat-agent`) and **AI SDK v5.x**. AI SDK v5 introduces several breaking changes and new features that the Agents SDK adopts.

## Overview of Changes ([AI SDK v5 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0))

### 1. Message Format Changes ([UIMessage Changes](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0#uimessage-changes))

The most significant change is the message format. AI SDK v5 uses a new `UIMessage` format that replaces the older `Message` format.

#### Before (AI SDK v4):

```typescript
import type { Message } from "ai";

// Messages had a simple structure
const message: Message = {
  id: "123",
  role: "user",
  content: "Hello, assistant!"
};
```

#### After (AI SDK v5):

```typescript
import type { UIMessage } from "ai";

// Messages now use a parts-based structure
const message: UIMessage = {
  id: "123",
  role: "user",
  // New: parts array replaces content property
  parts: [
    {
      type: "text",
      text: "Hello, assistant!"
    }
  ]
};
```

### 2. Import Changes ([Package Versions](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0#ai-sdk-50-package-versions))

Update your imports to use the new types and packages:

#### Before:

```typescript
import type { Message, StreamTextOnFinishCallback } from "ai";
import { useChat } from "ai/react";
```

#### After:

```typescript
import type { UIMessage as ChatMessage, StreamTextOnFinishCallback } from "ai";
import { useChat } from "@ai-sdk/react";
```

Note: Some imports moved to scoped packages like `@ai-sdk/react`, `@ai-sdk/ui-utils`, etc.

### 3. AIChatAgent Changes

If you're extending `AIChatAgent`, the message handling has been updated:

#### Before:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";

class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal: AbortSignal | undefined }
  ): Promise<Response | undefined> {
    // Your implementation
  }
}
```

#### After:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";

class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal: AbortSignal | undefined }
  ): Promise<Response | undefined> {
    // Same signature, but internally handles UIMessage format
  }
}
```

### 4. Tool Definitions ([Tool Definition Changes](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0#tool-definition-changes-parameters--inputschema))

Tool definitions now use `inputSchema` instead of `parameters`:

#### Before:

```typescript
const tools = {
  weather: {
    description: "Get weather information",
    parameters: z.object({
      city: z.string()
    }),
    execute: async (args) => {
      // Implementation
    }
  }
};
```

#### After:

```typescript
const tools = {
  weather: {
    description: "Get weather information",
    inputSchema: z.object({
      // Changed from 'parameters' to 'inputSchema'
      city: z.string()
    }),
    execute: async (args) => {
      // Implementation
    }
  }
};
```

### 5. Streaming Response Changes ([Streaming Architecture](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0#streaming-architecture))

AI SDK v5 introduces a new streaming pattern with start/delta/end events:

#### Before (v4):

```typescript
for await (const chunk of result.fullStream) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.textDelta);
  }
}
```

#### After (v5):

```typescript
for await (const chunk of result.fullStream) {
  switch (chunk.type) {
    case "text-start":
      // New: Called when text generation starts
      break;
    case "text-delta":
      process.stdout.write(chunk.delta); // Note: 'delta' not 'textDelta'
      break;
    case "text-end":
      // New: Called when text generation completes
      break;
  }
}
```

### 6. Automatic Message Migration

**The SDK automatically migrates all message formats** - no manual migration needed! Following the pattern from [this blog post](https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages), all legacy messages are transformed automatically.

**Automatic migration handles:**

- **Legacy v4 format**: `{role: "user", content: "text"}` → `{role: "user", parts: [{type: "text", text}]}`
- **Tool calls**: v4 `toolInvocations` → v5 tool parts with proper state mapping
- **Reasoning**: Preserves reasoning parts from v4 messages
- **File/media**: Converts file data/URLs to proper v5 media format
- **Corrupt formats**: Fixes malformed message structures
- **Missing IDs**: Generates UUIDs for messages without IDs

**Works automatically in:**

- Loading messages from database (constructor)
- Incoming message processing
- All message entry points

**Optional manual utilities:**

```typescript
import {
  autoTransformMessages,
  analyzeCorruption
} from "@cloudflare/ai-chat/ai-chat-v5-migration";

// Manual transformation (usually not needed)
const cleanMessages = autoTransformMessages(anyFormatMessages);

// Analyze existing message formats
const stats = analyzeCorruption(messages);
console.log(`Found ${stats.legacyString} legacy messages`);
```

### 7. Handling Human-in-the-Loop and Tool Confirmation

The SDK now provides a more robust and streamlined way to handle tools that require user confirmation, simplifying the logic in your UI components.

#### Automatic Confirmation Detection

The `useAgentChat` hook can now automatically detect which tools require human-in-the-loop confirmation. This is based on a simple convention:

- **Tools with an `execute` function** are considered automatic and will be resolved by the agent without user interaction.
- **Tools without an `execute` function** are considered to require human confirmation.

To enable this, pass your `tools` object to the `useAgentChat` hook:

```typescript
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { tools } from "./tools";

// ...

const { messages, ... } = useAgentChat({
  agent,
  experimental_automaticToolResolution: true,
  tools // Pass the tools object here
});
```

#### Manual Override

If you need to override the automatic detection, you can use the `toolsRequiringConfirmation` option to provide an explicit list of tool names:

```typescript
const { messages, ... } = useAgentChat({
  agent,
  experimental_automaticToolResolution: true,
  // This will override the automatic detection
  toolsRequiringConfirmation: ["getWeatherInformation"]
});
```

#### Simplified UI Logic

This new approach significantly simplifies the logic required in your UI components. The `useAgentChat` hook handles the automatic resolution of tools, so your UI only needs to render the confirmation prompt for tools that are left in the `input-available` state.

**Before:** The UI had to contain logic to decide if a tool needed confirmation.

```typescript
// In your component
const pendingToolCallConfirmation = messages.some((m) =>
  m.parts?.some(
    (part) =>
      isToolUIPart(part) &&
      part.state === "input-available" &&
      // Manual check inside the component
      !(tools as Record<string, any>)[getToolName(part)]?.execute
  )
);

// ... and in the render method
if (
  part.state === "input-available" &&
  !(tools as Record<string, any>)[toolName]?.execute
) {
  // Render confirmation UI
}
```

**After:** The UI logic is much cleaner, as the hook handles the decision.

```typescript
// In your component
const pendingToolCallConfirmation = messages.some((m) =>
  m.parts?.some(
    (part) => isToolUIPart(part) && part.state === "input-available"
  )
);

// ... and in the render method
if (part.state === "input-available") {
  // Render confirmation UI
}
```

## Step-by-Step Migration

### Step 1: Update Dependencies

```bash
npm update agents ai
```

Make sure you're on AI SDK v5.x. Check your package.json:

```json
{
  "dependencies": {
    "ai": "^5.0.0"
  }
}
```

### Step 2: Update Imports

Search and replace the following imports in your codebase:

- `import type { Message } from "ai"` → `import type { UIMessage } from "ai"`
- If you aliased Message as ChatMessage, you can now use: `import type { UIMessage as ChatMessage } from "ai"`

### Step 3: Update Tool Definitions

Find all tool definitions and rename `parameters` to `inputSchema`:

```typescript
// Find all occurrences of tool definitions
// Replace 'parameters:' with 'inputSchema:'
```

### Step 4: Test Your Application

1. Run your type checker: `npm run typecheck`
2. Run your tests: `npm test`
3. Check the console for any migration warnings about legacy message formats

### Step 5: (Optional) Migrate Legacy Messages

You can optionally use the migration utilities to convert stored messages:

```typescript
import {
  migrateMessagesToUIFormat,
  analyzeCorruption
} from "@cloudflare/ai-chat/ai-chat-v5-migration";

// In your agent class
// Check if messages need migration (autoTransformMessages handles this automatically)
const stats = analyzeCorruption(this.messages);
if (stats.legacyString || stats.corruptArray) {
  console.log(
    `Migrating ${stats.legacyString} legacy and ${stats.corruptArray} corrupt messages`
  );

  // Migrate and save
  const cleanMessages = migrateMessagesToUIFormat(this.messages);
  await this.saveMessages(cleanMessages);
}
```

## Migration Utilities Reference

```typescript
import {
  migrateMessagesToUIFormat,
  analyzeCorruption
} from "@cloudflare/ai-chat/ai-chat-v5-migration";

// Migration functions
migrateMessagesToUIFormat(messages); // Migrate array of messages

// Analysis tools
analyzeCorruption(messages); // Get stats about message format issues
```

**Note:** The `autoTransformMessages` function is used internally by `AIChatAgent` and automatically handles migration. You typically don't need to call migration utilities manually.

Migration handles:

- `{role, content: string}` → `{role, parts: [{type: "text", text}]}`
- `{role, content: [{type, text}]}` → `{role, parts: [{type, text}]}`
- Preserves additional properties and generates missing IDs

## Additional Changes

### Type Renames

- `CoreMessage` → `ModelMessage` (when working with model-specific messages)
- Various streaming chunk properties renamed (e.g., `textDelta` → `delta`)

## Need Help?

- Check the [official AI SDK v5 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0)
- Check the [AI SDK v5 documentation](https://sdk.vercel.ai/docs)
- Report issues on the [Agents SDK GitHub repository](https://github.com/cloudflare/agents/issues)
- Join the community discussions for migration tips and best practices

Your existing code will continue to work with minimal changes, and the SDK provides backward compatibility for legacy message formats.
