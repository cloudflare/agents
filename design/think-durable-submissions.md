# Think Durable Submissions

Durable programmatic chat turns for `Think`, exposed through
`submitMessages()`.

**Status:** implemented.

Related:

- [think.md](./think.md) — overall Think architecture
- [sessions.md](./sessions.md) — Session-backed message storage
- [docs/think/programmatic-submissions.md](../docs/think/programmatic-submissions.md) — user-facing API guide
- [server-driven-messages.md](../docs/agents/server-driven-messages.md) — lighter-weight server message patterns
- [workflows.md](../docs/agents/workflows.md) — durable multi-step orchestration

## Problem

`saveMessages()` injects messages and waits for the model turn to finish. That
is convenient inside an agent, but it is a poor fit for external RPC callers:

1. The caller can time out before the model finishes.
2. After a timeout, the caller cannot tell whether the turn was accepted.
3. Retrying can duplicate user messages or run the same external job twice.

The missing primitive is durable acceptance: persist the intent to run a chat
turn, return quickly, and process the turn later through the normal Think chat
path.

## Goals

- Give RPC callers a durable `accepted` boundary before model execution.
- Preserve Think's existing Session, turn queue, streaming, cancellation, and
  chat recovery semantics.
- Make retries safe through caller-provided idempotency keys.
- Keep the API narrow enough that users can reason about it without learning
  workflows.

## Non-goals

- This does not replace `saveMessages()`. `saveMessages()` remains the direct,
  blocking helper for in-process work that wants the final result.
- This does not replace workflows. Workflows are still the right tool for
  multi-step business processes, long-running external side effects, and
  orchestration across agents or services.
- This does not store callbacks or closures. Durable submissions only accept a
  concrete `UIMessage[]`, because the work must be serializable before it runs.

## API Shape

The core API is:

```typescript
await this.submitMessages(messages, {
  submissionId,
  idempotencyKey,
  metadata
});
```

It returns a `SubmitMessagesResult` immediately after the submission row has
been persisted and the initial status hook has run. `accepted: true` means a new
submission was created. `accepted: false` means the call matched an existing
submission by `submissionId` or `idempotencyKey`.

`messages` must contain at least one `UIMessage`. Empty submissions are rejected
before any row is persisted; the API is for injecting concrete work, not for
nudging the model with the current session unchanged.

The companion APIs are:

- `inspectSubmission(submissionId)`
- `listSubmissions(options)`
- `cancelSubmission(submissionId, reason?)`
- `deleteSubmission(submissionId)`
- `deleteSubmissions(options)`
- `onSubmissionStatus(submission)` for subclass observability

Statuses are intentionally simple:

| Status      | Meaning                                        |
| ----------- | ---------------------------------------------- |
| `pending`   | Accepted and waiting for its turn              |
| `running`   | Claimed by the agent and executing             |
| `completed` | The Think turn completed successfully          |
| `aborted`   | The submission was cancelled                   |
| `skipped`   | Turn state was reset before the submission ran |
| `error`     | Execution failed or recovery was unsafe        |

There is no public `recovering` status. Chat recovery is an implementation
detail; externally the submission remains `running` until recovery reaches a
terminal outcome.

Allowed transitions:

| From      | To                            | Trigger                                                       |
| --------- | ----------------------------- | ------------------------------------------------------------- |
| none      | `pending`                     | `submitMessages()` accepts new work                           |
| any       | unchanged                     | idempotent retry returns existing row                         |
| `pending` | `running`                     | the inbox lane reaches the submission                         |
| `pending` | `aborted`                     | `cancelSubmission()` before execution                         |
| `pending` | `skipped`                     | `resetTurnState()` before execution                           |
| `running` | `running`                     | the next attempt after a reset, when no messages were applied |
| `running` | `completed`                   | Think turn completes successfully                             |
| `running` | `aborted`                     | durable cancellation aborts the active turn                   |
| `running` | `skipped`                     | `resetTurnState()` while it runs                              |
| `running` | `error`                       | execution failed, replay is unsafe, or recovery failed        |
| terminal  | terminal, no further mutation | late completion and recovery updates are ignored              |

## Durable State

