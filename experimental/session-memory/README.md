# Session Memory

Experimental `Session` API for conversation history with tree-structured messages, context blocks, full-text search, and automatic compaction.

> ⚠️ **Experimental** — this API will break between releases.

## Quick Start

```typescript
import { Agent, callable, routeAgentRequest, type StreamingResponse } from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction, truncateOlderMessages } from "agents/experimental/memory/utils";
import { generateText, streamText, convertToModelMessages } from "ai";

export class ChatAgent extends Agent<Env> {
  session = Session.create(this)
    .withContext("soul", {
      initialContent: "You are a helpful assistant with persistent memory.",
      readonly: true
    })
    .withContext("memory", {
      description: "Learned facts",
      maxTokens: 1100
    })
    .onCompaction(
      createCompactFunction({
        summarize: (prompt) =>
          generateText({ model: myModel, prompt }).then((r) => r.text),
        tailTokenBudget: 4000
      })
    )
    .compactAfter(20000)
    .withCachedPrompt();

  @callable({ streaming: true })
  async chat(stream: StreamingResponse, message: string) {
    await this.session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const result = streamText({
      model: myModel,
      system: await this.session.freezeSystemPrompt(),
      messages: await convertToModelMessages(
        truncateOlderMessages(this.session.getHistory())
      ),
      tools: await this.session.tools()
    });

    for await (const chunk of result.textStream) {
      stream.send({ type: "text-delta", text: chunk });
    }

    const assistantMsg = { id: `asst-${crypto.randomUUID()}`, role: "assistant", parts: [{ type: "text", text: await result.text }] };
    await this.session.appendMessage(assistantMsg);
    stream.end({ message: assistantMsg });
  }
}
```

## Session Builder

`Session.create(agent)` returns a builder. Chain methods to configure, then use the session directly — it initializes lazily on first access.

```typescript
Session.create(agent)
  .forSession(sessionId)          // scope to a specific session (default: "default")
  .withContext(label, options)     // add a context block (repeatable)
  .onCompaction(fn)               // register compaction function
  .compactAfter(tokenThreshold)   // auto-compact when tokens exceed threshold
  .withCachedPrompt(provider?)    // cache the frozen system prompt
```

## Messages

