# Think Durable Submissions

Durable programmatic chat turns for `Think`, exposed through
`submitMessages()`.

**Status:** implemented on the durable submissions branch.

Related:

- [think.md](./think.md) — overall Think architecture
- [think-sessions.md](./think-sessions.md) — Session-backed message storage
- [docs/think/programmatic-submissions.md](../docs/think/programmatic-submissions.md) — user-facing API guide
- [server-driven-messages.md](../docs/server-driven-messages.md) — lighter-weight server message patterns
- [workflows.md](../docs/workflows.md) — durable multi-step orchestration

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

| From      | To                            | Trigger                                                |
| --------- | ----------------------------- | ------------------------------------------------------ |
| none      | `pending`                     | `submitMessages()` accepts new work                    |
| any       | unchanged                     | idempotent retry returns existing row                  |
| `pending` | `running`                     | drain claims the oldest pending row                    |
| `pending` | `aborted`                     | `cancelSubmission()` before execution                  |
| `pending` | `skipped`                     | `resetTurnState()` before execution                    |
| `running` | `pending`                     | startup recovery sees no messages were applied         |
| `running` | `completed`                   | Think turn completes successfully                      |
| `running` | `aborted`                     | durable cancellation aborts the active turn            |
| `running` | `skipped`                     | turn queue generation changed before/while running     |
| `running` | `error`                       | execution failed, replay is unsafe, or recovery failed |
| terminal  | terminal, no further mutation | late completion and recovery updates are ignored       |

## Durable State

Submissions are stored in `cf_think_submissions`:

```sql
CREATE TABLE IF NOT EXISTS cf_think_submissions (
  submission_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  request_id TEXT,
  stream_id TEXT,
  status TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  metadata_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  messages_applied_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER
)
```

Indexes keep the table usable as both a FIFO queue and an inspection ledger:

```sql
CREATE INDEX IF NOT EXISTS cf_think_submissions_status_created_idx
  ON cf_think_submissions (status, created_at, submission_id);

CREATE INDEX IF NOT EXISTS cf_think_submissions_request_status_idx
  ON cf_think_submissions (request_id, status);

CREATE INDEX IF NOT EXISTS cf_think_submissions_status_completed_idx
  ON cf_think_submissions (status, completed_at, created_at);
```

The row is the durable source of truth. In-memory state may accelerate the
current isolate, but the implementation must be able to reconstruct progress
from SQLite after hibernation.

`messages_applied_at` is the important internal safety marker. It is set only
after submitted messages have been appended to Session. Recovery uses it to
avoid unsafe replay:

- If a `running` submission has no applied messages, it can be moved back to
  `pending`.
- If any submitted messages are already present in Session but
  `messages_applied_at` is missing, replay is unsafe and the submission becomes
  `error`.
- If `messages_applied_at` is present, the turn has crossed the boundary where
  chat recovery must either continue it or mark it `error`.

## Execution Flow

1. `submitMessages()` serializes and sanitizes the messages, inserts a
   `pending` row, emits `submission:create`, emits the initial `pending` status,
   schedules an idempotent `_drainThinkSubmissions` alarm, and starts an
   in-memory drain.
2. `_drainSubmissions()` claims the oldest `pending` row by conditionally
   updating it to `running`.
3. `_runSubmission()` calls the same programmatic turn path used by
   `saveMessages()`, with the submission id as the request id.
4. `_runProgrammaticMessagesTurn()` appends submitted messages to Session,
   marks `messages_applied_at`, broadcasts messages, and runs the normal Think
   inference and streaming path.
5. The submission row is updated to `completed`, `aborted`, `skipped`, or
   `error` only while it is still `running`, so late completions cannot
   overwrite cancellation or reset outcomes.

The scheduled drain is deliberately idempotent. It is not a separate queue
system; it is a wakeup mechanism for the SQLite-backed submission table.

## Recovery Rules

On startup, `_recoverSubmissionsOnStart()` reconciles `running` rows:

- `messages_applied_at IS NULL` and no submitted messages are in Session:
  restore the row to `pending` so it can be drained again.
- `messages_applied_at IS NULL` and some or all submitted messages are already
  in Session: mark `error`, because replay could duplicate or reorder messages.
- `messages_applied_at IS NOT NULL` with fresh recoverable chat evidence:
  leave the row `running`; chat recovery owns the terminal outcome.
- `messages_applied_at IS NOT NULL` with a scheduled recovered continuation:
  leave the row `running`; the scheduled callback owns the terminal outcome.
- Otherwise: mark `error`, because the turn was interrupted after messages were
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
| After row insert, before drain scheduling      | Idempotent retry or startup drain scheduling re-wakes row   |
| After claim, before Session append             | `running` row returns to `pending`                          |
| During Session append                          | Any detected applied message makes replay unsafe → `error`  |
| After Session append, before stream completion | Chat recovery continues, or row becomes `error` if unsafe   |
| During recovered continuation                  | Submission remains `running` until continuation is terminal |
| After cancellation/reset                       | Conditional terminal updates prevent late overwrite         |

## Reset and Cancellation

`resetTurnState()` invalidates queued and active turns. For durable submissions,
it must synchronously mark all still-`pending` submissions as `skipped` before
returning; otherwise a pending submission could be claimed by a drain after the
reset. Status hook emission can remain async, but the SQLite state transition is
part of reset itself.

`cancelSubmission()` marks `pending` or `running` submissions as `aborted`. If
the submission is currently executing, its request controller is aborted. If the
submission is in recovered continuation, the continuation gets its own linked
controller so durable cancellation still reaches the resumed turn.

All completion paths use conditional updates against `status = 'running'`.
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
- `messages_applied_at` is set only after Session append succeeds.
- Recovery must never replay messages if any submitted message is already in
  Session.
- Pending submissions skipped by reset must transition synchronously before
  reset returns.
- Terminal statuses are final; late completion paths must not overwrite them.
- Idempotent retries must not append duplicate messages.
- Public inspection should expose the user contract, not internal recovery
  markers.
