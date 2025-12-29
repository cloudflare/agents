### 💬 `@cloudflare/ai-chat` - AI-Powered Conversations

![npm install @cloudflare/ai-chat](../../assets/npm-install-agents.svg)

Welcome to `@cloudflare/ai-chat`, a specialized package for building intelligent chat experiences with persistent, stateful AI agents. Built on top of the `agents` framework and integrated with the AI SDK, this package provides everything you need to create conversational AI applications that remember, learn, and evolve.

#### The Nature of AI Chat

AI chat transcends simple request-response patterns. It's a continuous dialogue where:

- **Persistence**: Conversations are automatically saved and restored across sessions
- **Streaming**: Real-time responses that flow naturally to users
- **Resumability**: Automatic recovery from disconnections without losing context
- **Tools**: Seamless integration of client and server-side capabilities
- **State**: Each conversation maintains its own memory and understanding

Built on Cloudflare's global network with Durable Objects, your chat agents persist across time, maintaining context and relationships with users.

#### 💫 Core Principles

1. **Automatic Persistence**: Messages are saved automatically - no manual storage needed
2. **Resumable Streaming**: Disconnections don't break the flow - streams resume automatically
3. **Tool Harmony**: Mix server and client-side tools seamlessly
4. **AI SDK Integration**: Built on the latest AI SDK v6 for maximum compatibility
5. **React First**: Designed for modern React applications with hooks

---

### 🌱 Beginning the Journey

Install the package in your project:

```sh
npm install @cloudflare/ai-chat agents ai
```

You'll also need the `agents` package (for the base `Agent` class) and `ai` (for AI SDK integration).

### 📝 Your First Chat Agent

Create a chat agent that remembers and responds:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { openai } from "@ai-sdk/openai";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse
} from "ai";

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(this.messages)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

That's it! Your agent now:

- Automatically persists all messages
- Streams responses in real-time
- Handles reconnections gracefully
- Maintains conversation context

### 🏰 Creating Space

Define your chat agent in your `wrangler.toml`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "ChatAgent",
        "class_name": "ChatAgent"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["ChatAgent"]
    }
  ]
}
```

### 🎭 Patterns of Conversation

#### Streaming Responses (Recommended)

For real-time interaction, use streaming:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { openai } from "@ai-sdk/openai";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse
} from "ai";

export class StreamingChat extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(this.messages),
          onFinish
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

#### Non-Streaming Responses

For simpler use cases without real-time updates:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { openai } from "@ai-sdk/openai";
import { generateText, convertToModelMessages } from "ai";

export class SimpleChat extends AIChatAgent<Env> {
  async onChatMessage() {
    const result = await generateText({
      model: openai("gpt-4o"),
      messages: await convertToModelMessages(this.messages)
    });

    const message = result.toUIMessage({
      metadata: {
        model: "gpt-4o",
        totalTokens: result.usage?.totalTokens
      }
    });

    return new Response(JSON.stringify(message), {
      headers: { "Content-Type": "application/json" }
    });
  }
}
```

### 🌐 Client Integration

