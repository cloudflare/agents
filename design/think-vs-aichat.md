# Think vs AIChatAgent: Feature Gap Analysis

> **Status: RESOLVED.** All gaps identified in this document have been closed by Phases 1–5. Think now has full feature parity with AIChatAgent plus Session-backed advantages (tree-structured messages, non-destructive regeneration, context blocks, compaction, FTS5 search). See [think-roadmap.md](./think-roadmap.md) for delivery details.
>
> This document is preserved as a historical record of the gap analysis that guided the implementation. The "Think" column in the summary table below reflects the state **before** the implementation — not the current state.

A detailed comparison of `@cloudflare/think` (`Think`) and `@cloudflare/ai-chat` (`AIChatAgent`), focused on features that were present in AIChatAgent but missing from Think at the time of writing.

Both classes extend `Agent` from the Agents SDK and share the same foundational primitives (SQLite, WebSocket hibernation, RPC, scheduling, fibers). They also share a common chat infrastructure layer (`agents/chat`) that provides `TurnQueue`, `ResumableStream`, `ContinuationState`, `StreamAccumulator`, `sanitizeMessage`, `enforceRowSizeLimit`, and `createToolsFromClientSchemas`.

The key architectural difference: **AIChatAgent expects `onChatMessage` to return a `Response`** (the agent consumes the response body internally), while **Think expects `onChatMessage` to return a `StreamableResult`** (an object with `toUIMessageStream()` — the `streamText()` return value). This means Think owns the full streaming pipeline internally, while AIChatAgent delegates streaming to the `Response` format and parses SSE or plaintext on consumption.

---

## Table of Contents

