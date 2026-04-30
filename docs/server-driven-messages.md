# Trigger patterns

Send messages and trigger LLM responses from the server without a human action. Use this for scheduled follow-ups, queue processing, email-triggered responses, and autonomous agent workflows.

## Overview

In a typical chat flow, the user sends a message and the agent responds. But agents often need to act on their own — a scheduled reminder fires, a webhook arrives, a workflow completes, or the agent decides to continue after inspecting its own response.

The key primitives:

| Primitive           | Role                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `saveMessages`      | Inject a message and trigger the LLM — the server-side equivalent of `sendMessage` |
| `persistMessages`   | Store messages without triggering a response — for injecting context silently      |
| `onChatResponse`    | React when any response completes, including ones you did not initiate             |
| `isServerStreaming` | Client-side flag: `true` when a server-initiated stream is active                  |

### `saveMessages` vs `persistMessages`

`saveMessages` persists messages to SQLite **and** triggers `onChatMessage` for a new LLM response. It is awaitable — after it returns, the LLM has responded and the message is persisted.

`persistMessages` stores messages and broadcasts them to connected clients, but does **not** trigger a model turn. Use it when you want to inject context (for example, a system message or background data) into the conversation without starting a response.

### When to use `saveMessages` vs `onChatResponse`

**Use `saveMessages` when you control the trigger** — schedule callbacks, webhooks, email handlers, or any method where you decide when to inject a message.

**Use `onChatResponse` when you need to react to responses you did not trigger** — user-initiated messages, auto-continuations after tool approvals, or any turn that the framework ran on your behalf.

## `waitUntilStable`

Always call `waitUntilStable()` before reading `this.messages` or calling `saveMessages` from schedule callbacks, webhooks, email handlers, or other non-chat entry points.

`waitUntilStable()` waits until the conversation is fully stable:

- No active LLM stream in progress
- No pending client-tool interactions (tool results or approvals the user has not yet provided)
- No queued continuation turns

It returns `true` when stable, or `false` if the timeout expires before a pending interaction resolves. If nothing is pending, it returns immediately.

```typescript
const stable = await this.waitUntilStable({ timeout: 30_000 });
if (!stable) {
  // The conversation is blocked on a user interaction or an in-flight
  // stream that did not complete within 30 seconds.
  console.warn("Conversation not stable, skipping server-driven message");
  return;
}
// Safe to read this.messages and call saveMessages.
```

Without this guard, you risk reading stale messages or overlapping with an in-flight stream.

## Triggering responses from the server

### Cron schedule

A daily digest agent that summarizes activity every morning. Cron schedules are idempotent by default, so calling `schedule()` in `onStart` is safe — it will not create duplicates across Durable Object restarts.

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";

export class DigestAgent extends AIChatAgent {
  async onChatMessage() {
    // ... your LLM call
  }

  async onStart() {
    await this.schedule("0 9 * * *", "dailyDigest");
  }

