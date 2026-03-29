# Chat Agents

Build AI-powered chat interfaces with `AIChatAgent` and `useAgentChat`. Messages are automatically persisted to SQLite, streams resume on disconnect, and tool calls work across server and client.

## Overview

`@cloudflare/ai-chat` provides two main exports:

| Export         | Import                      | Purpose                                                        |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| `AIChatAgent`  | `@cloudflare/ai-chat`       | Server-side agent class with message persistence and streaming |
| `useAgentChat` | `@cloudflare/ai-chat/react` | React hook for building chat UIs                               |

Built on the [AI SDK](https://ai-sdk.dev) and Cloudflare Durable Objects, you get:

- **Automatic message persistence** — conversations stored in SQLite, survive restarts
- **Resumable streaming** — disconnected clients resume mid-stream without data loss
- **Real-time sync** — messages broadcast to all connected clients via WebSocket
- **Tool support** — server-side, client-side, and human-in-the-loop tool patterns
- **Data parts** — attach typed JSON (citations, progress, usage) to messages alongside text
- **Row size protection** — automatic compaction when messages approach SQLite limits

## Quick Start

### Install

```sh
npm install @cloudflare/ai-chat agents ai workers-ai-provider
```

### Server

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";

export class ChatAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
  }
}
```

### Client

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "ChatAgent" });
  const { messages, sendMessage, status } = useAgentChat({ agent });

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
          sendMessage({ text: input.value });
          input.value = "";
        }}
      >
        <input name="input" placeholder="Type a message..." />
        <button type="submit" disabled={status === "streaming"}>
          Send
        </button>
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
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatAgent"] }]
}
```

The `new_sqlite_classes` migration is required — `AIChatAgent` uses SQLite for message persistence and stream chunk buffering.

## How It Works

```
┌──────────┐               WebSocket                ┌──────────────┐
│  Client  │ ◀──────────────────────────────────▶   │ AIChatAgent  │
│          │                                        │              │
│ useAgent │   CF_AGENT_USE_CHAT_REQUEST ──────▶    │ onChatMessage│
│    Chat  │                                        │              │
│          │   ◀────── CF_AGENT_USE_CHAT_RESPONSE   │  streamText  │
│          │          (UIMessageChunk stream)       │              │
│          │                                        │   SQLite     │
│          │   ◀────── CF_AGENT_CHAT_MESSAGES       │  (messages,  │
│          │          (broadcast to all clients)    │   chunks)    │
└──────────┘                                        └──────────────┘
```

1. The client sends a message via WebSocket
2. `AIChatAgent` persists messages to SQLite and calls your `onChatMessage` method
3. Your method returns a streaming `Response` (typically from `streamText`)
4. Chunks stream back over WebSocket in real-time
5. When the stream completes, the final message is persisted and broadcast to all connections

## Server API

### `AIChatAgent`

Extends `Agent` from the `agents` package. Manages conversation state, persistence, and streaming.

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";

export class ChatAgent extends AIChatAgent {
  // Access current messages
  // this.messages: UIMessage[]

  // Limit stored messages (optional)
  maxPersistedMessages = 200;

  async onChatMessage(onFinish?, options?) {
    // onFinish: optional callback for streamText (cleanup is automatic)
    // options.abortSignal: cancel signal
    // options.body: custom data from client
    // Return a Response (streaming or plain text)
  }
}
```

### `onChatMessage`

This is the main method you override. It receives the conversation context and should return a `Response`.

**Streaming response** (most common):

```typescript
async onChatMessage() {
  const workersai = createWorkersAI({ binding: this.env.AI });

  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.5"),
    system: "You are a helpful assistant.",
    messages: await convertToModelMessages(this.messages)
  });

  return result.toUIMessageStreamResponse();
}
```

**Plain text response**:

```typescript
async onChatMessage() {
  return new Response("Hello! I am a simple agent.", {
    headers: { "Content-Type": "text/plain" }
  });
}
```

**Accessing custom body data and request ID**:

```typescript
async onChatMessage(_onFinish, options) {
  const { timezone, userId } = options?.body ?? {};
  // Use these values in your LLM call or business logic

  // options.requestId — unique identifier for this chat request,
  // useful for logging and correlating events
  console.log("Request ID:", options?.requestId);
}
```

### `this.messages`

The current conversation history, loaded from SQLite. This is an array of `UIMessage` objects from the AI SDK. Messages are automatically persisted after each interaction.

### `maxPersistedMessages`

Cap the number of messages stored in SQLite. When the limit is exceeded, the oldest messages are deleted. This controls storage only — it does not affect what is sent to the LLM.

```typescript
export class ChatAgent extends AIChatAgent {
  maxPersistedMessages = 200;
}
```

To control what is sent to the model, use the AI SDK's `pruneMessages()`:

```typescript
import { streamText, convertToModelMessages, pruneMessages } from "ai";

