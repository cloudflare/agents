# Think vs AIChatAgent

A comparison of `@cloudflare/think` (`Think`) and `@cloudflare/ai-chat` (`AIChatAgent`), the two chat base classes built on the Agents SDK. Both extend `Agent`, speak the same `cf_agent_chat_*` WebSocket protocol, and use the same `useAgentChat` hook implementation from `agents/chat/react`. Both are supported; [rfc-ai-chat-maintenance.md](./rfc-ai-chat-maintenance.md) records that `AIChatAgent` is first-class and not a legacy API.

Related:

- [think.md](./think.md) — Think architecture
- [sessions.md](./sessions.md) — the Sessions storage both classes use
- [chat-shared-layer.md](./chat-shared-layer.md) — primitives both classes share
- [chat-api.md](./chat-api.md) — AIChatAgent + useAgentChat API analysis

---

## Philosophical difference

**AIChatAgent is a protocol adapter.** You override `onChatMessage(onFinish, options) → Response | undefined` and are responsible for calling `streamText`, wiring tools, converting messages, and building the system prompt. AIChatAgent handles the plumbing: persistence, streaming, abort, resume, recovery, and client sync.

**Think is an opinionated framework.** `getModel()` returns the model, `configureContext()` (or the `getSystemPrompt()` fallback) sets the prompt, and `getTools()` returns tools. Think runs the loop. There is no `onChatMessage` to override; you change behavior through hooks such as `beforeTurn`, `beforeStep`, and `beforeToolCall`, which fire on every entry path.

---

## API surface comparison

### Override points

| Concept                   | AIChatAgent                                                      | Think                                                                                 |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Minimal subclass**      | ~15 lines (wire `streamText`, tools, messages, prompt, response) | 3 lines (`getModel()` returning a model id string)                                    |
| **Inference**             | `onChatMessage(onFinish, options) → Response \| undefined`       | Framework-owned; `beforeTurn` returns a `TurnConfig` to adjust it                     |
| **System prompt**         | Inline in your `onChatMessage`                                   | `configureContext()` blocks, or `getSystemPrompt()` as a fallback                     |
| **Tools**                 | Inline in your `onChatMessage`                                   | `getTools()` merged with workspace, action, extension, context, MCP, and client tools |
| **Continuation flag**     | `options.continuation`                                           | `ctx.continuation` on `TurnContext`                                                   |
| **Post-turn hook**        | `onChatResponse(result)`                                         | `onChatResponse(result)`                                                              |
| **Error handling**        | No dedicated hook                                                | `onChatError(error, ctx)` and `classifyChatError`                                     |
| **Pre-persist transform** | `sanitizeMessageForPersistence(msg)`                             | None; Sessions sanitizes provider metadata on write                                   |
| **Recovery hook**         | `onChatRecovery(ctx)`                                            | `onChatRecovery(ctx)`                                                                 |

### Storage and data model

| Concept                | AIChatAgent                                                                | Think                                                                     |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Messages**           | `this.messages`, a mutable field over a linear Sessions chain              | `this.messages`, an in-isolate projection of a branched Sessions path     |
| **Storage**            | `agents/sessions` default handle; the legacy flat table is lifted on start | `agents/sessions` tree with compaction overlays; config in `think_config` |
| **Regeneration**       | Destructive — the old response is removed                                  | Non-destructive — the new response branches from the same user message    |
| **History limits**     | `maxPersistedMessages` (deletes oldest)                                    | Compaction (summaries as overlays; originals kept)                        |
| **Search**             | Reachable through `this.sessions.session().search()`; not model-facing     | `this.session.search()`, plus `search_context` over searchable blocks     |
| **Context blocks**     | Not built in                                                               | `configureContext()` with writable, readonly, and searchable blocks       |
| **Conversations**      | One per Durable Object                                                     | One per Durable Object; multi-chat apps add a parent directory            |
| **Config persistence** | Not built in                                                               | `configure<T>(config)` / `getConfig<T>()`                                 |

### Turn execution

| Concept                | AIChatAgent                                                 | Think                                                                      |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Sub-agent RPC**      | No `chat()` method                                          | `chat(message, callback, options)` with `StreamCallback`                   |
| **Programmatic turns** | `saveMessages()`, `continueLastTurn()`                      | `runTurn()`, `saveMessages()`, `submitMessages()`, `continueLastTurn()`    |
| **Continuation**       | `continueLastTurn()` appends to the last assistant message  | `continueLastTurn()` creates a new message (recovery continuations append) |
| **Concurrency**        | `messageConcurrency` (queue, latest, merge, drop, debounce) | Same strategies; merge keeps each user message in the tree                 |
| **Durability**         | Always-on recovery; `chatRecovery` tunes budgets            | Same; turns run as Tasks                                                   |
| **Stability**          | `waitUntilStable()` / `hasPendingInteraction()`             | Same                                                                       |
| **Turn reset**         | `resetTurnState()` (protected)                              | Same                                                                       |
| **onStart**            | Wrapped in the constructor; no `super.onStart()` needed     | Same                                                                       |

### Client compatibility

| Concept                    | AIChatAgent                                         | Think                                             |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| **Client hook**            | `useAgentChat` from `@cloudflare/ai-chat/react`     | `useAgentChat` from `@cloudflare/think/react`     |
| **Legacy message shapes**  | `autoTransformMessages` converts older formats      | Current UI messages only                          |
| **Message reconciliation** | Shared `reconcileMessages` / `resolveToolMergeId`   | Same                                              |
| **Client transcript sync** | `syncMessagesToServer` can push a client transcript | Omitted; the Session tree is server-authoritative |
| **Plaintext responses**    | A plain-text `Response` is converted to UI chunks   | Not applicable; Think owns the model call         |