  async dailyDigest() {
    const stable = await this.waitUntilStable({ timeout: 30_000 });
    if (!stable) {
      console.warn("Conversation not stable, skipping daily digest");
      return;
    }

    await this.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: "Summarize what happened since your last digest."
          }
        ],
        createdAt: new Date()
      }
    ]);
    // At this point the LLM has responded and the message is persisted.
  }
}
```

The function form of `saveMessages` — `saveMessages((messages) => [...])` — reads the latest persisted messages at execution time. This avoids stale baselines when multiple calls queue up (for example, rapid webhook arrivals). See [scheduling](./scheduling.md) for more on `schedule()` and cron syntax.

### Processing a queue

When you control the trigger, a simple loop is the clearest pattern:

```typescript
async processQueue() {
  for (const task of this.taskQueue) {
    const stable = await this.waitUntilStable({ timeout: 30_000 });
    if (!stable) {
      console.warn("Conversation not stable, stopping queue processing");
      break;
    }

    await this.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: task }],
        createdAt: new Date()
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
  const stable = await this.waitUntilStable({ timeout: 30_000 });
  if (!stable) {
    console.warn("Conversation not stable, cannot process email");
    return;
  }

  const subject = email.headers.get("subject") ?? "(no subject)";
  const body = await new Response(email.raw).text();

  await this.saveMessages((messages) => [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text: `Email from ${email.from}: ${subject}\n\n${body}`
        }
      ],
      createdAt: new Date()
    }
  ]);
}
```

### Webhook-triggered

```typescript
async onRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.endsWith("/webhook") && request.method === "POST") {
    const stable = await this.waitUntilStable({ timeout: 30_000 });
    if (!stable) {
      return new Response("Agent is busy", { status: 503 });
    }

    const payload = await request.json();
    try {
      await this.saveMessages((messages) => [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            { type: "text", text: `Webhook event: ${JSON.stringify(payload)}` }
          ],
          createdAt: new Date()
        }
      ]);
      return new Response("ok");
    } catch (error) {
      console.error("Failed to process webhook:", error);
      return new Response("Internal error", { status: 500 });
    }
  }

  return super.onRequest(request);
}
```

### Injecting context without triggering a response

Use `persistMessages` to add messages that the LLM will see on its next turn, without starting a turn now:

```typescript
async addBackgroundContext(data: string) {
  const stable = await this.waitUntilStable({ timeout: 30_000 });
  if (!stable) return;

  await this.persistMessages([
    ...this.messages,
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        { type: "text", text: `[Background context]: ${data}` }
      ],
      createdAt: new Date()
    }
  ]);
  // Message is stored and broadcast to clients, but no LLM call happens.
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
  try {
    await fetch("https://analytics.example.com/event", {
      method: "POST",
      body: JSON.stringify({
        requestId: result.requestId,
        status: result.status,
        continuation: result.continuation
      })
    });
  } catch (error) {
    console.error("Analytics reporting failed:", error);
  }
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
    await this.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Continue your research." }],
        createdAt: new Date()
      }
    ]);
  }
}
```

When `saveMessages` is called from inside `onChatResponse`, the inner turn runs to completion and `saveMessages` returns. After the current `onChatResponse` call returns, the framework fires `onChatResponse` again for the inner response. This continues until no more work is queued. The framework never nests `onChatResponse` calls — results are drained sequentially.

### Reactive queue processing

When queue items can be added by external events (user messages, webhooks) at any time, `onChatResponse` lets you drain the queue after every response regardless of who triggered it:

```typescript
protected async onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed" && this.taskQueue.length > 0) {
    const next = this.taskQueue.shift()!;
    await this.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: next }],
        createdAt: new Date()
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

## Client-side: detecting server-initiated streams

When the server triggers a stream via `saveMessages`, the AI SDK's `status` stays `"ready"` because the client did not initiate the request. The `useAgentChat` hook provides two additional flags to handle this:

| Flag                | What it tracks                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `status`            | AI SDK lifecycle: `"submitted"`, `"streaming"`, `"ready"`, `"error"` — only for client-initiated requests |
| `isServerStreaming` | `true` when a server-initiated stream is active                                                           |
| `isStreaming`       | `true` when either client or server streaming is active — use this for a universal indicator              |

Use `isStreaming` for most UI concerns (disabling the send button, showing a loading indicator). Use `isServerStreaming` only when you need to distinguish between user-initiated and server-initiated streams (for example, to show a different indicator like "Agent is working in the background...").

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "ChatAgent" });
  const { messages, sendMessage, isStreaming, isServerStreaming } =
    useAgentChat({ agent });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>{/* render message */}</div>
      ))}

      {isServerStreaming && <div>Agent is working in the background...</div>}
      {!isServerStreaming && isStreaming && <div>Agent is responding...</div>}

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

When a server-driven response arrives while the user is idle, connected clients see the new messages appear in real time. The `isStreaming` flag transitions from `false` → `true` → `false` as the stream runs, so UI elements like the send button automatically disable and re-enable.

## Interaction with `messageConcurrency`

The `messageConcurrency` setting on `AIChatAgent` controls how overlapping user submissions behave (`"queue"`, `"latest"`, `"merge"`, `"drop"`, `"debounce"`). This setting only applies to `sendMessage()` — user-initiated messages from the client.

`saveMessages()` always uses serialized (queued) behavior regardless of the `messageConcurrency` setting. This means server-driven messages never get dropped, merged, or debounced — they always queue up and execute in order.