async onChatMessage() {
  const workersai = createWorkersAI({ binding: this.env.AI });

  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.5"),
    messages: pruneMessages({
      messages: await convertToModelMessages(this.messages),
      reasoning: "before-last-message",
      toolCalls: "before-last-2-messages"
    })
  });

  return result.toUIMessageStreamResponse();
}
```

### `waitForMcpConnections`

Controls whether `AIChatAgent` waits for MCP server connections to settle before calling `onChatMessage`. This ensures `this.mcp.getAITools()` returns the full set of tools, especially after Durable Object hibernation when connections are being restored in the background.

| Value                 | Behavior                                      |
| --------------------- | --------------------------------------------- |
| `{ timeout: 10_000 }` | Wait up to 10 seconds (default)               |
| `{ timeout: N }`      | Wait up to `N` milliseconds                   |
| `true`                | Wait indefinitely until all connections ready |
| `false`               | Do not wait (old behavior before 0.2.0)       |

```typescript
export class ChatAgent extends AIChatAgent {
  // Default — waits up to 10 seconds
  // waitForMcpConnections = { timeout: 10_000 };

  // Wait forever
  waitForMcpConnections = true;

  // Disable waiting
  waitForMcpConnections = false;
}
```

For lower-level control, call `this.mcp.waitForConnections()` directly inside your `onChatMessage` instead.

### `persistMessages` and `saveMessages`

For advanced cases, you can manually persist messages:

```typescript
// Persist messages without triggering a new response
await this.persistMessages(messages);

// Persist messages AND trigger onChatMessage (e.g., programmatic messages)
await this.saveMessages(messages);
```

`saveMessages()` waits for any active chat turn to finish before it starts a
new one, so scheduled or programmatic messages do not overlap an in-flight
stream.

### `onResponse`

Called after a chat turn completes and the assistant message has been persisted. Override this to react when the agent finishes responding — broadcast state, process queued work, track analytics, or trigger follow-up messages.

```typescript
import { AIChatAgent, type ResponseResult } from "@cloudflare/ai-chat";