A submission is a request on the [Inbox](./inbox.md) capability: kind
`submission`, one lane, in `cf_agents_inbox`. The inbox owns the record, the
order, idempotent lookups, cancel, reset, `wait()` and the replay after a
reset. Its payload is the sanitized messages. What the turn learns about
itself lives in the request's progress:

| Progress field      | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `requestId`         | The request id of the turn answering it; recovery moves it    |
| `streamId`          | The stream that answered it                                   |
| `messagesAppliedAt` | Set once its messages were appended to Session                |
| `resultStatus`      | The cutover outcome, written in the stream settle transaction |
| `output`            | The structured output stamped with a `completed` cutover      |
| `messageId`         | The assistant message its turn persisted                      |

A completed submission's inbox result is its structured output, which the
workflow notification carries. Objects written by an older release keep their
rows in `cf_think_submissions`; the first start moves them into the inbox in
creation order and drops the table.

`messagesAppliedAt` is the important internal safety marker. It is set only
after submitted messages have been appended to Session. Recovery uses it to
avoid unsafe replay:

- If a `running` submission has no applied messages, it runs again.
- If any submitted messages are already present in Session but
  `messagesAppliedAt` is missing, replay is unsafe and the submission becomes
  `error`.
- If `messagesAppliedAt` is present, the turn has crossed the boundary where
  chat recovery must either continue it or mark it `error`.

## Execution Flow

1. `submitMessages()` sanitizes the messages and submits an inbox request.
   The inbox writes the row, reports `pending` (Think emits
   `submission:create` and `submission:status`), and pushes its lane's wake
   due now. No model work starts inside the accepting invocation.
2. The lane's alarm runs the submission. Keeping execution inside that alarm
   invocation also gives tracing spans the correct lifecycle owner; no
   `invoke_agent` span crosses an invocation boundary.
3. `_runSubmission()` calls the same programmatic turn path used by
   `saveMessages()`, with the submission id as the request id.
4. `_runProgrammaticMessagesTurn()` appends submitted messages to Session,
   records `messagesAppliedAt`, broadcasts messages, and runs the normal Think
   inference and streaming path.
5. The handler returns the outcome, and the inbox ends the request only while
   it is still `running`, so late completions cannot overwrite cancellation or
   reset outcomes.
6. The terminal report queues the workflow notification, then runs
   `onSubmissionStatus`. The inbox repeats a terminal report a reset cut
   short, so `onSubmissionStatus` can run twice for one terminal status.
   The notification is queued once: the report records `workflowNotified`
   in the request's progress and a repeat skips it.

## Recovery Rules

An interrupted submission runs again at most three times in all (the inbox's
`maxAttempts`); the next interruption ends it `error` with `Interrupted 3
times`. Before the inbox, a submission sent back to `pending` was requeued
without a limit.

A submission whose turn chat recovery took over ends its run `detached`: it
stays `running`, frees the lane, and recovery settles it. On startup, and on
the next attempt of a run a reset interrupted, Think decides from the stored
evidence:

- A `completed` or `aborted` cutover stamp ends it that way.
- `messagesAppliedAt` missing and no submitted messages in Session: it runs
  again, after any chat recovery the reset left.
- `messagesAppliedAt` missing and some or all submitted messages in Session:
  `error`, because replay could duplicate or reorder messages.
- `messagesAppliedAt` present with fresh recoverable chat evidence, or with a
  scheduled recovered continuation: it stays `running` (`detached`); chat
  recovery owns the terminal outcome.
- A terminal stream for its request: `completed` or `error`.
- Otherwise: `error`, because the turn was interrupted after messages were
  applied and there is no safe recovery path.

Fresh recovery evidence comes from `runFiber` rows or active stream metadata.
The freshness window prevents old, abandoned evidence from keeping a submission
`running` forever. The default window is 15 minutes. Subclasses with legitimate
longer-running turns can override `protected static submissionRecoveryStaleMs`
instead of disabling the stale-evidence safety net entirely.

Failure boundaries:

| Failure point                                  | Recovery behavior                                           |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Before row insert                              | Caller does not receive `accepted: true`; retry may insert  |
| After row insert, before the lane wake         | The inbox wakes open lanes on start; a retry re-wakes it    |
| After claim, before Session append             | The next attempt runs it again                              |
| During Session append                          | Any detected applied message makes replay unsafe → `error`  |
| After Session append, before stream completion | Chat recovery continues, or row becomes `error` if unsafe   |
| During recovered continuation                  | Submission remains `running` until continuation is terminal |
| After cancellation/reset                       | Conditional terminal updates prevent late overwrite         |

