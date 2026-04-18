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

Called **before** the tool's `execute` function runs. Think wraps every server-side tool's `execute` so it can consult this hook and act on the returned `ToolCallDecision`. Only fires for tools with `execute` — client tools are handled on the client.

```typescript
beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void | Promise<ToolCallDecision | void>
```

### ToolCallDecision

| Return value                               | Effect                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `void` / `undefined`                       | Run the original `execute` with the original `input`                               |
| `{ action: "allow" }`                      | Same as `void`                                                                     |
| `{ action: "allow", input }`               | Run the original `execute` with the substituted `input`                            |
| `{ action: "block", reason? }`             | Skip `execute`; the model sees `reason` (or a default string) as the tool's output |
| `{ action: "substitute", output, input? }` | Skip `execute`; the model sees `output` as the tool's output                       |

`afterToolCall` always fires after the decision resolves. For `block` and `substitute`, the substituted value flows through `afterToolCall` as `success: true, output: ...` (the model's perspective: it received a string back).

> Note: when `allow` substitutes the input, `afterToolCall.input` still reflects what the **model** emitted (the AI SDK records the original tool-call chunk), while `output` reflects the result of executing with the substituted input. If you need to see the substituted input in `afterToolCall`, capture it in `beforeToolCall` and stash it on the agent.

### ToolCallContext

`ToolCallContext<TOOLS>` spreads the AI SDK's `TypedToolCall<TOOLS>` at the top level (so `ctx.toolName` and `ctx.input` work without unwrapping) and adds the per-call event extras from `OnToolCallStartEvent`.

| Field              | Type                          | Description                                                                 |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `type`             | `"tool-call"`                 | Discriminator                                                               |
| `toolCallId`       | `string`                      | Unique id for this tool call                                                |
| `toolName`         | `string`                      | Name of the tool being called                                               |
| `input`            | typed when `TOOLS` is passed  | Arguments the model provided (formerly `args`; renamed to match AI SDK)     |
| `dynamic?`         | `boolean`                     | `true` for runtime-registered tools, `false`/absent for statically declared |
| `providerMetadata` | `ProviderMetadata?`           | Provider-specific metadata for this call                                    |
| `stepNumber`       | `number \| undefined`         | Index of the current step where this tool call occurs                       |
| `messages`         | `ReadonlyArray<ModelMessage>` | Conversation messages visible at tool execution time                        |
| `abortSignal`      | `AbortSignal \| undefined`    | Aborts if the turn is cancelled                                             |

Pass an explicit `TOOLS` generic to get full input typing:

```typescript
import type { ToolCallContext } from "@cloudflare/think";

const tools = { search: tool({ inputSchema: z.object({ query: z.string() }), ... }) };

beforeToolCall(ctx: ToolCallContext<typeof tools>) {
  if (ctx.toolName === "search") {
    ctx.input.query; // typed as string
  }
}
```

### Examples

Log all tool calls:

```typescript
beforeToolCall(ctx: ToolCallContext) {
  console.log(`Tool called: ${ctx.toolName}`, ctx.input);
}
```

Block a tool when the agent is in a restricted mode:

```typescript
beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
  if (this.isReadOnlyMode && ctx.toolName === "delete") {
    return {
      action: "block",
      reason: "delete is disabled in read-only mode"
    };
  }
}
```

Substitute a cached result without running `execute`:

```typescript
async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallDecision | void> {
  if (ctx.toolName === "weather") {
    const cached = await this.cache.get(`weather:${JSON.stringify(ctx.input)}`);
    if (cached) return { action: "substitute", output: cached };
  }
}
```

Sanitize the model's input before execution (e.g. clamp a `limit`):

```typescript
beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
  if (ctx.toolName === "search") {
    const input = ctx.input as { query: string; limit?: number };
    return {
      action: "allow",
      input: { ...input, limit: Math.min(input.limit ?? 10, 50) }
    };
  }
}
```

### Notes & limitations

- **Substituted input is not re-validated.** The AI SDK validates the model's emitted input against the tool's `inputSchema` _before_ `execute` runs. When `beforeToolCall` returns `{ action: "allow", input: ... }`, that substituted input is passed straight through to `execute` without going through the schema again. If you substitute, ensure the shape stays valid for the tool you're calling.
- **`stepNumber` is `undefined` in `ToolCallContext`.** The AI SDK's `ToolExecutionOptions` doesn't expose the current step index. The same field _is_ populated on `ToolCallResultContext` (sourced from `experimental_onToolCallFinish`).
- **Throwing from `beforeToolCall`** propagates as a tool error — the AI SDK records it in the same way it would record an `execute` failure, and `afterToolCall` fires with `success: false, error: ...`.
- **Streaming tools (AsyncIterable returns).** The AI SDK supports tools that return `AsyncIterable<output>` to emit preliminary results before a final value. Because Think's wrapper must `await beforeToolCall` first, preliminary chunks are collapsed — only the final yielded value reaches the model. If you need true streaming preliminaries, override `getTools()` to provide such tools and avoid using `beforeToolCall` for them.
- **Hook order:** `beforeToolCall` (subclass) → extension `beforeToolCall` dispatch → original `execute` (or `block`/`substitute` short-circuit) → AI SDK records the outcome → `afterToolCall` (subclass) → extension `afterToolCall` dispatch.

---

## afterToolCall

Called after a tool's outcome is known — for real executions, for `block` (carries the `reason` as `output`), and for `substitute` (carries the substituted `output`). The discriminated `success`/`output`/`error` reflects what the model actually sees: thrown errors from the original `execute` become `success: false`; everything else (including blocked / substituted calls) is `success: true`.

```typescript
afterToolCall(ctx: ToolCallResultContext): void | Promise<void>
```

### ToolCallResultContext

`ToolCallResultContext<TOOLS>` is backed by the AI SDK's `OnToolCallFinishEvent<TOOLS>` (the parameter of `experimental_onToolCallFinish`). It spreads the originating `TypedToolCall<TOOLS>` at the top level, plus the per-call event extras and a discriminated outcome:

| Field        | Type                                  | Description                                          |
| ------------ | ------------------------------------- | ---------------------------------------------------- |
| `type`       | `"tool-call"`                         | Discriminator (carried over from the call)           |
| `toolCallId` | `string`                              | Unique id matching the originating `ToolCallContext` |
| `toolName`   | `string`                              | Name of the tool that was called                     |
| `input`      | typed when `TOOLS` is passed          | Arguments the tool was called with                   |
| `dynamic?`   | `boolean`                             | `true` for runtime-registered tools                  |
| `stepNumber` | `number \| undefined`                 | Index of the current step                            |
| `messages`   | `ReadonlyArray<ModelMessage>`         | Conversation messages visible at tool execution time |
| `durationMs` | `number`                              | Wall-clock execution time of `execute`               |
| `success`    | `boolean`                             | Discriminator: `true` on success, `false` on failure |
| `output`     | `unknown` (when `success` is `true`)  | Whatever the tool's `execute` returned               |
| `error`      | `unknown` (when `success` is `false`) | Whatever was thrown from `execute`                   |

### Example

Track tool usage and surface failures:

```typescript
afterToolCall(ctx: ToolCallResultContext) {
  if (ctx.success) {
    this.env.ANALYTICS.writeDataPoint({
      blobs: [ctx.toolName, "ok"],
      doubles: [ctx.durationMs, JSON.stringify(ctx.output).length]
    });
  } else {
    this.env.ANALYTICS.writeDataPoint({
      blobs: [ctx.toolName, "error", String(ctx.error)],
      doubles: [ctx.durationMs]
    });
  }
}
```

---

## onStepFinish

Called after each step completes in the agentic loop. A step is one `streamText` iteration — the model generates text, optionally calls tools, and the step ends.

```typescript
onStepFinish(ctx: StepContext): void | Promise<void>
```

### StepContext

`StepContext<TOOLS>` is a re-export of the AI SDK's `StepResult<TOOLS>` (= `OnStepFinishEvent<TOOLS>`). The full step record is forwarded — nothing is dropped or renamed. Highlights:

| Field              | Type                                                  | Description                                                                          |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `stepNumber`       | `number`                                              | Zero-based index of this step                                                        |
| `text`             | `string`                                              | Text generated in this step                                                          |
| `reasoning`        | `Array<ReasoningPart>`                                | Reasoning parts emitted by the model                                                 |
| `reasoningText`    | `string \| undefined`                                 | Concatenated reasoning text                                                          |
| `files`            | `Array<GeneratedFile>`                                | Files generated during the step                                                      |
| `sources`          | `Array<Source>`                                       | Citations / sources used                                                             |
| `toolCalls`        | `Array<TypedToolCall<TOOLS>>`                         | Typed tool calls (same shape as `ToolCallContext`)                                   |
| `toolResults`      | `Array<TypedToolResult<TOOLS>>`                       | Typed tool results (same shape as `ToolCallResultContext`)                           |
| `finishReason`     | `FinishReason`                                        | Unified finish reason from the model                                                 |
| `rawFinishReason`  | `string \| undefined`                                 | Raw provider finish reason                                                           |
| `usage`            | `LanguageModelUsage`                                  | `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens` |
| `warnings`         | `CallWarning[] \| undefined`                          | Warnings from the provider                                                           |
| `request`          | `LanguageModelRequestMetadata`                        | Raw request metadata                                                                 |
| `response`         | `LanguageModelResponseMetadata & { messages, body? }` | Raw response metadata + assistant/tool messages                                      |
| `providerMetadata` | `ProviderMetadata \| undefined`                       | Provider-specific metadata (e.g. Anthropic cache accounting)                         |

### Examples

Log step-level usage with cache accounting:

```typescript
onStepFinish(ctx: StepContext) {
  console.log(
    `Step ${ctx.stepNumber} (${ctx.finishReason}): ` +
    `${ctx.usage.inputTokens}in/${ctx.usage.outputTokens}out, ` +
    `${ctx.usage.cachedInputTokens ?? 0} cached`
  );
}
```

Capture reasoning text and citations:

```typescript
onStepFinish(ctx: StepContext) {
  if (ctx.reasoningText) {
    this.env.LOGS.writeDataPoint({ blobs: ["reasoning", ctx.reasoningText] });
  }
  for (const source of ctx.sources) {
    this.env.LOGS.writeDataPoint({ blobs: ["source", source.url ?? ""] });
  }
}
```

Read provider-specific cache tokens (Anthropic):

```typescript
onStepFinish(ctx: StepContext) {
  const anthropic = ctx.providerMetadata?.anthropic as
    | { cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
    | undefined;
  if (anthropic) {
    console.log(
      `cache: ${anthropic.cacheCreationInputTokens ?? 0} created, ` +
      `${anthropic.cacheReadInputTokens ?? 0} read`
    );
  }
}
```

---

## onChunk

Called for each streaming chunk. High-frequency — fires per token. Override for streaming analytics, progress indicators, or token counting. Observational only.

```typescript
onChunk(ctx: ChunkContext): void | Promise<void>
```

### ChunkContext

`ChunkContext<TOOLS>` is the parameter type of the AI SDK's `StreamTextOnChunkCallback<TOOLS>`. The `chunk` field is a discriminated union of `TextStreamPart` variants — narrow on `chunk.type` for typed access:

| Field   | Type                                                                                                                                                                           | Description                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `chunk` | `Extract<TextStreamPart<TOOLS>, { type: "text-delta" \| "reasoning-delta" \| "source" \| "tool-call" \| "tool-input-start" \| "tool-input-delta" \| "tool-result" \| "raw" }>` | The current chunk from the AI SDK stream |

Example — count text-delta tokens and forward reasoning to a logger:

```typescript
onChunk(ctx: ChunkContext) {
  switch (ctx.chunk.type) {
    case "text-delta":
      this.tokensStreamed += ctx.chunk.text.length;
      break;
    case "reasoning-delta":
      console.log("[reasoning]", ctx.chunk.text);
      break;
    case "tool-call":
      console.log(`[tool] ${ctx.chunk.toolName}`, ctx.chunk.input);
      break;
  }
}
```

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

---

## Extension hook subscriptions

Extensions can subscribe to lifecycle hooks via their manifest's `hooks` array. Think dispatches to extension-side handlers in load order, after the subclass hook has run, with a JSON-safe snapshot of the event.

```js
// extension source
({
  tools: {
    /* ... */
  },
  hooks: {
    beforeTurn: async (snapshot, host) => {
      /* may return TurnConfig */
    },
    beforeToolCall: async (snapshot, host) => {
      /* observation */
    },
    afterToolCall: async (snapshot, host) => {
      /* observation */
    },
    onStepFinish: async (snapshot, host) => {
      /* observation */
    },
    onChunk: async (snapshot, host) => {
      /* observation; high-frequency */
    }
  }
});
```

The handler receives `(snapshot, host)` — symmetric with tool `execute`. `host` is the bridge (`HostBridgeLoopback`) when the extension was loaded with permissions that require it; otherwise `null`.

### Snapshot shapes

Snapshots are intentionally narrower than the subclass `Context` types — class instances, `AbortSignal`s, and other non-JSON-clonable values can't cross the Workers RPC boundary.

| Hook             | Snapshot fields                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `beforeTurn`     | `{ system, toolNames, messageCount, continuation, body?, modelId }` — see `TurnContextSnapshot`              |
| `beforeToolCall` | `{ toolName, toolCallId, input, stepNumber, dynamic? }`                                                      |
| `afterToolCall`  | `{ toolName, toolCallId, input, stepNumber, durationMs, success, output? \| error?, dynamic? }`              |
| `onStepFinish`   | `{ stepNumber, finishReason, text, reasoningText, toolCallCount, toolResultCount, usage, providerMetadata }` |
| `onChunk`        | `{ type, text?, toolName?, toolCallId? }` — minimal because this fires per token                             |

### Return values

Only `beforeTurn` honors return values (it merges scalar `TurnConfig` fields back into the turn). The other four hooks are observation-only — return values are discarded. Errors thrown from extension hooks are caught and logged; they do not abort the turn.

### Performance note

`onChunk` fires per streaming token. Subscribing in an extension means an RPC round trip per chunk. Use sparingly — prefer aggregating in `onStepFinish` instead unless you specifically need per-token reactivity.