export class ChatAgent extends AIChatAgent {
  protected async onResponse(result: ResponseResult) {
    if (result.status === "completed") {
      this.broadcast(JSON.stringify({ streaming: false }));
    }
  }
}
```

The turn lock is released before `onResponse` runs, so it is safe to call `saveMessages` from inside the hook. This enables sequential queue processing:

```typescript
protected async onResponse(result: ResponseResult) {
  if (result.status === "completed" && this.workQueue.length > 0) {
    const next = this.workQueue.shift()!;
    await this.saveMessages([
      ...this.messages,
      { id: nanoid(), role: "user", parts: [{ type: "text", text: next }] }
    ]);
  }
}
```

When `saveMessages` is called from `onResponse`, the inner turn's response is automatically drained — `onResponse` fires again for the inner response, allowing the queue to progress naturally. This continues until the queue is empty.

Responses triggered from inside `onResponse` do not fire the hook concurrently. They are drained sequentially after the outer hook returns.

**`ResponseResult` fields:**

| Field          | Type                                  | Description                                          |
| -------------- | ------------------------------------- | ---------------------------------------------------- |
| `message`      | `UIMessage`                           | The finalized assistant message from this turn       |
| `requestId`    | `string`                              | The request ID associated with this turn             |
| `continuation` | `boolean`                             | Whether this turn was a continuation (auto-continue) |
| `status`       | `"completed" \| "error" \| "aborted"` | How the turn ended                                   |
| `error`        | `string \| undefined`                 | Error message when `status` is `"error"`             |

`onResponse` fires for all turn completion paths: WebSocket chat requests, `saveMessages`, and auto-continuation after tool results or approvals.

### Turn coordination helpers

`AIChatAgent` serializes chat turns — WebSocket requests, tool continuations,
and `saveMessages()` calls all run one at a time. Most subclasses do not need to
think about this; the SDK handles the queuing automatically.

Coordination becomes relevant when your subclass runs code **outside** the
normal `onChatMessage()` flow — for example, a `schedule()` callback that
injects a message, a workflow-switching method, or a custom clear handler that
scopes deletes to a particular workflow. In these situations, the subclass
needs to know whether the conversation is mid-stream or waiting on user input
before it can safely act on `this.messages`.

Three protected helpers cover these cases:

| Helper                    | Returns            | When to use                                                                                                                     |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `waitUntilStable()`       | `Promise<boolean>` | Before reading or writing messages — waits for any active stream, pending tool interactions, and queued continuations to finish |
| `resetTurnState()`        | `void`             | When discarding the current conversation state — aborts the active stream and invalidates queued continuations                  |
| `hasPendingInteraction()` | `boolean`          | When you need a synchronous check for whether a tool is waiting on user input or approval                                       |

#### How the turn lifecycle works

A chat turn starts when a WebSocket message or `saveMessages()` call enters the
queue and ends after the `_reply()` stream finishes and the final assistant
message is persisted. If a tool result or approval arrives with
`autoContinue: true`, a continuation turn is queued automatically — the
conversation is not stable until that continuation finishes too.

A pending interaction is different from an active turn. The stream has finished,
but a tool part in the assistant message is in `input-available` or
`approval-requested` state — the SDK is waiting for the client to send a result
or approval. Until the user responds, `this.messages` reflects the pending
state.

`waitUntilStable()` handles both cases: it drains the turn queue, checks for
pending interactions, waits for any in-flight tool applies, and loops until
nothing is left. It only returns `true` once the conversation is genuinely
idle.

#### Waiting before injecting messages

The most common pattern is a `schedule()` callback or `onConnect()` method that
needs to inject a synthetic message into the conversation. Call
`waitUntilStable()` before reading `this.messages` or calling `saveMessages()`:

```typescript
async onTaskComplete(payload: { result: string }) {
  const ready = await this.waitUntilStable({ timeout: 30_000 });
  if (!ready) return; // timed out — a pending interaction was not resolved

  const syntheticMessage = {
    id: nanoid(),
    role: "user" as const,
    parts: [{ type: "text" as const, text: `Task result: ${payload.result}` }]
  };

  await this.saveMessages([...this.messages, syntheticMessage]);
}
```

Always pass a `timeout`. Without one, `waitUntilStable()` waits indefinitely —
if a tool is pending user approval and the user closes their browser, the
promise never resolves. The timeout lets you fail gracefully and retry later.

When `waitUntilStable()` returns `true`, `this.messages` is safe to read and
`saveMessages()` will not overlap with another turn. When it returns `false`,
the conversation is still in flux and you should not assume message state is
settled.

#### Checking pending interactions synchronously

`hasPendingInteraction()` is a synchronous check — it scans `this.messages`
for any assistant message with a tool part in `input-available` or
`approval-requested` state. Use it when you need to branch without awaiting:

```typescript
async onConnect(connection, ctx) {
  if (this.hasPendingInteraction()) {
    connection.send(JSON.stringify({
      type: "status",
      message: "Waiting for your input on a pending tool action"
    }));
  }
}
```

This does not tell you whether a stream is active — only whether a tool is
waiting on user input. For most coordination needs, prefer `waitUntilStable()`.

#### Resetting on workflow switch

Call `resetTurnState()` when the user switches context and the current stream
and any queued continuations are no longer relevant. It does three things:
increments the internal epoch (so queued continuations skip themselves), fires
the abort signal on the active stream, and clears any pending interaction
bookkeeping.

```typescript
async switchWorkflow(newWorkflowId: string) {
  this.resetTurnState();
  this.workflowId = newWorkflowId;
}
```

After `resetTurnState()`, the turn queue drains quickly — aborted turns finish
their cleanup and skipped continuations return immediately.

#### Overriding the clear handler

The SDK's built-in `CF_AGENT_CHAT_CLEAR` handler calls `resetTurnState()`
automatically. If your `onMessage` override intercepts `CF_AGENT_CHAT_CLEAR`
and returns before the SDK sees the message — for example, to scope the delete
to a specific workflow — the built-in handler never runs. The active stream
continues and queued continuations persist into the newly-cleared conversation.

Call `this.resetTurnState()` before performing your scoped delete:

```typescript
import { MessageType } from "@cloudflare/ai-chat/types";

const _onMessage = this.onMessage.bind(this);
this.onMessage = async (connection, message) => {
  if (typeof message === "string") {
    const data = JSON.parse(message);
    if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
      this.resetTurnState();
      this.sql`
        DELETE FROM cf_ai_chat_agent_messages
        WHERE workflow_id = ${this.workflowId}
      `;
      this.messages = [];
      return;
    }
  }
  return _onMessage(connection, message);
};
```

### Lifecycle Hooks

Override `onConnect` and `onClose` to add custom logic. Stream resumption and message sync are handled for you automatically — you do not need to call `super`:

```typescript
export class ChatAgent extends AIChatAgent {
  async onConnect(connection, ctx) {
    // Your custom logic (e.g., logging, auth checks)
    console.log("Client connected:", connection.id);
    // Stream resumption and message sync are handled automatically
  }

