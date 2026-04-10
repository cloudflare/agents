# Lifecycle Hooks

Think owns the `streamText` call and provides hooks at each stage of the chat turn. Hooks fire on every turn regardless of entry path — WebSocket chat, sub-agent `chat()`, `saveMessages`, and auto-continuation after tool results.

## Hook Summary

| Hook                        | When it fires                                 | Return                     | Async |
| --------------------------- | --------------------------------------------- | -------------------------- | ----- |
| `configureSession(session)` | Once during `onStart`                         | `Session`                  | yes   |
| `beforeTurn(ctx)`           | Before `streamText`                           | `TurnConfig` or void       | yes   |
| `beforeToolCall(ctx)`       | When model calls a tool                       | `ToolCallDecision` or void | yes   |
| `afterToolCall(ctx)`        | After tool execution                          | void                       | yes   |
| `onStepFinish(ctx)`         | After each step completes                     | void                       | yes   |
| `onChunk(ctx)`              | Per streaming chunk                           | void                       | yes   |
| `onChatResponse(result)`    | After turn completes and message is persisted | void                       | yes   |
| `onChatError(error)`        | On error during a turn                        | error to propagate         | no    |

## Execution Order

For a turn with two tool calls:

```
configureSession()          ← once at startup, not per-turn
      │
beforeTurn()                ← inspect assembled context, override model/tools/prompt
      │
  ┌── streamText ───────────────────────────────────┐
  │   onChunk()  onChunk()  onChunk()  ...          │
  │       │                                         │
  │   beforeToolCall()  →  tool executes            │
  │                        afterToolCall()           │
  │       │                                         │
  │   onStepFinish()                                │
  │       │                                         │
  │   onChunk()  onChunk()  ...                     │
  │       │                                         │
  │   beforeToolCall()  →  tool executes            │
  │                        afterToolCall()           │
  │       │                                         │
  │   onStepFinish()                                │
  └─────────────────────────────────────────────────┘
      │
onChatResponse()            ← message persisted, turn lock released
```

---

## configureSession

Called once during Durable Object initialization (`onStart`). Configure the Session with context blocks, compaction, search, and skills.

```typescript
configureSession(session: Session): Session | Promise<Session>
```

```typescript
import { Think, Session } from "@cloudflare/think";
import { createCompactFunction } from "agents/experimental/memory/utils/compaction-helpers";
import { generateText } from "ai";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: { get: async () => "You are a helpful coding assistant." }
      })
      .withContext("memory", {
        description: "Learned facts about the user.",
        maxTokens: 1100
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.getModel(), prompt }).then((r) => r.text)
        })
      )
      .compactAfter(100_000)
      .withCachedPrompt();
  }
}
```

When `configureSession` adds context blocks, Think builds the system prompt from those blocks instead of using `getSystemPrompt()`. See the [Sessions documentation](../sessions.md) for the full API.

---

## beforeTurn

Called before `streamText`. Receives the fully assembled context — system prompt, converted messages, merged tools, and model. Return a `TurnConfig` to override any part, or void to accept defaults.

```typescript
beforeTurn(ctx: TurnContext): TurnConfig | void | Promise<TurnConfig | void>
```

### TurnContext

| Field          | Type                      | Description                                                              |
| -------------- | ------------------------- | ------------------------------------------------------------------------ |
| `system`       | `string`                  | Assembled system prompt (from context blocks or `getSystemPrompt()`)     |
| `messages`     | `ModelMessage[]`          | Assembled model messages (truncated, pruned)                             |
| `tools`        | `ToolSet`                 | Merged tool set (workspace + getTools + session + MCP + client + caller) |
| `model`        | `LanguageModel`           | The model from `getModel()`                                              |
| `continuation` | `boolean`                 | Whether this is a continuation turn (auto-continue after tool result)    |
| `body`         | `Record<string, unknown>` | Custom body fields from the client request                               |

### TurnConfig

All fields are optional. Return only what you want to change.

| Field             | Type                      | Description                          |
| ----------------- | ------------------------- | ------------------------------------ |
| `model`           | `LanguageModel`           | Override the model for this turn     |
| `system`          | `string`                  | Override the system prompt           |
| `messages`        | `ModelMessage[]`          | Override the assembled messages      |
| `tools`           | `ToolSet`                 | Extra tools to merge (additive)      |
| `activeTools`     | `string[]`                | Limit which tools the model can call |
| `toolChoice`      | `ToolChoice`              | Force a specific tool call           |
| `maxSteps`        | `number`                  | Override `maxSteps` for this turn    |
| `providerOptions` | `Record<string, unknown>` | Provider-specific options            |

### Examples

Switch to a cheaper model for continuation turns:

```typescript
beforeTurn(ctx: TurnContext) {
  if (ctx.continuation) {
    return { model: this.cheapModel };
  }
}
```

Restrict which tools the model can call:

```typescript
beforeTurn(ctx: TurnContext) {
  return { activeTools: ["read", "write", "getWeather"] };
}
```

Add per-turn context from the client body:

```typescript
beforeTurn(ctx: TurnContext) {
  if (ctx.body?.selectedFile) {
    return {
      system: ctx.system + `\n\nUser is editing: ${ctx.body.selectedFile}`
    };
  }
}
```

Override `maxSteps` based on conversation length:

```typescript
beforeTurn(ctx: TurnContext) {
  if (ctx.messages.length > 100) {
    return { maxSteps: 3 };
  }
}
```

---

## beforeToolCall

