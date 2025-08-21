# Migration Guide: Upgrading to Agents SDK with AI SDK v5

This guide helps you migrate your existing code to a new version of our SDK. The Agents SDK now uses AI SDK v5, which introduces several breaking changes and new features.

## Overview of Changes

### 1. Message Format Changes

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

### 2. Import Changes

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
class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal: AbortSignal | undefined }
  ): Promise<Response | undefined> {
    // Same signature, but internally handles UIMessage format
  }
}
```

### 4. Tool Definitions

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

### 5. Streaming Response Changes

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

### 6. Message Persistence and Migration

The SDK automatically detects legacy message formats but **does NOT automatically rewrite your stored messages**. When old format messages are detected, you'll see a console warning:

```
🔄 [AIChatAgent] Detected messages in legacy format (role/content). These will continue to work but consider migrating to the new message format for better compatibility with AI SDK v5 features.
To migrate: import { migrateMessagesToUIFormat } from '@cloudflare/agents' and call await this.persistMessages(migrateMessagesToUIFormat(this.messages))
```

#### Important Notes:

- **No automatic rewriting**: The SDK reads and works with old format messages but doesn't modify your stored data
- **Backward compatibility**: Your existing messages will continue to work without migration
- **Manual migration**: You control when/if to migrate your data

#### How to migrate stored messages:

```typescript
import { migrateMessagesToUIFormat } from "@cloudflare/agents";

class MyAgent extends AIChatAgent<Env> {
  async migrateStoredMessages() {
    // Convert messages to new format
    const migratedMessages = migrateMessagesToUIFormat(this.messages);

    // Persist the migrated messages
    await this.persistMessages(migratedMessages);

    console.log("Messages migrated to UIMessage format");
  }
}
```

## Step-by-Step Migration

### Step 1: Update Dependencies

```bash
npm update @cloudflare/agents ai
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

The Agents SDK now provides migration utilities to help convert messages to the new format:

```typescript
import {
  migrateToUIMessage,
  migrateMessagesToUIFormat,
  needsMigration,
  isUIMessage
} from "@cloudflare/agents";

// Check if migration is needed
if (needsMigration(messages)) {
  console.log("Some messages need migration");
}

// Migrate a single message
const newMessage = migrateToUIMessage(oldMessage);

// Migrate an array of messages
const newMessages = migrateMessagesToUIFormat(oldMessages);

// Check if a message is already in UIMessage format
if (isUIMessage(message)) {
  console.log("Message is already in new format");
}
```

Note: The SDK handles this conversion automatically at runtime, so manual migration is usually not necessary. These utilities are provided for cases where you want to explicitly migrate stored messages.

## Converting Messages to New Format

The SDK automatically handles old format messages, but if you want to convert them:

### Automatic Conversion (Recommended)

```typescript
import { convertToModelMessages } from "ai";

// Converts any message format to model-compatible format
const modelMessages = convertToModelMessages(messages);
```

### Manual Conversion

Use the migration utilities from Step 5 above. The Agents SDK now provides these utilities for explicit migration when needed.

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