  async onClose(connection, code, reason, wasClean) {
    console.log("Client disconnected:", connection.id);
    // Connection cleanup is handled automatically
  }
}
```

The `destroy()` method cancels any pending chat requests and cleans up stream state. It is called automatically when the Durable Object is evicted, but you can call it manually if needed.

### Request Cancellation

When a user clicks "stop" in the chat UI, the client sends a `CF_AGENT_CHAT_REQUEST_CANCEL` message. The server propagates this to the `abortSignal` in `options`:

```typescript
async onChatMessage(_onFinish, options) {
  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.5"),
    messages: await convertToModelMessages(this.messages),
    abortSignal: options?.abortSignal // Pass through for cancellation
  });

  return result.toUIMessageStreamResponse();
}
```

If you do not pass `abortSignal` to `streamText`, the LLM call will continue running in the background even after the user cancels. Always forward it when possible.

## Client API

### `useAgentChat`

React hook that connects to an `AIChatAgent` over WebSocket. Wraps the AI SDK's `useChat` with a native WebSocket transport.

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "ChatAgent" });
  const {
    messages,
    sendMessage,
    clearHistory,
    addToolOutput,
    addToolApprovalResponse,
    setMessages,
    status,
    isServerStreaming,
    isStreaming
  } = useAgentChat({ agent });

  // ...
}
```

### Options

| Option                        | Type                                          | Default  | Description                                                                                                              |
| ----------------------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent`                       | `ReturnType<typeof useAgent>`                 | Required | Agent connection from `useAgent`                                                                                         |
| `onToolCall`                  | `({ toolCall, addToolOutput }) => void`       | —        | Handle client-side tool execution                                                                                        |
| `autoContinueAfterToolResult` | `boolean`                                     | `true`   | Auto-continue conversation after client tool results and approvals                                                       |
| `resume`                      | `boolean`                                     | `true`   | Enable automatic stream resumption on reconnect                                                                          |
| `body`                        | `object \| () => object`                      | —        | Custom data sent with every request                                                                                      |
| `prepareSendMessagesRequest`  | `(options) => { body?, headers? }`            | —        | Advanced per-request customization                                                                                       |
| `tools`                       | `Record<string, AITool>`                      | —        | Dynamic client-defined tools for SDK/platform use cases. Schemas are sent to the server automatically                    |
| `getInitialMessages`          | `(options) => Promise<UIMessage[]>` or `null` | —        | Custom initial message loader. Set to `null` to skip the HTTP fetch entirely (useful when providing `messages` directly) |

### Return Values

| Property                  | Type                               | Description                                                                |
| ------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `messages`                | `UIMessage[]`                      | Current conversation messages                                              |
| `sendMessage`             | `(message) => void`                | Send a message                                                             |
| `clearHistory`            | `() => void`                       | Clear conversation (client and server)                                     |
| `addToolOutput`           | `({ toolCallId, output }) => void` | Provide output for a client-side tool                                      |
| `addToolApprovalResponse` | `({ id, approved }) => void`       | Approve or reject a tool requiring approval                                |
| `setMessages`             | `(messages \| updater) => void`    | Set messages directly (syncs to server)                                    |
| `status`                  | `string`                           | `"idle"`, `"submitted"`, `"streaming"`, or `"error"`                       |
| `isServerStreaming`       | `boolean`                          | `true` when a server-initiated stream is active (e.g. from `saveMessages`) |
| `isStreaming`             | `boolean`                          | `true` when any stream is active (client or server-initiated)              |

## Tools

`AIChatAgent` supports three tool patterns, all using the AI SDK's `tool()` function:

| Pattern     | Where it runs                | When to use                                   |
| ----------- | ---------------------------- | --------------------------------------------- |
| Server-side | Server (automatic)           | API calls, database queries, computations     |
| Client-side | Browser (via `onToolCall`)   | Geolocation, clipboard, camera, local storage |
| Approval    | Server (after user approval) | Payments, deletions, external actions         |

### Server-Side Tools

Tools with an `execute` function run automatically on the server:

```typescript
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";

async onChatMessage() {
  const workersai = createWorkersAI({ binding: this.env.AI });

  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.5"),
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
    stopWhen: stepCountIs(5)
  });

  return result.toUIMessageStreamResponse();
}
```

### Client-Side Tools

Define a tool on the server without `execute`, then handle it on the client with `onToolCall`. Use this for tools that need browser APIs:

**Server:**

```typescript
tools: {
  getLocation: tool({
    description: "Get the user's location from the browser",
    inputSchema: z.object({})
    // No execute — the client handles it
  });
}
```

**Client:**

```tsx
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

When the LLM invokes `getLocation`, the stream pauses. The `onToolCall` callback fires, your code provides the output, and the conversation continues.

### Dynamic Client Tools (SDK/Platform Pattern)

For SDKs and platforms where tools are defined dynamically by the embedding application at runtime, use the `tools` option on `useAgentChat` and `createToolsFromClientSchemas()` on the server:

**Server:**

```typescript
import { createToolsFromClientSchemas } from "@cloudflare/ai-chat";

async onChatMessage(_onFinish, options) {
  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.5"),
    messages: await convertToModelMessages(this.messages),
    tools: createToolsFromClientSchemas(options?.clientTools)
  });
  return result.toUIMessageStreamResponse();
}
```

**Client:**

