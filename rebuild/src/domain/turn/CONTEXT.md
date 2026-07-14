# Turn

Running one model interaction, narrowly: the pure engine plus the admission queue
that serializes turns. The engine *consumes* assembled inputs (owned by
Conversation) and *emits* `UiChunk`s (also owned by Conversation); it neither
prepares nor persists them. See the [context map](../../../CONTEXT-MAP.md).

## Engine

**Turn**:
One end-to-end model interaction — one or more steps ending in a TurnOutcome.
_Avoid_: request, conversation round

**TurnEngine**:
The pure component that takes inputs, streams chunks, and returns a TurnOutcome
without touching storage.
_Avoid_: loop, runner

**Step**:
A single `model.stream()` call within a turn (one generation + any tool calls).
_Avoid_: iteration; a step *contains* one model call

**StepResult**:
The outcome of one step: text, reasoning, tool calls, tool results, finish reason,
usage.

**Trigger**:
What started a turn: websocket, chat, save, submission, continuation, or schedule.
_Avoid_: source, cause

## Configuration & hooks

**TurnConfig**:
Turn-scoped configuration: model, system prompt, messages, tools, activeTools,
toolChoice, maxSteps, stopWhen, sendReasoning, settings, stall timeout.
_Avoid_: turn options

**StepConfig**:
Per-step overrides returned by `beforeStep` (system, messages, activeTools,
toolChoice, model, settings).

**TurnContext**:
Descriptive context of a turn: requestId, trigger, continuation flag, channelId,
message history.

**TurnHooks**:
The turn lifecycle hooks: `beforeTurn`, `beforeStep`, `onStepFinish`, `onChunk`.
_Avoid_: callbacks

**maxSteps**:
The hard cap on steps per turn (default 10). `stopWhen` is composed with it, never
replaces it.

**stopWhen**:
A custom predicate that can end a turn early, composed with `maxSteps`.

## Outcome

**TurnOutcome**:
The terminal result of a turn: `completed`, `suspended`, `aborted`, or `error`.
_Avoid_: TurnResult

**Suspended**:
A turn paused because a client tool, an approval-gated tool, or a durable-pause is
pending; the outcome carries the pending calls.
_Avoid_: paused, blocked — always qualify against Fibers' `interrupted`.

**Abort**:
External `AbortSignal` cancellation of the model stream and tool executions,
yielding the `aborted` outcome; chunks so far remain valid.
_Avoid_: cancel (that's the queue-level API that leads to an abort)

**Stall watchdog**:
An inactivity timer spanning the gap between model chunks; when the configured
timeout elapses it aborts the turn with a StallError and emits `chat:stream:stalled`.
_Avoid_: idle timer, heartbeat

## Admission

**TurnQueue**:
The component ensuring exactly one turn runs at a time per agent; all entry points
funnel through it.
_Avoid_: turn scheduler

**Admission**:
The policy for entering the queue when busy: `queue` (FIFO wait), `replace` (abort
the running turn then run), or `reject` (fail fast).
_Avoid_: enqueue mode, priority

**Continuation**:
A follow-up turn enqueued by a turn (e.g. after tool results settle), admitted
normally without deadlock.
_Avoid_: confusing with Reliability's *recovery* continuation (resuming a partial
after an interruption) — different trigger, same word.

**Reentrancy**:
The property that a turn can enqueue a continuation from within itself without
deadlocking.
