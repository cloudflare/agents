# @cloudflare/ai-chat

AI chat agents with automatic message persistence, resumable streaming, and tool support. Built on Cloudflare Durable Objects and the [AI SDK](https://ai-sdk.dev).

## Install

```sh
npm install @cloudflare/ai-chat agents ai workers-ai-provider
```

## Quick Start

### Server

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";

export class ChatAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
  }
}
```

That gives you: automatic message persistence in SQLite, resumable streaming on disconnect/reconnect, and real-time WebSocket delivery to all connected clients.

### Client

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "ChatAgent" });
  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong>
          {msg.parts.map((part, i) =>
            part.type === "text" ? <span key={i}>{part.text}</span> : null
          )}
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            "input"
          ) as HTMLInputElement;
          sendMessage({
            role: "user",
            parts: [{ type: "text", text: input.value }]
          });
          input.value = "";
        }}
      >
        <input name="input" placeholder="Type a message..." />
      </form>
    </div>
  );
}
```

### Wrangler Config

```jsonc
// wrangler.jsonc
{
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "name": "ChatAgent", "class_name": "ChatAgent" }]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["ChatAgent"]
    }
  ]
}
```

## Tools

### Server-side tools

Tools with an `execute` function run on the server automatically:

```typescript
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, tool } from "ai";
import { z } from "zod";

export class ChatAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        getWeather: tool({
          description: "Get weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => {
            const data = await fetchWeather(city);
            return { temperature: data.temp, condition: data.condition };
          }
        })
      },
      maxSteps: 5
    });

    return result.toUIMessageStreamResponse();
  }
}
```

### Client-side tools

Tools without `execute` are handled on the client via `onToolCall`. Use this for tools that need browser APIs (geolocation, clipboard, camera):

```typescript
// Server: define tool without execute
getLocation: tool({
  description: "Get the user's location from their browser",
  inputSchema: z.object({})
  // No execute -- client handles it
});
```

```tsx
// Client: handle via onToolCall
const { messages, sendMessage } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName === "getLocation") {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject)
      );
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: { lat: pos.coords.latitude, lng: pos.coords.longitude }
      });
    }
  }
});
```

### Tool approval (human-in-the-loop)

Use `needsApproval` for tools that require user confirmation before executing:

```typescript
// Server
processPayment: tool({
  description: "Process a payment",
  inputSchema: z.object({ amount: z.number(), recipient: z.string() }),
  needsApproval: async ({ amount }) => amount > 100, // Only require approval for large amounts
  execute: async ({ amount, recipient }) => charge(amount, recipient)
});
```

```tsx
// Client
const { messages, addToolApprovalResponse } = useAgentChat({ agent });

// When rendering tool parts with state === "approval-requested":
<button onClick={() => addToolApprovalResponse({ id: approvalId, approved: true })}>
  Approve
</button>
<button onClick={() => addToolApprovalResponse({ id: approvalId, approved: false })}>
  Reject
</button>
```

## Resumable Streaming

Streams automatically resume on disconnect/reconnect. No configuration needed.

When a client disconnects mid-stream, chunks are buffered in SQLite. On reconnect, the client receives all buffered chunks and continues receiving the live stream.

Disable with `resume: false`:

```tsx
const { messages } = useAgentChat({ agent, resume: false });
```

## Storage Management

### Limiting stored messages

Cap the number of messages kept in SQLite:

```typescript
export class ChatAgent extends AIChatAgent {
  maxPersistedMessages = 200; // Keep last 200 messages

  async onChatMessage() {
    // ...
  }
}
```

Oldest messages are deleted when the count exceeds the limit. This controls storage only -- it does not affect what is sent to the LLM.

### Controlling LLM context

Use the AI SDK's `pruneMessages()` to control what is sent to the model, independently of what is stored:

```typescript
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, pruneMessages } from "ai";

export class ChatAgent extends AIChatAgent {
  maxPersistedMessages = 200;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message",
        toolCalls: "before-last-2-messages"
      })
    });

    return result.toUIMessageStreamResponse();
  }
}
```

