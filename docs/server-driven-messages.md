# Server-Driven Messages

Send messages and trigger LLM responses from the server without a human action. Use this for scheduled follow-ups, queue processing, email-triggered responses, and autonomous agent workflows.

## Overview

In a typical chat flow, the user sends a message and the agent responds. But agents often need to act on their own — a scheduled reminder fires, a webhook arrives, a workflow completes, or the agent decides to continue after inspecting its own response.

The key primitive is `saveMessages`: it persists messages to SQLite and triggers `onChatMessage`, just like a user sending a message over WebSocket. Connected clients see the response stream in real time.

| Primitive           | Role                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `saveMessages`      | Inject a message and trigger the LLM — the server-side equivalent of `sendMessage` |
| `onChatResponse`    | React when any response completes, including ones you did not initiate             |
| `isServerStreaming` | Client-side flag: `true` when a server-initiated stream is active                  |

### When to use which

**Use `saveMessages` when you control the trigger** — schedule callbacks, webhooks, email handlers, or any method where you decide when to inject a message. `saveMessages` is awaitable: after it returns, the LLM has responded and the message is persisted.

**Use `onChatResponse` when you need to react to responses you did not trigger** — user-initiated messages, auto-continuations after tool approvals, or any turn that the framework ran on your behalf. You cannot chain work after these because you did not call `saveMessages` — the WebSocket handler or the continuation system did.

## Triggering responses from the server

### Schedule callback

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { nanoid } from "nanoid";

export class ReminderAgent extends AIChatAgent {
  async onChatMessage() {
    // ... your LLM call
  }

  async onStart() {
    // Schedule a reminder 60 seconds from now
    await this.schedule(60, "sendReminder", { text: "Time for a check-in!" });
  }

  async sendReminder(payload: { text: string }) {
    const ready = await this.waitUntilStable({ timeout: 30_000 });
    if (!ready) return;

    await this.saveMessages([
      ...this.messages,
      {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: payload.text }]
      }
    ]);
    // At this point the LLM has responded and the message is persisted.
  }
}
```

Always call `waitUntilStable()` before reading `this.messages` or calling `saveMessages` from schedule callbacks, webhooks, email handlers, or other non-chat contexts. This ensures the conversation is not mid-stream or waiting on a tool interaction. See [scheduling](./scheduling.md) for more on `schedule()`.

### Processing a queue

When you control the trigger, a simple loop is the clearest pattern:

```typescript
async processQueue() {
  for (const task of this.taskQueue) {
    const ready = await this.waitUntilStable({ timeout: 30_000 });
    if (!ready) break;

    await this.saveMessages([
      ...this.messages,
      {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: task }]
      }
    ]);
    // LLM has responded. this.messages is updated. Next iteration.
  }
  this.taskQueue = [];
}
```

No special hooks needed — `saveMessages` returns after the full turn completes.

### Email-triggered

```typescript
async onEmail(email: AgentEmail) {
  const ready = await this.waitUntilStable({ timeout: 30_000 });
  if (!ready) return;

  const subject = email.headers.get("subject") ?? "(no subject)";
  const body = await new Response(email.raw).text();

  await this.saveMessages([
    ...this.messages,
    {
      id: nanoid(),
      role: "user",
      parts: [
        {
          type: "text",
          text: `Email from ${email.from}: ${subject}\n\n${body}`
        }
      ]
    }
  ]);
}
```

### Webhook-triggered

```typescript
async onRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.endsWith("/webhook") && request.method === "POST") {
    const ready = await this.waitUntilStable({ timeout: 30_000 });
    if (!ready) return new Response("busy", { status: 503 });

    const payload = await request.json();
    await this.saveMessages([
      ...this.messages,
      {
        id: nanoid(),
        role: "user",
        parts: [
          { type: "text", text: `Webhook event: ${JSON.stringify(payload)}` }
        ]
      }
    ]);
    return new Response("ok");
  }

  return super.onRequest(request);
}
```

## Reacting to responses you did not initiate

`onChatResponse` fires after **every** completed turn — user-initiated messages, `saveMessages` calls, and auto-continuations. Use it when you need to observe or react to responses regardless of how they were triggered.

### Broadcasting state

```typescript
import { AIChatAgent, type ChatResponseResult } from "@cloudflare/ai-chat";

export class ChatAgent extends AIChatAgent {
  async onChatMessage() {
    // ... your LLM call
  }

