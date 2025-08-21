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
  content: "Hello, assistant!",
  // New: parts array for rich content
  parts: [
    {
      type: "text",
      text: "Hello, assistant!"
    }
  ]
};
```

### 2. Import Changes

Update your imports to use the new types:

#### Before:

```typescript
import type { Message, StreamTextOnFinishCallback } from "ai";
```

#### After:

```typescript
import type { UIMessage as ChatMessage, StreamTextOnFinishCallback } from "ai";
```

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

### 5. Message Persistence

The SDK automatically detects and handles legacy message formats. When old format messages are detected, you'll see a console warning:

```
🔄 [AIChatAgent] Detected messages in legacy format (role/content). These will continue to work but consider migrating to the new message format for better compatibility with AI SDK v5 features.
```

Your existing messages will continue to work, but for new features, consider migrating to the new format.

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

If you want to migrate existing messages to the new format, you can use this utility:

```typescript
function migrateToUIMessage(oldMessage: any): UIMessage {
  // If already in new format, return as-is
  if (oldMessage.parts) {
    return oldMessage;
  }

  // Convert old format to new
  return {
    ...oldMessage,
    parts: [
      {
        type: "text",
        text: oldMessage.content
      }
    ]
  };
}
```

## Need Help?

- Check the [AI SDK v5 documentation](https://sdk.vercel.ai/docs)
- Report issues on the [Agents SDK GitHub repository](https://github.com/cloudflare/agents/issues)
- Join the community discussions for migration tips and best practices

Your existing code will continue to work with minimal changes, and the SDK provides backward compatibility for legacy message formats.