```tsx
import { useAgentChat, type AITool } from "@cloudflare/ai-chat/react";

const tools: Record<string, AITool> = {
  getPageTitle: {
    description: "Get the current page title",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ title: document.title })
  }
};

const { messages, sendMessage } = useAgentChat({
  agent,
  tools,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    const tool = tools[toolCall.toolName];
    if (tool?.execute) {
      const output = await tool.execute(toolCall.input);
      addToolOutput({ toolCallId: toolCall.toolCallId, output });
    }
  }
});
```

For most apps, server-side tools with `tool()` and `onToolCall` are simpler and provide full Zod type safety. Use dynamic client tools when the server does not know the tool surface at deploy time.

### Tool Approval (Human-in-the-Loop)

Use `needsApproval` for tools that require user confirmation before executing:

**Server:**

```typescript
tools: {
  processPayment: tool({
    description: "Process a payment",
    inputSchema: z.object({
      amount: z.number(),
      recipient: z.string()
    }),
    needsApproval: async ({ amount }) => amount > 100,
    execute: async ({ amount, recipient }) => charge(amount, recipient)
  });
}
```

**Client:**

```tsx
import { isToolUIPart, getToolName } from "ai";

const { messages, addToolApprovalResponse } = useAgentChat({ agent });

// Render pending approvals from message parts
{
  messages.map((msg) =>
    msg.parts
      .filter(
        (part) =>
          isToolUIPart(part) &&
          "approval" in part &&
          part.state === "approval-requested"
      )
      .map((part) => (
        <div key={part.toolCallId}>
          <p>Approve {getToolName(part)}?</p>
          <button
            onClick={() =>
              addToolApprovalResponse({
                id: part.approval?.id,
                approved: true
              })
            }
          >
            Approve
          </button>
          <button
            onClick={() =>
              addToolApprovalResponse({
                id: part.approval?.id,
                approved: false
              })
            }
          >
            Reject
          </button>
        </div>
      ))
  );
}
```

When denied, the tool part transitions to `output-denied`. You can also use `addToolOutput` with `state: "output-error"` for custom denial messages — see [Human in the Loop](./human-in-the-loop.md) for details.

## Custom Request Data

Include custom data with every chat request using the `body` option:

```tsx
const { messages, sendMessage } = useAgentChat({
  agent,
  body: {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userId: currentUser.id
  }
});
```

For dynamic values, use a function:

```tsx
body: () => ({
  token: getAuthToken(),
  timestamp: Date.now()
});
```

Access these fields on the server:

```typescript
async onChatMessage(_onFinish, options) {
  const { timezone, userId } = options?.body ?? {};
  // ...
}
```

For advanced per-request customization (custom headers, different body per request), use `prepareSendMessagesRequest`:

```tsx
const { messages, sendMessage } = useAgentChat({
  agent,
  prepareSendMessagesRequest: async ({ messages, trigger }) => ({
    headers: { Authorization: `Bearer ${await getToken()}` },
    body: { requestedAt: Date.now() }
  })
});
```

## Data Parts

Data parts let you attach typed JSON to messages alongside text — progress indicators, source citations, token usage, or any structured data your UI needs.

### Writing Data Parts (Server)

Use `createUIMessageStream` with `writer.write()` to send data parts from the server:

```ts
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse
} from "ai";

export class ChatAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: workersai("@cf/moonshotai/kimi-k2.5"),
          messages: await convertToModelMessages(this.messages)
        });

        // Merge the LLM stream
        writer.merge(result.toUIMessageStream());

        // Write a data part — persisted to message.parts
        writer.write({
          type: "data-sources",
          id: "src-1",
          data: { query: "agents", status: "searching", results: [] }
        });

        // Later: update the same part in-place (same type + id)
        writer.write({
          type: "data-sources",
          id: "src-1",
          data: {
            query: "agents",
            status: "found",
            results: ["Agents SDK docs", "Durable Objects guide"]
          }
        });
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}
```

### Three Patterns

| Pattern            | How                                              | Persisted? | Use case                              |
| ------------------ | ------------------------------------------------ | ---------- | ------------------------------------- |
| **Reconciliation** | Same `type` + `id` → updates in-place            | Yes        | Progressive state (searching → found) |
| **Append**         | No `id`, or different `id` → appends             | Yes        | Log entries, multiple citations       |
| **Transient**      | `transient: true` → not added to `message.parts` | No         | Ephemeral status (thinking indicator) |

Transient parts are broadcast to connected clients in real time but excluded from SQLite persistence and `message.parts`. Use the `onData` callback to consume them.

### Reading Data Parts (Client)

Non-transient data parts appear in `message.parts`. Use the `UIMessage` generic to type them:

```ts
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";

type ChatMessage = UIMessage<
  unknown,
  {
    sources: { query: string; status: string; results: string[] };
    usage: { model: string; inputTokens: number; outputTokens: number };
  }
>;

const { messages } = useAgentChat<unknown, ChatMessage>({ agent });

// Typed access — no casts needed
for (const msg of messages) {
  for (const part of msg.parts) {
    if (part.type === "data-sources") {
      console.log(part.data.results); // string[]
    }
  }
}
```

