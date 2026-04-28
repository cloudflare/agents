# Sub-agents and Programmatic Turns

Think works as both a top-level agent (WebSocket to browser) and a sub-agent (RPC from a parent agent). It also supports programmatic turns — injecting messages and triggering model turns without a WebSocket connection.

This page focuses on Think's `chat()` RPC surface and programmatic turns. For the generic framework primitives underneath (`subAgent`, `onBeforeSubAgent`, `useAgent({ sub })`, `parentAgent`, `hasSubAgent`, `listSubAgents`, routing shape), see [Sub-agents](../sub-agents.md).

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
  messages: UIMessage[] | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
  options?: SaveMessagesOptions
): Promise<SaveMessagesResult>
```

Returns `{ requestId, status }` where `status` is `"completed"`, `"skipped"`, or `"aborted"`.

| `status`      | When                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `"completed"` | Turn ran to completion.                                                                                                   |
| `"skipped"`   | Turn invalidated mid-flight (e.g. by `chat-clear`); user message persisted, no model run.                                 |
| `"aborted"`   | Turn cancelled before completion via `options.signal` or `chat-request-cancel`. Partial assistant chunks still persisted. |

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

### External cancellation with `options.signal`

`saveMessages` accepts an `AbortSignal` so callers can cancel the turn from outside without knowing the internally-generated request id. The signal is linked to Think's per-turn `AbortController`; when it aborts:

- the inference loop's signal aborts (the same path `chat-request-cancel` takes);
- partial chunks already streamed are persisted to the resumable stream;
- `saveMessages` resolves with `{ status: "aborted" }`;
- `onChatResponse` fires with `status: "aborted"`.

If the signal is **already aborted** when `saveMessages` is called, no inference work runs.

```typescript
class MyAgent extends Think<Env> {
  async runWithTimeout(text: string) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30_000);

    const { status } = await this.saveMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      { signal: controller.signal }
    );

    if (status === "aborted") {
      console.log("Turn cancelled by external signal");
    }
  }
}
```

#### Crossing DO boundaries

`AbortSignal` cannot be passed as an RPC argument across Durable Object boundaries — workerd's JSRPC layer rejects it at serialization time. Construct the controller **inside** the DO that calls `saveMessages` and bridge the parent's intent through a different mechanism (typically a `ReadableStream` returned from the child whose `cancel` callback aborts the per-turn controller).

The reference implementation lives in `examples/agents-as-tools`:

```typescript
// In the helper sub-agent (Think subclass).
async runTurnAndStream(query: string): Promise<ReadableStream<Uint8Array>> {
  // Per-turn controller — owned in this DO so the signal is local.
  const turnAbort = new AbortController();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await this.saveMessages([userMsg(query)], { signal: turnAbort.signal });
      // ... stream chunks via the broadcast tee ...
      controller.close();
    },
    cancel(reason) {
      // workerd propagates the parent's reader.cancel() here.
      turnAbort.abort(reason);
    }
  });
}

// In the parent's tool execute.
const stream = await helper.runTurnAndStream(query);
const reader = stream.getReader();
// Forward the parent's AI SDK abort signal by cancelling the local reader —
// workerd propagates the cancel back across RPC to the helper's source.
parentSignal.addEventListener("abort", () => reader.cancel(parentSignal.reason),
  { once: true });
```

#### Hibernation and recovery

The external signal lives in memory only. If the Durable Object hibernates mid-turn and `chatRecovery` is enabled, the recovered turn runs via `continueLastTurn()` **without** the original `options.signal` — the listener was lost on eviction, and the recovery path has no way to reach back to the original caller.

In practice this means:

- A signal that aborts **after** the DO restarts has no effect on the recovered turn.
- Subclasses that need the recovered turn to honor a fresh signal should override `onChatRecovery` and reject continuation (`return { continue: false }`) when the original caller is gone.
- The `examples/agents-as-tools` helper sets `chatRecovery = false` for exactly this reason: helpers are per-turn workers driven by an active parent, and silently re-running on wake would burn an inference call on no consumer.

See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the original motivation, and `examples/agents-as-tools` for the helper-as-sub-agent reference implementation.

---

## continueLastTurn

Resume the last assistant turn without injecting a new user message. Useful after tool results are received or after recovery from an interruption.

```typescript
protected async continueLastTurn(
  body?: Record<string, unknown>,
  options?: SaveMessagesOptions
): Promise<SaveMessagesResult>
```

Returns `{ requestId, status: "skipped" }` if the last message is not an assistant message.

The optional `body` parameter overrides the stored body for this continuation. If omitted, the last body from the previous turn is used. The optional `options.signal` accepts an external `AbortSignal` for cancellation, matching the `saveMessages` contract.

---

## Aborting in-flight turns

For callers that don't have access to the `requestId` but need a coarse "cancel whatever is running" handle (e.g. an RPC-driven sub-agent helper that runs one turn at a time), Think exposes two protected methods:

```typescript
protected abortRequest(requestId: string, reason?: unknown): void
protected abortAllRequests(): void
```

- **`abortRequest(id, reason?)`** — abort a specific in-flight turn by id. No-op if no controller exists for that id. Equivalent to a client `chat-request-cancel`.
- **`abortAllRequests()`** — abort every in-flight controller in the registry. Used by single-purpose sub-agents that don't track ids.

Both methods produce the same end state as `chat-request-cancel`: inference loop terminates, partial chunks persist, the turn's `ChatResponseResult` reports `status: "aborted"`. Prefer `options.signal` on `saveMessages` / `continueLastTurn` when driving a turn programmatically — it threads the abort intent in from turn start without requiring the caller to know the id.

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
