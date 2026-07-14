# Conversation

What the conversation *is*, how it is persisted and shaped for the model, the
durable outbound event stream that describes it, and the per-turn lifecycle glue
run over it. This is the largest context; it spans `messages/`, `session/`,
`events/`, and `conversation/`. See the [context map](../../../CONTEXT-MAP.md).

## Messages & transcript

**ChatMessage**:
The canonical client/persistence message: an id, a role, and an ordered array of
message parts.
_Avoid_: UIMessage (the AI SDK name), message row

**MessagePart**:
A typed element within a ChatMessage: text, reasoning, file, or a ToolPart.
_Avoid_: part (loosely), content block

**ToolPart**:
A message part carrying a toolCallId, a lifecycle `state`, and input/output/error.
_Avoid_: tool invocation

**Tool-part state**:
The lifecycle position of a ToolPart: `input-streaming`, `input-available`,
`approval-requested`, `output-available`, `output-error`.

**ModelMessage**:
The provider-facing message shape (system/user/assistant/tool with typed content).
Reasoning parts are dropped when converting to it — the port is output-only for
reasoning (a known gap, tracked as ISSUE-001 in `ISSUES.md`).
_Avoid_: provider message

**Transcript**:
The linear ordered sequence of ChatMessages sent to the provider.
_Avoid_: history (the session's tree view) and conversation (the whole context) —
these are distinct.

**Transcript repair**:
Healing a transcript with unsettled tool parts before a provider call, producing a
RepairReport. The default repair flips an interrupted tool part to `output-error`.
_Avoid_: fixing messages

**Unsettled tool part**:
A ToolPart left mid-flight (`input-streaming`/`input-available`/`approval-requested`)
by an interrupted turn; would otherwise cause a provider 400.
_Avoid_: stuck tool

**MessageStore**:
The durable, ordered, upsert-by-id persistence of the conversation.

**Row-size enforcement**:
Compacting a message's largest tool outputs (replaced by a truncation marker) when
its serialized size exceeds the row limit; the message is never dropped.

## Session & prompt

**Session**:
Conversation semantics over the MessageStore: the history tree, context blocks,
system-prompt assembly, and compaction.

**Context block**:
A labeled unit injected into the system prompt, backed by a context provider that
supplies (and optionally mutates) its content.
_Avoid_: block (loosely)

**Context provider**:
The backing object for a context block; comes in read-only, writable, skill, and
search variants, each generating its own context tools.

**Frozen prompt**:
A system prompt rendered once and persisted so later turns reuse it (preserving the
provider's prefix cache); block writes do not refresh it.
_Avoid_: cached prompt (though the builder seam is `withCachedPrompt`)

**History tree**:
The tree-structured record of ChatMessages linked by `parentId`; `getHistory` walks
root to leaf.
_Avoid_: transcript (the linear provider-facing form)

**Compaction overlay**:
A non-destructive record that, at read time, replaces a message range with a
synthetic summary message; the originals stay in the store.
_Avoid_: summary (loosely)

**SessionBuilder**:
The fluent session configuration (`withContext`, `withCachedPrompt`, `onCompaction`,
`compactAfter`).

## Streaming

**UiChunk**:
The rebuild-owned unit of streamed UI update (start, text/reasoning delta, tool
input/approval/output, finish, error). Produced by Turn's engine; owned here because
its consumers (accumulator, event log) live here.
_Avoid_: stream part (the AI SDK term), frame; distinct from `ModelChunk`
(Infrastructure).

**StreamAccumulator**:
Folds a sequence of UiChunks back into an assistant ChatMessage, keyed by toolCallId,
snapshottable at any point (for persisting partials).
_Avoid_: chunk folder

## Outbound events

**ConversationEventLog**:
The durable, offset-addressed log of typed outbound events the app publishes; every
transport adapter subscribes. It absorbed the old resumable stream buffer's
retention/replay.
_Avoid_: bus (that's the kernel EventBus, a different thing); the Delegation *event
log* is a per-run parent-side log, not this.

**ConversationEvent**:
A typed entry in the log: `turn:started`, `chunk`, `message:updated`,
`conversation:cleared`, `state:changed`, `recovering:changed`, `session:status`,
`run:event`, `turn:settled`.

**relayTurn**:
The shared primitive that subscribes to the log and maps one turn's events onto a
callback (onStart/onEvent/onDone/onError/onInterrupted).
_Avoid_: conflating with Delegation's `ChildChatRelay`, which is built on it.

**Replay**:
Re-sending buffered log chunks to a reconnecting client from an offset (with a `gap`
full-resync fallback).
_Avoid_: the Actions sense of "replay" (returning a settled ledger output).

## Turn lifecycle glue

**ConversationTurnState**:
Durable per-turn bookkeeping: the last partial assistant message per requestId, the
last requestId, channel stamping, and committing an interrupted partial. (Its commit
path is a Reliability edge.)

**PendingInteractions**:
The client-tool / approval resolution loop: writes a resolved tool part back into the
persisted message, publishes `message:updated`, and decides (debounced) whether to
request a continuation.

**TurnAssembly**:
`assembleTurn` — shapes a turn's `{ system, tools }` from the frozen prompt + channel
instructions + skills catalog + capability block + merged tool sources.
_Avoid_: reading it as a Turn concern; it *shapes the conversation for the model*.