## Reset and Cancellation

`resetTurnState()` invalidates queued and active turns. For durable submissions
it clears the inbox lane: every open submission ends `skipped` before reset
returns, so none can start after it. Status hook emission stays async, but the
SQLite state transition is part of reset itself.

`cancelSubmission()` marks `pending` or `running` submissions as `aborted`. If
the submission is currently executing, its request controller is aborted. If the
submission is in recovered continuation, the continuation gets its own linked
controller so durable cancellation still reaches the resumed turn.

All completion paths end the request through the inbox, which writes only
while it is `running`.
That invariant is what prevents late stream completion, recovery completion, or
error handling from overwriting `aborted` or `skipped`.

## Idempotency Semantics

`idempotencyKey` is a dedupe key, not a payload validator. If a retry uses the
same key with different messages, Think returns the existing submission and
does not replace its stored payload.

If both `submissionId` and `idempotencyKey` are provided, they must refer to the
same existing row. If they point at different submissions, Think rejects the
call instead of guessing which identity wins.

This matches the expected external-job pattern: callers should derive the key
from their own durable event id and treat the first accepted payload as the
canonical one.

## Observability

Think emits lifecycle events for durable submissions:

- `submission:create` when a new row is accepted
- `submission:status` whenever a status transition is emitted
- `submission:error` when a transition reaches `error`

Subclasses can also override `onSubmissionStatus(submission)`. The hook is
awaited via `keepAliveWhile()`, so acceptance and recovery paths do not drop the
status callback just because the Durable Object would otherwise go idle.

## Retention

Terminal rows are retained until the application deletes them. This is
deliberate: callers often need a durable status ledger after the original RPC
has returned.

Applications should periodically call `deleteSubmissions()` for terminal rows
they no longer need. Active rows are not deleted by the cleanup APIs.

## Why This Lives in Think

The durable submission API is chat-specific:

- It persists `UIMessage[]`.
- It appends to Think's Session store.
- It runs the Think turn queue and inference loop.
- It coordinates with Think chat recovery and stream metadata.

The base `Agent` already provides the lower-level durable primitives:
SQLite, schedules, `keepAliveWhile()`, abort registries, and `runFiber()`.
Putting this API in `Agent` would either make the base class know about chat or
force users to rebuild Think-specific safety rules themselves.

## Key Design Decisions

### No durable generation

Earlier designs considered storing a submission generation to distinguish rows
created before and after `resetTurnState()`. The simpler invariant is better:
reset synchronously marks all pending submissions as `skipped`, and future
submissions are just normal `pending` rows. Running turns are protected by the
existing turn queue generation and conditional terminal updates.

### No `locked_at`

`started_at` already records when a row moved to `running`. A separate lock
timestamp added another field without changing the recovery decision. Recovery
is based on status, message application, and chat recovery evidence.

### No public `recovering`

Recovery is not a user action. Exposing it would make the public state machine
more complex without giving callers a clear new decision to make. A recovered
submission remains `running` until it becomes terminal.

### No `AbortSignal` on `submitMessages()`

`AbortSignal` is in-memory and does not cross RPC or hibernation boundaries
reliably. Durable cancellation is explicit through `cancelSubmission()`. Direct
turn helpers such as `saveMessages()` can still accept `AbortSignal` because
they are tied to the lifetime of the in-process call.

### Workflows remain separate

Durable submissions are a single Think turn. Workflows are durable processes.
Using workflows for this feature would force users to create workflow instances
just to say "please run this chat turn eventually", and it would duplicate
Think's existing turn queue, Session integration, and chat recovery machinery.

## Invariants to Preserve

- A new submission row is inserted before `submitMessages()` returns
  `accepted: true`.
- Submitted messages are appended to Session only when the row has been claimed
  as `running`.
- `messagesAppliedAt` is set only after Session append succeeds.
- Recovery must never replay messages if any submitted message is already in
  Session.
- Pending submissions skipped by reset must transition synchronously before
  reset returns.
- Terminal statuses are final; late completion paths must not overwrite them.
- Idempotent retries must not append duplicate messages.
- Public inspection should expose the user contract, not internal recovery
  markers.
