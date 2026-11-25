# Client-Side Tools and Auto-Continuation

## Overview

Tools in `AIChatAgent` can be divided into two categories:

- **Server tools**: Have an `execute` function on the server. The AI SDK runs them automatically and the LLM continues responding in the same turn.
- **Client tools**: No `execute` function on the server. The tool call is sent to the client via `onToolCall`, and the client provides the result. By default, this requires a new request to continue.

With `autoContinueAfterToolResult`, client tools can behave like server tools -- the LLM calls a tool, the client executes it, and the server automatically continues the conversation in the same turn.

## Server Setup

Define a tool without an `execute` function. The AI SDK will pause and send `tool-input-available` to the client:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { z } from "zod";

export class MyAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/deepseek-ai/deepseek-v4.1-flash-1017"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        // Client-side tool: no execute function
        getUserLocation: tool({
          description: "Get the user's location from their browser",
          inputSchema: z.object({})
        }),

        // Server-side tool: has execute, runs automatically
        getWeather: tool({
          description: "Get weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => fetchWeather(city)
        })
      },
      stopWhen: stepCountIs(5) // Allow multi-step so the LLM can respond after tool results
    });

    return result.toUIMessageStreamResponse();
  }
}
```

## Client Setup

Use `onToolCall` to handle client-side tool execution. Auto-continuation is enabled by default (`autoContinueAfterToolResult: true`), so the server automatically calls `onChatMessage()` again after receiving the tool result, letting the LLM continue in the same assistant message.

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "MyAgent" });

  const { messages, sendMessage } = useAgentChat({
    agent,
    // Auto-continuation is enabled by default — no need to set this explicitly
    // autoContinueAfterToolResult: true,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === "getUserLocation") {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject);
        });
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          }
        });
      }
    }
  });

  // Render messages...
}
```

## How It Works

```
User: "What's the weather near me?"

1. Client sends message → Server calls LLM
2. LLM decides to call getUserLocation (no server execute)
3. Stream sends tool-input-available to client
4. onToolCall fires → client gets geolocation → sends CF_AGENT_TOOL_RESULT
5. Server receives result with autoContinue: true
6. Server waits for the original stream to complete
7. Server calls onChatMessage() again (continuation)
8. LLM sees the location result, calls getWeather (server execute)
9. LLM responds: "It's sunny and 72°F near you!"
10. Continuation parts are merged into the same assistant message
```

The user sees a single seamless response, even though it involved a client-side tool call mid-stream.

## Without Auto-Continuation

When `autoContinueAfterToolResult` is set to `false`, the client must explicitly send a follow-up message after providing the tool result:

```tsx
const { messages, sendMessage, addToolOutput } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput: provide }) => {
    if (toolCall.toolName === "getUserLocation") {
      const pos = await getPosition();
      provide({
        toolCallId: toolCall.toolCallId,
        output: { lat: pos.coords.latitude, lng: pos.coords.longitude }
      });
    }
  }
  autoContinueAfterToolResult: false, // Disable auto-continuation
});

// After tool result is provided, send a follow-up to continue
// This creates a new assistant message rather than continuing the existing one
```

Use this when you want explicit control over when the conversation continues, or when tool results need user review before proceeding.

## Combining with `needsApproval`

You can use client-side tools and approval together. For example, a tool that needs both user approval and browser execution:

```typescript
// Server: tool with needsApproval but no execute
const shareLocation = tool({
  description: "Share the user's location with a third party",
  inputSchema: z.object({ service: z.string() }),
  needsApproval: true
  // No execute - client handles after approval
});
```

```tsx
// Client: handle approval, then execute
const { addToolApprovalResponse } = useAgentChat({
  agent,
  autoContinueAfterToolResult: true,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName === "shareLocation") {
      const pos = await getPosition();
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: { lat: pos.coords.latitude, lng: pos.coords.longitude }
      });
    }
  }
});
```

The flow becomes: LLM calls tool → user approves → client executes → server auto-continues.

If the user denies the tool instead, you can provide a custom error message using `addToolOutput` with `state: "output-error"`:

```tsx
// Deny with a reason instead of generic rejection
addToolOutput({
  toolCallId: toolCall.toolCallId,
  state: "output-error",
  errorText: "User declined to share location"
});
```

## When the user moves on without answering

