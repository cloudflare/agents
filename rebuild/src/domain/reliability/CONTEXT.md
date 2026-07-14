# Reliability

Making turns survive eviction, stalls, context overflow, and untrusted callers.
Three sub-areas: chat recovery + overflow (`recovery/`), the durable submissions
ledger (`submissions/`), and declared scheduled tasks (`scheduled-tasks/`). See the
[context map](../../../CONTEXT-MAP.md).

## Recovery & overflow

**ChatRecovery**:
The engine that wraps a recoverable turn in a fiber and, on fiber recovery, decides
whether to skip, retry, continue, or exhaust it. It owns the continue/terminalize
semantics.
_Avoid_: fiber recovery (Durable Runtime) — this is the chat-level policy built on it.

**Incident**:
The record tracking one interrupted turn across attempts: `{ incidentId, requestId,
attempt, maxAttempts, recoveryKind }`.

**Recovery kind**:
The chosen strategy: `retry` (no assistant output yet — replay the turn) or
`continue` (partial output persisted — resume from it).

**Exhaustion**:
Reaching `maxAttempts`: the configured terminal message is shown as the assistant
outcome and `chat:recovery:exhausted` is emitted.

**Terminal message**:
The assistant message shown when recovery is exhausted, so the user never sees a raw
stall/eviction error.

**Recovering status**:
The flag set between a scheduled recovery attempt and its terminal outcome (broadcast
as a `recovering:changed` event, replayed to connecting clients).

**OverflowGuard**:
The opt-in component that reuses session compaction to handle context overflow both
reactively (on a turn error classified as overflow) and proactively (mid-turn when
reported input tokens near the window).

**Chat error classification**:
The category a chat error maps to: `context_overflow`, `rate_limit`, `transient`,
`fatal`, or `unknown`.

## Submissions

**Submission**:
A durably recorded turn-acceptance created *before* any inference runs, so a
webhook/RPC caller gets a durable record even if it times out.
_Avoid_: request

**Submission status**:
`pending` -> `running` -> `completed` | `aborted` | `skipped` | `error`.
_Avoid_: `skipped` = the conversation was cleared before the submission ran.

**Idempotency key (submission)**:
A caller-supplied token identifying a turn; a repeat returns the existing record with
`accepted: false`.
_Avoid_: conflating with the Actions ledger key or a scheduled-task occurrence key —
same phrase, different identity.

**FIFO isolation**:
Submitted messages are appended to the session only when that submission's own turn
starts — so later submissions are invisible to earlier turns.

**Drain**:
The re-entrant-safe pass that claims the oldest pending submission, promotes it to
running, and runs it through the TurnQueue, repeating until none remain.

## Scheduled tasks

**Declared task**:
A code-declared recurring unit (`schedule`, timezone, retry) with exactly one of a
`prompt` or a `handler`.

**Occurrence**:
A single scheduled firing of a task, identified by `occurrenceKey` = `taskId:scheduledFor`.

**Reconciliation**:
The idempotent startup/on-demand process that diffs declared tasks against stored
rows and inserts/arms/cancels/repairs schedules.
_Avoid_: recovery/reconciliation of *Delegation* runs — unrelated.

**At-least-once delivery**:
The occurrence delivery guarantee; deduplication happens at the submission ledger.