### Transient Parts with `onData`

Transient data parts are not in `message.parts`. Use the `onData` callback instead:

```ts
const [thinking, setThinking] = useState(false);

const { messages } = useAgentChat<unknown, ChatMessage>({
  agent,
  onData(part) {
    if (part.type === "data-thinking") {
      setThinking(true);
    }
  }
});
```

On the server, write transient parts with `transient: true`:

```ts
writer.write({
  transient: true,
  type: "data-thinking",
  data: { model: "glm-4.7-flash", startedAt: new Date().toISOString() }
});
```

`onData` fires on all code paths — new messages, stream resumption, and cross-tab broadcasts.

## Resumable Streaming

Streams automatically resume when a client disconnects and reconnects. No configuration is needed — it works out of the box.

When streaming is active:

1. All chunks are buffered in SQLite as they are generated
2. If the client disconnects, the server continues streaming and buffering
3. When the client reconnects, it receives all buffered chunks and resumes live streaming

Disable with `resume: false`:

```tsx
const { messages } = useAgentChat({ agent, resume: false });
```

For more details, see [Resumable Streaming](./resumable-streaming.md).

## Storage Management

### Row Size Protection

SQLite rows have a maximum size of 2 MB. When a message approaches this limit (for example, a tool returning a very large output), `AIChatAgent` automatically compacts the message:

1. **Tool output compaction** — Large tool outputs are replaced with an LLM-friendly summary that instructs the model to suggest re-running the tool
2. **Text truncation** — If the message is still too large after tool compaction, text parts are truncated with a note

Compacted messages include `metadata.compactedToolOutputs` so clients can detect and display this gracefully.

### `sanitizeMessageForPersistence`

Override this method to transform messages before they are written to SQLite. It runs after the built-in sanitization (OpenAI metadata stripping, Anthropic provider-executed tool payload truncation, empty reasoning part removal), so built-in cleanup is never bypassed.

The default implementation returns the message unchanged.

```typescript
import type { UIMessage } from "ai";

export class ChatAgent extends AIChatAgent {
  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return {
      ...message,
      parts: message.parts.map((part) => {
        // Strip large tool outputs you do not need to persist
        if (
          "output" in part &&
          typeof part.output === "string" &&
          part.output.length > 2000
        ) {
          return { ...part, output: "[redacted — too large to store]" };
        }
        return part;
      })
    };
  }
}
```

Built-in sanitization already handles:

- **OpenAI** — strips ephemeral `itemId` and `reasoningEncryptedContent` from `providerMetadata`
- **Anthropic** — truncates large strings in `input`/`output` of provider-executed tool parts (code execution, text editor)
- **Reasoning** — removes empty reasoning parts left after metadata stripping

Use `sanitizeMessageForPersistence` for anything the built-in logic does not cover, such as redacting sensitive fields or trimming domain-specific tool outputs.

### Controlling LLM Context vs Storage

Storage (`maxPersistedMessages`) and LLM context are independent:

| Concern                         | Control                           | Scope       |
| ------------------------------- | --------------------------------- | ----------- |
| How many messages SQLite stores | `maxPersistedMessages`            | Persistence |
| What the model sees             | `pruneMessages()`                 | LLM context |
| Custom pre-persist transforms   | `sanitizeMessageForPersistence()` | Per-message |
| Row size limits                 | Automatic compaction              | Per-message |

```typescript
export class ChatAgent extends AIChatAgent {
  maxPersistedMessages = 200; // Storage limit

  async onChatMessage() {
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      messages: pruneMessages({
        // LLM context limit
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message",
        toolCalls: "before-last-2-messages"
      })
    });

    return result.toUIMessageStreamResponse();
  }
}
```

## Using Different AI Providers

`AIChatAgent` works with any AI SDK-compatible provider. The server code determines which model to use — the client does not need to change.

### Workers AI (Cloudflare)

```typescript
import { createWorkersAI } from "workers-ai-provider";

const workersai = createWorkersAI({ binding: this.env.AI });
const result = streamText({
  model: workersai("@cf/moonshotai/kimi-k2.5"),
  messages: await convertToModelMessages(this.messages)
});
```

### OpenAI

```typescript
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
const result = streamText({
  model: openai.chat("gpt-4o"),
  messages: await convertToModelMessages(this.messages)
});
```

### Anthropic

```typescript
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
const result = streamText({
  model: anthropic("claude-sonnet-4-20250514"),
  messages: await convertToModelMessages(this.messages)
});
```

## Advanced Patterns

Since `onChatMessage` gives you full control over the `streamText` call, you can use any AI SDK feature directly. The patterns below all work out of the box — no special `AIChatAgent` configuration is needed.

### Dynamic Model and Tool Control