  protected async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      this.broadcast(JSON.stringify({ streaming: false }));
    }
  }
}
```

### Analytics

```typescript
protected async onChatResponse(result: ChatResponseResult) {
  await fetch("https://analytics.example.com/event", {
    method: "POST",
    body: JSON.stringify({
      requestId: result.requestId,
      status: result.status,
      continuation: result.continuation
    })
  });
}
```

### Chained reasoning

An agent can inspect its own response and decide whether to continue. This works for user-initiated messages too — you cannot predict what the user will ask, but you can react to what the agent said.

```typescript
protected async onChatResponse(result: ChatResponseResult) {
  if (result.status !== "completed") return;

  const lastText = result.message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");

  if (lastText.includes("[NEEDS_MORE_RESEARCH]")) {
    await this.saveMessages([
      ...this.messages,
      {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: "Continue your research." }]
      }
    ]);
  }
}
```

When `saveMessages` is called from inside `onChatResponse`, the inner turn runs to completion and `onChatResponse` fires again for the inner response. This continues until no more work is queued. The framework prevents concurrent `onChatResponse` calls — inner responses are drained sequentially.

### Reactive queue processing

When queue items can be added by external events (user messages, webhooks) at any time, `onChatResponse` lets you drain the queue after every response regardless of who triggered it:

```typescript
protected async onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed" && this.taskQueue.length > 0) {
    const next = this.taskQueue.shift()!;
    await this.saveMessages([
      ...this.messages,
      {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: next }]
      }
    ]);
  }
}
```

### `ChatResponseResult` fields

| Field          | Type                                  | Description                              |
| -------------- | ------------------------------------- | ---------------------------------------- |
| `message`      | `UIMessage`                           | The finalized assistant message          |
| `requestId`    | `string`                              | Unique ID for this turn                  |
| `continuation` | `boolean`                             | `true` if this was an auto-continuation  |
| `status`       | `"completed" \| "error" \| "aborted"` | How the turn ended                       |
| `error`        | `string \| undefined`                 | Error details when `status` is `"error"` |

## Client-side: showing a streaming indicator

When the server triggers a stream, the AI SDK's `status` stays `"ready"` because the client did not initiate the request. Use `isServerStreaming` or `isStreaming` instead:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "ChatAgent" });
  const { messages, sendMessage, isStreaming } = useAgentChat({ agent });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>{/* render message */}</div>
      ))}

      {isStreaming && <div>Agent is responding...</div>}

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
        <button type="submit" disabled={isStreaming}>
          Send
        </button>
      </form>
    </div>
  );
}
```

| Field               | What it tracks                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `status`            | AI SDK lifecycle: `"submitted"`, `"streaming"`, `"ready"`, `"error"` — only for client-initiated requests |
| `isServerStreaming` | `true` when a server-initiated stream is active                                                           |
| `isStreaming`       | `true` when either client or server streaming is active — use this for a universal indicator              |

## Combining with other Agent primitives

| Primitive          | How to combine                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `schedule()`       | Schedule a callback that calls `saveMessages` — see the reminder example above                |
| `queue()`          | Queue a method that calls `saveMessages` for deferred processing                              |
| `runWorkflow()`    | Start a Workflow; use `AgentWorkflow.agent` RPC to call a method that triggers `saveMessages` |
| `onEmail()`        | Convert email content to a chat message and call `saveMessages`                               |
| `onRequest()`      | Handle webhooks and call `saveMessages`                                                       |
| `this.broadcast()` | Broadcast custom state from `onChatResponse`                                                  |

## Important notes

- **`saveMessages` is awaitable.** After it returns, the LLM has responded and the message is persisted. Use this when you control the trigger.
- **`onChatResponse` is for reacting to turns you did not initiate.** Use it for user-initiated messages, auto-continuations, or any turn where you did not call `saveMessages` yourself.
- **Messages are persisted before `onChatResponse` fires.** If the Durable Object evicts during the hook, the conversation is safe in SQLite — only the hook callback is lost.
- **`onChatResponse` runs outside the turn lock.** It is safe to call `saveMessages` from inside. The next queued turn can start while the hook executes.
- **`waitUntilStable()` before injecting.** Always call this from schedule callbacks, webhooks, or other non-chat contexts to avoid overlapping with an in-flight stream.
- **The client sees `done: true` before `onChatResponse` runs.** The server-side hook does not delay the client.