Both React entry points wrap the same implementation in `agents/chat/react`.

---

## When to use AIChatAgent

### 1. You need full control over the LLM call

Custom streaming, several model calls per turn, retrieval before generation, response post-processing, or a non-AI-SDK provider. `onChatMessage` can return any `Response`, including plain text.

```typescript
class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const context = await this.vectorSearch(this.messages);
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.7-code"),
      system: buildPrompt(context),
      messages: await convertToModelMessages(this.messages),
      tools: this.buildTools(),
      onFinish
    });
    return result.toUIMessageStreamResponse();
  }
}
```

### 2. You have stored messages in older formats

`autoTransformMessages` converts legacy message shapes. Think expects current UI messages.

### 3. You want the `Response` abstraction

If your testing or middleware expects HTTP `Response` objects, `onChatMessage → Response` fits naturally.

### 4. You want a thin chatbot

If you do not need context blocks, compaction, workspace tools, or extensions, AIChatAgent is less opinionated: you write `onChatMessage` and own exactly the complexity you need.

---

## When to use Think

### 1. You want to ship fast

Override `getModel()` and you have a streaming chat agent with persistence, cancellation, recovery, resumable streams, and workspace tools.

```typescript
export class MyAgent extends Think<Env> {
  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }
}
```

Then add `getTools()` for tools, `configureContext()` for memory and instructions, and `configureSession()` for compaction.

### 2. You need persistent memory

A writable context block gives the model memory it updates through the `set_context` tool.

```typescript
configureContext(): ContextConfig[] {
  return [
    {
      label: "memory",
      description: "Important facts about the user.",
      maxTokens: 2000
    }
  ];
}
```

The block renders into the system prompt with a usage header such as `MEMORY (Important facts about the user.) [23% — 462/2000 tokens] [writable]`.

### 3. You need long conversations

Compaction summarizes older messages as overlays; the originals stay stored. `maxPersistedMessages` in AIChatAgent deletes them.

```typescript
configureSession(session: Session) {
  return session
    .onCompaction(
      createCompactFunction({
        summarize: (prompt) =>
          generateText({ model: this.resolveModel(), prompt }).then((r) => r.text)
      })
    )
    .compactAfter(50000);
}
```

### 4. You need regeneration with version history

Regenerated responses are branches in the Session tree; `session.getBranches(messageId)` lists them for a "v1 / v2 / v3" UI.

### 5. You are building a sub-agent system

`chat()` streams a child's turn back to a parent over Durable Object RPC:

```typescript
const child = await this.subAgent(ResearchAgent, "research-1");
await child.chat("Analyze this data", {
  onStart: () => {},
  onEvent: (json) => this.forwardToClient(json),
  onDone: () => this.handleChildComplete(),
  onError: (error) => console.error(error)
});
```

The callback crosses the RPC boundary, so in practice it is an `RpcTarget`. For rendering a child's progress inline in a parent chat, use agent tools instead — see [agent-tools.md](./agent-tools.md).

### 6. You need proactive or programmatic turns

`saveMessages()` runs a turn from a schedule, webhook, or hook without a WebSocket. `submitMessages()` adds durable acceptance with idempotency keys, and `getScheduledTasks()` declares recurring prompts.

### 7. You need typed server-side configuration

`configure<T>(config)` / `getConfig<T>()` persist a JSON blob in `think_config` across hibernation. The type is a method-level generic.

```typescript
class MyAgent extends Think<Env> {
  getModel() {
    return (
      this.getConfig<{ model: string }>()?.model ??
      "@cf/moonshotai/kimi-k2.7-code"
    );
  }
}
```

### 8. You need on-demand skills

`getSkills()` registers [Agent Skills](https://agentskills.io/). The prompt lists skill metadata, and the model loads full instructions with `activate_skill` only when a task needs them. See [skills.md](./skills.md).

---

## What Think adds beyond storage

| Capability                   | Why it matters                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| **Tree-structured messages** | Non-destructive regeneration and branch navigation                                                  |
| **Context blocks**           | Persistent, structured, model-writable system prompt sections                                       |
| **Compaction overlays**      | Summarization without deleting originals                                                            |
| **Frozen system prompt**     | A stable prompt prefix across turns, which helps provider prompt caching                            |
| **Workspace and tools**      | Workspace file and Bash tools by default; code execution, fetch, browser, and extensions are opt-in |
| **Durable submission paths** | `submitMessages()`, scheduled tasks, messengers, and workflows                                      |

## What AIChatAgent keeps that Think skips

| Feature                                | Rationale                                                    |
| -------------------------------------- | ------------------------------------------------------------ |
| `onFinish` callback on `onChatMessage` | Think uses `onChatResponse`, which fires from every path     |
| `Response` return type                 | Think owns the model call, so there is no response to return |
| Legacy message conversion              | Think has no legacy transcripts to support                   |
| Client transcript sync                 | Think's Session tree is server-authoritative                 |
| `maxPersistedMessages`                 | Replaced by compaction                                       |
| Plaintext responses                    | Not applicable without `onChatMessage`                       |

---

## Open directions

- **Think-specific client features.** Branch navigation, compaction status, and context-block display have server APIs but no dedicated client helpers yet.
- **Multi-chat helpers.** Both classes use the same composition for many chats per user. `useChats()` and the directory remain example code (`examples/assistant`, `examples/next/routing`); see [rfc-user-chat-durable-objects.md](./rfc-user-chat-durable-objects.md) and [`docs/think/multi-chat.md`](../docs/think/multi-chat.md).
- **More shared layer.** Capabilities that both classes need move into `agents/chat` rather than into one class.
