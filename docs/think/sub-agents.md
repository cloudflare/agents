# Sub-agents and Programmatic Turns

Think works as both a top-level agent (WebSocket to browser) and a sub-agent (RPC from a parent agent). It also supports programmatic turns — injecting messages and triggering model turns without a WebSocket connection.

## Sub-agent via chat()

When used as a sub-agent, the `chat()` method runs a full turn (persist user message, run agentic loop, persist assistant response) and streams events via a callback.

```typescript
async chat(
  userMessage: string | UIMessage,
  callback: StreamCallback,
  options?: ChatOptions
): Promise<void>
```

### StreamCallback

```typescript
interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}
```

| Method           | When it fires                                                   |
| ---------------- | --------------------------------------------------------------- |
| `onEvent(json)`  | For each streaming chunk (JSON-serialized UIMessageChunk)       |
| `onDone()`       | After the turn completes and the assistant message is persisted |
| `onError(error)` | On error during the turn (if not provided, the error is thrown) |

### ChatOptions

```typescript
interface ChatOptions {
  signal?: AbortSignal;
  tools?: ToolSet;
}
```

| Field    | Description                                                 |
| -------- | ----------------------------------------------------------- |
| `signal` | `AbortSignal` to cancel the turn mid-stream                 |
| `tools`  | Extra tools to merge for this turn (highest merge priority) |

### Example: Parent agent calling a child

```typescript
import { Think, Session } from "@cloudflare/think";
import type { StreamCallback } from "@cloudflare/think";

export class ParentAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  async delegateToChild(task: string) {
    const child = await this.subAgent(ChildAgent, "child-1");

    const chunks: string[] = [];
    await child.chat(task, {
      onEvent: (json) => {
        chunks.push(json);
        // Optionally forward to a connected client
      },
      onDone: () => {
        console.log("Child completed");
      },
      onError: (error) => {
        console.error("Child failed:", error);
      }
    });

    return chunks;
  }
}

export class ChildAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  getSystemPrompt() {
    return "You are a research assistant. Analyze data and report findings.";
  }
}
```

### Passing a string vs UIMessage

`chat()` accepts either a plain string or a `UIMessage`. A string is auto-wrapped:

```typescript
// These are equivalent:
await child.chat("Analyze this data", callback);
await child.chat(
  {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Analyze this data" }]
  },
  callback
);
```

### Passing extra tools

The `tools` option adds tools for this turn only, with the highest merge priority:

```typescript
await child.chat("Summarize the report", callback, {
  tools: {
    fetchReport: tool({
      description: "Fetch the report data",
      inputSchema: z.object({}),
      execute: async () => this.getReportData()
    })
  }
});
```

### Aborting a sub-agent turn

Pass an `AbortSignal` to cancel mid-stream:

```typescript
const controller = new AbortController();

setTimeout(() => controller.abort(), 30_000);

await child.chat("Long analysis task", callback, {
  signal: controller.signal
});
```

When aborted, the partial assistant message is still persisted.

---

## Programmatic Turns with saveMessages

`saveMessages` injects messages and triggers a model turn without a WebSocket connection. Use for scheduled responses, webhook-triggered turns, proactive agents, or chaining from `onChatResponse`.

```typescript
async saveMessages(
  messages: UIMessage[] | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>)
): Promise<SaveMessagesResult>
```

Returns `{ requestId, status }` where `status` is `"completed"` or `"skipped"`.

### Static messages

```typescript
await this.saveMessages([
  {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Time for your daily summary." }]
  }
]);
```

### Function form

When multiple `saveMessages` calls queue up, the function form runs with the latest messages when the turn actually starts:

```typescript
await this.saveMessages((current) => [
  ...current,
  {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Continue your analysis." }]
  }
]);
```

### Scheduled responses

Trigger a turn from a cron schedule:

```typescript
export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  async onScheduled() {
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Generate the daily report." }]
      }
    ]);
  }
}
```

### Chaining from onChatResponse

Start a follow-up turn after the current one completes:

