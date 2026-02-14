# Migrating from AI SDK v4 to v5

This guide covers the changes needed when upgrading from AI SDK v4 to v5 with `@cloudflare/ai-chat`.

> If you are on AI SDK v5 and upgrading to v6, see the [v6 migration guide](./migration-to-ai-sdk-v6.md) instead.

## Message format: `content` to `parts`

The biggest change. Messages now use a `parts` array instead of a `content` string:

```typescript
// v4
const message = { id: "1", role: "user", content: "Hello" };

// v5
const message = {
  id: "1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};
```

**You do not need to migrate stored messages manually.** `AIChatAgent` automatically transforms legacy messages on load via `autoTransformMessages()`. This handles v4 `content` strings, tool invocations, reasoning parts, file data, and malformed formats.

## Import changes

```typescript
// v4
import type { Message } from "ai";
import { useChat } from "ai/react";

// v5
import type { UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
```

## Tool definitions: `parameters` to `inputSchema`

```typescript
// v4
const tools = {
  weather: {
    description: "Get weather",
    parameters: z.object({ city: z.string() }),
    execute: async ({ city }) => fetchWeather(city)
  }
};

// v5
const tools = {
  weather: {
    description: "Get weather",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => fetchWeather(city)
  }
};
```

## Streaming events

v5 adds `text-start` and `text-end` events around text deltas, and renames `textDelta` to `delta`:

```typescript
// v4
chunk.type === "text-delta" && chunk.textDelta;

// v5
chunk.type === "text-delta" && chunk.delta;
// Plus new: "text-start" and "text-end" events
```

## Migration checklist

1. Update dependencies: `npm update agents ai`
2. Replace `import type { Message }` with `import type { UIMessage }`
3. Replace `"ai/react"` imports with `"@ai-sdk/react"`
4. Rename `parameters` to `inputSchema` in tool definitions
5. Run `npm run typecheck` and fix any remaining type errors
6. Test your application -- legacy stored messages are migrated automatically

## Migration utilities (deprecated)

These are available but rarely needed since migration is automatic:

```typescript
import {
  autoTransformMessages, // Used internally by AIChatAgent
  migrateMessagesToUIFormat, // Deprecated -- use autoTransformMessages
  analyzeCorruption // Deprecated -- debugging only
} from "@cloudflare/ai-chat/ai-chat-v5-migration";
```

## Further reading

- [Official AI SDK v5 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0)
- [v6 migration guide](./migration-to-ai-sdk-v6.md) (if upgrading further)