1. [Fiber-Wrapped Chat Turns (`unstable_chatRecovery`)](#1-fiber-wrapped-chat-turns-unstable_chatrecovery)
2. [Chat Recovery (`onChatRecovery` / `_chatRecoveryContinue`)](#2-chat-recovery-onchatrecovery--_chatrecoverycontinue)
3. [Continue Last Turn (`continueLastTurn`)](#3-continue-last-turn-continuelastturn)
4. [Programmatic Turn Entry (`saveMessages`)](#4-programmatic-turn-entry-savemessages)
5. [Post-Turn Hook (`onChatResponse`)](#5-post-turn-hook-onchatresponse)
6. [Custom Sanitization Hook (`sanitizeMessageForPersistence`)](#6-custom-sanitization-hook-sanitizemessageforpersistence)
7. [Message Concurrency Strategies (`messageConcurrency`)](#7-message-concurrency-strategies-messageconcurrency)
8. [Conversation Stability (`waitUntilStable` / `hasPendingInteraction`)](#8-conversation-stability-waituntilstable--haspendinginteraction)
9. [Message Reconciliation](#9-message-reconciliation)
10. [Regeneration (`regenerate-message`)](#10-regeneration-regenerate-message)
11. [`onFinish` Callback (Provider Finish Metadata)](#11-onfinish-callback-provider-finish-metadata)
12. [Custom Body Persistence (`_lastBody`)](#12-custom-body-persistence-_lastbody)
13. [Client Message Sync (`CF_AGENT_CHAT_MESSAGES` from Client)](#13-client-message-sync-cf_agent_chat_messages-from-client)
14. [v4 → v5 Message Migration (`autoTransformMessages`)](#14-v4--v5-message-migration-autotransformmessages)
15. [Continuation as Message Append (Chunk Rewriting)](#15-continuation-as-message-append-chunk-rewriting)
16. [Plaintext Response Support](#16-plaintext-response-support)
17. [`resetTurnState` (Public Turn Reset)](#17-resetturnstate-public-turn-reset)
18. [Summary Table](#summary-table)
19. [Dependency Graph](#dependency-graph)

---

## 1. Fiber-Wrapped Chat Turns (`unstable_chatRecovery`)

### What AIChatAgent does

AIChatAgent has a boolean property `unstable_chatRecovery` (default `false`). When set to `true`, **every chat turn** — WebSocket requests, auto-continuations, programmatic turns via `saveMessages`, and `continueLastTurn` — is wrapped in `runFiber()`:

```typescript
// packages/ai-chat/src/index.ts, lines 699–714 (WebSocket turn)
if (this.unstable_chatRecovery) {
  await this.runFiber(
    `${(this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME}:${requestId}`,
    async () => {
      await chatTurnBody();
    }
  );
} else {
  await chatTurnBody();
}
```

The same pattern appears in four places:

- **WebSocket turns** (line 705)
- **Auto-continuation turns** (line 1899)
- **Programmatic turns** via `_runProgrammaticChatTurn` (line 1965)
- **`continueLastTurn`** (line 2198)

Each fiber is named `__cf_internal_chat_turn:<requestId>`, enabling the recovery system to identify and handle chat-specific fibers separately from user fibers.

With `unstable_chatRecovery` enabled, subclasses can call `this.stash(data)` during streaming to checkpoint provider-specific recovery data (e.g., an OpenAI `responseId`). The stashed data is persisted in `cf_agents_runs` and made available during recovery via `ctx.recoveryData`.

### What Think does

Think inherits `runFiber()` from `Agent` but **does not wire it into the chat lifecycle**. Chat turns use `keepAliveWhile()` only:

```typescript
// packages/think/src/think.ts, lines 610–665
await this.keepAliveWhile(async () => {
  const turnResult = await this._turnQueue.enqueue(requestId, async () => {
    // ... onChatMessage → _streamResult ...
  });
});
```

`keepAliveWhile` prevents hibernation while the callback runs, but if the DO is **evicted** (memory pressure, runtime restart), the stream is lost with no recovery path. Think has no `unstable_chatRecovery` flag, no fiber wrapping, and no `stash()` support during chat turns.

Subclasses can still call `runFiber()` directly for non-chat work (e.g., background tasks), and Think's test suite includes fiber tests (`fiber.test.ts`), but the chat lifecycle itself is not fiber-aware.

### Impact

**High.** Long-running LLM calls (especially with tool chains, slow providers, or large context windows) can take 30–120+ seconds. Without fiber wrapping, any eviction during that window loses the entire response. For production agents with high traffic, eviction is not rare.

---

## 2. Chat Recovery (`onChatRecovery` / `_chatRecoveryContinue`)

### What AIChatAgent does

When a fiber-wrapped chat turn is interrupted by DO eviction, AIChatAgent's `_handleInternalFiberRecovery` runs on restart:

```typescript
// packages/ai-chat/src/index.ts, lines 2232–2301
protected override async _handleInternalFiberRecovery(
  ctx: FiberRecoveryContext
): Promise<boolean> {
  const chatPrefix =
    (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME + ":";
  if (!ctx.name.startsWith(chatPrefix)) {
    return false;  // Not a chat fiber — let the user handle it
  }

  const requestId = ctx.name.slice(chatPrefix.length);

  // Resolve stream ID from SQL or active stream
  let streamId = "";
  if (requestId) {
    const rows = this.sql<{ id: string }>`
      SELECT id FROM cf_ai_chat_stream_metadata
      WHERE request_id = ${requestId}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (rows.length > 0) {
      streamId = rows[0].id;
    }
  }

  // Reconstruct partial response from stored chunks
  const partial = streamId
    ? this._getPartialStreamText(streamId)
    : { text: "", parts: [] as MessagePart[] };

  // Call the user's recovery hook
  const options = await this.onChatRecovery({
    streamId,
    requestId,
    partialText: partial.text,
    partialParts: partial.parts,
    recoveryData: ctx.snapshot,      // Data from this.stash()
    messages: [...this.messages],
    lastBody: this._lastBody,
    lastClientTools: this._lastClientTools
  });

  // Persist orphaned stream if still active
  const streamStillActive = streamId &&
    this._resumableStream.hasActiveStream() &&
    this._resumableStream.activeStreamId === streamId;
  if (options.persist !== false && streamStillActive) {
    this._persistOrphanedStream(streamId);
  }
  if (streamStillActive) {
    this._resumableStream.complete(streamId);
  }

  // Schedule continuation
  if (options.continue !== false) {
    const targetId = this._findLastAssistantMessage()?.id;
    await this.schedule(0, "_chatRecoveryContinue",
      targetId ? { targetAssistantId: targetId } : undefined,
      { idempotent: true }
    );
  }

  return true;
}
```

The recovery context (`ChatRecoveryContext`) provides everything a subclass needs for provider-specific recovery:

```typescript
// packages/ai-chat/src/index.ts, lines 105–122
export type ChatRecoveryContext = {
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  recoveryData: unknown | null; // From this.stash()
  messages: ChatMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
};
```

The default `onChatRecovery` returns `{}`, which means: persist the partial response and schedule a continuation. Subclasses can override to:

- `{ continue: false }` — persist but don't continue (e.g., the partial is sufficient)
- `{ persist: false, continue: false }` — handle everything manually (e.g., fetch the complete response from the provider using `recoveryData`)

The scheduled continuation (`_chatRecoveryContinue`) uses a `targetAssistantId` guard to prevent stale continuations when the conversation has moved on:

```typescript
// packages/ai-chat/src/index.ts, lines 2322–2339
async _chatRecoveryContinue(data?: { targetAssistantId?: string }): Promise<void> {
  const ready = await this.waitUntilStable({ timeout: 10_000 });
  if (!ready) {
    console.warn("timed out waiting for stable state, skipping continuation");
    return;
  }

  const targetId = data?.targetAssistantId;
  if (targetId && this._findLastAssistantMessage()?.id !== targetId) {
    return;  // Conversation moved on, don't continue stale turn
  }

  await this.continueLastTurn();
}
```

### What Think does

Think has no `_handleInternalFiberRecovery` override, no `onChatRecovery` hook, no `ChatRecoveryContext`, and no `_chatRecoveryContinue` scheduler. Think does have `_persistOrphanedStream` (used during stream resume ACK handling), but it is not wired to any recovery lifecycle.

### Impact

**High.** This is the primary durability gap. Without recovery, interrupted streams are permanently lost — the user sees a truncated response with no automatic follow-up. The gap is compounded by the lack of `continueLastTurn` (gap #3) and `waitUntilStable` (gap #8), which are both prerequisites for the recovery flow.

---

## 3. Continue Last Turn (`continueLastTurn`)

### What AIChatAgent does

`continueLastTurn` is a protected method that triggers a new LLM call to extend the last assistant message:

```typescript
// packages/ai-chat/src/index.ts, lines 2142–2216
protected async continueLastTurn(
  body?: Record<string, unknown>
): Promise<SaveMessagesResult> {
  if (!this._findLastAssistantMessage()) {
    return { requestId: "", status: "skipped" };
  }

  const requestId = nanoid();
  const clientTools = this._lastClientTools;
  const resolvedBody = body ?? this._lastBody;
  const epoch = this._turnQueue.generation;
  let status: SaveMessagesResult["status"] = "completed";

  await this._runExclusiveChatTurn(requestId, async () => {
    if (this._turnQueue.generation !== epoch) {
      status = "skipped";
      return;
    }

    this._setRequestContext(clientTools, resolvedBody);

    const turnBody = async () => {
      await this._tryCatchChat(async () => {
        return agentContext.run({ agent: this, ... }, async () => {
          const response = await this.onChatMessage(() => {}, {
            requestId,
            abortSignal,
            clientTools,
            body: resolvedBody
          });

          if (response) {
            await this._reply(requestId, response, [], {
              continuation: true,        // Key flag
              chatMessageId: requestId
            });
          }
        });
      });
    };

    // Fiber-wrap if recovery is enabled
    if (this.unstable_chatRecovery) {
      await this.runFiber(`__cf_internal_chat_turn:${requestId}`, turnBody);
    } else {
      await turnBody();
    }
  }, { epoch });

  return { requestId, status };
}
```

The `continuation: true` flag in `_reply` triggers special chunk rewriting (see gap #15) that strips `messageId` from `start` chunks, causing the client to append new parts to the existing assistant message rather than creating a new one.

### What Think does

Think does not implement `continueLastTurn`. It has auto-continuation after client tool results (via `_scheduleAutoContinuation` → `_fireAutoContinuation`), but those create **new** assistant messages rather than appending to the existing one. There is no mechanism for a subclass to say "continue the last response."

### Impact

**Medium-high.** `continueLastTurn` is the building block for:

- Chat recovery after eviction (gap #2 calls it)
- Subclasses that want to extend a response programmatically (e.g., "generate more" buttons)
- Agent self-correction patterns (detect incomplete output, continue)

### Note on auto-continuation

Think's auto-continuation after tool results uses a full `onChatMessage` → `_streamResult` cycle, which creates a new assistant message. AIChatAgent's auto-continuation also calls `onChatMessage` but with `continuation: true`, which **appends** to the existing message. This is a subtle but important behavioral difference — in AIChatAgent, the tool result and the model's response to it appear as parts of the same assistant message.

---

## 4. Programmatic Turn Entry (`saveMessages`)

### What AIChatAgent does

`saveMessages` is the programmatic entry point for injecting messages and triggering a model turn from within the agent (without a WebSocket request):

```typescript
// packages/ai-chat/src/index.ts, lines 2085–2127
async saveMessages(
  messages:
    | ChatMessage[]
    | ((currentMessages: ChatMessage[]) => ChatMessage[] | Promise<ChatMessage[]>)
): Promise<SaveMessagesResult> {
  const requestId = nanoid();
  const clientTools = this._lastClientTools;
  const body = this._lastBody;
  const epoch = this._turnQueue.generation;
  let status: SaveMessagesResult["status"] = "completed";

  await this._runExclusiveChatTurn(requestId, async () => {
    const resolvedMessages = typeof messages === "function"
      ? await messages(this.messages)
      : messages;

    if (this._turnQueue.generation !== epoch) {
      status = "skipped";
      return;
    }

    await this.persistMessages(resolvedMessages);

    if (this._turnQueue.generation !== epoch) {
      status = "skipped";
      return;
    }

    await this._runProgrammaticChatTurn(requestId, clientTools, body);
  }, { epoch });

  return { requestId, status };
}
```

Key features:

- **Function form**: `saveMessages((msgs) => [...msgs, newMsg])` derives the next message list from the latest persisted state when the turn actually starts, avoiding stale baselines when multiple calls queue up.
- **Generation guards**: skips the turn if the conversation was cleared while waiting.
- **Return value**: `{ requestId, status }` lets callers detect skipped turns.
- **No connection required**: runs via `_runProgrammaticChatTurn` with `connection: undefined` in `agentContext`, so broadcasts go to all connected clients.

This enables patterns like:

- Scheduled agent responses (`this.schedule(delay, "sendFollowUp")`)
- Webhook-triggered turns (HTTP → `onRequest` → `saveMessages`)
- `onChatResponse` chaining (post-turn hook triggers another turn)
- Proactive agent behavior (agent notices something and speaks up)

### What Think does

Think has `chat()` for sub-agent RPC, which accepts a user message and streams via `StreamCallback`. But there is no equivalent for internal programmatic use — no way for a Think subclass to inject messages and trigger a turn from a scheduled task, webhook, or lifecycle hook without an external caller.

### Impact

**Medium-high.** This is the main programmatic API for agents that need to self-trigger responses. Without it, proactive agent patterns require workarounds (e.g., faking a WebSocket message from a synthetic connection).

---

## 5. Post-Turn Hook (`onChatResponse`)

### What AIChatAgent does

`onChatResponse` is called after every chat turn completes — WebSocket, `saveMessages`, and auto-continuation — once the assistant message has been persisted and the turn lock released:

```typescript
// packages/ai-chat/src/index.ts, lines 1997–2026
/**
 * Called after a chat turn completes and the assistant message has been
 * persisted. The turn lock is released before this hook runs, so it is
 * safe to call `saveMessages` from inside.
 *
 * Fires for all turn completion paths: WebSocket chat requests,
 * `saveMessages`, and auto-continuation.
 *
 * Responses triggered from inside `onChatResponse` (e.g. via `saveMessages`)
 * do not fire `onChatResponse` recursively.
 */
protected onChatResponse(
  _result: ChatResponseResult
): void | Promise<void> {}
```

The `ChatResponseResult` provides:

```typescript
// packages/ai-chat/src/index.ts, lines 166–177
export type ChatResponseResult = {
  message: ChatMessage; // The finalized assistant message
  requestId: string; // Request ID for this turn
  continuation: boolean; // Whether this was a continuation
  status: "completed" | "error" | "aborted";
  error?: string; // Error message when status is "error"
};
```

The hook runs outside the turn lock but inside `keepAliveWhile`, so it can safely call `saveMessages` (which queues another turn) without deadlocking. A re-entrancy guard (`_insideResponseHook`) prevents recursive `onChatResponse` calls when the hook triggers another turn.

### What Think does

Think has `onChatError(error)` for error handling, but no post-turn success/completion hook. Subclasses that need to react after a turn (logging, triggering side effects, updating external state, chaining responses) have no clean extension point.

### Impact

**Medium.** Important for:

- Observability (logging turn duration, token usage, finish reason)
- Agent chaining (trigger follow-up based on what was said)
- External integrations (push notifications, webhook callbacks)
- Analytics (track completion vs error vs abort ratios)

---

## 6. Custom Sanitization Hook (`sanitizeMessageForPersistence`)

### What AIChatAgent does

After the built-in sanitization (`sanitizeMessage` from `agents/chat` — strips OpenAI `itemId`, `reasoningEncryptedContent`, empty reasoning parts) and row size enforcement, AIChatAgent calls a user-overridable hook:

```typescript
// packages/ai-chat/src/index.ts, lines 2028–2064
/**
 * Override this method to apply custom transformations to messages before
 * they are persisted to storage. This hook runs **after** the built-in
 * sanitization (OpenAI metadata stripping, Anthropic provider-executed tool
 * payload truncation, empty reasoning part filtering).
 */
protected sanitizeMessageForPersistence(
  message: ChatMessage
): ChatMessage {
  return message;
}
```

This hook is called in `_sanitizeMessageForPersistence` which wraps both the built-in sanitization and the user hook, and it's invoked during `persistMessages`:

```typescript
// packages/ai-chat/src/index.ts, line 2384 (inside persistMessages)
const sanitizedMessage = this._sanitizeMessageForPersistence(message);
```

Use cases:

- Redacting PII or sensitive tool outputs before persistence
- Custom compaction of large message parts
- Stripping internal metadata that shouldn't be stored long-term
- Transforming provider-specific message formats

### What Think does

Think calls `sanitizeMessage()` and `enforceRowSizeLimit()` internally in `_persistAssistantMessage`, but does not expose a hook for subclass customization:

```typescript
// packages/think/src/think.ts, lines 890–904
private _persistAssistantMessage(msg: UIMessage): void {
  const sanitized = sanitizeMessage(msg);
  const safe = enforceRowSizeLimit(sanitized);
  const json = JSON.stringify(safe);

  if (this._persistedMessageCache.get(safe.id) !== json) {
    this._upsertMessage(safe);
  }
  // ...
}
```

There is no way for a Think subclass to inject custom transformations into the persistence pipeline.

### Impact

**Low-medium.** Matters for agents that handle sensitive data, need custom compaction strategies, or work with providers that attach non-standard metadata.

---

## 7. Message Concurrency Strategies (`messageConcurrency`)

### What AIChatAgent does

AIChatAgent supports five strategies for handling overlapping `submit-message` requests:

```typescript
// packages/ai-chat/src/index.ts, lines 134–142
export type MessageConcurrency =
  | "queue" // Serial FIFO (default)
  | "latest" // Drop all queued, run only the latest
  | "merge" // Merge queued user messages into a single turn
  | "drop" // Ignore if a turn is active
  | {
      strategy: "debounce";
      debounceMs?: number; // Default: 750ms
    };
```

The concurrency decision is evaluated per-request:

```typescript
// packages/ai-chat/src/index.ts, lines 384–401
/**
 * Controls how overlapping user submit requests behave while another chat
 * turn is already active or queued.
 *
 * This setting only applies to `sendMessage()` / `trigger: "submit-message"`
 * requests. Regenerations, tool continuations, approvals, clears, and
 * programmatic `saveMessages()` calls keep their existing serialized behavior.
 */
messageConcurrency: MessageConcurrency = "queue";
```

Under `"latest"`: superseded submits still persist their user messages (so they appear in the conversation), but their model turns are skipped. A monotonic `_submitSequence` counter tracks which submit is latest.

Under `"merge"`: overlapping user messages are collapsed. When the turn starts, `_mergeQueuedUserMessages` re-persists the combined user messages.

Under `"debounce"`: a trailing-edge debounce with configurable window (default 750ms). The turn waits for a quiet period before starting, picking up all user messages that arrived during the window.

### What Think does

Think uses `TurnQueue` which serializes all turns in FIFO order. There is no mechanism to drop, merge, or debounce overlapping requests:

```typescript
// packages/think/src/think.ts, lines 610–655
await this.keepAliveWhile(async () => {
  const turnResult = await this._turnQueue.enqueue(requestId, async () => {
    // ... always runs, always in order ...
  });
});
```

### Impact

**Medium.** The `"queue"` strategy works for most traditional chat UIs where users send one message at a time. But for real-time typing UIs (where the user can send rapid messages), collaborative interfaces, or agents that receive high-frequency inputs, the additional strategies prevent redundant LLM calls and provide better UX:

- `"latest"` — avoids processing stale messages when the user corrects themselves
- `"merge"` — combines "oh, also..." follow-up messages into one context-rich turn
- `"debounce"` — natural fit for search-as-you-type or real-time suggestion UIs
- `"drop"` — prevents queue buildup in high-frequency scenarios

---

## 8. Conversation Stability (`waitUntilStable` / `hasPendingInteraction`)

### What AIChatAgent does

**`hasPendingInteraction()`** checks whether any message (streaming or persisted) has a tool part waiting for client interaction:

```typescript
// packages/ai-chat/src/index.ts, lines 1581–1595
protected hasPendingInteraction(): boolean {
  if (
    this._streamingMessage &&
    this._messageHasPendingInteraction(this._streamingMessage)
  ) {
    return true;
  }

  return this.messages.some(
    (message) =>
      message.role === "assistant" &&
      this._messageHasPendingInteraction(message)
  );
}
```

A message has a pending interaction if any tool part is in `input-available` or `approval-requested` state.

**`waitUntilStable()`** combines turn queue drain with pending interaction polling:

```typescript
// packages/ai-chat/src/index.ts, lines 1605–1652
protected async waitUntilStable(options?: {
  timeout?: number;
}): Promise<boolean> {
  const deadline = options?.timeout != null ? Date.now() + options.timeout : null;

  while (true) {
    // Wait for active turns to finish
    if ((await this._awaitWithDeadline(
      this._turnQueue.waitForIdle(), deadline
    )) === TIMED_OUT) {
      return false;
    }

    // Check if any interaction is pending
    if (!this.hasPendingInteraction()) {
      return true;
    }

    // Wait for the pending interaction to resolve
    const pending = this._pendingInteractionPromise;
    if (pending) {
      const result = await this._awaitWithDeadline(pending, deadline);
      if (result === TIMED_OUT) return false;
    } else {
      // Poll with backoff
      if ((await this._awaitWithDeadline(
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
        deadline
      )) === TIMED_OUT) {
        return false;
      }
    }
  }
}
```

This is used by `_chatRecoveryContinue` to wait for pending client tool interactions to settle before continuing:

```typescript
// packages/ai-chat/src/index.ts, lines 2325–2326
const ready = await this.waitUntilStable({ timeout: 10_000 });
if (!ready) {
  /* skip continuation */
}
```

### What Think does

Think has no `hasPendingInteraction` or `waitUntilStable`. It has `TurnQueue.waitForIdle()` (inherited via the shared `TurnQueue`), but no way to wait for client-side tool interactions to complete.

### Impact

**Medium.** This is a prerequisite for safe chat recovery (you can't continue if the client hasn't responded to a pending tool call). It's also useful for:

- Programmatic agents that need to wait for human-in-the-loop approval
- Test harnesses that need to wait for conversation quiescence
- Orchestrators that need to know when a sub-agent is done with all interactions

---

## 9. Message Reconciliation

### What AIChatAgent does

AIChatAgent uses `reconcileMessages()` from `message-reconciler.ts` — a multi-stage pipeline that runs during `persistMessages`:

```typescript
// packages/ai-chat/src/index.ts, lines 2377–2379
const mergedMessages = reconcileMessages(messages, this.messages, (msg) =>
  this._sanitizeMessageForPersistence(msg)
);
```

The reconciler performs two stages:

**Stage 1 — Tool output merge:** When the server has a tool part with `output-available` but the client sends the same tool call as `input-available` or `approval-requested`, the server's output is preserved. This prevents the client from accidentally reverting tool results it hasn't seen yet.

**Stage 2 — ID reconciliation:** When client and server have messages with different IDs but identical content (common with optimistic client IDs), the server's ID is adopted. Content comparison uses a sanitized content key (via the optional `sanitizeForContentKey` callback) to handle cases where ephemeral metadata differs.

Additionally, `persistMessages` handles **stale row deletion** for regeneration:

```typescript
// packages/ai-chat/src/index.ts, lines 2402–2430
if (options?._deleteStaleRows) {
  const serverIds = new Set(this.messages.map((m) => m.id));
  const isSubsetOfServer = mergedMessages.every((m) => serverIds.has(m.id));

  if (isSubsetOfServer) {
    const keepIds = new Set(mergedMessages.map((m) => m.id));
    // Delete rows not in the incoming set
    for (const row of allDbRows) {
      if (!keepIds.has(row.id)) {
        this.sql`delete from cf_ai_chat_agent_messages where id = ${row.id}`;
      }
    }
  }
}
```

### What Think does

Think uses `INSERT OR IGNORE` for incoming user messages — the first version of a message ID wins. There is no content-based ID remapping, no tool output merge, and no stale row deletion:

```typescript
// packages/think/src/think.ts, lines 836–843
private _appendMessage(msg: UIMessage): void {
  const json = JSON.stringify(msg);
  this.sql`
    INSERT OR IGNORE INTO assistant_messages (id, role, content)
    VALUES (${msg.id}, ${msg.role}, ${json})
  `;
  this._persistedMessageCache.set(msg.id, json);
}
```

### Impact

**Medium.** The lack of reconciliation can cause issues in:

- **Multi-tab scenarios**: different tabs may assign different optimistic IDs to the same message
- **Reconnection**: the client may re-send messages with IDs that differ from the server's after an ID-less reconnect
- **Client tool state drift**: the client may have an older tool state than the server, and without merge, the client's stale state could overwrite the server's resolved state

In practice, Think partially mitigates this because `INSERT OR IGNORE` prevents duplicates (by ID), and the authoritative message list is always reloaded from SQLite after each operation. But edge cases around ID mismatches and tool state drift remain.

---

## 10. Regeneration (`regenerate-message`)

### What AIChatAgent does

AIChatAgent supports a `regenerate-message` trigger type alongside `submit-message`:

```typescript
// packages/ai-chat/src/index.ts, line 144
type ChatRequestTrigger = "submit-message" | "regenerate-message";
```

When the client sends a chat request with `trigger: "regenerate-message"`, the incoming message list is a truncated version of the conversation (up to the point where the user wants to regenerate). The `_deleteStaleRows: true` option in `persistMessages` deletes the old assistant response(s) that follow the truncation point, then a fresh turn runs:

```typescript
// packages/ai-chat/src/index.ts, lines 548–551
const requestTrigger: ChatRequestTrigger =
  _trigger === "regenerate-message" ? "regenerate-message" : "submit-message";
```

Concurrency strategies (`messageConcurrency`) do not apply to regeneration — it always uses the standard serial path.

### What Think does

Think does not handle a `regenerate-message` trigger. The only conversation reset mechanism is `clear` (`cf_agent_chat_clear`), which wipes the entire conversation. There is no way to truncate to a specific point and re-run inference.

### Impact

**Medium.** Regeneration is a standard chat UI feature. Users expect to be able to click "regenerate" on a response they're unhappy with. Without server-side support, the client would need to implement truncation, deletion, and re-submission manually — which is fragile across hibernation boundaries.

---

## 11. `onFinish` Callback (Provider Finish Metadata)

### What AIChatAgent does

AIChatAgent's `onChatMessage` signature includes an `onFinish` callback parameter:

```typescript
// packages/ai-chat/src/index.ts, lines 1986–1995
async onChatMessage(
  onFinish: StreamTextOnFinishCallback<ToolSet>,
  options?: OnChatMessageOptions
): Promise<Response | undefined> {
  throw new Error("override onChatMessage and return a Response");
}
```

Subclasses can pass this callback to `streamText()` to receive provider-level finish metadata when the stream completes:

```typescript
// Example usage in a subclass
async onChatMessage(onFinish, options) {
  const result = streamText({
    model: this.getModel(),
    messages: this.messages,
    onFinish,  // Receives: { usage, finishReason, text, toolCalls, ... }
  });
  return result.toUIMessageStreamResponse();
}
```

The callback provides token usage (`promptTokens`, `completionTokens`), finish reason, final text, tool calls, and other provider-specific metadata. AIChatAgent itself passes `async (_finishResult) => {}` (a no-op) when calling `onChatMessage` internally.

### What Think does

Think's `onChatMessage` returns a `StreamableResult` and does not accept an `onFinish` callback:

```typescript
// packages/think/src/think.ts, lines 278–297
async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
  return streamText({
    model: this.getModel(),
    system: this.getSystemPrompt(),
    messages,
    tools,
    stopWhen: stepCountIs(this.getMaxSteps()),
    abortSignal: options?.signal
  });
}
```

Subclasses that override `onChatMessage` can call `streamText` with their own `onFinish`, but the Think framework itself doesn't facilitate passing finish metadata to a lifecycle hook. There's no structured way to capture token usage or finish reasons for observability.

### Impact

**Low-medium.** Important for:

- Token accounting and billing
- Model routing decisions (switch models based on usage patterns)
- Analytics (finish reason distribution, average token counts)
- Cost optimization (detecting unnecessarily long completions)

---

## 12. Custom Body Persistence (`_lastBody`)

### What AIChatAgent does

AIChatAgent persists the custom `body` field from chat requests to SQLite, alongside client tools:

```typescript
// packages/ai-chat/src/index.ts, lines 342–347
/**
 * Custom body data from the most recent chat request.
 * Stored so it can be passed to onChatMessage during tool continuations.
 */
protected _lastBody: Record<string, unknown> | undefined;
```

The body is persisted via `_setRequestContext`:

```typescript
// packages/ai-chat/src/index.ts (inside _setRequestContext)
if (body) {
  this.sql`INSERT OR REPLACE INTO cf_ai_chat_request_context (key, value)
    VALUES ('lastBody', ${JSON.stringify(body)})`;
}
```

This means the `body` survives hibernation and is available during:

- Auto-continuation after tool results (`_enqueueAutoContinuation` passes `body`)
- Programmatic turns (`_runProgrammaticChatTurn` receives `body`)
- `continueLastTurn` (falls back to `this._lastBody`)
- Chat recovery (`_chatRecoveryContinue` → `continueLastTurn`)

The `body` field is passed to `onChatMessage` via `OnChatMessageOptions`:

```typescript
// packages/ai-chat/src/index.ts, lines 207–219
/**
 * Custom body data sent from the client via `prepareSendMessagesRequest`
 * or the AI SDK's `body` option in `sendMessage`.
 *
 * During tool continuations (auto-continue after client tool results), this
 * contains the body from the most recent chat request. The value is persisted
 * to SQLite so it survives Durable Object hibernation.
 */
body?: Record<string, unknown>;
```

### What Think does

Think parses `messages` and `clientTools` from the chat request body, but does not extract or persist any additional fields:

```typescript
// packages/think/src/think.ts, lines 571–578
let parsed: {
  messages?: UIMessage[];
  clientTools?: ClientToolSchema[];
};
try {
  parsed = JSON.parse(init.body) as typeof parsed;
} catch {
  return;
}
```

Any additional fields in the request body (e.g., `{ modelTier: "fast", persona: "pirate" }`) are silently discarded.

### Impact

**Low-medium.** Matters for agents that receive per-request configuration from the client. Think has `configure()` / `getConfig()` for dynamic configuration, but that's a separate mechanism intended for parent-to-child RPC configuration, not per-request client context.

---

## 13. Client Message Sync (`CF_AGENT_CHAT_MESSAGES` from Client)

### What AIChatAgent does

AIChatAgent handles the client sending a `CF_AGENT_CHAT_MESSAGES` frame with a complete message list. This is used for client-side message sync — when the client has edited messages locally (e.g., after optimistic updates) and needs the server to reconcile.

### What Think does

Think only handles `cf_agent_use_chat_request` (which contains a partial message list in the request body). The `CF_AGENT_CHAT_MESSAGES` type from the client is not handled in Think's `_handleProtocol`.

### Impact

**Low.** This is an edge case for advanced client state management and multi-device sync. Most chat UIs don't send full message arrays to the server.

---

## 14. v4 → v5 Message Migration (`autoTransformMessages`)

### What AIChatAgent does

AIChatAgent calls `autoTransformMessages()` on incoming messages to handle clients that still send AI SDK v4 message format (content-as-string, `TextPart` arrays) alongside v5 format (parts-based):

```typescript
// packages/ai-chat/src/index.ts, line 547
const transformedMessages = autoTransformMessages(messages);
```

This is also applied when loading from the database:

```typescript
// packages/ai-chat/src/index.ts, line 2439
this.messages = autoTransformMessages(persisted);
```

### What Think does

Think works with v5 `UIMessage` format only. No migration bridge is applied to incoming messages or stored messages.

### Impact

**Low (decreasing).** Only matters for existing applications upgrading from AI SDK v4 to v5. New applications built on Think will use v5 natively. Over time, this gap becomes irrelevant.

---

## 15. Continuation as Message Append (Chunk Rewriting)

### What AIChatAgent does

When `_reply` is called with `continuation: true`, AIChatAgent rewrites stream chunks before storing and broadcasting:

```typescript
// packages/ai-chat/src/index.ts, lines 3197–3220
// 1. Strip messageId from continuation start chunks so clients
//    reuse the existing assistant message
let eventToSend: unknown = data;
if (continuation && data.type === "start" && "messageId" in data) {
  const { messageId: _, ...rest } = data;
  eventToSend = rest;
}

// 2. Convert finish event's finishReason into messageMetadata format
if (data.type === "finish" && "finishReason" in data) {
  const { finishReason, ...rest } = data;
  eventToSend = {
    ...rest,
    type: "finish",
    messageMetadata: { finishReason }
  };
}
```

It also broadcasts with a `continuation: true` flag:

```typescript
// packages/ai-chat/src/index.ts, lines 3225–3231
this._broadcastChatMessage({
  body: chunkBody,
  done: false,
  id,
  type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
  ...(continuation && { continuation: true })
});
```

For plaintext continuations, it even reuses the last streaming text part if it was interrupted mid-generation:

```typescript
// packages/ai-chat/src/index.ts, lines 3271–3288
if (continuation) {
  for (let k = message.parts.length - 1; k >= 0; k--) {
    const part = message.parts[k];
    if (part.type === "text") {
      if ("state" in part && part.state === "streaming") {
        textPart = part as TextUIPart; // Reuse existing streaming part
      }
      break;
    }
  }
}
```

### What Think does

Think's `_streamResult` always creates a new `StreamAccumulator` with a fresh `messageId`:

```typescript
// packages/think/src/think.ts, lines 725–727
const accumulator = new StreamAccumulator({
  messageId: crypto.randomUUID()
});
```

Auto-continuation after tool results runs the same `_streamResult` pipeline, which creates a new assistant message. There is no concept of appending to an existing message.

### Impact

**Medium.** The continuation-as-append behavior is important for:

- Clean chat UI where tool call → result → continuation appears as one coherent assistant message
- Recovery after eviction (the continued response should extend the interrupted message, not create a new one)
- Consistent message history (fewer, more complete messages rather than many small fragments)

---

## 16. Plaintext Response Support

### What AIChatAgent does

AIChatAgent's `_reply` method detects the response content type and handles both SSE (AI SDK's `toUIMessageStreamResponse()`) and plain text:

```typescript
// packages/ai-chat/src/index.ts, lines 3469–3500
const contentType = response.headers.get("content-type") || "";
const isSSE = contentType.includes("text/event-stream");

if (isSSE) {
  streamEndStatus = await this._streamSSEReply(/* ... */);
} else {
  streamEndStatus = await this._sendPlaintextReply(/* ... */);
}
```

The plaintext path (`_sendPlaintextReply`) synthesizes `text-start`, `text-delta`, and `text-end` events from raw bytes, creating a proper `UIMessage` with a single text part. This means `onChatMessage` can return a simple `new Response("Hello")` and it will be properly streamed, accumulated, and persisted as a UIMessage.

### What Think does

Think expects `onChatMessage` to return a `StreamableResult` with `toUIMessageStream()`. This interface is satisfied by `streamText()` and other AI SDK streaming functions, but not by plain strings or simple `Response` objects. If a Think subclass wants to return a non-streaming response, it must manually wrap it in the `StreamableResult` interface.

### Impact

**Low.** Most agents use `streamText()` or `generateText()` which return objects with `toUIMessageStream()`. The plaintext path is a convenience for simple use cases (e.g., echo bots, static responses, non-AI endpoints).

---

## 17. `resetTurnState` (Public Turn Reset)

### What AIChatAgent does

`resetTurnState` is a protected method that aborts the active turn, resets the turn queue, destroys all abort controllers, cancels debounce timers, clears pending interactions, and resets continuation state:

```typescript
// packages/ai-chat/src/index.ts, lines 1668–1677
protected resetTurnState(): void {
  this._mergeQueuedUserStartIndexByEpoch.delete(this._turnQueue.generation);
  this._turnQueue.reset();
  this._destroyAbortControllers();
  this._cancelActiveDebounce();
  this._pendingInteractionPromise = null;
  this._continuation.sendResumeNone();
  this._continuation.clearAll();
  this._pendingChatResponseResults.length = 0;
}
```

Subclasses can call this when intercepting clear events or implementing custom reset logic.

### What Think does

Think's `_handleClear` performs the same operations inline, but it's a private method and there's no protected API for subclasses to trigger a reset independently:

```typescript
// packages/think/src/think.ts, lines 679–701
private _handleClear() {
  this._turnQueue.reset();
  for (const controller of this._abortControllers.values()) {
    controller.abort();
  }
  this._abortControllers.clear();
  this._resumableStream.clearAll();
  // ... etc
}
```

### Impact

**Low.** Edge case for subclasses that need to intercept or customize the clear behavior.

---

## Summary Table (current status)

All gaps have been resolved. The implementation order differed from the original recommendation below — see [think-roadmap.md](./think-roadmap.md) for the actual phasing.

| #   | Feature                                        | AIChatAgent                                         | Think (current)                                                                | Status           |
| --- | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------- |
| 1   | `unstable_chatRecovery` (fiber-wrapped turns)  | All 4 turn paths wrapped in `runFiber`              | All 4 paths wrapped (Phase 4)                                                 | **Resolved**     |
| 2   | `onChatRecovery` / `_chatRecoveryContinue`     | Full recovery pipeline with stale guards            | Full recovery pipeline with Session-aware guards (Phase 4)                     | **Resolved**     |
| 3   | `continueLastTurn()`                           | Append to last assistant message                    | Creates new message (Phase 3); true append planned                             | **Resolved**     |
| 4   | `saveMessages()`                               | Programmatic message injection + turn               | Full implementation with function form + generation guards (Phase 3)           | **Resolved**     |
| 5   | `onChatResponse` hook                          | Post-turn lifecycle with `ChatResponseResult`       | Fires from all paths: WebSocket, RPC, auto-continuation (Phase 1)              | **Resolved**     |
| 6   | `sanitizeMessageForPersistence` hook           | User-overridable pre-persist transform              | Protected hook, runs after built-in sanitization (Phase 3)                     | **Resolved**     |
| 7   | `messageConcurrency` strategies                | queue, latest, merge, drop, debounce                | All 5 strategies; merge is non-destructive (Phase 5)                           | **Resolved**     |
| 8   | `waitUntilStable` / `hasPendingInteraction`    | Full quiescence detection with timeout              | Full implementation with `_pendingInteractionPromise` (Phase 4)                | **Resolved**     |
| 9   | Message reconciliation                         | ID remapping, tool output merge, stale row deletion | Session's idempotent `appendMessage` + tree structure handles these cases      | **By design**    |
| 10  | Regeneration (`regenerate-message`)            | Truncate + re-run (destructive)                     | Non-destructive branching via Session tree (Phase 2)                           | **Resolved**     |
| 11  | `onFinish` callback                            | Provider finish metadata forwarding                 | Not in signature (deliberate — use `onChatResponse` instead)                   | **Skipped**      |
| 12  | Custom body persistence (`_lastBody`)          | Persisted to SQLite, survives hibernation           | Persisted to `assistant_config`, passed in all turn paths (Phase 3)            | **Resolved**     |
| 13  | Client message sync (`CF_AGENT_CHAT_MESSAGES`) | Full array sync from client                         | Session's idempotent append + tree structure makes full sync unnecessary        | **By design**    |
| 14  | v4 → v5 migration (`autoTransformMessages`)    | Automatic format bridge                             | v5 only (deliberate — no legacy)                                               | **Skipped**      |
| 15  | Continuation chunk rewriting                   | Strip `messageId`, append to existing message       | Creates new message; true append deferred                                      | **Partial**      |
| 16  | Plaintext response support                     | Auto-synthesizes UIMessage events from raw bytes    | Requires `StreamableResult` (deliberate — cleaner API)                         | **Skipped**      |
| 17  | `resetTurnState` (protected)                   | Subclass-callable turn reset                        | Protected method extracted from `_handleClear` (Phase 5)                       | **Resolved**     |
