# Think vs AIChatAgent

A comparison of `@cloudflare/think` (`Think`) and `@cloudflare/ai-chat` (`AIChatAgent`) — two chat agent base classes built on the Agents SDK. Both extend `Agent` and speak the same `cf_agent_chat_*` WebSocket protocol, but they serve different goals.

Related:

- [think-roadmap.md](./think-roadmap.md) — Think implementation plan (all phases complete)
- [think-sessions.md](./think-sessions.md) — Session integration design
- [chat-api.md](./chat-api.md) — AIChatAgent + useAgentChat API analysis
- [chat-improvements.md](./chat-improvements.md) — shared extraction + client DX improvements

---

## Philosophical difference

**AIChatAgent is a protocol adapter.** It bridges the `cf_agent_chat_*` WebSocket protocol to the AI SDK. You override `onChatMessage(onFinish, options) → Response | undefined` — you're responsible for calling `streamText`, wiring up tools, converting messages, constructing the system prompt, and returning a `Response`. AIChatAgent handles the plumbing: message persistence, streaming, abort, resume, client sync. But the LLM call is entirely your problem.

**Think is an opinionated framework.** It makes decisions for you: `getModel()` returns the model, `getSystemPrompt()` or `configureSession()` sets the prompt, `getTools()` returns tools, `assembleContext()` handles message conversion + truncation + pruning. The default `onChatMessage` runs the complete agentic loop. You override individual pieces, not the whole pipeline.

---

## API surface comparison

### Override points

| Concept                   | AIChatAgent                                                                 | Think                                                           |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Minimal subclass**      | ~15 lines (wire `streamText` + tools + messages + system prompt + response) | 3 lines (`getModel()` only)                                     |
| **onChatMessage**         | `(onFinish, options) → Response \| undefined`                               | `(options?) → StreamableResult`                                 |
| **System prompt**         | Inline in your `onChatMessage`                                              | `getSystemPrompt()` or `configureSession()` with context blocks |
| **Tools**                 | Inline in your `onChatMessage`                                              | `getTools()` + auto-merge with client tools + context tools     |
| **Context assembly**      | Manual in `onChatMessage`                                                   | `assembleContext()` → `{ system, messages }`                    |
| **Post-turn hook**        | `onChatResponse(result)`                                                    | `onChatResponse(result)` (same)                                 |
| **Error handling**        | No dedicated hook                                                           | `onChatError(error)`                                            |
| **Pre-persist transform** | `sanitizeMessageForPersistence(msg)`                                        | `sanitizeMessageForPersistence(msg)` (same)                     |
| **Recovery hook**         | `onChatRecovery(ctx)`                                                       | `onChatRecovery(ctx)` (same)                                    |

### Storage and data model

| Concept                | AIChatAgent                                           | Think                                                                                                               |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Messages**           | `this.messages` — mutable field, flat SQL table       | `this.messages` — getter from Session tree (always fresh from SQLite)                                               |
| **Storage**            | Flat `cf_ai_chat_agent_messages` table                | Session: `assistant_messages` (tree with `parent_id`), `assistant_compactions`, `assistant_fts`, `assistant_config` |
| **Regeneration**       | Destructive — `_deleteStaleRows` removes old response | Non-destructive — new response branches from same parent, old preserved                                             |
| **Message pruning**    | `maxPersistedMessages` (deletes oldest)               | Compaction (non-destructive summaries via overlays)                                                                 |
| **Search**             | Not available                                         | FTS5 full-text search (per-session and cross-session)                                                               |
| **Context blocks**     | Not available                                         | `configureSession()` with writable blocks, skills, search providers                                                 |
| **Multi-session**      | One conversation per DO                               | `SessionManager` for multiple conversations per DO                                                                  |
| **Config persistence** | Not available                                         | `configure(config)` / `getConfig()` with generic `Config` type                                                      |

### Turn execution

| Concept                | AIChatAgent                                                               | Think                                                             |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **WebSocket chat**     | Protocol handler in constructor                                           | Protocol handler via `_setupProtocolHandlers`                     |
| **Sub-agent RPC**      | Not built in                                                              | `chat(userMessage, callback, options)` with `StreamCallback`      |
| **Programmatic turns** | `saveMessages(messages)`                                                  | `saveMessages(messages)` (same)                                   |
| **Continuation**       | `continueLastTurn(body?)` — appends to existing message (chunk rewriting) | `continueLastTurn(body?)` — creates new message (append deferred) |
| **Concurrency**        | `messageConcurrency` (queue/latest/merge/drop/debounce)                   | `messageConcurrency` (same strategies, merge is non-destructive)  |
| **Durability**         | `chatRecovery` + `runFiber`                                               | `chatRecovery` + `runFiber` (same)                                |
| **Stability**          | `waitUntilStable()` / `hasPendingInteraction()`                           | `waitUntilStable()` / `hasPendingInteraction()` (same)            |
| **Turn reset**         | `resetTurnState()` (protected)                                            | `resetTurnState()` (protected)                                    |
| **onStart**            | Must call `super.onStart()`                                               | Constructor wrapping — no `super.onStart()` needed                |

