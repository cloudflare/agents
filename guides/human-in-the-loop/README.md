## Human in the Loop with Cloudflare Agents

This guide demonstrates human-in-the-loop patterns using `AIChatAgent` from `@cloudflare/ai-chat`. Tools can require user approval before executing, and tools that need browser APIs are handled client-side.

### Key Patterns

1. **`needsApproval`** -- Server-side tools that pause for user approval before executing
2. **`onToolCall`** -- Client-side tool execution for tools that need browser APIs
3. **`addToolApprovalResponse`** -- Client responds to approval requests

### Server

Tools are defined on the server. Use `needsApproval` for tools requiring human confirmation:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, tool } from "ai";
import { z } from "zod";

export class HumanInTheLoop extends AIChatAgent {
  async onChatMessage() {
    const result = streamText({
      model: openai("gpt-4o"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        // Requires approval -- needsApproval: true
        getWeather: tool({
          description: "Get weather for a city",
          inputSchema: z.object({ city: z.string() }),
          needsApproval: true,
          execute: async ({ city }) => `The weather in ${city} is sunny.`
        }),

        // Client-side tool -- no execute function
        getLocalTime: tool({
          description: "Get local time for a location",
          inputSchema: z.object({ location: z.string() })
        }),

        // Automatic -- no approval, runs server-side
        getNews: tool({
          description: "Get news for a location",
          inputSchema: z.object({ location: z.string() }),
          execute: async ({ location }) => `${location} news: all good!`
        })
      },
      maxSteps: 5
    });

    return result.toUIMessageStreamResponse();
  }
}
```

### Client

Handle approvals with `addToolApprovalResponse` and client-side tools with `onToolCall`:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "human-in-the-loop" });

  const { messages, sendMessage, addToolApprovalResponse } = useAgentChat({
    agent,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getLocalTime") {
        const time = new Date().toLocaleTimeString();
        addToolOutput({ toolCallId: toolCall.toolCallId, output: time });
      }
    }
  });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          {msg.parts.map((part, i) => {
            if (part.type === "text") return <p key={i}>{part.text}</p>;

            // Tool approval request
            if ("approval" in part && part.state === "approval-requested") {
              return (
                <div key={part.toolCallId}>
                  <p>Approve {getToolName(part)}?</p>
                  <button
                    onClick={() =>
                      addToolApprovalResponse({
                        id: part.approval.id,
                        approved: true
                      })
                    }
                  >
                    Approve
                  </button>
                  <button
                    onClick={() =>
                      addToolApprovalResponse({
                        id: part.approval.id,
                        approved: false
                      })
                    }
                  >
                    Reject
                  </button>
                </div>
              );
            }

            return null;
          })}
        </div>
      ))}
    </div>
  );
}
```

### Running

```bash
npm install
npm run dev
```

Requires `OPENAI_API_KEY` in `.env`.

### Learn More

- [Human in the Loop docs](../../docs/human-in-the-loop.md)
- [Client Tools & Auto-Continuation](../../docs/client-tools-continuation.md)
- [@cloudflare/ai-chat README](../../packages/ai-chat/README.md)
