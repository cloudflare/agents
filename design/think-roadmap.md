# Think Roadmap

The implementation plan for `@cloudflare/think` — an opinionated chat agent base class built on Session for conversation storage and the Agents SDK for execution.

This document synthesizes four prior analyses:

- [think-sessions.md](./think-sessions.md) — Session integration design (the foundation)
- [think-vs-aichat.md](./think-vs-aichat.md) — feature gap analysis vs AIChatAgent (raw material — superseded by this doc for prioritization)
- [chat-api.md](./chat-api.md) — API analysis of AIChatAgent + useAgentChat (informs what to avoid)
- [chat-improvements.md](./chat-improvements.md) — non-breaking improvements + shared code extraction (feeds into Phase 1)

Think hasn't shipped yet. There are no backward compatibility constraints.

---

## Status

| Phase | Description                                                | Status      | Commit     |
| ----- | ---------------------------------------------------------- | ----------- | ---------- |
| **0** | Shared extraction (`agents/chat`) + non-breaking additions | **Done**    | `56558cd1` |
| **1** | Session integration into Think                             | **Done**    | —          |
| **2** | Regeneration (`regenerate-message` trigger)                | **Done**    | —          |
| **3** | Programmatic API (`saveMessages`, `continueLastTurn`)      | **Done**    | —          |
| **4** | Durability (`unstable_chatRecovery`, `onChatRecovery`)     | Not started | —          |
| **5** | Polish (demand-driven)                                     | Not started | —          |

**Phase 0 delivered:** `AbortRegistry`, `applyToolUpdate` + builders, `parseProtocolMessage` in `agents/chat`. `continuation` flag on `OnChatMessageOptions`. Tool part helpers, `getHttpUrl()`, `getAgentMessages()` in client layer. AIChatAgent refactored to use `AbortRegistry`. See [chat-improvements.md](./chat-improvements.md) for details.

**Phase 1 delivered:** Session wired into Think as the storage layer. `this.messages` is now a getter backed by `session.getHistory()`. All storage internals removed (`_initStorage`, `_loadMessages`, `_appendMessage`, `_upsertMessage`, `_clearMessages`, `_deleteMessages`, `_rebuildPersistenceCache`, `_enforceMaxPersistedMessages`, `_persistedMessageCache`, `maxPersistedMessages`, `_storageReady`, `#configTableReady`, `_think_config` table, `think_request_context` table). Switched to `AbortRegistry`, `parseProtocolMessage`, `applyToolUpdate`/`toolResultUpdate`/`toolApprovalUpdate` from `agents/chat`. Added `configureSession()` override point, `onChatResponse()` lifecycle hook with re-entrancy guard, `ChatResponseResult` type, `continuation` flag on `ChatMessageOptions`, context tool auto-merge in `onChatMessage`, and `assembleContext()` returning `{ system, messages }` with context block composition.

**Phase 2 delivered:** Non-destructive regeneration via `trigger: "regenerate-message"`. New responses branch from the same parent as the old response — old alternatives stay in the tree, accessible via `session.getBranches(parentId)`. `getHistory()` follows the latest leaf automatically. Contrast with AIChatAgent's destructive `_deleteStaleRows` approach.

**Phase 3 delivered:** `saveMessages()` for programmatic turn entry (scheduled responses, webhooks, proactive agents) with function form and generation guards. `continueLastTurn()` for extending the last assistant response. Custom body persistence across hibernation, passed to `onChatMessage` in all turn paths (WebSocket, RPC, auto-continuation, programmatic). `sanitizeMessageForPersistence` hook for PII redaction and custom transforms.

**Next:** Phase 4 — Durability (`unstable_chatRecovery`, `onChatRecovery`).

---

## Table of Contents

