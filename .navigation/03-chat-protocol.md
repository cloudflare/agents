# 03 — Chat Protocol Internals

This section covers the low-level machinery that makes streaming AI chat work: the wire protocol, how stream chunks are reassembled into messages, concurrency control for overlapping requests, and resumable streams for reconnection.

Read this before diving into `AIChatAgent` or `Think` — both build directly on these primitives.

All code lives in `packages/agents/src/chat/`.

---

## Wire protocol constants

[`CHAT_MESSAGE_TYPES` object in `protocol.ts`](../packages/agents/src/chat/protocol.ts#L1-L21) — the string keys for every WebSocket message type in the chat protocol:

- `CHAT_MESSAGES` — server pushes updated message array to client
- `USE_CHAT_REQUEST` / `USE_CHAT_RESPONSE` — a submit/stream round trip
- `CHAT_CLEAR` — client requests all history to be cleared
- `CHAT_REQUEST_CANCEL` — client cancels an in-flight request
- `TOOL_RESULT` / `TOOL_APPROVAL` — client-side tool execution results
- `MESSAGE_UPDATED` — server notifies a specific message was updated
- `STREAM_RESUME_REQUEST` / `STREAM_RESUME_ACK` / `STREAM_RESUME_NONE` — reconnection handshake

[`parseProtocolMessage()` in `parse-protocol.ts`](../packages/agents/src/chat/parse-protocol.ts#L67-L133) — parses the raw JSON from a WebSocket message into a typed discriminated union (`ChatProtocolEvent`). Every incoming message flows through this before any business logic runs.

---

## Public lifecycle types (`lifecycle.ts`)

[`ChatResponseResult`](../packages/agents/src/chat/lifecycle.ts#L23-L34) — returned when a chat turn completes. Carries the final assistant message, the request ID, whether this turn was itself a continuation of the previous assistant turn, and the turn's terminal status (`completed`, `error`, or `aborted`).

[`MessageConcurrency`](../packages/agents/src/chat/lifecycle.ts#L143-L148) — the strategy for handling overlapping submits: `"queue"` (serialise), `"latest"` (drop older in-flight), `"merge"` (coalesce), `"drop"` (ignore new while busy), or `{strategy: "debounce", debounceMs?}`.

[`ChatRecoveryContext`](../packages/agents/src/chat/lifecycle.ts#L88-L111) — the context object passed to the `onChatRecovery` lifecycle hook when an interrupted stream is detected after a Durable Object restart. Contains the partial text and parts reconstructed from stored chunks, the stream and request IDs, current persisted messages, and the timestamp the fiber started (useful for suppressing stale replays).

[`SaveMessagesOptions` and `SaveMessagesResult`](../packages/agents/src/chat/lifecycle.ts#L40-L82) — the API for the `saveMessages()` hook (implemented by `AIChatAgent` subclasses). The `signal` field is an external `AbortSignal` you can wire to your own cancellation logic.

---

## Stream chunk processing

The AI SDK delivers a stream of *chunks* (typed payloads like `text-start`, `tool-input-delta`, `tool-output-available`, etc.). The chat layer reassembles these into `UIMessage` objects that the client renders.

[applyChunkToParts() — text, reasoning, and file chunk handling](../packages/agents/src/chat/message-builder.ts#L78-L250) and [applyChunkToParts() — tool input/output chunks and step-start handling](../packages/agents/src/chat/message-builder.ts#L250-L400) — handles every possible chunk type. Returns `true` if the chunk was consumed. Called once per chunk; the caller maintains the accumulating parts array. This is the most detailed file if you want to understand the full streaming message format.

[`StreamAccumulator` class in `stream-accumulator.ts`](../packages/agents/src/chat/stream-accumulator.ts#L59-L232) — a stateful wrapper around `applyChunkToParts()`. Call `applyChunk()` per chunk; call `toMessage()` to get a snapshot. Also emits `ChunkAction` signals (e.g. `tool-approval-request`, `message-metadata`) so the layer above can react to notable events without parsing every chunk itself.

[`ChunkAction` types](../packages/agents/src/chat/stream-accumulator.ts#L31-L52) — the set of signals that `StreamAccumulator` can emit: `start`, `finish`, `tool-approval-request`, `cross-message-tool-update`, `error`, `message-metadata`.

---

## Message persistence and hygiene

[`sanitizeMessage()` in `sanitize.ts`](../packages/agents/src/chat/sanitize.ts#L29-L76) — strips ephemeral OpenAI provider metadata (`itemId` and `reasoningEncryptedContent`) from part metadata, and filters out reasoning parts that have no text and no remaining provider metadata. Always called before persistence.

[`enforceRowSizeLimit()` in `sanitize.ts`](../packages/agents/src/chat/sanitize.ts#L76-L185) — compacts tool outputs and truncates text to keep rows under 1.8 MB (`ROW_MAX_BYTES = 1_800_000`). Cloudflare's SQLite has row size limits, and very long tool outputs can blow past them. The algorithm prioritises preserving assistant text at the expense of tool output fidelity.

[`truncateToolOutput()` in `tool-output-truncation.ts`](../packages/agents/src/chat/tool-output-truncation.ts#L11-L221) — recursively truncates deeply-nested objects and long strings to a caller-supplied `maxChars` budget. Depth limit is 8 levels (`DEFAULT_MAX_DEPTH`); arrays and objects distribute the budget across children and pop excess elements when still over budget; strings are sliced with a `... [truncated N chars]` suffix. Adds a `__truncated` sentinel flag so the LLM knows data was dropped.

[`reconcileMessages()` in `message-reconciler.ts`](../packages/agents/src/chat/message-reconciler.ts#L26-L210) — a three-pass algorithm that merges the client's view of the message list with the server's authoritative state. Pass 1: merge server-known tool outputs into stale client parts. Pass 2: reconcile IDs (exact match → content-key hash → toolCallId). Pass 3: deduplicate by toolCallId. The `assistantContentKey()` helper hashes the content for identity checks.

---

## Resumable streams (`resumable-stream.ts`)

When a client disconnects mid-stream, it should be able to reconnect and receive the chunks it missed.

[ResumableStream — SQLite schema, start(), storeChunk(), and flush logic](../packages/agents/src/chat/resumable-stream.ts#L79-L300) and [ResumableStream — replay(), replayChunks(), and reconnection handoff](../packages/agents/src/chat/resumable-stream.ts#L300-L450) and [ResumableStream — restore(), clearAll(), destroy(), and lazy cleanup](../packages/agents/src/chat/resumable-stream.ts#L450-L591) — buffers stream chunks to a SQLite table (`cf_ai_chat_stream_chunks`) keyed by `stream_id`. When a client reconnects with `Last-Event-ID`, `replay()` re-sends the stored chunks, then hands off to the live stream.

[`start()`, `storeChunk()`, `complete()`](../packages/agents/src/chat/resumable-stream.ts#L156-L250) — the lifecycle. Chunks are batched in memory up to `CHUNK_BUFFER_SIZE = 10` then flushed to SQLite. Old streams are pruned after 24 hours (`CLEANUP_AGE_THRESHOLD_MS`).

---

## Concurrency control

### TurnQueue

[`TurnQueue` class in `turn-queue.ts`](../packages/agents/src/chat/turn-queue.ts#L27-L117) — serialises async work with generation-based invalidation. Each enqueued item carries a generation number; if the generation is stale by the time the item runs, the result is discarded. This is what prevents a slow AI response from overwriting a newer one that arrived while it was computing.

[`enqueue()` method](../packages/agents/src/chat/turn-queue.ts#L45-L80) — add work to the queue.

[`reset()`](../packages/agents/src/chat/turn-queue.ts#L86-L88) — increments the generation, invalidating anything currently in flight.

### SubmitConcurrencyController

[`SubmitConcurrencyController` class in `submit-concurrency.ts`](../packages/agents/src/chat/submit-concurrency.ts#L20-L188) — decides what to do when the user submits a new message while the previous turn is still running.

[`decide()` method](../packages/agents/src/chat/submit-concurrency.ts#L38-L92) — returns an action (`"execute"` or `"drop"`) and the concurrency strategy that applies. Implements all five strategies: `queue`, `latest`, `merge`, `drop`, `debounce`. The debounce strategy uses a trailing-edge timer; `waitForTimestamp()` is used to implement the delay.

---

## Broadcast state machine (`broadcast-state.ts`)

When multiple browser tabs are connected to the same agent, they all receive the same stream. This module handles the state machine for a *secondary* tab that is observing a stream started by the *primary* tab.

[`transition()` pure function](../packages/agents/src/chat/broadcast-state.ts#L63-L153) — takes the current state and an event, returns the next state. Events: `response` (stream started or continued), `resume-fallback` (stream already done, load from history), `clear` (messages cleared). Manages a `StreamAccumulator` for the duration of observation.

---

## Continuation state (`continuation-state.ts`)

When a tool call returns, the agent often needs to re-run the model with the tool result. This is the "continuation" — a follow-up turn triggered automatically.

[`ContinuationState` class](../packages/agents/src/chat/continuation-state.ts#L69-L161) — tracks whether a continuation is `pending` (ready to run), `deferred` (waiting for the active turn to finish), or absent. 

[`activatePending()` and `activateDeferred()`](../packages/agents/src/chat/continuation-state.ts#L123-L160) — the state transitions that kick off the follow-up turn.

---

## Tool state helpers (`tool-state.ts`)

[`applyToolUpdate()` in `tool-state.ts`](../packages/agents/src/chat/tool-state.ts#L25-L43) — finds a specific tool part by `toolCallId` in a set of messages and applies a state mutation. Used to update a tool's status (e.g. from `input-available` to `output-available`) without rebuilding the whole message array.

[`toolResultUpdate()` and `toolApprovalUpdate()`](../packages/agents/src/chat/tool-state.ts#L51-L98) — builders that produce the right chunk structure for a tool result or approval response respectively.

---

## AbortRegistry (`abort-registry.ts`)

[`AbortRegistry` class](../packages/agents/src/chat/abort-registry.ts#L11-L118) — maps request IDs to `AbortController` instances. When the client sends a cancel message, `cancel(id)` fires the signal. `linkExternal()` links a parent `AbortSignal` (e.g. from a sub-agent) to a child controller, so cancellation propagates across boundaries.

---

## Client tool schemas (`client-tools.ts`)

[`createToolsFromClientSchemas()`](../packages/agents/src/chat/client-tools.ts#L37-L63) — converts a list of `ClientToolSchema` (name + JSON Schema) received from the client into AI SDK `tool()` objects with no `execute` function. When the LLM calls one of these, the call is forwarded back to the browser for execution there. This enables client-side tools like file pickers or UI interactions.

---

## Recovery (`recovery.ts`)

[`createChatFiberSnapshot()` and `unwrapChatFiberSnapshot()`](../packages/agents/src/chat/recovery.ts#L17-L96) — serialize the in-progress state of a chat turn (which request was running, what the last persisted message was) so that if the Durable Object hibernates mid-stream, the turn can be resumed on wakeup.

---

## Module index (`chat/index.ts`)

[`chat/index.ts` re-exports](../packages/agents/src/chat/index.ts#L1-L94) — the public surface of the chat module. Everything used by `AIChatAgent` and `Think` is imported from this file rather than from the individual files above. If you're navigating imports, this is the canonical import point.

---

## Agent tool run state (`agent-tools.ts` in chat/)

[`AgentToolEventState` and `applyAgentToolEvent()`](../packages/agents/src/chat/agent-tools.ts#L1-L139) — a reducer over `AgentToolEvent` messages that tracks the status of nested sub-agent tool calls. `AgentToolEventState` has three views: `runsById` (all runs), `runsByToolCallId` (grouped by parent tool call), and `unboundRuns` (sorted list for display). The `AgentToolRunState` type records the run ID, agent type, input preview, status, and streaming parts. The UI uses this to show live progress of multi-step tool chains.

## Client tools (`client-tools.ts` in chat/)

[`createToolsFromClientSchemas()` and `ClientToolSchema`](../packages/agents/src/chat/client-tools.ts#L1-L63) — the full file. `ClientToolSchema` is the wire-format schema declaration (name + JSON Schema description) sent by the browser. `createToolsFromClientSchemas()` converts these into AI SDK `Tool` objects with no `execute` function, which causes the AI SDK to include the tool call in the response without executing it — the agent then sends the call back to the client.