Use [`prepareStep`](https://ai-sdk.dev/docs/agents/loop-control) to change the model, available tools, or system prompt between steps in a multi-step agent loop:

```typescript
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai";
import { z } from "zod";

async onChatMessage() {
  const result = streamText({
    model: cheapModel, // Default model for simple steps
    messages: await convertToModelMessages(this.messages),
    tools: {
      search: searchTool,
      analyze: analyzeTool,
      summarize: summarizeTool
    },
    stopWhen: stepCountIs(10),
    prepareStep: async ({ stepNumber, messages }) => {
      // Phase 1: Search (steps 0-2)
      if (stepNumber <= 2) {
        return {
          activeTools: ["search"],
          toolChoice: "required" // Force tool use
        };
      }

      // Phase 2: Analyze with a stronger model (steps 3-5)
      if (stepNumber <= 5) {
        return {
          model: expensiveModel,
          activeTools: ["analyze"]
        };
      }

      // Phase 3: Summarize
      return { activeTools: ["summarize"] };
    }
  });

  return result.toUIMessageStreamResponse();
}
```

`prepareStep` runs before each step and can return overrides for `model`, `activeTools`, `toolChoice`, `system`, and `messages`. Use it to:

- **Switch models** — use a cheap model for simple steps, escalate for reasoning
- **Phase tools** — restrict which tools are available at each step
- **Manage context** — prune or transform messages to stay within token limits
- **Force tool calls** — use `toolChoice: { type: "tool", toolName: "search" }` to require a specific tool

### Language Model Middleware

Use [`wrapLanguageModel`](https://ai-sdk.dev/docs/ai-sdk-core/middleware) to add guardrails, RAG, caching, or logging without modifying your chat logic:

```typescript
import { streamText, convertToModelMessages, wrapLanguageModel } from "ai";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";

const guardrailMiddleware: LanguageModelV3Middleware = {
  wrapGenerate: async ({ doGenerate }) => {
    const { text, ...rest } = await doGenerate();
    // Filter PII or sensitive content from the response
    const cleaned = text?.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED]");
    return { text: cleaned, ...rest };
  }
};

async onChatMessage() {
  const model = wrapLanguageModel({
    model: baseModel,
    middleware: [guardrailMiddleware]
  });

  const result = streamText({
    model,
    messages: await convertToModelMessages(this.messages)
  });

  return result.toUIMessageStreamResponse();
}
```

The AI SDK includes built-in middlewares:

- `extractReasoningMiddleware` — surface chain-of-thought from models like DeepSeek R1
- `defaultSettingsMiddleware` — apply default temperature, max tokens, etc.
- `simulateStreamingMiddleware` — add streaming to non-streaming models

Multiple middlewares compose in order: `middleware: [first, second]` applies as `first(second(model))`.

### Structured Output

Use [`generateObject`](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) inside tools for structured data extraction:

```typescript
import {
  streamText, generateObject, convertToModelMessages, tool, stepCountIs
} from "ai";
import { z } from "zod";

async onChatMessage() {
  const result = streamText({
    model: myModel,
    messages: await convertToModelMessages(this.messages),
    tools: {
      extractContactInfo: tool({
        description: "Extract structured contact information from the conversation",
        inputSchema: z.object({
          text: z.string().describe("The text to extract contact info from")
        }),
        execute: async ({ text }) => {
          const { object } = await generateObject({
            model: myModel,
            schema: z.object({
              name: z.string(),
              email: z.string().email(),
              phone: z.string().optional()
            }),
            prompt: `Extract contact information from: ${text}`
          });
          return object;
        }
      })
    },
    stopWhen: stepCountIs(5)
  });

  return result.toUIMessageStreamResponse();
}
```

### Subagent Delegation

Tools can delegate work to focused sub-calls with their own context. Use [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) to define a reusable agent, then call it from a tool's `execute`:

```typescript
import {
  ToolLoopAgent, streamText, convertToModelMessages, tool, stepCountIs
} from "ai";
import { z } from "zod";

// Define a reusable research agent with its own tools and instructions
const researchAgent = new ToolLoopAgent({
  model: researchModel,
  instructions: "You are a research assistant. Be thorough and cite sources.",
  tools: { webSearch: webSearchTool },
  stopWhen: stepCountIs(10)
});

async onChatMessage() {
  const result = streamText({
    model: orchestratorModel,
    messages: await convertToModelMessages(this.messages),
    tools: {
      deepResearch: tool({
        description: "Research a topic in depth",
        inputSchema: z.object({
          topic: z.string().describe("The topic to research")
        }),
        execute: async ({ topic }) => {
          const { text } = await researchAgent.generate({ prompt: topic });
          return { summary: text };
        }
      })
    },
    stopWhen: stepCountIs(5)
  });

  return result.toUIMessageStreamResponse();
}
```

The research agent runs in its own context — its token budget is separate from the orchestrator's. Only the summary goes back to the parent model.

`ToolLoopAgent` is best suited for subagents, not as a replacement for `streamText` in `onChatMessage` itself. The main `onChatMessage` benefits from direct access to `this.env`, `this.messages`, and `options.body` — things that a pre-configured `ToolLoopAgent` instance cannot reference.

#### Streaming progress with preliminary results

By default, a tool part appears as loading until `execute` returns. Use an async generator (`async function*`) to stream progress updates to the client while the tool is still working:

```typescript
deepResearch: tool({
  description: "Research a topic in depth",
  inputSchema: z.object({
    topic: z.string().describe("The topic to research")
  }),
  async *execute({ topic }) {
    // Preliminary result — the client sees "searching" immediately
    yield { status: "searching", topic, summary: undefined };

    const { text } = await researchAgent.generate({ prompt: topic });

    // Final result — sent to the model for its next step
    yield { status: "done", topic, summary: text };
  }
});
```

Each `yield` updates the tool part on the client in real-time (with `preliminary: true`). The last yielded value becomes the final output that the model sees. This is useful for long-running tools where you want to show status (searching, analyzing, summarizing) as the work progresses.

This pattern is useful when:

- A task requires exploring large amounts of information that would bloat the main context
- You want to show real-time progress for long-running tools
- You want to parallelize independent research (multiple tool calls run concurrently)
- You need different models or system prompts for different subtasks

For more, see the [AI SDK Agents docs](https://ai-sdk.dev/docs/agents/overview), [Subagents](https://ai-sdk.dev/docs/agents/subagents), and [Preliminary Tool Results](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#preliminary-tool-results).

## Multi-Client Sync

When multiple clients connect to the same agent instance, messages are automatically broadcast to all connections. If one client sends a message, all other connected clients receive the updated message list.

```
Client A ──── sendMessage("Hello") ────▶ AIChatAgent
                                              │
                                        persist + stream
                                              │
Client A ◀── CF_AGENT_USE_CHAT_RESPONSE ──────┤
Client B ◀── CF_AGENT_CHAT_MESSAGES ──────────┘
```

The originating client receives the streaming response. All other clients receive the final messages via a `CF_AGENT_CHAT_MESSAGES` broadcast.

## API Reference

### Exports

| Import path                 | Exports                                             |
| --------------------------- | --------------------------------------------------- |
| `@cloudflare/ai-chat`       | `AIChatAgent`, `createToolsFromClientSchemas`       |
| `@cloudflare/ai-chat/react` | `useAgentChat`                                      |
| `@cloudflare/ai-chat/types` | `MessageType`, `OutgoingMessage`, `IncomingMessage` |

### WebSocket Protocol

The chat protocol uses typed JSON messages over WebSocket:

| Message                          | Direction       | Purpose                     |
| -------------------------------- | --------------- | --------------------------- |
| `CF_AGENT_USE_CHAT_REQUEST`      | Client → Server | Send a chat message         |
| `CF_AGENT_USE_CHAT_RESPONSE`     | Server → Client | Stream response chunks      |
| `CF_AGENT_CHAT_MESSAGES`         | Server → Client | Broadcast updated messages  |
| `CF_AGENT_CHAT_CLEAR`            | Bidirectional   | Clear conversation          |
| `CF_AGENT_CHAT_REQUEST_CANCEL`   | Client → Server | Cancel active stream        |
| `CF_AGENT_TOOL_RESULT`           | Client → Server | Provide tool output         |
| `CF_AGENT_TOOL_APPROVAL`         | Client → Server | Approve or reject a tool    |
| `CF_AGENT_MESSAGE_UPDATED`       | Server → Client | Notify of message update    |
| `CF_AGENT_STREAM_RESUMING`       | Server → Client | Notify of stream resumption |
| `CF_AGENT_STREAM_RESUME_REQUEST` | Client → Server | Request stream resume check |

## Examples

- [AI Chat Example](../examples/ai-chat/) — Modern example with server tools, client tools, and approval
- [Dynamic Tools](../examples/dynamic-tools/) — SDK/platform pattern with dynamic client-defined tools
- [Resumable Stream Chat](../examples/resumable-stream-chat/) — Automatic stream resumption demo
- [Human in the Loop Guide](../guides/human-in-the-loop/) — Tool approval with `needsApproval` and `onToolCall`
- [Playground](../examples/playground/) — Kitchen-sink demo of all SDK features

## Related Docs

- [Client SDK](./client-sdk.md) — `useAgent` hook and `AgentClient` class
- [Human in the Loop](./human-in-the-loop.md) — Approval flows and manual intervention patterns
- [Resumable Streaming](./resumable-streaming.md) — How stream resumption works
- [Client Tools Continuation](./client-tools-continuation.md) — Advanced client-side tool patterns
- [Migration to AI SDK v6](./migration-to-ai-sdk-v6.md) — Upgrading from AI SDK v5
