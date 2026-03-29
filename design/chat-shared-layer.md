# Chat Shared Layer

Shared streaming, persistence, and protocol primitives for the `cf_agent_chat_*` WebSocket protocol. Lives in `packages/agents/src/chat/` and is consumed by both `@cloudflare/ai-chat` (the stable chat agent) and `@cloudflare/think` (the opinionated assistant base class).

## Problem

`@cloudflare/ai-chat` and `@cloudflare/think` both implement the same WebSocket chat protocol and share fundamental streaming/persistence concerns, but they live in separate packages with no shared code path. Think was forced to **fork** `message-builder.ts` (with a drift warning comment) and reimplement sanitization because `agents` — the only package both depend on — didn't have these primitives.

This led to:

- **Duplicated chunk-to-message logic** (`applyChunkToParts`) across two packages, with a comment warning about drift risk
- **Duplicated sanitization** (OpenAI metadata stripping, row-size enforcement) with subtle behavioral differences
- **Duplicated wire protocol constants** (`MSG_CHAT_*` strings matching `MessageType` values)
- **Duplicated metadata handling** (the `start`/`finish`/`message-metadata` switch that `applyChunkToParts` doesn't cover) in three separate code paths: ai-chat server, ai-chat client, and Think server

On the ai-chat side, `index.ts` (~3700 lines) and `react.tsx` (~1577 lines) mixed too many concerns together — streaming, reconciliation, persistence, broadcasting, turn management — making the code difficult to modify and reason about.

## Architecture

```
packages/agents/src/chat/          ← shared foundation
  index.ts                         barrel exports
  message-builder.ts               applyChunkToParts + types
  sanitize.ts                      sanitizeMessage, enforceRowSizeLimit
  stream-accumulator.ts            StreamAccumulator class
  protocol.ts                      CHAT_MESSAGE_TYPES constants

packages/ai-chat/src/              ← stable chat agent + client
  index.ts                         AIChatAgent (uses shared imports)
  react.tsx                        useAgentChat (uses StreamAccumulator)
  message-reconciler.ts            reconcileMessages, resolveToolMergeId
  ws-chat-transport.ts             WebSocket transport for AI SDK
  resumable-stream.ts              SQLite-backed chunk replay
  types.ts                         MessageType enum, wire protocol types

packages/think/src/                ← opinionated assistant
  think.ts                         Think (uses shared imports)
  session/                         SessionManager, branching, compaction
  extensions/                      ExtensionManager, HostBridgeLoopback
  transport.ts                     AgentChatTransport
```

**Dependency direction**: `ai-chat → agents`, `think → agents`. The shared layer resolves the circular dependency that caused the original fork.

## Modules

### message-builder.ts

**`applyChunkToParts(parts, chunk) → boolean`** — the core chunk-to-message-part builder. Mutates a `UIMessage["parts"]` array in place for streaming performance. Returns `true` if the chunk type was recognized, `false` for types the caller must handle (`start`, `finish`, `message-metadata`, `error`, `finish-step`).

This is the single most shared piece of code in the chat system. Used by:

- `AIChatAgent._streamSSEReply` — server-side SSE parsing
- `AIChatAgent._persistOrphanedStream` — rebuilding messages from stored chunks after hibernation
- `StreamAccumulator.applyChunk` — the higher-level wrapper
- Think's `StreamAccumulator` usage in `_streamResult` and `chat()`

**Key type: `StreamChunkData`** — deliberately loose (index signature, many optionals) to match the wire format without encoding chunk-type-specific constraints. The `messageMetadata` field is typed as `unknown` (not `Record<string, unknown>`) to match `UIMessageChunk` from the AI SDK.

### sanitize.ts

Two functions for persistence hygiene:

**`sanitizeMessage(message) → UIMessage`** — strips OpenAI ephemeral fields (`itemId`, `reasoningEncryptedContent`) from `providerMetadata` and `callProviderMetadata`, then filters truly empty reasoning parts (no text and no remaining provider metadata after stripping).

**`enforceRowSizeLimit(message) → UIMessage`** — compacts messages exceeding 1.8MB (the safety threshold below SQLite's 2MB row limit). Two-pass: first compact tool outputs over 1KB, then truncate text parts.

`@cloudflare/ai-chat` wraps these with additional logic:

- `_truncateProviderExecutedToolPayloads` — truncates large strings in Anthropic-style server-executed tool payloads (code_execution, text_editor)
- `sanitizeMessageForPersistence()` — protected hook for subclass customization
- `_enforceRowSizeLimit` — adds `console.warn` logging and `metadata.compactedToolOutputs` / `metadata.compactedTextParts` tracking

Think uses the shared functions directly (no extra steps).

### stream-accumulator.ts

**`StreamAccumulator`** — wraps `applyChunkToParts` and handles the chunk types it returns `false` for. Manages `messageId`, `parts`, and `metadata` as a coherent unit.

```typescript
class StreamAccumulator {
  messageId: string;
  readonly parts: UIMessage["parts"];
  metadata?: Record<string, unknown>;

  applyChunk(chunk: StreamChunkData): ChunkResult;
  toMessage(): UIMessage;
  mergeInto(messages: UIMessage[]): UIMessage[];
}
```

**`ChunkResult`** carries an optional **`ChunkAction`** — a discriminated union that signals domain-specific concerns without the accumulator knowing about them:

| Action type                 | When                                                                                  | Caller handles                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `start`                     | `start` chunk with optional `messageId` / `messageMetadata`                           | ai-chat: may overwrite `message.id`                                     |
| `finish`                    | `finish` chunk with optional `finishReason`                                           | ai-chat: normalize `finishReason` to `messageMetadata` before broadcast |
| `message-metadata`          | `message-metadata` chunk                                                              | Metadata already merged by accumulator                                  |
| `tool-approval-request`     | `tool-approval-request` chunk                                                         | ai-chat: early persist to SQLite for page-refresh survival              |
| `cross-message-tool-update` | `tool-output-available` / `tool-output-error` for a `toolCallId` not in current parts | ai-chat: search `this.messages` and update persisted message            |
| `error`                     | `error` chunk                                                                         | Think: broadcast error frame, `continue`; ai-chat: broadcast error      |

**`mergeInto(messages)`** — produces a new message array by finding an existing message (by `messageId`, or walking backward for last assistant in continuation mode), then replacing or appending. This replaced the `flushActiveStreamToMessages` function on the client and the `activeStreamRef` + metadata merge pattern.

**Where the accumulator is used vs. not:**

- **ai-chat client** (`react.tsx`): Uses `StreamAccumulator` for broadcast/resume streams. The transport-owned path (local tab requests) still goes through `useChat`'s built-in pipeline.
- **Think server**: Uses `StreamAccumulator` in both `_streamResult` (WebSocket path) and `chat()` (RPC sub-agent path).
- **ai-chat server** (`_streamSSEReply`): Still uses `applyChunkToParts` directly. The server's streaming message (`_streamingMessage`) is shared by reference with `hasPendingInteraction`, `_messagesForClientSync`, and `_findAndUpdateToolPart`, making it impractical to route through the accumulator without a deeper refactoring of the shared mutable state.

### protocol.ts

**`CHAT_MESSAGE_TYPES`** — plain string constants for the wire protocol message types. Used by Think to avoid depending on `@cloudflare/ai-chat/types` (which would create a dependency edge Think shouldn't have). The values match `MessageType` in `ai-chat/src/types.ts`.

### message-reconciler.ts (ai-chat only)

Pure functions for aligning client messages with server state during persistence. Think doesn't need these — its `INSERT OR IGNORE` + reload-from-DB model avoids the ID reconciliation problem entirely.

**`reconcileMessages(incoming, serverMessages, sanitize?)`** — two-stage pipeline:

1. **Tool output merge**: When the server has `output-available` for a tool that the client still shows as `input-available`, `approval-requested`, or `approval-responded`, adopt the server's output. This handles the case where the client sends stale tool states.

2. **ID reconciliation** (two-pass):
   - Pass 1: Exact ID matches between incoming and server, claiming server indices
   - Pass 2: Content-key matching for non-tool assistant messages using JSON-serialized sanitized parts. Prevents duplicate rows when the AI SDK assigns a different local ID than the server.

**`resolveToolMergeId(message, serverMessages)`** — per-message ID resolution by `toolCallId`. If a tool call ID exists in a server message with a different ID, adopt the server's ID. Called during persistence to prevent duplicate rows.

## Key decisions

### Why `agents/chat` and not a new package

Both `ai-chat` and `think` already depend on `agents`. Adding a new package would create another dependency edge and another build/publish step. The `agents` package already has subdirectory exports (`agents/mcp`, `agents/react`, etc.), so `agents/chat` follows the established pattern.

### Why the accumulator signals actions instead of handling them

The accumulator doesn't know about SQLite, WebSockets, or broadcasting. It signals via `ChunkAction` and the caller decides what to do. This keeps the accumulator testable as a pure data structure and reusable across contexts that handle actions differently (server persists to SQLite on approval, client ignores it; server broadcasts errors on the wire, client logs them).

### Why `_streamSSEReply` was not refactored to use the accumulator

`_streamSSEReply` in ai-chat's server mutates a `message` object that is shared by reference as `this._streamingMessage`. Other methods read this reference to check for pending tool interactions, build client sync payloads, and apply tool results during streaming. Routing through a `StreamAccumulator` would require either:

1. Sharing the same parts array between the accumulator and the message object (breaking the accumulator's encapsulation)
2. Syncing the accumulator's state back to the message after each chunk (adding complexity, not removing it)
3. Refactoring all consumers of `_streamingMessage` to read from the accumulator (a much larger change)

None of these reduce complexity. The metadata handling on the server is ~30 lines of straightforward switch/case that matches the accumulator's behavior exactly. The cost of duplication is low; the risk of the refactoring is high.

### Why reconciliation stays in ai-chat

Think avoids the reconciliation problem entirely through its persistence model: user messages use `INSERT OR IGNORE` (idempotent), assistant messages use `INSERT ON CONFLICT UPDATE`, and the authoritative message list is always reloaded from SQLite. There's no client/server ID mismatch because Think controls the full lifecycle.

`AIChatAgent` can't do this because it must accept whatever IDs the AI SDK generates on the client side, and the `useChat` hook's internal state management can produce ID mismatches during streaming, tool interactions, and page refreshes.

### Why `StreamChunkData.messageMetadata` is `unknown`

The AI SDK's `UIMessageChunk` types `messageMetadata` as `unknown`. If `StreamChunkData` used `Record<string, unknown>`, passing a `UIMessageChunk` directly to `applyChunkToParts` would fail type checking. The accumulator uses an `asMetadata()` helper to safely narrow `unknown` to `Record<string, unknown>` at runtime.

## Tradeoffs

**Shared `enforceRowSizeLimit` lacks ai-chat's observability features.** The shared version doesn't add `metadata.compactedToolOutputs` or `console.warn` on compaction. Think gets the simpler version; ai-chat wraps it with its own enhanced version. If Think ever needs compaction observability, the shared function could accept an options bag.

**The accumulator creates a new message on every `toMessage()` / `mergeInto()` call.** This is intentional for immutability (React needs new references for re-renders), but it means the server can't use `toMessage()` for its shared `_streamingMessage` reference without breaking identity.

**Wire protocol constants are duplicated between `CHAT_MESSAGE_TYPES` and `MessageType`.** The values are identical strings but live in two places. `MessageType` is `@cloudflare/ai-chat`'s published enum; `CHAT_MESSAGE_TYPES` is `agents`'s internal constants. Drift is the operational risk. A future consolidation could move the canonical values to `agents/chat` and have `ai-chat` re-export them, but that requires `ai-chat` to depend on the specific export path — a semver-sensitive change.

## What's next

### TurnQueue (deferred)

The turn serialization and concurrency policy code in `AIChatAgent` (~500 lines) is the next candidate for extraction. It would become a `TurnQueue` class in `agents/chat` with policy-based dispatch, usable by both ai-chat (full 5-policy spectrum) and Think (simple serial queue).

**State fields to move** (all in `index.ts`, declared ~287–347):

| Field                              | Type                                    | Role                                                                                  |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `_chatTurnQueue`                   | `Promise<void>`                         | Promise chain serializing turns; each turn chains a new promise until `releaseTurn()` |
| `_chatEpoch`                       | `number`                                | Bumped on clear; queued work compares and skips if stale                              |
| `_activeChatTurnRequestId`         | `string \| null`                        | Which request currently holds the lock                                                |
| `_queuedChatTurnCountsByEpoch`     | `Map<number, number>`                   | Refcount of active+queued turns per epoch                                             |
| `_submitSequence`                  | `number`                                | Monotonic counter for overlapping submits (latest/debounce/merge)                     |
| `_latestOverlappingSubmitSequence` | `number`                                | Latest sequence number; older sequences are superseded                                |
| `_activeDebounceTimer`             | `ReturnType<typeof setTimeout> \| null` | Debounce timeout handle                                                               |
| `_activeDebounceResolve`           | `(() => void) \| null`                  | Resolves the debounce promise                                                         |

**Fields that stay in AIChatAgent** (message-specific, not turn-scheduling):

| Field                               | Role                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `_mergeQueuedUserStartIndexByEpoch` | Start index for merging queued user messages — depends on `this.messages`        |
| `_pendingChatResponseResults`       | FIFO queue for `onChatResponse` — drained in `_runExclusiveChatTurn`'s `finally` |
| `_insideResponseHook`               | Re-entrancy guard for the drain loop                                             |
| `_pendingInteractionPromise`        | In-flight tool apply/approval; used by `waitUntilStable`                         |

**Methods to move:**

| Method                          | Lines      | Role                                                             |
| ------------------------------- | ---------- | ---------------------------------------------------------------- |
| `_runExclusiveChatTurn`         | ~1797–1852 | Promise-chain serialization + epoch refcount + drain             |
| `_getSubmitConcurrencyDecision` | ~1391      | Strategy dispatch for overlapping submits                        |
| `_isSupersededSubmit`           | ~1461      | Checks if a sequence is older than latest                        |
| `_waitForTimestamp`             | ~1468      | Debounce sleep with cancellation                                 |
| `_cancelActiveDebounce`         | ~1484      | Clears active debounce                                           |
| `waitForIdle`                   | ~1365–1371 | Awaits turn queue drain (loops until queue reference stabilizes) |

**Methods that stay** (message-specific):

| Method                                                      | Role                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `_mergeQueuedUserMessages` / `_getMergedQueuedUserMessages` | Merge consecutive user messages — operates on `this.messages`         |
| `_rollbackDroppedSubmit`                                    | Sends `CF_AGENT_CHAT_MESSAGES` to restore client state after drop     |
| `_completeSkippedRequest`                                   | Sends empty `done: true` response for skipped turns                   |
| `resetTurnState`                                            | Calls queue reset + clears abort controllers, auto-continuation, etc. |
| `waitUntilStable`                                           | Wraps `waitForIdle` + `hasPendingInteraction` + polling               |

**Key design challenge — the `onChatResponse` drain.** `_runExclusiveChatTurn`'s `finally` block drains `_pendingChatResponseResults` by calling `this.onChatResponse(result)` inside `keepAliveWhile`. This couples the queue's release logic to the agent's hook system. Options:

1. TurnQueue emits a `turnComplete` callback; AIChatAgent wires the drain there
2. TurnQueue returns a `TurnHandle` whose `done` promise resolves after `fn` completes; AIChatAgent drains after awaiting it
3. The drain stays in AIChatAgent and TurnQueue only handles serialization

Option 3 is simplest. The `_runExclusiveChatTurn` method becomes a thin wrapper: `await this._turnQueue.enqueue(requestId, fn)` then drain.

**Key design challenge — merge policy.** The `"merge"` policy doesn't create a new turn; it coalesces user messages into the existing queued turn. The queue itself can't do this (it doesn't know about messages). It needs to signal `{ merged: true }` and let the caller handle message coalescing.

**Test coverage to preserve:** `message-concurrency.test.ts` (13 tests), `chat-turn-serialization.test.ts` (9 tests), `programmatic-turns.test.ts` (3 tests), `pending-interaction.test.ts` (9 tests). Write characterization tests against TurnQueue unit tests first, then integrate.

**Why deferred:** The interleaving of turn scheduling with message-specific concerns (`_mergeQueuedUserMessages`, `_rollbackDroppedSubmit`, `_completeSkippedRequest`, `resetTurnState`, `onChatResponse` drain) means the extraction boundary is fuzzy. A clean TurnQueue handles scheduling; everything else stays in AIChatAgent. But the `finally` block mixes both.

---

### Server-side StreamAccumulator (deferred)

Making `_streamSSEReply` use the `StreamAccumulator` requires resolving the `_streamingMessage` shared reference problem.

**Consumers of `_streamingMessage`:**

| Method                   | What it reads                                                       | Mutation?                                            |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `_messagesForClientSync` | `parts.length`, `id`, full object (spliced into messages array)     | Read only                                            |
| `hasPendingInteraction`  | Full object → `_messageHasPendingInteraction`                       | Read only                                            |
| `_findAndUpdateToolPart` | Iterates `parts`, uses `message === _streamingMessage` for identity | **Mutates parts in place** when `isStreamingMessage` |
| `_streamSSEReply`        | Truthiness, shallow copy for early persist snapshot                 | Read only                                            |
| `_reply`                 | Sets to the live message object; clears to `null` in `finally`      | Write                                                |

**The core problem:** `_findAndUpdateToolPart` uses **reference identity** (`message === this._streamingMessage`) to decide whether to mutate parts in place vs. spread-copy. If `_streamingMessage` were a `StreamAccumulator`, you'd need to replace this identity check with something else (e.g., a boolean `isStreamingBuffer`, or comparing against the accumulator instance).

**Possible approaches:**

1. **Shared parts array.** Make `StreamAccumulator` accept an external `parts` array in its constructor (by reference, not copy). The accumulator and the `ChatMessage` share the same array. `applyChunk` mutates the shared array. `_streamingMessage` continues to point to the `ChatMessage`. The accumulator is only used for metadata handling. **Downside:** Breaks the accumulator's current encapsulation (constructor copies parts).

2. **Accumulator as `_streamingMessage`.** Replace `_streamingMessage: ChatMessage | null` with `_streamingAccumulator: StreamAccumulator | null`. Refactor all consumers to use `_streamingAccumulator.parts` / `_streamingAccumulator.messageId` / `_streamingAccumulator.toMessage()`. The biggest change is `_findAndUpdateToolPart`'s identity check — replace with `message === _streamingAccumulator?.toMessage()` won't work (toMessage creates new objects). Use a flag instead. **Downside:** Touches 5+ methods.

3. **Leave as-is.** The metadata handling in `_streamSSEReply` is ~30 lines of switch/case that exactly matches the accumulator's behavior. The cost of duplication is low. **This is the current state.**

---

### Client state machine (future)

The client (`react.tsx` + `ws-chat-transport.ts`) tracks streaming state across multiple independent variables. Formalizing these into a state machine would prevent invalid combinations and make transitions explicit.

**Current state variables:**

| Variable                      | Location             | Role                                                     |
| ----------------------------- | -------------------- | -------------------------------------------------------- |
| `accumulatorRef`              | react.tsx            | Active `StreamAccumulator` for broadcast/resume streams  |
| `activeStreamIdRef`           | react.tsx            | Which stream ID the accumulator is bound to              |
| `isServerStreaming`           | react.tsx (useState) | True when a broadcast/resume stream is active            |
| `localRequestIdsRef`          | react.tsx            | Request IDs for this tab's transport sends               |
| `resumingToolContinuationRef` | react.tsx            | Re-entrancy guard for `resumeStream()` after tool output |
| `useChatHelpers.status`       | from useChat         | AI SDK lifecycle: submitted/streaming/ready/error        |
| `_resumeResolver`             | ws-chat-transport.ts | Pending resume handshake resolver                        |
| `_resumeNoneResolver`         | ws-chat-transport.ts | Pending "no stream" resolver                             |
| `_expectToolContinuation`     | ws-chat-transport.ts | Flag for tool continuation vs. normal resume             |
| `activeRequestIds`            | ws-chat-transport.ts | Set shared with `localRequestIdsRef`                     |

**Conceptual states (not formalized, cross-cuts multiple variables):**

| State                   | What's active                                      | How it's detected                                                         |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| **Idle**                | Nothing streaming                                  | `status !== "streaming"` and `!isServerStreaming`                         |
| **Local streaming**     | User submitted; transport feeds chunks to useChat  | `status === "streaming"`, request ID in `localRequestIdsRef`              |
| **Observing broadcast** | Another tab streaming; accumulator builds message  | `isServerStreaming`, `accumulatorRef` set, ID not in `localRequestIdsRef` |
| **Resuming**            | Transport's `reconnectToStream` pending            | `_resumeResolver` set, `isAwaitingResume()` true                          |
| **Tool continuation**   | `expectToolContinuation()` called; deferred stream | `_expectToolContinuation` true, `resumingToolContinuationRef` true        |
| **Waiting for tool**    | Tool UI shown, no streaming                        | `pendingConfirmations` non-empty or `hasPendingInteraction` server-side   |

**Transitions that are error-prone without a machine:**

- Resume arrives while already observing a broadcast → must not create duplicate accumulator
- Tool continuation starts while resume is pending → `clearHandshakeResolvers` in transport
- Agent switch (new `useAgent` return) while streaming → must clean up old accumulator/refs
- `CF_AGENT_CHAT_CLEAR` during any streaming state → must reset everything

**Suggested approach:** A discriminated union for client stream state:

```typescript
type ClientStreamState =
  | { status: "idle" }
  | { status: "localStreaming"; requestId: string }
  | { status: "observing"; streamId: string; accumulator: StreamAccumulator }
  | { status: "resuming"; streamId: string }
  | { status: "toolContinuation"; requestId: string };

function transition(
  state: ClientStreamState,
  event: ClientStreamEvent
): ClientStreamState;
```

This would replace `accumulatorRef`, `activeStreamIdRef`, `isServerStreaming`, and `resumingToolContinuationRef` with a single ref holding the discriminated union. The transport's resume state (`_resumeResolver`, `_resumeNoneResolver`, `_expectToolContinuation`) would remain in the transport class but the client would drive transitions.

## History

- This design doc was created alongside the initial shared layer extraction.
- No prior RFCs — the extraction was motivated by Think's fork of `message-builder.ts` and the growing complexity of `ai-chat/src/index.ts`.