Called when the model produces a tool call. Only fires for server-side tools (tools with `execute`). Client tools are handled on the client.

> **Current limitation:** `beforeToolCall` currently fires as an observation hook — after tool execution, via `onStepFinish` data. The `block` and `substitute` actions in `ToolCallDecision` are defined in the types but are not yet functional. The AI SDK's `streamText` does not expose a pre-execution interception point in the Workers runtime. For now, use this hook for logging and analytics.

```typescript
beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void | Promise<ToolCallDecision | void>
```

### ToolCallContext

| Field      | Type                      | Description                   |
| ---------- | ------------------------- | ----------------------------- |
| `toolName` | `string`                  | Name of the tool being called |
| `args`     | `Record<string, unknown>` | Arguments the model provided  |

### ToolCallDecision (future)

When pre-execution interception becomes available, the return type will support three actions:

| Action         | Fields            | Behavior                                           |
| -------------- | ----------------- | -------------------------------------------------- |
| `"allow"`      | `args?`           | Execute the tool, optionally with modified args    |
| `"block"`      | `reason?`         | Do not execute; return `reason` as the tool result |
| `"substitute"` | `result`, `args?` | Do not execute; return `result` as the tool result |

### Example

Log all tool calls:

```typescript
beforeToolCall(ctx: ToolCallContext) {
  console.log(`Tool called: ${ctx.toolName}`, ctx.args);
}
```

---

## afterToolCall

Called after a tool executes (or a substitute result is provided by `beforeToolCall`). Does not fire when `beforeToolCall` blocks with no substitute.

```typescript
afterToolCall(ctx: ToolCallResultContext): void | Promise<void>
```

### ToolCallResultContext

| Field      | Type                      | Description                                                              |
| ---------- | ------------------------- | ------------------------------------------------------------------------ |
| `toolName` | `string`                  | Name of the tool that was called                                         |
| `args`     | `Record<string, unknown>` | Arguments the tool was called with (may be modified by `beforeToolCall`) |
| `result`   | `unknown`                 | The result returned by the tool                                          |

### Example

Track tool usage:

```typescript
afterToolCall(ctx: ToolCallResultContext) {
  this.env.ANALYTICS.writeDataPoint({
    blobs: [ctx.toolName],
    doubles: [JSON.stringify(ctx.result).length]
  });
}
```

---

## onStepFinish

Called after each step completes in the agentic loop. A step is one `streamText` iteration — the model generates text, optionally calls tools, and the step ends.

```typescript
onStepFinish(ctx: StepContext): void | Promise<void>
```

### StepContext

| Field          | Type                                       | Description                 |
| -------------- | ------------------------------------------ | --------------------------- |
| `stepType`     | `"initial" \| "continue" \| "tool-result"` | Why the step ran            |
| `text`         | `string`                                   | Text generated in this step |
| `toolCalls`    | `unknown[]`                                | Tool calls made             |
| `toolResults`  | `unknown[]`                                | Tool results received       |
| `finishReason` | `string`                                   | Why the step ended          |
| `usage`        | `{ inputTokens, outputTokens }`            | Token usage for this step   |

### Example

Log step-level usage:

```typescript
onStepFinish(ctx: StepContext) {
  console.log(
    `Step ${ctx.stepType}: ${ctx.usage.inputTokens}in/${ctx.usage.outputTokens}out`
  );
}
```

---

## onChunk

Called for each streaming chunk. High-frequency — fires per token. Override for streaming analytics, progress indicators, or token counting. Observational only.

```typescript
onChunk(ctx: ChunkContext): void | Promise<void>
```

### ChunkContext

| Field   | Type      | Description                           |
| ------- | --------- | ------------------------------------- |
| `chunk` | `unknown` | The chunk data from the AI SDK stream |

---

## onChatResponse

Called after a chat turn completes and the assistant message has been persisted. The turn lock is released before this hook runs, so it is safe to call `saveMessages` or other methods from inside.

Fires for all turn completion paths: WebSocket, sub-agent RPC, `saveMessages`, and auto-continuation.

```typescript
onChatResponse(result: ChatResponseResult): void | Promise<void>
```

### ChatResponseResult

| Field          | Type                                  | Description                                |
| -------------- | ------------------------------------- | ------------------------------------------ |
| `message`      | `UIMessage`                           | The persisted assistant message            |
| `requestId`    | `string`                              | Unique ID for this turn                    |
| `continuation` | `boolean`                             | Whether this was a continuation turn       |
| `status`       | `"completed" \| "error" \| "aborted"` | How the turn ended                         |
| `error`        | `string?`                             | Error message (when `status` is `"error"`) |

### Examples

Log turn completion:

```typescript
onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed") {
    console.log(
      `Turn ${result.requestId} completed: ${result.message.parts.length} parts`
    );
  }
}
```

Chain a follow-up turn:

```typescript
async onChatResponse(result: ChatResponseResult) {
  if (result.status === "completed" && this.shouldFollowUp(result.message)) {
    await this.saveMessages([{
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "Now summarize what you found." }]
    }]);
  }
}
```

---

## onChatError

Called when an error occurs during a chat turn. Return the error to propagate it, or return a different error.

```typescript
onChatError(error: unknown): unknown
```

The partial assistant message (if any) is persisted before this hook fires.

### Example

Log and transform errors:

```typescript
onChatError(error: unknown) {
  console.error("Chat turn failed:", error);
  return new Error("Something went wrong. Please try again.");
}
```