Messages use the [AI SDK `UIMessage`](https://sdk.vercel.ai/docs/reference/ai-sdk-ui/ui-message) format. The session stores them in a tree structure (branching via `parentId`).

```typescript
// Write
await session.appendMessage(message, parentId?)  // add message (auto-compacts if threshold exceeded)
session.updateMessage(message)                    // update in place
session.deleteMessages(messageIds)                // delete by ID
session.clearMessages()                           // delete all messages in session

// Read
session.getHistory(leafId?)     // linear path from root to leaf
session.getMessage(id)          // single message by ID
session.getLatestLeaf()         // most recent leaf message
session.getBranches(messageId)  // children of a message
session.getPathLength(leafId?)  // depth of the path
```

Every write method broadcasts a `cf_agent_session` event to connected WebSocket clients with the current token estimate.

## Context Blocks

Context blocks are named text sections injected into the system prompt. The AI can read and update them via auto-generated tools.

```typescript
.withContext("memory", {
  description: "Learned facts",     // shown to AI in tool description
  initialContent: "Empty",          // used when no stored value exists
  maxTokens: 1100,                  // enforced on writes
  readonly: false                   // if true, AI cannot modify via tools
})
```

### Context API

```typescript
session.getContextBlock(label)                      // get block content + metadata
session.getContextBlocks()                           // all blocks
await session.replaceContextBlock(label, content)    // overwrite block content
await session.appendContextBlock(label, content)     // append to block content
await session.freezeSystemPrompt()                   // build and cache system prompt from all blocks
await session.refreshSystemPrompt()                  // rebuild after context changes
await session.tools()                                // get ToolSet for AI SDK (update_context tool)
```

### System Prompt

`freezeSystemPrompt()` assembles all context blocks into a single system prompt and caches it. Call it once per request. The AI modifies blocks via the `update_context` tool, which calls `replaceContextBlock` / `appendContextBlock` under the hood.

## Compaction

Compaction replaces older messages with a summary overlay, keeping the conversation within a token budget. The original messages are preserved in the database — the overlay is applied at read time.

### How It Works

1. **Head** — first N messages are protected (never compacted)
2. **Tail** — messages at the end are protected by token budget
3. **Middle** — everything between head and tail is summarized by an LLM
4. On subsequent compactions, the previous summary is passed to the LLM for iterative updates

### `createCompactFunction(options)`

Built-in compaction implementation. Returns a function compatible with `onCompaction()`.

```typescript
import { createCompactFunction } from "agents/experimental/memory/utils";

createCompactFunction({
  // Required: LLM call for summarization
  summarize: (prompt: string) => Promise<string>,

  // Number of messages at the start to never compact (default: 3)
  protectHead: 3,

  // Token budget for the tail — messages at the end are protected
  // until this budget is exceeded. Larger = more tail preserved. (default: 20000)
  tailTokenBudget: 20000,

  // Minimum tail messages regardless of token budget (default: 4)
  minTailMessages: 4,
})
```

**Choosing values:**

| Context window | `compactAfter` | `tailTokenBudget` | `protectHead` | `minTailMessages` |
|---|---|---|---|---|
| Small (~1K tokens) | `1000` | `100–200` | `1` | `1` |
| Medium (~8K tokens) | `6000` | `2000` | `2` | `2` |
| Large (~128K tokens) | `100000` | `20000` | `3` | `4` (default) |

The summary budget is automatically scaled — it's capped at 50% of `tailTokenBudget`, so the summary never crowds out the tail.

### Auto-Compaction

```typescript
Session.create(agent)
  .onCompaction(compactFn)
  .compactAfter(20000)   // token threshold
```

After every `appendMessage`, the session estimates tokens in the history. If it exceeds the threshold, `compact()` runs automatically. Failures are non-fatal — the message is always persisted.

### Manual Compaction

```typescript
const result = await session.compact();
// result: { fromMessageId, toMessageId, summary } | null
```

### Custom Compaction Function

You can pass any function to `onCompaction()`. It receives the full message history and returns a `CompactResult` or `null`:

```typescript
.onCompaction(async (messages: UIMessage[]): Promise<CompactResult | null> => {
  // Your logic here
  return {
    fromMessageId: "first-message-to-replace",
    toMessageId: "last-message-to-replace",
    summary: "Summary text for the overlay"
  };
})
```

`fromMessageId` and `toMessageId` must be real message IDs that exist in the history (not virtual overlay IDs).

## Read-Time Truncation

`truncateOlderMessages` truncates tool outputs and long text in older messages before sending to the LLM. Does not mutate the stored messages.

```typescript
import { truncateOlderMessages } from "agents/experimental/memory/utils";

const truncated = truncateOlderMessages(history, {
  keepRecent: 4,              // recent messages left intact (default: 4)
  maxToolOutputChars: 500,    // max chars for tool outputs in older messages (default: 500)
  maxTextChars: 10000         // max chars for text parts in older messages (default: 10000)
});
```

## Full-Text Search

Requires `AgentSessionProvider` (SQLite-backed). Uses FTS5.

```typescript
const results = session.search("deployment error", { limit: 10 });
// [{ id, role, content, createdAt? }]
```

## WebSocket Events

The session broadcasts status events to connected clients on every mutation and during compaction.

### `cf_agent_session`

```json
{ "type": "cf_agent_session", "phase": "idle", "tokenEstimate": 456, "tokenThreshold": 20000 }
{ "type": "cf_agent_session", "phase": "compacting", "tokenEstimate": 21000, "tokenThreshold": 20000 }
{ "type": "cf_agent_session", "phase": "idle", "tokenEstimate": 3200, "tokenThreshold": 20000, "compacted": { "tokensBefore": 21000 } }
```

### `cf_agent_session_error`

```json
{ "type": "cf_agent_session_error", "error": "504 Gateway Timeout" }
```

Both types are available via `MessageType.CF_AGENT_SESSION` and `MessageType.CF_AGENT_SESSION_ERROR` exported from the `agents` package.

## Setup

```bash
npm install
npm start
```