### Client compatibility

| Concept                    | AIChatAgent                                          | Think                                                |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| **useAgentChat**           | Primary client hook                                  | Works unchanged (same protocol)                      |
| **useChat (AI SDK)**       | `Response` return type designed for AI SDK internals | `StreamableResult` — works via `useAgentChat`        |
| **v4 migration**           | `autoTransformMessages` bridges v4→v5                | v5 only (no legacy support)                          |
| **Message reconciliation** | ID remapping, tool output merge                      | Session's idempotent append handles underlying cases |
| **Client message sync**    | `CF_AGENT_CHAT_MESSAGES` from client                 | Not needed with Session                              |
| **Plaintext responses**    | Auto-synthesizes UIMessage events                    | Requires `StreamableResult`                          |

---

## When to use AIChatAgent

### 1. You need full control over the LLM call

You're doing something non-standard — custom streaming, multiple model calls per turn, RAG with vector search before the LLM call, response post-processing, or integrating with a non-AI-SDK provider. AIChatAgent lets you return any `Response` — even a plain text response or a manually constructed SSE stream.

```typescript
class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    // Full control: RAG → rerank → generate → post-process
    const context = await this.vectorSearch(this.messages);
    const response = streamText({
      model: openai("gpt-4o"),
      system: buildPrompt(context),
      messages: await convertToModelMessages(this.messages),
      tools: this.buildTools(),
      onFinish
    });
    return response.toUIMessageStreamResponse();
  }
}
```

### 2. You're migrating from AI SDK v4

`autoTransformMessages` handles the v4→v5 format bridge automatically. Think is v5-only — if you have existing v4 clients, AIChatAgent provides the migration path.

### 3. You want the `Response` abstraction

If your infrastructure expects HTTP `Response` objects (e.g., for testing, middleware, or non-WebSocket transports), AIChatAgent's `onChatMessage → Response` pattern fits naturally. Think's `StreamableResult` is an internal abstraction.

### 4. You need message reconciliation

Multi-tab, multi-device scenarios where clients send optimistic IDs that need server-side remapping. AIChatAgent's `reconcileMessages` handles ID conflicts and tool state merge. Think's Session uses idempotent append which avoids the problem differently — but doesn't remap IDs.

### 5. You're building a simple chatbot with no memory

If you don't need context blocks, compaction, search, or multi-session, AIChatAgent is less opinionated — you write your own `onChatMessage` and own exactly the complexity you need.

---

## When to use Think

### 1. You want to ship fast

3-line minimal subclass. Override `getModel()` and you have a working chat agent with streaming, persistence, abort/cancel, error handling, and resumable streams.

```typescript
export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
    );
  }
}
```

Graduation path: add `getSystemPrompt()` for a custom prompt, `getTools()` for tools, `configureSession()` for memory — each is one method, each has a clear default.

### 2. You need persistent memory

Context blocks give the model writable persistent memory via the `set_context` tool. The model can learn and remember facts across conversations without any custom code.

```typescript
configureSession(session: Session) {
  return session
    .withContext("memory", {
      description: "Important facts about the user.",
      maxTokens: 2000
    })
    .withCachedPrompt();
}
```

The memory block content renders into the system prompt with token usage indicators. The model sees: `MEMORY (Important facts — use set_context to update) [42% — 462/1100 tokens]` and can proactively write to it.

### 3. You need long conversations

Compaction replaces old messages with LLM-generated summaries — non-destructive, original messages preserved as overlays. Contrast with AIChatAgent's `maxPersistedMessages` which deletes oldest messages (lossy, permanent data loss).

```typescript
configureSession(session: Session) {
  return session
    .onCompaction(createCompactFunction({
      summarize: (prompt) => generateText({ model: this.getModel(), prompt }).then(r => r.text)
    }))
    .compactAfter(50000);
}
```

### 4. You need conversation search

FTS5 full-text search across message history. Per-session `session.search(query)` and cross-session `SessionManager.search(query)`. The model can search its own history via `search_context` tool.

