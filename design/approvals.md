# Approvals

`Approvals` (`agents/approvals`) is a Lifecycle capability for two kinds of
work that must not happen twice: a side effect claimed by key, and work
parked until someone approves or rejects it. It is built for Think's action
ledger and its durable-pause and codemode approvals.

## How it works

The capability owns two tables and one kind of job.

### Effect ledger (`cf_agents_effects`)

`once({ key, name, input, run })` claims `key`, runs `run`, and records its
value. The row holds the name, a stable hash of the input, a status
(`pending` while claimed, `settled` once recorded), the value and two
timestamps.

- A later call with the same key, name and input returns the recorded value
  and does not run (`replayed`).
- The same key with another name or input runs nothing (`conflict`). The
  caller reused a key, which is a programming error.
- A call while this isolate runs the key awaits that run, if its name and
  input match; otherwise it is a `conflict`.
- A `pending` row nothing in this isolate is running was left by an attempt
  whose isolate ended. The effect may or may not have happened. The call
  answers `in-doubt` and runs nothing, unless the caller passed
  `reclaimAfterMs` and the claim is older, in which case it takes the claim
  over and runs again (`reclaimed`).
- If `run` throws, the row is deleted and the error rethrown, so a later call
  runs again. A value that is not JSON is returned once and not recorded
  (`unrecorded`), and so is one whose claim was deleted while it ran.

The value is recorded as its JSON round trip and that form is returned on
the first run too, so the first caller and a replay see the same value.

Claim, settle and release are each one synchronous SQLite statement, and
there is no `await` between reading a row and writing it, so two claims in
one isolate cannot interleave.

### Decisions (`cf_agents_decisions`)

A decision moves `pending` → `decided` → `settled`, and a settled one waits
until the host acknowledges its outcome.

1. `park({ kind, subject, descriptor })` writes a `pending` row. `subject` is
   what the continuation needs; `descriptor` is what a UI shows.
2. `decide(id, verdict)` moves the row to `decided` with one conditional
   `UPDATE … WHERE status = 'pending'`. Only the caller whose update changed
   the row goes on. Every other caller gets `already-decided` with the
   record, which carries the outcome once there is one.
3. The deciding call pushes a recovery job (`decision:<id>`) due after
   `resumeAfterMs`, then runs `onDecided` in host context, records its
   return value as the outcome (`settled`), cancels the job, and calls
   `onSettled`.
4. `onSettled` is where the host takes the outcome up. It calls
   `acknowledge(id)` when done. A host that must wait leaves the record
   unacknowledged and reads `unacknowledged()` later.

After a reset, the recovery job finds a `decided` row with nothing running
it in this isolate and runs `onDecided` again. It finds a settled row nobody
acknowledged and calls `onSettled` again with `redelivered: true`. `onStart`
pushes a due job for every such row, so a lost alarm is repaired on the next
wake. Each attempt is counted, and the count synced to disk (`storage.sync()`),
before the continuation runs: a reset before the continuation's first I/O
rolls back unsynced writes (measured, RUNTIME-FACTS.md), so without the sync
a continuation that keeps ending the isolate would never give up. A
continuation that throws stays `decided` and the job retries it; the third
failed or cut-off attempt settles the decision with the error.

`wait(id)` resolves when the decision is settled. It waits in memory; a
decision that settled earlier resolves at once, and a sweep that deletes the
decision rejects it.

`record({ kind, subject, verdict, outcome })` stores a decision made
elsewhere as settled and hands its outcome off the same way. It is for work
whose own system holds what is pending and runs the decision, such as the
codemode runtime: only the hand-off needs a record here.

The recovery job stays while the outcome is handed off and is cancelled
when `onSettled` returns, so a reset during the hand-off hands it off again
but an outcome the host chose to take up later is not handed off in a loop.
An outcome SQLite will not store (its 2 MB row limit) settles the decision
with an error instead of failing the same way on every retry.

### Retention

`sweep()` runs from `onStart` at most once an hour. It deletes, per
retention window (each can be `false`): recorded effects (30 days), unfinished
effect claims (90 days), decisions nobody made (30 days), and acknowledged
decisions (30 days). A `decided` row is never swept, and neither is an
effect claim this isolate is running. Deleting an effect ends
the run-once guarantee for its key.

## Guarantees

|               | Durable                                                                                 | In memory                                         |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Effect ledger | the claim, the recorded value                                                           | the running promise callers in this isolate share |
| Decisions     | the record, verdict, outcome, acknowledgement; one recovery job per unfinished decision | the running continuation, `wait()` waiters        |

- A verdict is taken once.
- An effect runs at most once per key while its claim is held and not
  reclaimed. A reset between the effect and its settle write leaves the row
  `pending`, so the next call answers `in-doubt` rather than run it again.
  Anything that leaves the object still needs idempotency on the receiving
  side.
- A decided continuation runs at least once. It can run twice if a reset
  lands after it ran and before the outcome was written, so a continuation
  with a side effect runs it through `once()`.
- `onSettled` runs at least once per outcome, until acknowledged. If it
  throws, `decide()` still returns `settled` and the recovery job hands the
  outcome off again.
- A continuation that is still running in this isolate when its job fires
  is checked again after `resumeAfterMs`, with no limit. It needs its own
  timeout (Think's actions have one).
- An effect value SQLite will not store is `unrecorded` and its claim is
  released, as for a value that is not JSON.

## Key decisions

- **The ledger is a table, not a job.** An effect runs inside a caller that
  waits for it (a model tool call). Nothing has to wake the object for it,
  so it uses no job and no alarm.
- **Decisions use the Lifecycle job queue, not Tasks.** The one thing that
  has to wake the object is a continuation that was decided and never
  finished. That is one keyed job per decision. A Task run would replay a
  journal of steps; the continuation is host code given its record, and its
  only step that must not repeat already goes through `once()`.
- **The verdict is written before the continuation runs.** Think used to
  delete the pending row and then run the approved action. A reset in
  between lost the approval: the row was gone, and the transcript still said
  "paused".
- **A second decide returns the record.** It used to be an error ("no longer
  pending"). The record says who won and what came of it, which is what a
  second tab needs.
- **The hash and value encoding are Think's.** `stableHash` and the
  `{ valuePresent, value }` encoding are the ones Think's action ledger
  wrote, so rows moved forward still deduplicate and replay.

## Tradeoffs

- A facet has no alarm, so the capability keeps no recovery job there, and
  an unfinished decision on a facet is not resumed after a reset. Effects
  and the once-only verdict work the same on a facet.
- `in-doubt` is conservative. A caller that knows its effect is safe to
  repeat opts into `reclaimAfterMs`; nobody else gets a second run they did
  not ask for.
