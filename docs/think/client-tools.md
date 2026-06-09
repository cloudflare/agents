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

## Client Tools over the Sub-Agent RPC `chat()` Path

When a parent agent delegates to a Think sub-agent over RPC with `chat()` (rather than the browser WebSocket), there is no WebSocket to carry `clientTools` or to send tool results back. Pass them through `ChatOptions` instead:

```typescript
await child.chat(message, callback, {
  signal,
  clientTools: [
    {
      name: "get_user_timezone",
      description: "Get the caller's timezone",
      parameters: { type: "object" }
    }
  ],
  onClientToolCall: async ({ toolName, input }) => {
    // Run the client tool wherever the parent can — return its output.
    return runClientTool(toolName, input);
  }
});
```

- `clientTools` registers the tool schemas for the turn, exactly like the WebSocket `clientTools` field.
- `onClientToolCall` executes a client-tool call and returns its output. The model can call a client tool, receive the result, and continue — all within the single `chat()` call.

If you omit `onClientToolCall`, the tools are registered but have no result: the model's call is surfaced through the stream callback and the turn ends with a dangling tool call (the RPC stream callback has no inbound result channel of its own). Supply `onClientToolCall` whenever you want the round trip to complete.

### Behavior notes

- **Recovery:** neither the schemas nor the `onClientToolCall` executor are persisted — they are per-turn only. The executor is a live RPC reference that dies with the isolate, and (unlike the WebSocket path) there is no SPA to replay a `tool-result` after an eviction. So if an eviction interrupts the turn while a client-tool call is mid-flight, chat recovery treats the orphaned call like a server tool: `continueLastTurn`'s transcript repair errors it and the model proceeds. (Persisting the schemas would instead make recovery mistake the orphan for a pending human interaction and park forever.) To re-run cleanly, the parent re-invokes `chat()` with the `clientTools` and `onClientToolCall` again.
- **Errors:** if `onClientToolCall` throws, the failure is surfaced to the model as a tool error (`output-error`) and the turn continues — it does not crash the turn.
- **Serialization:** the value returned from `onClientToolCall` becomes the tool output, so it must be JSON-serializable (it travels back over RPC and into the model context).
- **No approval gate:** RPC client tools execute immediately through `onClientToolCall`. The WebSocket approval flow (`needsApproval`) does not apply on this path — gate execution inside your executor if you need it.
- **Name precedence:** client tools are merged after server tools, so a client tool that shares a name with a server tool (for example a workspace tool) overrides it for that turn — the same as the WebSocket path.
- **Abort:** aborting the turn via `signal` stops the loop, but an in-flight `onClientToolCall` is not itself cancelled; the turn ends after the current call resolves.

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

Concurrency strategies only apply to `submit-message` requests. Regenerations, tool continuations, approvals, clears, `saveMessages`, durable `submitMessages` submissions, and `continueLastTurn` keep their serialized behavior.

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