A client tool call or an approval request stays pending until a client answers it. If the user sends a new message first, the next turn settles every unanswered call in the earlier replies as an error before it calls the model. That includes a call the user approved that never ran. A provider rejects a request that holds a tool call with no result (`AI_MissingToolResultsError`), so the new message could not be answered otherwise.

The error text tells the model what is known:

| The call was                                        | `errorText`                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A call to a tool the client sent with `clientTools` | "The conversation moved on before this tool call was answered. The tool may still have run." |
| An approval request the user never answered         | "The conversation moved on before this tool call was approved or denied. It did not run."    |
| A call the user approved that no turn ran           | "The tool call was approved but did not run before the next turn started."                   |
| Any other call (a server tool cut off mid-run)      | "The tool call was interrupted before a result was recorded. The tool may still have run."   |

A result that arrives for a settled call is ignored. This is a real race: a tab can still be running the tool when the user, or another tab, sends the next message. The tool's effect happened, and the model was told only that it may have. Make a client tool with side effects safe to run twice, or override `repairInterruptedToolPart` to record the call in a way the model will not retry.

`repairInterruptedToolPart` is called for every call a turn settles: a server tool cut off mid-run, a client tool call, an approval request, and an approved call. Override it to change what a settled call becomes, for example a text part that carries the question.

A continuation turn settles the earlier replies the same way. In the message it continues, it keeps the calls a client can still answer: a call to a tool the client sent with `clientTools`, and an approval request. While there is one, there is nothing to continue yet. `continueLastTurn()` changes nothing, does not call `onChatMessage`, and returns `{ requestId: "", status: "skipped", reason: "awaiting-client" }`. The client's answer starts the continuation.

`reason` says why a turn was skipped:

| `reason`                | Meaning                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `"awaiting-client"`     | The reply still waits on a client for a tool result or an approval. |
| `"nothing-to-continue"` | There is no assistant message to continue.                          |
| `"cleared"`             | The chat was cleared before or while the turn ran.                  |

The tools a turn offers the model are the `clientTools` of the request that started it. A request that sends none clears the stored ones. A tool result that settles its call and lists `clientTools` replaces them. A result that settles nothing, such as a late duplicate from another tab, leaves them.

## Reasoning at the end of a reply

A reply that is cut off right after the model's reasoning ends in a reasoning part. Anthropic rejects a request in which an assistant message's final block is a thinking block, whether a user message follows it or not, so one such reply would fail every later turn. The reasoning a reply ends in is removed when a cut-off reply is stored and before every turn. Reasoning that text or a tool call follows is kept. A text part with no text goes with the reasoning: it is the start of an answer the model never wrote.

### A reply that holds nothing

A reply has nothing left once its trailing reasoning is gone when it holds no text, no tool call and nothing else a client can show. That happens to a reply cut off while the model was still reasoning, to one cut off before the model produced anything, and to one that finished with no content.

Such a reply is not stored, in `AIChatAgent` and in `Think`. The question stays the latest message, and recovery answers it again as it does for a turn that was cut off before it produced anything. Tabs that drew the reasoning while it streamed receive the message list after the turn's terminal frame, so they drop it too.

A stored reply that is only reasoning is removed the same way. This includes a reply that finished as reasoning alone, which a model produces when it runs out of output tokens while it is thinking, and a reply an earlier version stored with its reasoning. It is removed:

- by the next turn that starts a new reply,
- by `continueLastTurn()`, which then answers the question again, and
- by a recovery that was scheduled to continue it, which also answers the question again.

Every connected client receives the message list without it. The user saw that reasoning, and after the next turn it is gone from the transcript. The reason is that an app builds its model request from the stored messages, and Anthropic rejects a request in which that message appears. To keep a copy, read it from the `chat:transcript:repaired` event: `removedMessages` holds each removed message as it was stored.

### A reply cut off while a tool runs

A tool call is written to storage before the tool runs. If the isolate resets while the tool is running, the reply is rebuilt with that call in it, and the call becomes an error that says the tool may still have run. The model and the user both see that a call was made.

A text or reasoning part a cut-off reply was in the middle of is stored closed (`state: "done"`), since nothing writes into it again.

## Related Docs

- [Chat Agents](./chat-agents.md) — Full `AIChatAgent` and `useAgentChat` reference
- [Human in the Loop](./human-in-the-loop.md) — Approval patterns including `needsApproval`