### Row size protection

Messages approaching SQLite's 2MB row limit are automatically compacted. Large tool outputs are replaced with an LLM-friendly summary that instructs the model to suggest re-running the tool. Compacted messages include `metadata.compactedToolOutputs` so clients can detect and display this gracefully.

## Custom Request Data

Include custom data with every chat request using the `body` option:

```tsx
const { messages, sendMessage } = useAgentChat({
  agent,
  body: {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userId: "abc"
  }
});

// Or use a function for dynamic values:
body: () => ({ token: getAuthToken(), timestamp: Date.now() });
```

Access these fields on the server via `options.body`:

```typescript
async onChatMessage(onFinish, options) {
  const { timezone, userId } = options?.body ?? {};
}
```

## API Reference

### `AIChatAgent<Env, State>`

Extends `Agent` from the `agents` package.

| Property / Method                    | Type                  | Description                                                                 |
| ------------------------------------ | --------------------- | --------------------------------------------------------------------------- |
| `messages`                           | `UIMessage[]`         | Current conversation messages (loaded from SQLite)                          |
| `maxPersistedMessages`               | `number \| undefined` | Max messages to keep in SQLite. Default: unlimited                          |
| `onChatMessage(onFinish?, options?)` | Override              | Handle incoming chat messages. Return a `Response`. `onFinish` is optional. |
| `persistMessages(messages)`          | `Promise<void>`       | Manually persist messages (usually automatic)                               |
| `saveMessages(messages)`             | `Promise<void>`       | Persist messages and trigger `onChatMessage`                                |

### `useAgentChat(options)`

React hook for chat interactions. Wraps the AI SDK's `useChat` with WebSocket transport.

**Options:**

| Option                        | Type                                    | Description                                               |
| ----------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `agent`                       | `ReturnType<typeof useAgent>`           | Agent connection (required)                               |
| `onToolCall`                  | `({ toolCall, addToolOutput }) => void` | Handle client-side tool execution                         |
| `autoContinueAfterToolResult` | `boolean`                               | Auto-continue after client tool results. Default: `false` |
| `resume`                      | `boolean`                               | Enable stream resumption. Default: `true`                 |
| `body`                        | `object \| () => object`                | Custom data sent with every request (see below)           |
| `prepareSendMessagesRequest`  | `(options) => { body?, headers? }`      | Advanced per-request customization                        |
| `getInitialMessages`          | `(options) => Promise<UIMessage[]>`     | Custom initial message loader                             |

**Returns:**

| Property                  | Type                               | Description                                             |
| ------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `messages`                | `UIMessage[]`                      | Chat messages                                           |
| `sendMessage`             | `(message) => void`                | Send a message                                          |
| `clearHistory`            | `() => void`                       | Clear conversation                                      |
| `addToolOutput`           | `({ toolCallId, output }) => void` | Provide tool output                                     |
| `addToolApprovalResponse` | `({ id, approved }) => void`       | Approve/reject a tool                                   |
| `setMessages`             | `(messages \| updater) => void`    | Set messages (syncs to server)                          |
| `status`                  | `string`                           | `"idle"` \| `"submitted"` \| `"streaming"` \| `"error"` |

### Exports

| Import path                 | What it provides                                    |
| --------------------------- | --------------------------------------------------- |
| `@cloudflare/ai-chat`       | `AIChatAgent`, `createToolsFromClientSchemas`       |
| `@cloudflare/ai-chat/react` | `useAgentChat`                                      |
| `@cloudflare/ai-chat/types` | `MessageType`, `OutgoingMessage`, `IncomingMessage` |

## Examples

- [Resumable streaming chat](../../examples/resumable-stream-chat/) -- automatic stream resumption
- [Human-in-the-loop guide](../../guides/human-in-the-loop/) -- tool approval with `needsApproval` + `onToolCall`
- [Playground](../../examples/playground/) -- kitchen-sink demo of all SDK features

## License

MIT