## Combining with other Agent primitives

| Primitive          | How to combine                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule()`       | Schedule a callback that calls `saveMessages` — see the cron example above                                                                                                                                                                            |
| `queue()`          | Queue a method that calls `saveMessages` for deferred processing                                                                                                                                                                                      |
| `runWorkflow()`    | Start a Workflow; use `AgentWorkflow.agent` RPC to call a method that triggers `saveMessages`. For workflows started by sub-agents, this stub routes back to the originating facet and is RPC-only; use sub-agent routing for HTTP/WebSocket traffic. |
| `onEmail()`        | Convert email content to a chat message and call `saveMessages`                                                                                                                                                                                       |
| `onRequest()`      | Handle webhooks and call `saveMessages`                                                                                                                                                                                                               |
| `this.broadcast()` | Broadcast custom state from `onChatResponse`                                                                                                                                                                                                          |

## Cancelling a server-driven turn

Pass `options.signal` to cancel a programmatic turn from outside without knowing the internally-generated request id:

```typescript
async runLongTask(query: string, abortSignal: AbortSignal) {
  const result = await this.saveMessages(
    [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: query }] }],
    { signal: abortSignal }
  );

  if (result.status === "aborted") {
    // The signal aborted mid-stream. Partial chunks are still persisted.
  }
}
```

When the signal aborts:

- the inference loop's signal aborts (same path `chat-request-cancel` takes);
- partial chunks streamed before the abort are persisted;
- `saveMessages` resolves with `{ status: "aborted" }`;
- `onChatResponse` fires with `status: "aborted"`.

Pre-aborted signals short-circuit before any model work runs.

### Limitations

- **Signals cannot cross Durable Object boundaries.** `AbortSignal` is not an RPC-serializable type. Construct the controller inside the DO that calls `saveMessages`. For Think child-agent orchestration, use [Agent Tools](./agent-tools.md); `runAgentTool()` bridges parent aborts into the child run. For lower-level custom RPC, return a `ReadableStream` from the child and let the parent cancel it — workerd propagates the cancel back to the source's `cancel` callback.
- **Hibernation drops the listener.** The signal lives in memory. If the DO hibernates mid-turn and `chatRecovery` is enabled, the recovered turn calls `continueLastTurn()` internally without the original signal — an abort fired after restart has no effect on the recovered turn. This is true for top-level agents and sub-agents; sub-agent recovery still works, but the original caller's in-memory signal is gone. Override `onChatRecovery` (Think) or set `chatRecovery = false` for callers that need stronger guarantees.

This is the integration point for agent-tool orchestration where the parent's AI SDK abort signal needs to propagate into a child DO's `saveMessages` call. See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the original use case.

## Important notes

- **`saveMessages` is awaitable.** After it returns, the LLM has responded and the message is persisted. Use this when you control the trigger.
- **Use the function form of `saveMessages`.** `saveMessages((messages) => [...messages, newMsg])` reads the latest persisted messages at execution time, avoiding stale baselines when multiple calls queue up.
- **`persistMessages` does not trigger a response.** Use it to inject context or system messages silently.
- **`onChatResponse` is for reacting to turns you did not initiate.** Use it for user-initiated messages, auto-continuations, or any turn where you did not call `saveMessages` yourself.
- **`onChatResponse` does not nest.** When `saveMessages` is called from inside `onChatResponse`, the inner turn completes and `onChatResponse` fires again sequentially — not recursively.
- **Messages are persisted before `onChatResponse` fires.** If the Durable Object evicts during the hook, the conversation is safe in SQLite — only the hook callback is lost.
- **`waitUntilStable()` before injecting.** Always call this from schedule callbacks, webhooks, or other non-chat entry points to avoid overlapping with an in-flight stream or pending tool interaction.
- **The client sees `done: true` before `onChatResponse` runs.** The server-side hook does not delay the client.
- **`saveMessages` accepts `options.signal` for external cancellation.** Useful when forwarding an upstream `AbortSignal` (e.g. from an AI SDK tool `execute` on a parent agent) into a child DO's chat turn.
- **`messageConcurrency` does not affect `saveMessages`.** Server-driven messages always queue and execute in order.