1. [Architecture](#architecture)
2. [What Think Already Has](#what-think-already-has)
3. [What Think Has That AIChatAgent Doesn't](#what-think-has-that-aichatagent-doesnt)
4. [Remaining Gaps](#remaining-gaps)
5. [Deliberately Skipped](#deliberately-skipped)
6. [Implementation Plan](#implementation-plan)
7. [Client-Side Improvements](#client-side-improvements)
8. [Open Questions](#open-questions)

---

## Architecture

Think is three layers, plus a shared chat infrastructure layer consumed by both Think and AIChatAgent:

```
┌─────────────────────────────────────────────────────────┐
│                      Think                               │
│  Chat execution: streaming, auto-continuation,          │
│  sub-agent RPC, extensions, configureSession             │
├─────────────────────────────────────────────────────────┤
│                   agents/chat                            │
│  Shared primitives: TurnQueue, ResumableStream,         │
│  StreamAccumulator, AbortRegistry, tool state machine,  │
│  protocol handler, ContinuationState, sanitization      │
├─────────────────────────────────────────────────────────┤
│                     Session                              │
│  Conversation data: tree messages, context blocks,      │
│  compaction, FTS5 search, multi-session, config          │
├─────────────────────────────────────────────────────────┤
│                      Agent                               │
│  DO primitives: SQLite, WebSocket, RPC, scheduling,     │
│  fibers, MCP client, state sync                          │
└─────────────────────────────────────────────────────────┘
```

**`agents/chat`** is the shared chat infrastructure layer — consumed by both Think and AIChatAgent. It provides primitives for turn queue serialization, resumable streams, stream accumulation, abort management, tool state updates, protocol message handling, continuation state, and message sanitization. See [chat-improvements.md](./chat-improvements.md) for the extraction plan.

**Session** owns all conversation data — messages, context blocks, compaction overlays, search indexes, configuration. See [think-sessions.md](./think-sessions.md) for the full design.

**Think** owns the chat execution lifecycle — streaming to clients, auto-continuation, sub-agent RPC, extensions, and the `configureSession` builder. It imports shared primitives from `agents/chat` rather than reimplementing them.

**Agent** provides the Durable Object primitives — SQLite, WebSocket hibernation, RPC, scheduling, fibers, MCP client.

---

## What Think Already Has

Features that are implemented or designed and ready to implement (via existing Think code + Session integration from [think-sessions.md](./think-sessions.md)):

### Execution layer (Think-specific)

| Feature               | Source                         | Notes                                                                          |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| Agentic loop          | `onChatMessage` → `streamText` | Structured overrides: `getModel`, `getSystemPrompt`, `getTools`, `getMaxSteps` |
| Sub-agent RPC         | `chat()`                       | `StreamCallback` interface for parent → child streaming                        |
| Dynamic configuration | `configure()` / `getConfig()`  | Typed `Config` parameter, persisted in SQLite                                  |
| Extensions            | `ExtensionManager`             | Sandboxed Worker tools, permission-gated, hot-loadable                         |
| Error handling        | `onChatError`                  | Partial message persistence on failure                                         |
| Auto-continuation     | `_scheduleAutoContinuation`    | 50ms coalesce, deferred queue                                                  |

### Shared chat layer (`agents/chat` — used by both Think and AIChatAgent)

| Feature              | Source                                   | Notes                                                                                   |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Turn queue           | `TurnQueue`                              | Serial execution with generation-based invalidation                                     |
| Resumable streams    | `ResumableStream`                        | Chunk buffering in SQLite, replay on reconnect                                          |
| Stream accumulation  | `StreamAccumulator`                      | Build assistant message from stream chunks                                              |
| Abort registry       | `AbortRegistry`                          | Per-request `AbortController` management (extracted from both agents)                   |
| Tool state machine   | `findAndUpdateToolPart`                  | Find tool part by `toolCallId`, match states, apply update (extracted from both agents) |
| Protocol handling    | `ChatProtocolHandler`                    | WebSocket protocol message parsing and dispatch (extracted from both agents)            |
| Continuation state   | `ContinuationState`                      | Pending/active/deferred continuation tracking                                           |
| Message sanitization | `sanitizeMessage`, `enforceRowSizeLimit` | Strip provider metadata, enforce 1.8MB row limit                                        |
| Client tools         | `createToolsFromClientSchemas`           | Convert client-side tool schemas to AI SDK tools                                        |
| Broadcast state      | `broadcastTransition`                    | Client-side stream state machine for cross-tab broadcast                                |
| Request context      | `RequestContextStore`                    | Key-value persistence for client tools, body, config (extracted from both agents)       |

See [chat-improvements.md §Shared Code Extraction](./chat-improvements.md#shared-code-extraction) for the extraction plan. Items marked "extracted from both agents" are currently duplicated between AIChatAgent and Think and will be consolidated into `agents/chat` before Think Phase 1.

### Data layer (via Session integration)

| Feature                   | Source                          | Notes                                                             |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Tree-structured messages  | `AgentSessionProvider`          | `parent_id` column, recursive CTE for history                     |
| `this.messages` getter    | `session.getHistory()`          | Always fresh, applies compaction overlays                         |
| Context blocks            | `ContextBlocks`                 | Readonly, writable, skills (R2), search (FTS5)                    |
| Auto-generated tools      | `session.tools()`               | `set_context`, `load_context`, `search_context`                   |
| Compaction                | `onCompaction` + `compactAfter` | Non-destructive overlays, hermes-style algorithm                  |
| FTS5 search               | `AgentSessionProvider`          | Per-message indexing, per-session and cross-session               |
| System prompt composition | `assembleContext()`             | Context blocks → frozen prompt, falls back to `getSystemPrompt()` |
| Read-time truncation      | `truncateOlderMessages()`       | Old tool outputs and long text truncated before LLM               |
| Multi-session             | `SessionManager`                | Create, list, delete, rename, fork, usage tracking                |
| Config storage            | `assistant_config` table        | Client tools, body, Think config — one table                      |

### Override points

| Method                      | Default                             | Purpose                                                |
| --------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `getModel()`                | throws                              | Return the `LanguageModel`                             |
| `getSystemPrompt()`         | `"You are a helpful assistant."`    | Simple system prompt (fallback when no context blocks) |
| `getTools()`                | `{}`                                | Server-side `ToolSet`                                  |
| `getMaxSteps()`             | `10`                                | Max tool-call rounds per turn                          |
| `configureSession(session)` | pass-through                        | Add context blocks, compaction, search                 |
| `assembleContext()`         | context blocks + truncated history  | Full control over what's sent to the LLM               |
| `onChatMessage(options?)`   | `streamText` with assembled context | Full control over inference                            |
| `onChatError(error)`        | passthrough                         | Customize error handling                               |

---

## What Think Has That AIChatAgent Doesn't

These are genuine advantages — features Think provides that AIChatAgent does not:

| Feature                                              | Think                                                                                                                                                                                                                                                                         | AIChatAgent                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context blocks**                                   | `withContext("memory", ...)` with auto-wired SQLite providers. Model can read/write its own persistent memory via `set_context` tool. Supports readonly blocks, writable blocks, R2-backed skill collections (`load_context`), and FTS5 searchable blocks (`search_context`). | Not available. System prompt is static per-request. No LLM-writable persistent memory.                                                                                                                                                 |
| **Compaction**                                       | `onCompaction(fn)` + `compactAfter(threshold)`. Non-destructive overlays — original messages preserved, LLM-generated summaries replace ranges at read time. Iterative updates on subsequent compactions. Token-budget tail protection with tool-group alignment.             | Not available. `maxPersistedMessages` deletes old messages (lossy).                                                                                                                                                                    |
| **Branching / regeneration**                         | Tree-structured messages via `parent_id`. Regeneration creates a sibling branch — both old and new responses preserved. `getBranches(messageId)` returns alternatives. `getHistory()` follows latest leaf.                                                                    | Destructive: `_deleteStaleRows` removes old response, re-runs inference. No version history.                                                                                                                                           |
| **FTS5 search**                                      | Every message indexed on insert. Per-session `searchMessages(query)`. Cross-session `SessionManager.search(query)`. `session_search` tool for model self-search.                                                                                                              | Not available.                                                                                                                                                                                                                         |
| **Multi-session**                                    | `SessionManager` with create, list, delete, rename, fork, usage tracking. Namespaced context blocks per session. Cross-session search.                                                                                                                                        | One conversation per DO instance.                                                                                                                                                                                                      |
| **Structured overrides**                             | `getModel()`, `getSystemPrompt()`, `getTools()`, `getMaxSteps()`, `configureSession()`, `assembleContext()` — each has clear defaults and a single responsibility. Minimal subclass is 3 lines.                                                                               | Single `onChatMessage(onFinish, options?)` override. Must wire `this.messages`, `convertToModelMessages`, `pruneMessages`, `streamText`, `toUIMessageStreamResponse` manually every time.                                              |
| **Sub-agent RPC**                                    | `chat(userMessage, callback, options?)` — parent agent drives sub-agent turns over Durable Object RPC with streaming via `StreamCallback`.                                                                                                                                    | Not available.                                                                                                                                                                                                                         |
| **`onChatMessage` signature**                        | `(options?) → StreamableResult` — no unused `onFinish` callback, no HTTP `Response` abstraction mismatch.                                                                                                                                                                     | `(onFinish, options?) → Response \| undefined` — `onFinish` is always a no-op internally, `Response` is consumed as a stream (never sent over HTTP). See [chat-api.md §S1](./chat-api.md#issue-s1-onchatmessage-signature-is-awkward). |
| **Skills from R2**                                   | `R2SkillProvider` + `load_context` tool. Model sees skill metadata in system prompt, loads full content on demand.                                                                                                                                                            | Not available.                                                                                                                                                                                                                         |
| **Dynamic config**                                   | `configure(config)` / `getConfig()` with typed `Config` parameter. Persisted across restarts.                                                                                                                                                                                 | Not available.                                                                                                                                                                                                                         |
| **Extension system**                                 | `ExtensionManager` — sandboxed Worker tools loaded at runtime, permission-gated network/workspace access, hot-loadable via `load_extension` tool.                                                                                                                             | Not available.                                                                                                                                                                                                                         |
| **`assembleContext` returns `{ system, messages }`** | System prompt is composed from context blocks + compaction summaries, returned alongside model messages. Clean separation.                                                                                                                                                    | System prompt is inlined in the `streamText` call inside `onChatMessage`. No structured composition.                                                                                                                                   |

---

## Remaining Gaps

Features from AIChatAgent that Think still needs. Session doesn't solve these — they're in the execution layer.

### Gap 1: `continueLastTurn()` — Programmatic continuation

**What it does:** Trigger a new LLM call that appends to the last assistant message rather than creating a new one. The LLM sees the full conversation (including the partial assistant response) and continues from where it left off.

**Why Think needs it:** Building block for chat recovery (#2). Also enables "generate more" buttons, agent self-correction, and subclass-driven continuation.

**Implementation with Session:** Session's tree structure makes this clean — the continuation appends as a child of the same parent the original assistant message was parented to. `getHistory()` follows the latest leaf, so the continued response replaces the interrupted one in the active path. Needs chunk rewriting (strip `messageId` from `start` chunks) so clients append to the existing message.

**Depends on:** Nothing (can implement standalone).

**Effort:** Medium. Needs turn queue integration, chunk rewriting, and a `continuation: true` flag wired through the pipeline.

### Gap 2: `unstable_chatRecovery` / `onChatRecovery` — Durability

**What it does:** Wraps every chat turn in `runFiber()`. If the DO is evicted mid-stream, the fiber recovers on restart: reconstructs partial response from stored chunks, calls `onChatRecovery()` for provider-specific recovery logic, then schedules `continueLastTurn()`.

**Why Think needs it:** Long-running LLM calls (30–120+ seconds with tool chains) can be interrupted by DO eviction. Without fiber wrapping, the stream is lost with no recovery path.

**Implementation with Session:** `onChatRecovery` receives a `ChatRecoveryContext` with `messages` from `session.getHistory()`, `partialText`/`partialParts` from stored chunks, and `recoveryData` from `this.stash()`. The `_chatRecoveryContinue` scheduler uses `waitUntilStable()` (#3) then calls `continueLastTurn()` (#1). `targetAssistantId` guard prevents stale continuations.

**Depends on:** `continueLastTurn` (#1), `waitUntilStable` (#3).

**Effort:** Medium-high. Four turn paths need fiber wrapping (WebSocket, auto-continuation, programmatic, `continueLastTurn`). Recovery pipeline needs `_handleInternalFiberRecovery` override, `ChatRecoveryContext` construction, and `schedule(0, "_chatRecoveryContinue")`.

### Gap 3: `waitUntilStable()` / `hasPendingInteraction()`

**What it does:** `hasPendingInteraction()` checks whether any message has a tool part in `input-available` or `approval-requested` state. `waitUntilStable()` combines turn queue drain with pending interaction polling, with a configurable timeout.

**Why Think needs it:** Prerequisite for safe chat recovery — you can't continue if the client hasn't responded to a pending tool call. Also useful for programmatic agents and test harnesses.

**Implementation with Session:** Check `session.getHistory()` for pending tool states. Session's `getHistory()` returns the current path including compaction overlays — tool states are always fresh.

**Depends on:** Nothing.

**Effort:** Low. Mostly logic, no storage changes.

### Gap 4: `saveMessages()` — Programmatic turn entry

**What it does:** Inject messages and trigger a model turn from within the agent — without a WebSocket request. Accepts static messages or a callback `(currentMessages) => newMessages`. Waits for active turns, persists, runs turn, returns `{ requestId, status }`.

**Why Think needs it:** Proactive agents (scheduled responses), webhook-triggered turns, `onChatResponse` chaining, notification-driven interactions. The existing `chat()` method serves sub-agent RPC, but there's no equivalent for internal programmatic use.

**Implementation with Session:** `session.appendMessage()` for persistence, then run a programmatic turn via the turn queue. Generation guards prevent stale turns after clear.

**Depends on:** Nothing (can implement standalone, but most useful with `onChatResponse`).

**Effort:** Medium. Needs turn queue integration and generation tracking.

### Gap 5: `onChatResponse` — Post-turn lifecycle hook

**What it does:** Called after every turn completion (WebSocket, `saveMessages`, auto-continuation) once the assistant message is persisted and the turn lock released. Receives `ChatResponseResult` with message, requestId, continuation flag, and status. Safe to call `saveMessages` from inside (re-entrancy guard prevents recursive hooks).

**Why Think needs it:** Observability, analytics, chaining behavior, usage tracking via `SessionManager.addUsage()`, refreshing system prompt after context block changes.

**Already designed in:** [think-sessions.md](./think-sessions.md) — API surface is defined. Implementation is straightforward.

**Depends on:** Nothing.

**Effort:** Low. Wire into existing turn completion paths.

### Gap 6: Regeneration (`regenerate-message` trigger)

**What it does:** Client sends `trigger: "regenerate-message"` with a truncated message list. Server deletes the old response and runs a fresh turn.

**Why Think needs it:** Standard chat UI feature — users expect "regenerate" on responses.

**Implementation with Session:** Session's branching makes this non-destructive. Instead of deleting the old response, append a new assistant message as a sibling branch (same `parentId`). `getHistory()` follows the latest leaf — the new response is the active path. Old response accessible via `getBranches()`.

This is **better** than AIChatAgent's approach: alternatives are preserved, users can browse response versions, and there's no data loss.

**Depends on:** Nothing. Session branching already works.

**Effort:** Low-medium. Parse `trigger: "regenerate-message"` in `_handleChatRequest`, resolve parent ID from message list, run turn with branching semantics.

### Gap 7: `continuation` flag on `ChatMessageOptions`

**What it does:** Let `onChatMessage` know whether it's being called for a continuation (after tool results, after recovery, via `continueLastTurn`) vs a fresh user turn.

**Why Think needs it:** Subclasses can adjust system prompts, select different models, skip expensive context assembly (RAG, memory retrieval), or log different metrics for continuations.

**Status:** Resolved in Phase 0. The `continuation` field is added to AIChatAgent's `OnChatMessageOptions` as a non-breaking addition (see [chat-improvements.md §3](./chat-improvements.md#3-add-continuation-to-onchatmessageoptions)). Think imports the shared type from `agents/chat` and sets the flag at its call sites.

**Effort:** Zero for Think — the type and AIChatAgent wiring land in Phase 0.

### Gap 8: `sanitizeMessageForPersistence` hook

**What it does:** User-overridable transform called after built-in sanitization but before Session persistence. For redacting PII, custom compaction, stripping internal metadata.

**Depends on:** Nothing.

**Effort:** Very low. Insert hook call in `_persistAssistantMessage` before `session.appendMessage`/`updateMessage`.

### Gap 9: Custom body persistence

**What it does:** Persist the client's custom `body` fields from the chat request. Available in auto-continuations, programmatic turns, and recovery. Survives hibernation.

**Implementation with Session:** Store in `assistant_config` table (same as client tools).

**Depends on:** Nothing.

**Effort:** Very low. Parse `body` from request, store in `assistant_config`, restore on turn start.

### Gap 10: `messageConcurrency` strategies

**What it does:** queue (default), latest, merge, drop, debounce for overlapping user submits.

**Why it might matter:** Real-time typing UIs, rapid-fire interactions, search-as-you-type patterns.

**Depends on:** Nothing.

**Effort:** Medium. Significant logic but self-contained.

**Status:** Demand-driven. Don't implement until users request it.

### Gap 11: `resetTurnState` (protected)

**What it does:** Expose turn reset as a protected method for subclasses that need to intercept or customize clear behavior.

**Depends on:** Nothing.

**Effort:** Very low. Extract from `_handleClear`.

---

## Deliberately Skipped

Features from AIChatAgent that Think will **not** implement, with rationale:

| Feature                                                    | Rationale                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onFinish` callback on `onChatMessage`                     | Think's signature is cleaner without it. Use `onChatResponse` for post-turn metadata. See [chat-api.md §S1](./chat-api.md#issue-s1-onchatmessage-signature-is-awkward).            |
| `Response` return type                                     | Think uses `StreamableResult` (`toUIMessageStream()`). No HTTP abstraction mismatch. See [chat-api.md §S4](./chat-api.md#issue-s4-response-return-type-couples-to-http-semantics). |
| v4 → v5 message migration                                  | Think is v5-only. No legacy clients.                                                                                                                                               |
| Client message sync (`CF_AGENT_CHAT_MESSAGES` from client) | Session's idempotent `appendMessage` + tree structure handles reconnect scenarios. Full array sync is unnecessary.                                                                 |
| Plaintext response support                                 | `StreamableResult` is the right abstraction. Subclasses that want to return plain text can wrap it in a simple helper.                                                             |
| `maxPersistedMessages`                                     | Replaced by compaction. Compaction is non-destructive and preserves information.                                                                                                   |
| `_persistedMessageCache`                                   | Session's `appendMessage` is idempotent by ID. `updateMessage` is explicit. No skip-unchanged optimization needed.                                                                 |
| Message reconciliation (`reconcileMessages`)               | Session's tree structure with idempotent append and explicit `updateMessage` handles the cases reconciliation was designed for (ID conflicts, tool state merge).                   |

---

## Implementation Plan

### Phase 0: Shared Extraction (prerequisite)

**Goal:** Extract duplicated code from AIChatAgent into `agents/chat` so Think can import shared primitives rather than reimplementing them. These PRs land on AIChatAgent first (non-breaking refactors), then Think consumes the extracted modules.

See [chat-improvements.md §Shared Code Extraction](./chat-improvements.md#shared-code-extraction) for the full extraction plan with side-by-side code comparison.

| Extraction                   | What moved to `agents/chat`                                   | Impact on Think Phase 1                                                    |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `AbortRegistry`              | `Map<string, AbortController>` + get/cancel/remove/destroyAll | Think imports instead of building `_abortControllers`                      |
| `applyToolUpdate` + builders | `toolResultUpdate` / `toolApprovalUpdate` / `applyToolUpdate` | Think imports instead of writing `_applyToolResult` / `_applyToolApproval` |
| `parseProtocolMessage`       | Typed parser for `cf_agent_chat_*` WebSocket messages         | Think imports for type-safe protocol dispatch                              |

**Each extraction is a non-breaking refactor to AIChatAgent** — the public API doesn't change, only the internal implementation moves to `agents/chat`. Think then imports from `agents/chat` in Phase 1.

**Also in Phase 0 (non-breaking additions to AIChatAgent, see [chat-improvements.md §Non-Breaking Additions](./chat-improvements.md#non-breaking-additions)):**

| Addition                                 | Notes                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| `continuation` on `OnChatMessageOptions` | Think reuses the shared type from `agents/chat`            |
| Export `getAgentMessages()`              | Works with Think agents (same protocol)                    |
| Export tool part helpers                 | Works with Think agents (same `UIMessage` format)          |
| `getHttpUrl()` on `useAgent`             | Removes `@ts-expect-error`, any Think client hook benefits |

### Phase 1: Session Integration

**Goal:** Wire Session into Think as the storage layer. This is the foundation — every subsequent phase builds on it.

**Prerequisite:** Phase 0 extractions must be landed so Think can import from `agents/chat`.

**Changes (from [think-sessions.md](./think-sessions.md)):**

1. **`onStart` rewrite:**
   - Remove `_initStorage`, `_loadMessages`, `_rebuildPersistenceCache`
   - Create `Session.create(this)`, pass to `configureSession()`
   - Store result as `this.session`

2. **`this.messages` becomes a getter:**

   ```typescript
   get messages(): UIMessage[] {
     return this.session.getHistory();
   }
   ```

3. **User message persistence:**
   - Replace `_appendMessage(msg)` with `session.appendMessage(msg)`
   - Remove `_appendMessage`, `_upsertMessage`, `_loadMessages` methods

4. **Assistant message persistence:**
   - Replace `_persistAssistantMessage` internals with `session.getMessage(id)` → `session.updateMessage(msg)` or `session.appendMessage(msg)`
   - Remove `_persistedMessageCache`, `_rebuildPersistenceCache`, `_enforceMaxPersistedMessages`, `maxPersistedMessages`

5. **`assembleContext` returns `{ system, messages }`:**
   - Compose system prompt from context blocks (if configured) or `getSystemPrompt()` (fallback)
   - Apply `truncateOlderMessages()` before `convertToModelMessages`
   - `onChatMessage` destructures result, passes `system` and `messages` to `streamText`

6. **Tool auto-merge:**
   - `onChatMessage` merges `getTools()` + `clientTools` + `session.tools()` + `options.tools`
   - Context tools (`set_context`, `load_context`, `search_context`) auto-included when context blocks configured

7. **Clear:**
   - Replace `_clearMessages()` + `this.messages = []` + `_persistedMessageCache.clear()` with `session.clearMessages()`

8. **Config and client tools:**
   - Use Session's `assistant_config` table directly for client tools and Think config
   - Remove `_think_config` table, `think_request_context` table, `_storageReady`, `#configTableReady`

9. **Protocol handling:**
   - Use `parseProtocolMessage` from `agents/chat` (extracted in Phase 0) for typed protocol dispatch
   - Think provides agent-specific handling per event type
   - Simplifies `_setupProtocolHandlers` / `_handleProtocol` with type-safe switch

10. **Abort management:**
    - Use `AbortRegistry` from `agents/chat` (extracted in Phase 0)
    - Replace `_abortControllers` Map + manual get/cancel/remove/destroyAll

11. **Tool result/approval:**
    - Use `applyToolUpdate` + `toolResultUpdate` / `toolApprovalUpdate` from `agents/chat` (extracted in Phase 0)
    - Replace `_applyToolResult` / `_applyToolApproval` (~70 lines) with calls to shared functions + Think-specific persist/broadcast

12. **Stream resume:**
    - Think keeps its own resume handling (notify/ACK/replay) — this was not extracted in Phase 0
    - Uses existing `ResumableStream` from `agents/chat` (already shared)

13. **Broadcast:**
    - Session's `_emitStatus` broadcasts `CF_AGENT_SESSION` with token estimates and compaction status
    - `_broadcastMessages` continues to use `this.messages` (now a getter)
    - Resume exclusions handled by `StreamResumeHandler.getExclusions()`

**Removes:** `_initStorage`, `_loadMessages`, `_appendMessage`, `_upsertMessage`, `_clearMessages`, `_deleteMessages`, `_rebuildPersistenceCache`, `_enforceMaxPersistedMessages`, `_persistedMessageCache`, `maxPersistedMessages`, `_storageReady`, `#configTableReady`, `think_request_context` table, `_think_config` table, `_applyToolResult`, `_applyToolApproval` (replaced by shared functions).

**Adds:** `session` field, `configureSession()` override, `{ system, messages }` return from `assembleContext()`.

**Imports from `agents/chat` (via Phase 0):** `AbortRegistry`, `applyToolUpdate`, `toolResultUpdate`, `toolApprovalUpdate`, `parseProtocolMessage`.

### Phase 2: Regeneration

**Goal:** First user-visible feature from Session's tree structure.

**Note:** `onChatResponse` and `continuation` flag were originally planned for Phase 2 but were delivered in Phase 1 — they fell naturally out of the Session integration work.

1. **Regeneration:**
   - Parse `trigger: "regenerate-message"` in the protocol handler
   - Find the user message that the old response branches from
   - Run `onChatMessage` — new assistant message appends as sibling branch
   - `getHistory()` follows latest leaf automatically
   - Broadcast updated messages

### Phase 3: Programmatic API

**Goal:** Enable agents to drive their own turns without WebSocket requests.

1. **`saveMessages()`:**
   - Accept `UIMessage[] | ((currentMessages) => UIMessage[])`
   - Wait for idle via turn queue
   - Persist via `session.appendMessage`
   - Run programmatic turn (no `connection` in `agentContext`)
   - Generation guards for stale-after-clear detection
   - Return `{ requestId, status }`

2. **`continueLastTurn()`:**
   - Find last assistant message via `session.getLatestLeaf()`
   - Run `onChatMessage` with `continuation: true`
   - Continuation chunk rewriting: strip `messageId` from `start` chunks
   - Return `{ requestId, status }`

3. **Custom body persistence:**
   - Parse `body` from chat request (everything except `messages`, `clientTools`, `trigger`)
   - Persist to `assistant_config` as `_lastBody`
   - Restore on turn start, pass to `onChatMessage` as `options.body`
   - Available in auto-continuations and `continueLastTurn`

4. **`sanitizeMessageForPersistence` hook:**
   - Called in `_persistAssistantMessage` after built-in sanitization, before Session persistence
   - Default: passthrough

### Phase 4: Durability

**Goal:** Streams survive DO eviction.

1. **`unstable_chatRecovery` flag:**
   - Boolean property (default `false`)
   - When `true`, wrap all turn paths in `runFiber(CHAT_FIBER_NAME:requestId, ...)`
   - Four paths: WebSocket turns, auto-continuation, `saveMessages`, `continueLastTurn`
   - `stash()` available during streaming for provider-specific checkpoint data

2. **`waitUntilStable()` / `hasPendingInteraction()`:**
   - `hasPendingInteraction()`: check `session.getHistory()` for tool parts in `input-available` or `approval-requested` state
   - `waitUntilStable({ timeout? })`: drain turn queue + poll pending interactions with deadline

3. **`onChatRecovery(ctx)` / `_chatRecoveryContinue`:**
   - `_handleInternalFiberRecovery` override: detect `CHAT_FIBER_NAME:` prefix
   - Build `ChatRecoveryContext` from `session.getHistory()` + stored stream chunks + `stash()` snapshot
   - Default `onChatRecovery()` returns `{}` → persist partial + schedule continuation
   - `_chatRecoveryContinue`: `waitUntilStable(10s)` → `targetAssistantId` guard → `continueLastTurn()`
   - Use `schedule(0, "_chatRecoveryContinue", { targetAssistantId }, { idempotent: true })`

### Phase 5: Polish (demand-driven)

Implement when users request:

1. **`messageConcurrency` strategies** — queue/latest/merge/drop/debounce
2. **`resetTurnState`** — extract from `_handleClear`, make protected

### Timeline

```
Phase 0: Shared Extraction          ──┐ Non-breaking refactors to AIChatAgent
  ├─ AbortRegistry                    │ + non-breaking additions
  ├─ RequestContextStore              │ Can proceed in parallel with
  ├─ findAndUpdateToolPart            │ client-side improvements
  ├─ ChatProtocolHandler              │
  ├─ StreamResumeHandler              │
  ├─ continuation flag                │
  ├─ getAgentMessages()               │
  ├─ tool part helpers                │
  └─ getHttpUrl()                     │
                                      │
Client-side improvements           ───┤ Parallel track (see chat-improvements.md)
  ├─ fallbackMessages                 │
  ├─ onChatError callback             │
  └─ (future: non-suspending hook)    │
                                      │
Phase 1: Session Integration       ───┤ Foundation — imports from agents/chat
                                      │
Phase 2: Regeneration              ───┤ First user-facing win (branching)
                                      │
Phase 3: Programmatic API          ───┤ saveMessages, continueLastTurn
                                      │
Phase 4: Durability                ───┤ Fiber-wrapped turns, recovery
                                      │
Phase 5: Polish                    ───┘ Demand-driven
```

---

## Client-Side Improvements

These improve `useAgentChat` for **all** agents (Think and AIChatAgent) and can proceed in parallel with server-side phases. Detailed analysis in [chat-api.md](./chat-api.md).

### High priority

| Issue                   | Description                                                                                                                                                               | Reference                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Non-suspending hook** | Export `getAgentMessages()` for framework loaders. Add non-suspending variant with `{ isPending, error }`. Support `fallbackMessages` for instant conversation switching. | [chat-api.md §C1](./chat-api.md#issue-c1-suspense-only-initial-message-fetch), [#1011](https://github.com/cloudflare/agents/issues/1011), [#1045](https://github.com/cloudflare/agents/issues/1045) |
| **Tool UI components**  | Export `<MessageParts>` renderer with slot-based customization. Export `getToolPartState()` utility. Eliminate the tool-state-machine boilerplate every app reimplements. | [chat-api.md §C3](./chat-api.md#issue-c3-tool-ui-is-entirely-user-rebuilt-every-time)                                                                                                               |
| **Combined hook**       | `useAgentChat({ agent: "ChatAgent", name: "session-1" })` that manages the WebSocket connection internally. Keep split hooks for advanced use.                            | [chat-api.md §C2](./chat-api.md#issue-c2-two-hook-calls-required-for-basic-setup)                                                                                                                   |

### Medium priority

| Issue                         | Description                                                                                            | Reference                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Unified streaming status**  | Make `isStreaming` the primary API. Simplify `status` / `isServerStreaming` / `isStreaming` confusion. | [chat-api.md §C4](./chat-api.md#issue-c4-isserverstreaming-vs-status-is-confusing) |
| **Structured error handling** | Add `onChatError` callback to hook options. Distinguish server vs network errors.                      | [chat-api.md §C5](./chat-api.md#issue-c5-no-structured-error-handling)             |
| **Message rendering helpers** | `<MessageRenderer>` component or `useMessageText`, `useToolParts` hooks.                               | [chat-api.md §X4](./chat-api.md#issue-x4-message-rendering-has-no-helpers)         |

### Low priority

| Issue                           | Description                                                                                                                                          | Reference                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **`addToolOutput` naming**      | Align with AI SDK's `addToolResult` or clearly document distinction.                                                                                 | [chat-api.md §C6](./chat-api.md#issue-c6-addtooloutput-vs-addtoolresult-naming-confusion)   |
| **Remove deprecated options**   | `tools`, `experimental_automaticToolResolution`, `toolsRequiringConfirmation`, `autoSendAfterAllConfirmationsResolved` — plan major version removal. | [chat-api.md §X1](./chat-api.md#issue-x1-deprecated-options-accumulating)                   |
| **Remove PartySocket coupling** | Add public `getHttpUrl()` method, remove `@ts-expect-error` internal access.                                                                         | [chat-api.md §C8](./chat-api.md#issue-c8-ts-expect-error-coupling-to-partysocket-internals) |

### Think-specific client opportunities

| Feature               | Description                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session status UI** | Session broadcasts `CF_AGENT_SESSION` with `{ phase, tokenEstimate, tokenThreshold }`. Client hook could expose `{ phase, tokenUsage }` for compaction progress bars, token counters.                                                      |
| **Context block UI**  | Expose context blocks to the client. Display "Memory" block contents, show token usage per block, allow manual editing.                                                                                                                    |
| **Branching UI**      | Session's `getBranches(messageId)` returns response alternatives. Client could show "← v1 / v2 / v3 →" navigation for regenerated responses.                                                                                               |
| **Conversation list** | `SessionManager.list()` returns `SessionInfo[]` with metadata. A `useConversations()` hook could power conversation sidebars without custom code. Addresses [chat-api.md §X2](./chat-api.md#issue-x2-no-conversation--session-management). |

---

## Open Questions

### Should `configureSession` be async?

Context block providers like `R2SkillProvider` might need async init. Currently the builder is sync with lazy resolution — providers are loaded on first access (inside `_ensureReady()`). This works because `getHistory()`, `tools()`, `freezeSystemPrompt()`, etc. all call `_ensureReady()` before accessing providers.

**Resolved:** `configureSession` accepts both sync and async return types (`Session | Promise<Session>`). `onStart` is async and awaits it. The Agent base class supports async `onStart` — it wraps and awaits the user's implementation. Sync implementations work unchanged (a sync return is a valid `Promise<Session>`). Async implementations can read from KV, D1, or R2 before configuring context blocks.

### Should compaction run synchronously or in background?

Currently `appendMessage` triggers auto-compaction synchronously when the token threshold is exceeded. For a chat turn, this adds LLM latency.

**Options:**

- **Sync (current):** Compaction runs inline. Simpler, but adds latency.
- **Background:** `schedule(0, "_compact")` defers to after the turn. No latency, but token count may briefly exceed threshold.
- **Post-turn:** Run compaction in `onChatResponse` after the turn lock is released.

**Leaning:** Post-turn compaction in `onChatResponse`. The turn is complete, messages are persisted, and the compaction runs without blocking the next user interaction. If it fails, non-fatal — the conversation continues uncompacted.

### How does regeneration interact with the wire protocol?

The client sends `trigger: "regenerate-message"` with a truncated message list. AIChatAgent uses `_deleteStaleRows` to remove the old response. Think-on-Session uses branching instead — no deletion.

**Question:** Does the client need to know about branching? Options:

- **Transparent:** Server broadcasts updated `messages` (from `getHistory()`, which follows latest leaf). Client sees the new response replace the old one. `useAgentChat` works unchanged.
- **Branch-aware:** Server sends branch metadata. Client can show "v1 / v2" UI. Requires client-side changes.

**Leaning:** Start transparent (no client changes needed). Add branch awareness later as a Think-specific client feature.

### Multi-session + wire protocol

When `session` is swapped based on `options.body.sessionId`, the existing WebSocket connections are still bound to the DO instance and receiving broadcasts. How should session switching work?

**Options:**

- **Per-request session:** Each `onChatMessage` call can use a different session via `options.body.sessionId`. Broadcasts go to all connections. Client is responsible for filtering by session.
- **Connection-scoped session:** Associate each WebSocket connection with a session ID on connect. Broadcasts are scoped to connections in the same session.
- **Separate DOs:** Each conversation is a separate DO instance (current model). `SessionManager` is only used for within-DO multi-session (sub-agent orchestration, branching).

**Leaning:** Separate DOs for user-facing conversations. `SessionManager` for internal orchestration (sub-agent logs, branching, forking). Don't try to multiplex user-facing sessions in a single DO.

### Should Session be promoted from experimental?

Session is currently in `agents/experimental/memory/session`. If Think depends on it, Think inherits the "experimental" designation. Options:

- **Promote Session** to `agents/memory/session` (or `agents/session`) — stable API, changeset required for changes.
- **Keep experimental** — Think is already `@experimental`, so inheriting experimental Session is consistent.
- **Inline** — Copy Session into `@cloudflare/think` as an internal module. Avoids cross-package coupling but duplicates code.

**Leaning:** Promote Session to stable alongside Think's release. They ship together as a coherent system.
