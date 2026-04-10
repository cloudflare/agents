# Client Tools

Think supports tools that execute in the browser. The client sends tool schemas in the chat request body, Think merges them with server tools, and when the LLM calls a client tool, the call is routed to the client for execution.

## How Client Tools Work

1. The client sends tool schemas as part of the chat request body
2. Think merges client tools with server-side tools (workspace, `getTools()`, session, MCP)
3. The LLM calls a client tool — the tool call chunk is sent to the client over WebSocket
4. The client executes the tool and sends back a `CF_AGENT_TOOL_RESULT` message
5. Think persists the result, broadcasts `CF_AGENT_MESSAGE_UPDATED`, and optionally auto-continues

Client tools are tools without an `execute` function on the server — they only have a schema. When the LLM produces a tool call for one of these, Think sends the call to the client instead of executing it server-side.

## Defining Client Tools

On the client, pass `clientTools` to `useAgentChat`:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "MyAgent" });
  const { messages, sendMessage } = useAgentChat({
    agent,
    clientTools: {
      getUserTimezone: {
        description: "Get the user's timezone from their browser",
        parameters: {},
        execute: async () => {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        }
      },
      getClipboard: {
        description: "Read text from the user's clipboard",
        parameters: {},
        execute: async () => {
          return navigator.clipboard.readText();
        }
      }
    }
  });

  // ... render chat UI
}
```

The `parameters` field is a JSON Schema object describing the tool's input. The `execute` function runs in the browser.

## Tool Approval

Tools can require user approval before execution. This works for both server-side and client-side tools.

### Server-side approval

Use `needsApproval` in the tool definition:

```typescript
getTools(): ToolSet {
  return {
    calculate: tool({
      description: "Perform a calculation",
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
        operator: z.enum(["+", "-", "*", "/"])
      }),
      needsApproval: async ({ a, b }) =>
        Math.abs(a) > 1000 || Math.abs(b) > 1000,
      execute: async ({ a, b, operator }) => {
        const ops: Record<string, (x: number, y: number) => number> = {
          "+": (x, y) => x + y, "-": (x, y) => x - y,
          "*": (x, y) => x * y, "/": (x, y) => x / y
        };
        return { result: ops[operator](a, b) };
      }
    })
  };
}
```

When `needsApproval` returns `true`:

1. Think sends the tool call to the client with a pending approval state
2. The conversation pauses
3. The client shows an approval UI and sends `CF_AGENT_TOOL_APPROVAL` (approve or deny)
4. If approved, the tool executes and the conversation continues
5. If denied, the denial reason is returned to the model as the tool result

### Handling approvals on the client

`useAgentChat` provides approval helpers:

```tsx
const { messages, sendMessage, addToolResult } = useAgentChat({
  agent,
  onToolCall: ({ toolCall }) => {
    // Auto-approve safe tools
    if (toolCall.toolName === "read") {
      return { approve: true };
    }
    // Others go through the UI approval flow
  }
});
```

See [Client Tools Continuation](../client-tools-continuation.md) for the full protocol reference.

## Auto-Continuation

After a client tool result is received, Think can automatically continue the conversation without a new user message. This is the default behavior — when all pending tool results are received, Think starts a new model turn with the tool results in context.

The continuation turn has `continuation: true` in the `TurnContext`, which you can use in `beforeTurn` to adjust model or tool selection:

```typescript
beforeTurn(ctx: TurnContext) {
  if (ctx.continuation) {
    return { model: this.cheapModel };
  }
}
```

## Message Concurrency

The `messageConcurrency` property controls how overlapping user submits behave when a chat turn is already active.

```typescript
import { Think } from "@cloudflare/think";
import type { MessageConcurrency } from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  override messageConcurrency: MessageConcurrency = "queue"; // default

  getModel() {
    /* ... */
  }
}
```

### Strategies

| Strategy                                        | Behavior                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `"queue"`                                       | Queue every submit and process them in order. Default.                                                                               |
| `"latest"`                                      | Keep only the latest overlapping submit. Superseded submits still persist their user messages but do not start their own model turn. |
| `"merge"`                                       | Like `"latest"`, but all overlapping user messages remain in the conversation history. The model sees them all in one turn.          |
| `"drop"`                                        | Ignore overlapping submits entirely. Messages are not persisted.                                                                     |
| `{ strategy: "debounce", debounceMs?: number }` | Trailing-edge latest with a quiet window (default 750ms).                                                                            |

Concurrency strategies only apply to `submit-message` requests. Regenerations, tool continuations, approvals, clears, `saveMessages`, and `continueLastTurn` keep their serialized behavior.

### Examples

For a search-as-you-type UI where each keystroke sends a new query:

```typescript
export class SearchAgent extends Think<Env> {
  override messageConcurrency: MessageConcurrency = "latest";
  getModel() {
    /* ... */
  }
}
```

For a collaborative editor where multiple users type simultaneously:

```typescript
export class CollabAgent extends Think<Env> {
  override messageConcurrency: MessageConcurrency = "merge";
  getModel() {
    /* ... */
  }
}
```

For a debounced input where the model only responds after the user stops typing:

```typescript
export class DebouncedAgent extends Think<Env> {
  override messageConcurrency: MessageConcurrency = {
    strategy: "debounce",
    debounceMs: 1000
  };
  getModel() {
    /* ... */
  }
}
```

## Multi-Tab Broadcast

Think broadcasts streaming responses to all connected WebSocket clients. When multiple browser tabs are connected to the same agent:

- All tabs see the streamed response in real time
- Tool call states (pending, result, approval) are broadcast to all tabs
- The tab that resumes a stream is excluded from the broadcast to avoid duplicates
- `CF_AGENT_MESSAGE_UPDATED` events are sent to all tabs after tool results and message persistence