```typescript
async onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed" && this.needsFollowUp(result.message)) {
    await this.saveMessages([{
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "Now summarize what you found." }]
    }]);
  }
}
```

---

## continueLastTurn

Resume the last assistant turn without injecting a new user message. Useful after tool results are received or after recovery from an interruption.

```typescript
protected async continueLastTurn(
  body?: Record<string, unknown>
): Promise<SaveMessagesResult>
```

Returns `{ requestId, status: "skipped" }` if the last message is not an assistant message.

The optional `body` parameter overrides the stored body for this continuation. If omitted, the last body from the previous turn is used.

---

## Chat Recovery

Think can wrap chat turns in Durable Object fibers for durable execution. When a DO is evicted mid-turn, the turn can be recovered on restart.

### Setup

```typescript
export class MyAgent extends Think<Env> {
  chatRecovery = true;

  getModel() {
    /* ... */
  }
}
```

When `chatRecovery` is `true`, all four turn paths (WebSocket, auto-continuation, `saveMessages`, `continueLastTurn`) are wrapped in `runFiber`.

### onChatRecovery

When an interrupted chat fiber is detected after DO restart, Think calls the `onChatRecovery` hook:

```typescript
onChatRecovery(ctx: ChatRecoveryContext): ChatRecoveryOptions | void
```

### ChatRecoveryContext

| Field             | Type                       | Description                                          |
| ----------------- | -------------------------- | ---------------------------------------------------- |
| `streamId`        | `string`                   | The stream ID of the interrupted turn                |
| `requestId`       | `string`                   | The request ID of the interrupted turn               |
| `partialText`     | `string`                   | Text generated before the interruption               |
| `partialParts`    | `MessagePart[]`            | Parts accumulated before the interruption            |
| `recoveryData`    | `unknown \| null`          | Data from `this.stash()` during the turn             |
| `messages`        | `UIMessage[]`              | Current conversation history                         |
| `lastBody`        | `Record<string, unknown>?` | Body from the interrupted turn                       |
| `lastClientTools` | `ClientToolSchema[]?`      | Client tools from the interrupted turn               |
| `createdAt`       | `number`                   | Epoch milliseconds when the underlying fiber started |

### ChatRecoveryOptions

| Field      | Type       | Description                                      |
| ---------- | ---------- | ------------------------------------------------ |
| `persist`  | `boolean?` | Whether to persist the partial assistant message |
| `continue` | `boolean?` | Whether to auto-continue with a new turn         |

### Example

```typescript
export class MyAgent extends Think<Env> {
  chatRecovery = true;

  getModel() {
    /* ... */
  }

  onChatRecovery(ctx: ChatRecoveryContext) {
    console.log(
      `Recovering turn ${ctx.requestId}, partial: ${ctx.partialText.length} chars`
    );
    return {
      persist: true,
      continue: true
    };
  }
}
```

With `persist: true`, the partial message is saved. With `continue: true`, Think calls `continueLastTurn()` after the agent reaches a stable state.

To suppress continuation for turns that have been orphaned too long to safely replay, gate on `ctx.createdAt`:

```typescript
onChatRecovery(ctx: ChatRecoveryContext): ChatRecoveryOptions {
  if (Date.now() - ctx.createdAt > 2 * 60 * 1000) {
    return { continue: false };
  }
  return {};
}
```

---

## Stability Detection

Think provides methods to check if the agent is in a stable state — no pending tool results, no pending approvals, no active turns.

### hasPendingInteraction

```typescript
protected hasPendingInteraction(): boolean
```

Returns `true` if any assistant message has pending tool calls (tools without results or pending approvals).

### waitUntilStable

```typescript
protected async waitUntilStable(options?: { timeout?: number }): Promise<boolean>
```

Returns a promise that resolves to `true` when the agent reaches a stable state, or `false` if the timeout is exceeded.

```typescript
const stable = await this.waitUntilStable({ timeout: 30_000 });
if (stable) {
  await this.saveMessages([
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "Now that you are done, summarize." }]
    }
  ]);
}
```
