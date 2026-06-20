# Chat Shared Layer

Shared streaming, persistence, and protocol primitives for the `cf_agent_chat_*` WebSocket protocol. Lives in `packages/agents/src/chat/` and is consumed by both `@cloudflare/ai-chat` (the stable chat agent) and `@cloudflare/think` (the opinionated assistant base class).

## Problem

`@cloudflare/ai-chat` and `@cloudflare/think` both implement the same WebSocket chat protocol and share fundamental streaming/persistence concerns, but they live in separate packages with no shared code path. Think was forced to **fork** `message-builder.ts` (with a drift warning comment) and reimplement sanitization because `agents` — the only package both depend on — didn't have these primitives.

This led to:

- **Duplicated chunk-to-message logic** (`applyChunkToParts`) across two packages, with a comment warning about drift risk
- **Duplicated sanitization** (OpenAI metadata stripping, row-size enforcement) with subtle behavioral differences
- **Duplicated wire protocol constants** (`MSG_CHAT_*` strings matching `MessageType` values)
- **Duplicated metadata handling** (the `start`/`finish`/`message-metadata` switch that `applyChunkToParts` doesn't cover) in three separate code paths: ai-chat server, ai-chat client, and Think server

On the ai-chat side, `index.ts` and `react.tsx` already mixed too many concerns together — streaming, reconciliation, persistence, broadcasting, turn management — making the code difficult to modify and reason about, and both have only grown since (today ~6.1k and ~2.5k lines respectively, with durable chat-recovery layered on).

## Architecture

```
packages/agents/src/chat/          ← shared foundation
  index.ts                         barrel exports
  message-builder.ts               applyChunkToParts, getPartialStreamText + types
  sanitize.ts                      sanitizeMessage, enforceRowSizeLimit
  tool-output-truncation.ts        provider-executed tool payload truncation
  stream-accumulator.ts            StreamAccumulator class
  turn-queue.ts                    TurnQueue class
  submit-concurrency.ts            SubmitConcurrencyController
  broadcast-state.ts               broadcastTransition state machine
  continuation-state.ts            ContinuationState
  abort-registry.ts                AbortRegistry
  resumable-stream.ts              ResumableStream (SQLite chunk buffer)
  sql-batch.ts                     bound-param batching for IN-clause deletes
  connection.ts                    sendIfOpen WS send guard
  client-tools.ts                  ClientToolSchema, createToolsFromClientSchemas
  protocol.ts                      CHAT_MESSAGE_TYPES constants (chat + resume + tool)
  parse-protocol.ts                parseProtocolMessage
  tool-state.ts                    tool-part update / interaction helpers
  agent-tools.ts                   agent-tool-as-child event state
  message-reconciler.ts            reconcileMessages, resolveToolMergeId, reconcileOrphanPartial, assistantContentKey
  orphan-store.ts                  OrphanPersistStore interface
  lifecycle.ts                     shared lifecycle / result / config types

  # @internal chat-recovery engine — shared by ai-chat, think, and the
  # experimental tanstack-recovery / pi-recovery adapters
  recovery.ts                      chat-fiber snapshot codec
  recovery-incident.ts             incident budget math + storage helpers
  recovery-engine.ts               ChatRecoveryEngine + adapter / wake-hook seams
  recovery-codec.ts                ChatRecoveryCodec (AISDKRecoveryCodec)
  resume-handshake.ts              ResumeHandshake stream-resume driver
  stall-watchdog.ts                iterateWithStallWatchdog

packages/ai-chat/src/              ← stable chat agent + client
  index.ts                         AIChatAgent (uses shared imports)
  react.tsx                        useAgentChat (uses broadcastTransition)
  ws-chat-transport.ts             WebSocket transport for AI SDK
  types.ts                         MessageType enum, wire protocol types

packages/think/src/                ← opinionated assistant
  think.ts                         Think (uses shared imports)
  extensions/                      ExtensionManager, HostBridgeLoopback (standalone)
```

**Dependency direction**: `ai-chat → agents`, `think → agents`. The shared layer resolves the circular dependency that caused the original fork.

## Modules

### message-builder.ts

**`applyChunkToParts(parts, chunk) → boolean`** — the core chunk-to-message-part builder. Mutates a `UIMessage["parts"]` array in place for streaming performance. Returns `true` if the chunk type was recognized, `false` for types the caller must handle (`start`, `finish`, `message-metadata`, `error`, `finish-step`).

This is the single most shared piece of code in the chat system. Used by:

- `AIChatAgent._streamSSEReply` — server-side SSE parsing
- `StreamAccumulator.applyChunk` — the higher-level wrapper (which is how
  `AIChatAgent._persistOrphanedStream` and Think now rebuild orphaned partials —
  the orphan path no longer calls `applyChunkToParts` directly)
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
- **Think server**: Uses `StreamAccumulator` in both `_streamResult` (WebSocket path) and `chat()` (RPC sub-agent path), and to rebuild orphaned partials in `_persistOrphanedStream`.
- **ai-chat server**: `_persistOrphanedStream` rebuilds orphaned partials through `StreamAccumulator` (the orphan-persist (a) step — see [recovery-engine.ts](#recovery-enginets)). The live streaming path (`_streamSSEReply`) **still** uses `applyChunkToParts` directly: its streaming message (`_streamingMessage`) is shared by reference with `hasPendingInteraction`, `_messagesForClientSync`, and `_findAndUpdateToolPart`, making it impractical to route through the accumulator without a deeper refactoring of the shared mutable state (see "Server-side StreamAccumulator (deferred)").

### protocol.ts

**`CHAT_MESSAGE_TYPES`** — plain string constants for the wire protocol message types. Used by Think to avoid depending on `@cloudflare/ai-chat/types` (which would create a dependency edge Think shouldn't have). The values match `MessageType` in `ai-chat/src/types.ts`.

### message-reconciler.ts

Pure functions for aligning client messages with server state during persistence. Both `@cloudflare/ai-chat` and `@cloudflare/think` consume `reconcileMessages` and `resolveToolMergeId`: a client can post an optimistically-minted assistant snapshot (e.g. while a prior tool call is still streaming), so reconciling it against the server's current path maps client IDs onto server IDs and lets stale client tool states pick up the server's outputs — without it, an INSERT-OR-IGNORE-by-ID persist would write a duplicate orphan assistant row.

**`reconcileMessages(incoming, serverMessages, sanitize?)`** — two-stage pipeline:

1. **Tool output merge**: When the server has `output-available` for a tool that the client still shows as `input-available`, `approval-requested`, or `approval-responded`, adopt the server's output. This handles the case where the client sends stale tool states.

2. **ID reconciliation** (two-pass):
   - Pass 1: Exact ID matches between incoming and server, claiming server indices
   - Pass 2: Content-key matching for non-tool assistant messages using JSON-serialized sanitized parts. Prevents duplicate rows when the AI SDK assigns a different local ID than the server.

**`resolveToolMergeId(message, serverMessages)`** — per-message ID resolution by `toolCallId`. If a tool call ID exists in a server message with a different ID, adopt the server's ID. Called during persistence to prevent duplicate rows.

`reconcileMessages` and `resolveToolMergeId` are shared — both hosts call them (`Think._handleChatRequest` reconciles incoming messages; `Think._persistIncomingMessage` resolves assistant tool-merge IDs). The module also exports **`reconcileOrphanPartial(existing, incoming)`** — the orphan-persist **(c)** merge primitive (shared; ai-chat is the only consumer today). It is described with the rest of the orphan path in [recovery-engine.ts](#recovery-enginets).

### recovery-engine.ts

**`ChatRecoveryEngine`** owns the **shared durable chat-recovery orchestration** — the sequence both `AIChatAgent` and `Think` run when a Durable Object wakes and finds an interrupted chat turn (a `runFiber` that died mid-stream from hibernation, process death, or deploy churn). This state machine was previously duplicated across both packages, and the duplication was already drifting (better fixes landing in one but not the other).

**Two host-supplied seams:**

- **`ChatRecoveryAdapter`** — the incident/budget I/O the engine drives (read/write/sweep incidents, read progress, emit lifecycle events, resolve the recovery stream, give-up/exhaust). Stable across a session.
- **`ChatFiberWakeHooks<TClassify>`** — the per-wake "divergent organs": classify the turn (`retry`/`continue`), unwrap the fiber snapshot, the base persist gate, `persistOrphanedStream`, `completeRecoveredStream`, and the retry/continue/skip dispatch. Passed per `handleChatFiberRecovery` call so the adapter stays focused.

**The engine owns the lifecycle and its ordering invariants**: non-chat-fiber dispatch first → chat-fiber name gate → parse request id / unwrap snapshot / resolve stream / reconstruct partial → classify → open incident → **if the budget is exhausted**, persist the settled partial _before_ sealing (so non-idempotent tool results aren't discarded, #1631) and terminalize → **else** (inside a `failed`-on-throw guard) invoke `onChatRecovery`, apply the shared persist gate (`persist !== false || hasSettledToolResults`), complete the live stream, then hand the decision to `dispatchRecoveredTurn`. The budget math is the pure `evaluateChatRecoveryIncident`. `experimental/pi-recovery` is a third adapter implementation driving a **non-AI-SDK codec** — the forcing function that keeps the engine host-agnostic.

**Orphan-persist seams** (`persistOrphanedStream`'s internals). The engine owns _whether_ to persist; the host owns _how_, in four steps:

| Step                     | Shared?          | What                                                         |
| ------------------------ | ---------------- | ------------------------------------------------------------ |
| (a) chunks → parts       | shared           | rebuild via `StreamAccumulator` (idempotent by `toolCallId`) |
| (b) target-id resolution | host hook        | which message id to write under                              |
| (c) merge onto existing  | shared primitive | `reconcileOrphanPartial`                                     |
| (d) upsert by id         | host store       | a `SessionProvider`-subset write                             |

(b) is the one legitimately per-package step: ai-chat reads the stored stream `message_id` (#1691) because a flat `UIMessage[]` can't express parent/child (`AIChatAgent._resolveOrphanTargetId`); Think resolves it structurally from its Session tree. (c) `reconcileOrphanPartial` keeps an existing in-place tool result that lives only in storage — ai-chat's early tool-approval persist — rather than letting a replayed chunk re-advance it; Think has no early persist, so its whole-message replace is already dedup-safe and it doesn't use the helper. (d) is recognizably the same shape on both: ai-chat does `findIndex` → map-replace / append over its flat array; `Think._upsertMessageInHistory` does `session.getMessage` → `updateMessage` / `appendMessage` over a Session tree.

Full design + point-in-time decision record: [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md).

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

### Why reconciliation is shared

Both hosts face client/server ID mismatch, so the pure reconciler functions live in `agents/chat` and both consume them:

- **`AIChatAgent`** must accept whatever IDs the AI SDK generates on the client side, and the `useChat` hook's internal state management can produce ID mismatches during streaming, tool interactions, and page refreshes.
- **`Think`** persists through Session (`INSERT OR IGNORE`-by-ID for user messages, upsert for assistant), which is idempotent by ID — but a client can still post an optimistically-minted assistant snapshot mid-turn. Reconciling it against the server's active path maps the client ID onto the server's and prevents a duplicate orphan assistant row.

### Why `StreamChunkData.messageMetadata` is `unknown`

The AI SDK's `UIMessageChunk` types `messageMetadata` as `unknown`. If `StreamChunkData` used `Record<string, unknown>`, passing a `UIMessageChunk` directly to `applyChunkToParts` would fail type checking. The accumulator uses an `asMetadata()` helper to safely narrow `unknown` to `Record<string, unknown>` at runtime.

## Tradeoffs

**Shared `enforceRowSizeLimit` lacks ai-chat's observability features.** The shared version doesn't add `metadata.compactedToolOutputs` or `console.warn` on compaction. Think gets the simpler version; ai-chat wraps it with its own enhanced version. If Think ever needs compaction observability, the shared function could accept an options bag.

**The accumulator creates a new message on every `toMessage()` / `mergeInto()` call.** This is intentional for immutability (React needs new references for re-renders), but it means the server can't use `toMessage()` for its shared `_streamingMessage` reference without breaking identity.

**Wire protocol constants are duplicated between `CHAT_MESSAGE_TYPES` and `MessageType`.** The values are identical strings but live in two places. `MessageType` is `@cloudflare/ai-chat`'s published enum; `CHAT_MESSAGE_TYPES` is `agents`'s internal constants. Drift is the operational risk. A future consolidation could move the canonical values to `agents/chat` and have `ai-chat` re-export them, but that requires `ai-chat` to depend on the specific export path — a semver-sensitive change.

## What's next

### TurnQueue (done)

`TurnQueue` — a serial async queue with generation-based invalidation — now lives in `agents/chat/turn-queue.ts`. It handles:

- Promise-chain serialization (FIFO)
- Generation counter with `reset()` (maps to ai-chat's epoch and Think's former `_clearGeneration`)
- Auto-skip of stale entries (generation mismatch at the front of the queue)
- Active request tracking (`activeRequestId`, `isActive`)
- `waitForIdle()` — resolves when the queue is fully drained
- Per-generation queued counts (`queuedCount()`)

```typescript
class TurnQueue {
  get generation(): number;
  get activeRequestId(): string | null;
  get isActive(): boolean;
  enqueue<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: EnqueueOptions
  ): Promise<TurnResult<T>>;
  reset(): void;
  waitForIdle(): Promise<void>;
  queuedCount(generation?: number): number;
}
```

**AIChatAgent** uses it through `_runExclusiveChatTurn`, which wraps `_turnQueue.enqueue()` with the `onChatResponse` drain and merge-map cleanup. Concurrency policies (drop/latest/merge/debounce) remain in AIChatAgent — they operate on message-specific state the queue doesn't know about. The `onStale` callback on `_runExclusiveChatTurn` lets the WS submit call site send a `done:true` response for turns skipped by auto-skip.

**Think** wraps both `chat()` and `_handleChatRequest` in `_turnQueue.enqueue()`, giving it proper turn serialization (previously concurrent calls could interleave on `this.messages`). `_clearGeneration` was replaced by `_turnQueue.generation`.

**Fields moved from AIChatAgent to TurnQueue:** `_chatTurnQueue`, `_activeChatTurnRequestId`, `_chatEpoch`, `_queuedChatTurnCountsByEpoch`.

**Fields that stayed in AIChatAgent:** `_mergeQueuedUserStartIndexByEpoch`, `_submitSequence` / `_latestOverlappingSubmitSequence`, `_activeDebounceTimer` / `_activeDebounceResolve`, `_pendingChatResponseResults` / `_insideResponseHook`, `_pendingInteractionPromise`.

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

### Broadcast stream state machine (done)

`broadcastTransition` — a pure state machine for the accumulator-based broadcast/resume path — now lives in `agents/chat/broadcast-state.ts`. It manages the `StreamAccumulator` lifecycle that `useAgentChat`'s `onAgentMessage` handler previously tracked through scattered refs (`accumulatorRef`, `activeStreamIdRef`).

```typescript
type BroadcastStreamState =
  | { status: "idle" }
  | { status: "observing"; streamId: string; accumulator: StreamAccumulator };

type BroadcastStreamEvent =
  | {
      type: "response";
      streamId: string;
      messageId: string;
      chunkData?: unknown;
      done?: boolean;
      error?: boolean;
      replay?: boolean;
      replayComplete?: boolean;
      continuation?: boolean;
      currentMessages?: UIMessage[];
    }
  | { type: "resume-fallback"; streamId: string; messageId: string }
  | { type: "clear" };

function transition(
  state: BroadcastStreamState,
  event: BroadcastStreamEvent
): TransitionResult;
```

The machine handles accumulator creation (including continuation context walking), chunk application, replay suppression, done/error cleanup, and produces `messagesUpdate` closures for the caller to apply. Side effects (sending ACKs, calling `onData`, `setIsServerStreaming`) stay in the caller.

**Scope**: covers only the broadcast/resume accumulator path (path B). The transport-owned path (path A — local tab requests via `WebSocketChatTransport`) is managed by the AI SDK's `useChat` and doesn't go through the state machine. The transport's resume resolver state (`_resumeResolver`, `_resumeNoneResolver`, `_expectToolContinuation`) stays in `ws-chat-transport.ts`.

**What still uses independent variables**: `localRequestIdsRef` (path A vs B switch), `resumingToolContinuationRef` (tool continuation re-entrancy guard), `useChatHelpers.status` (AI SDK lifecycle), and the transport's resolver state. These cross-cut the broadcast/transport boundary and aren't part of the accumulator lifecycle.

## History

- This design doc was created alongside the initial shared layer extraction.
- No prior RFCs — the extraction was motivated by Think's fork of `message-builder.ts` and the growing complexity of `ai-chat/src/index.ts`.
- TurnQueue extracted to `agents/chat/turn-queue.ts`. AIChatAgent and Think both adopt it, unifying turn serialization and the epoch/clear-generation concept.
- Broadcast stream state machine extracted to `agents/chat/broadcast-state.ts`. `useAgentChat`'s `onAgentMessage` handler uses `broadcastTransition` instead of manual accumulator/ref management.
- Think stripped to minimal core: single-session inline storage, removed multi-session API, deleted `AgentChatTransport`, disconnected extensions from Think class. Session module and transport deleted.
- ResumableStream moved from ai-chat to `agents/chat/resumable-stream.ts`. Resume protocol constants (`STREAM_RESUMING`, `STREAM_RESUME_ACK`, `STREAM_RESUME_REQUEST`, `STREAM_RESUME_NONE`) added to `CHAT_MESSAGE_TYPES`. Think wired with full resume support.
- Client tool primitives (`ClientToolSchema`, `createToolsFromClientSchemas`) moved to `agents/chat/client-tools.ts`. Tool protocol constants (`TOOL_RESULT`, `TOOL_APPROVAL`, `MESSAGE_UPDATED`) added. Think implements client-side tools with debounce-based auto-continuation.
- Think now has: MCP `waitForMcpConnections`, message push on connect, feature parity with AIChatAgent's core chat experience.
- Durable chat-recovery orchestration unified in `agents/chat/recovery-engine.ts` (`ChatRecoveryEngine` over a `ChatRecoveryAdapter` + per-wake `ChatFiberWakeHooks`); `AIChatAgent`, `Think`, and the `experimental/pi-recovery` fixture all drive it. The orphan-persist path was factored into named seams — (a) shared `StreamAccumulator` reconstruction, (b) host `resolveOrphanTargetId`, (c) shared `reconcileOrphanPartial`, (d) `SessionProvider`-subset upsert. See [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md).
