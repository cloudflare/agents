# Session Multichat

Demonstrates the experimental `SessionManager` API for managing multiple independent chat sessions within a single Agent, with cross-session search.

> ⚠️ **Experimental** — this API will break between releases.

## SessionManager API

`SessionManager` creates and manages multiple `Session` instances, each with isolated message history but shared context block configuration.

```typescript
import { SessionManager } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";

export class MultiSessionAgent extends Agent<Env> {
  manager = SessionManager.create(this)
    .withContext("soul", {
      provider: {
        get: async () => "You are a helpful assistant with persistent memory."
      }
    })
    .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
    .withSearchableHistory("history")
    .onCompaction(createCompactFunction({ summarize, tailTokenBudget: 150 }))
    .compactAfter(1000)
    .withCachedPrompt();

  @callable({ streaming: true })
  async chat(stream: StreamingResponse, chatId: string, message: string) {
    const session = this.manager.getSession(chatId);
    // Each session has its own history, memory, and compaction
    // But shares the searchable history across all sessions
    await session.appendMessage({
      id,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const result = streamText({
      system: await session.freezeSystemPrompt(),
      messages: await convertToModelMessages(session.getHistory()),
      tools: { ...(await session.tools()), ...this.manager.tools() }
    });
    // ...
  }
}
```

## Cross-Session Search

`.withSearchableHistory("history")` adds a readonly `SearchProvider` context block to every session. The model can search conversation history across all sessions:

```
search_context("history", { query: "deployment timeline" })
```

This uses the manager's existing FTS5 message index — no additional storage needed. The model sees:

```
══════════════════════════════════════════════
HISTORY (Cross-session conversation history — use search_context to search)
══════════════════════════════════════════════
3 sessions available for search.
```

## Builder Methods

```typescript
SessionManager.create(agent)
  .withContext(label, options)       // add context block (propagated to all sessions)
  .withSearchableHistory(label)      // add cross-session message search
  .onCompaction(fn)                  // register compaction function
  .compactAfter(tokenThreshold)      // auto-compact threshold
  .withCachedPrompt(provider?)       // cache frozen system prompt
  .maxContextMessages(count)         // limit context messages per session
```

## Session Lifecycle

```typescript
manager.create("Chat about APIs"); // create a named session
manager.list(); // list all sessions
manager.get(sessionId); // get session info
manager.rename(sessionId, "New name"); // rename session
manager.delete(sessionId); // delete session and its messages
manager.getSession(sessionId); // get Session instance for message ops
```

## Setup

```bash
npm install
npm start
```