### 5. You need regeneration with version history

Think preserves all response alternatives as branches in the Session tree. Users can browse "v1 / v2 / v3" responses via `session.getBranches(messageId)`. AIChatAgent destroys the old response on regeneration.

### 6. You're building a sub-agent system

`chat(userMessage, callback)` is designed for parent-child agent communication over Durable Object RPC. The parent drives the child's turns and receives streaming events via `StreamCallback`.

```typescript
// Parent agent
const child = this.spawn(ChildAgent, "child-1");
await child.chat("Analyze this data", {
  onEvent: (json) => this.forwardToClient(json),
  onDone: () => this.handleChildComplete()
});
```

### 7. You need proactive agents

`saveMessages()` lets the agent inject messages and trigger turns from scheduled tasks, webhooks, or `onChatResponse` hooks — without a WebSocket connection.

```typescript
async onScheduled() {
  await this.saveMessages([{
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Time for your daily summary." }]
  }]);
}
```

### 8. You need typed dynamic configuration

`configure<Config>(config)` / `getConfig()` with TypeScript generics. Persisted in Session's `assistant_config` table, survives hibernation and restarts.

```typescript
class MyAgent extends Think<Env, { theme: string; model: string }> {
  async onRequest(request: Request) {
    const config = await request.json();
    this.configure(config);
    return new Response("OK");
  }
}
```

### 9. You need R2-backed skills or on-demand knowledge

`R2SkillProvider` + `load_context` tool. The model sees skill metadata in the system prompt and loads full content on demand — without bloating the context window.

---

## Architectural advantages Think has over AIChatAgent

These are structural differences that come from the Session-backed architecture. They can't be added to AIChatAgent without a fundamental storage redesign.

| Advantage                          | Why it matters                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| **Tree-structured messages**       | Branching, forking, non-destructive regeneration                               |
| **Context blocks**                 | Persistent, structured, LLM-writable system prompt sections                    |
| **Compaction overlays**            | Non-destructive summarization — original messages preserved                    |
| **`assembleContext()` pipeline**   | Context blocks → frozen prompt → truncation → pruning, with LLM prefix caching |
| **Session as first-class concept** | Multi-session, cross-session search, usage tracking, forking                   |
| **`configureSession()` builder**   | Discoverable via autocomplete, async-capable, composable                       |

## What AIChatAgent has that Think deliberately skips

| Feature                                                    | Rationale                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `onFinish` callback on `onChatMessage`                     | Think uses `onChatResponse` instead — cleaner, fires from all paths          |
| `Response` return type                                     | Think uses `StreamableResult` — no HTTP abstraction mismatch                 |
| v4 → v5 message migration                                  | Think is v5-only — no legacy clients to support                              |
| `reconcileMessages`                                        | Session's idempotent append + tree structure handles the underlying cases    |
| Client message sync (`CF_AGENT_CHAT_MESSAGES` from client) | Unnecessary with Session's tree model                                        |
| `maxPersistedMessages`                                     | Replaced by compaction (non-destructive, preserves information)              |
| Plaintext response support                                 | Think requires `StreamableResult` — subclasses can wrap plain text if needed |

---

## Future directions

### Think could replace AIChatAgent entirely

Think's `onChatMessage` override gives the same level of control as AIChatAgent — you can ignore all the opinionated defaults and do everything manually. If Think is mature and tested enough, AIChatAgent becomes a legacy API maintained for backward compatibility.

### Shared Session layer

AIChatAgent could adopt Session as its storage layer — getting tree messages, compaction, and search without the opinionated framework layer. Session was designed to be reusable.

### Think-specific client features

`useAgentChat` works with Think today, but Think-specific features could get first-class client support:

- **Branch navigation** — `regenerate()` + `getBranches()` for "v1 / v2 / v3" UI
- **Session status** — compaction progress, token usage from `CF_AGENT_SESSION` broadcasts
- **Context block UI** — display memory contents, token budgets
- **Conversation list** — `SessionManager.list()` for conversation sidebars

### Multi-agent orchestration

Think's `chat()` RPC + `Session` + `configureSession` make it a natural building block for multi-agent systems where a parent Think agent delegates to child Think agents, each with their own conversation trees, memory, and tools.

### `StreamableResult` ← `Response` bridge

Think could accept `Response` objects in `onChatMessage` alongside `StreamableResult`, giving AIChatAgent users a zero-friction migration path. The bridge would parse SSE from the `Response` body into `StreamableResult` chunks.