Connect your React application to your chat agent:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function ChatInterface() {
  // Connect to the agent
  const agent = useAgent({
    agent: "ChatAgent",
    name: "my-chat"
  });

  // Set up the chat interaction
  const { messages, sendMessage, clearHistory, status } = useAgentChat({
    agent
  });

  const [input, setInput] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    await sendMessage({
      role: "user",
      parts: [{ type: "text", text: input }]
    });
    setInput("");
  };

  return (
    <div className="chat-interface">
      <div className="messages">
        {messages.map((message) => (
          <div key={message.id} className="message">
            <div className="role">{message.role}</div>
            <div className="content">
              {message.parts.map((part, i) => {
                if (part.type === "text")
                  return <span key={i}>{part.text}</span>;
                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
        />
      </form>

      <button onClick={clearHistory}>Clear Chat</button>
    </div>
  );
}
```

### 🌊 Resumable Streaming

One of the most powerful features of `@cloudflare/ai-chat` is **automatic resumable streaming**. When a client disconnects during a stream, the response automatically resumes when they reconnect.

#### How It Works

1. **During streaming**: All chunks are automatically persisted to SQLite
2. **On disconnect**: The stream continues server-side, buffering chunks
3. **On reconnect**: Client receives all buffered chunks and continues streaming

It just works! No special configuration needed.

#### Example

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function ResumableChat() {
  const agent = useAgent({
    agent: "ResumableStreamingChat",
    name: "demo"
  });

  // resume: true is the default - streams automatically resume on reconnect
  const { messages, sendMessage, status } = useAgentChat({
    agent
    // resume: true is the default
  });

  // Try it: Start a long response, refresh the page, and watch it resume!
  return (
    <div>
      {status === "streaming" && <div>Streaming...</div>}
      {/* Your chat UI */}
    </div>
  );
}
```

The server automatically handles stream resumption - no extra code needed on your part.

### 🔧 Tool Support

`@cloudflare/ai-chat` supports both server-side and client-side tools, allowing you to build rich interactive experiences.

#### Server-Side Tools

Define tools that execute on the server:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { openai } from "@ai-sdk/openai";
import { streamText, convertToModelMessages, tool } from "ai";
import { z } from "zod";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

export class ToolChat extends AIChatAgent<Env> {
  async onChatMessage() {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(this.messages),
          tools: {
            getWeather: tool({
              description: "Get weather for a city",
              parameters: z.object({ city: z.string() }),
              execute: async ({ city }) => {
                // Fetch weather from your API
                const weather = await fetch(`https://api.weather.com/${city}`);
                return { temperature: 72, condition: "sunny" };
              }
            })
          }
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

#### Client-Side Tools

For tools that need to run in the browser (like DOM manipulation, user interactions):

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { tool } from "ai";
import { z } from "zod";

function ChatWithClientTools() {
  const agent = useAgent({ agent: "ToolChat" });

  const { messages, sendMessage, addToolResult } = useAgentChat({
    agent,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "showAlert") {
        alert(toolCall.input.message);
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: { success: true }
        });
      }
    }
  });

  // Server defines the tool without execute:
  // showAlert: tool({
  //   description: "Shows an alert to the user",
  //   parameters: z.object({ message: z.string() })
  //   // No execute = client handles it
  // })
}
```

#### Human-in-the-Loop Tools

For tools requiring user approval before execution:

```tsx
import { useAgentChat } from "@cloudflare/ai-chat/react";

function HumanInTheLoopChat() {
  const agent = useAgent({ agent: "ApprovalChat" });

  const { messages, sendMessage, addToolResult } = useAgentChat({
    agent,
    toolsRequiringConfirmation: ["sendEmail", "deleteFile"],
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "sendEmail") {
        const approved = confirm(`Send email to ${toolCall.input.recipient}?`);
        if (approved) {
          // Execute the tool
          const result = await sendEmail(toolCall.input);
          addToolOutput({
            toolCallId: toolCall.toolCallId,
            output: result,
            autoContinue: true // Automatically continue after tool result
          });
        }
      }
    }
  });
}
```

### 📊 Message Metadata

Attach custom metadata to messages for tracking, analytics, or display purposes:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { openai } from "@ai-sdk/openai";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse
} from "ai";

export class MetadataChat extends AIChatAgent<Env> {
  async onChatMessage() {
    const startTime = Date.now();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(this.messages)
        });

        writer.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              if (part.type === "start") {
                return {
                  model: "gpt-4o",
                  createdAt: Date.now(),
                  messageCount: this.messages.length
                };
              }
              if (part.type === "finish") {
                return {
                  responseTime: Date.now() - startTime,
                  totalTokens: part.totalUsage?.totalTokens
                };
              }
            }
          })
        );
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

Access metadata on the client:

```tsx
{
  messages.map((message) => (
    <div key={message.id}>
      {message.metadata?.createdAt && (
        <span>{new Date(message.metadata.createdAt).toLocaleTimeString()}</span>
      )}
      {message.metadata?.totalTokens && (
        <span>{message.metadata.totalTokens} tokens</span>
      )}
    </div>
  ));
}
```

For more details, see the [AI SDK Message Metadata documentation](https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata).

### 🔄 Advanced Patterns

#### Custom Request Preparation

Add custom headers or context to requests:

```tsx
const { messages, sendMessage } = useAgentChat({
  agent,
  prepareSendMessagesRequest: ({ id, messages }) => ({
    body: {
      currentUrl: window.location.href,
      userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    headers: {
      "X-Widget-Version": "1.0.0",
      "X-Request-ID": crypto.randomUUID()
    }
  })
});
```

#### Automatic Tool Continuation

Enable automatic continuation after tool results for seamless UX:

```tsx
const { messages, addToolResult } = useAgentChat({
  agent,
  autoContinueAfterToolResult: true, // Automatically continue after tool execution
  onToolCall: async ({ toolCall, addToolOutput }) => {
    const result = await executeTool(toolCall);
    addToolOutput({
      toolCallId: toolCall.toolCallId,
      output: result,
      autoContinue: true // Server will automatically continue the conversation
    });
  }
});
```

### 🎯 Real-World Examples

Explore these examples to see `@cloudflare/ai-chat` in action:

- **Basic Chat**: [`examples/playground/src/agents/chat.ts`](../../examples/playground/src/agents/chat.ts) - Simple streaming chat
- **Resumable Streaming**: [`examples/resumable-stream-chat/`](../../examples/resumable-stream-chat/) - Automatic stream resumption
- **Human-in-the-Loop**: [`guides/human-in-the-loop/`](../../guides/human-in-the-loop/) - Tools requiring user approval

### 📚 API Reference

#### `AIChatAgent<Env, State>`

Base class for chat agents. Extends `Agent` from the `agents` package.

**Methods:**

- `onChatMessage(onFinish, options?)`: Override this method to handle chat messages and return a `Response`
- `persistMessages(messages, excludeBroadcastIds?)`: Manually persist messages (usually automatic)
- `messages`: Array of current chat messages

**Properties:**

- `messages: ChatMessage[]`: The current conversation messages

#### `useAgentChat(options)`

React hook for chat interactions.

**Options:**

- `agent`: Agent connection from `useAgent()`
- `onToolCall`: Callback for handling client-side tool execution
- `toolsRequiringConfirmation`: Array of tool names that need user approval
- `autoContinueAfterToolResult`: Automatically continue conversation after tool results
- `resume`: Enable automatic stream resumption (default: `true`)
- `prepareSendMessagesRequest`: Customize request headers/body

**Returns:**

- `messages`: Array of chat messages
- `sendMessage`: Function to send a new message
- `clearHistory`: Function to clear conversation history
- `addToolResult`: Function to provide tool output
- `status`: Current status ("idle" | "streaming" | "error")

### 🔗 Integration with Agents Framework

`@cloudflare/ai-chat` is built on top of the [`agents`](../agents/) framework. It extends the base `Agent` class with chat-specific capabilities:

- Automatic message persistence in SQLite
- WebSocket-based real-time communication
- Resumable streaming infrastructure
- Tool execution coordination

For more information about the underlying agent framework, see the [`agents` README](../agents/README.md).

### 💬 The Path Forward

We're continuously improving `@cloudflare/ai-chat`:

- **Enhanced Tool Support**: More flexible tool execution patterns
- **Better Error Handling**: Graceful degradation and recovery
- **Performance Optimizations**: Faster streaming and lower latency
- **Developer Experience**: Better TypeScript types and debugging tools

### Contributing

Contributions are welcome! Please:

1. Open an issue to discuss your proposal
2. Ensure your changes align with the package's goals
3. Include tests for new features
4. Update documentation as needed

### License

MIT licensed. See the LICENSE file at the root of this repository for details.
