Status: accepted

# RFC: Count interrupted chat-recovery attempts before the next attempt runs

Related:

- [rfc-chat-recovery-work-budget.md](./rfc-chat-recovery-work-budget.md), whose #1825 OOM budget this replaces
- [chat-shared-layer.md](./chat-shared-layer.md)
- [alarm-coordination.md](./alarm-coordination.md)
- Issue [#2613](https://github.com/cloudflare/agents/issues/2613)

## The problem

A chat turn that exceeds the Durable Object's 128 MB limit on every run was
retried forever. One production object logged "strike 1/3" 10,800 times a day
for eight days, re-running the model each time, and never reached 2/3.

The #1825 bounds all recorded the out-of-memory after the reset:

- `recordOomAndDecide` bumped the incident's `oomAttempts` from the recovery
  callback's `catch`.
- The alarm circuit breaker bumped a strike counter at the alarm boundary.
- Both relied on the outermost frame having unwound, so that small writes
  could land.

A Durable Object's own memory-limit reset condemns the actor. Every storage
call in that invocation rejects, and writes that were not yet confirmed are
discarded. So `recordOomAndDecide` failed on its first read, the give-up's
seal failed too, and the breaker's strike `get`/`put` threw and fell back to
`strikes = 1` on every alarm. Unwinding frees the JS heap but does not bring
the actor's storage back.

The bounds evaluated when an incident opens could not catch it either. The
attempt cap and the no-progress window reset whenever the re-run streamed
output, the 30-second debounce pinned the attempt counter when deaths came
faster than that, and the OOM seal only fired on counts the failure path had
written.

## The proposal

Count a death when the next attempt is admitted, before it does anything
heavy, from an isolate whose storage works.

Every attempt adds itself to the incident's `attemptsInFlight` list
(`{ isolate, token }`), confirms the write with `storage.sync()`, and removes
its entry when it finishes, confirming that too so a reset right after a clean
finish cannot make it look interrupted. `isolate` is a random id held by the
`ChatRecoveryEngine`, which is built once per object instance, so a reset
produces a new value. An attempt that finds entries from another isolate knows
that isolate died mid-attempt, adds one to `interruptedAttempts` per dead
isolate however many entries it left, and drops them. Entries from its own
isolate are attempts still running, such as a replay that has just scheduled
this callback, so overlapping attempts are tracked apart.

Two kinds of attempt record themselves:

- The replay of an interrupted turn run (`handleChatFiberRecovery` opening the
  incident with an `interrupted` trigger). A replay with no incident yet is
  the original turn's death and counts one.
- A recovery callback (`_chatRecoveryContinue` / `_chatRecoveryRetry`) and the
  turn it starts, through `ChatRecoveryEngine.runRecoveryAttempt`, which both
  hosts call from `_dispatchChatRecovery`. This catches a callback that dies
  before it starts a turn, which leaves no turn run to replay.

Once `interruptedAttempts` reaches `chatRecovery.maxInterruptedAttempts`
(default 5, the original turn included), the incident is sealed with
`reason="interrupted_attempts_exceeded"`. Progress and debounce never reset
the count. A turn parked on a client interaction is counted but never sealed.
A callback still queued for a sealed incident does nothing, since running it
would re-run the model after the turn was terminalized.

The failure path writes nothing. `recordOomAndDecide` and both hosts'
`_handleRecoveryOom` are removed, Think re-throws a caught memory-limit reset,
and `AIChatAgent` drops its OOM-only `catch`. `maxOomRetries` stays as a
deprecated alias, read as `maxInterruptedAttempts: maxOomRetries + 1` so an
explicit retry count keeps its meaning.

## The alternatives

- **Keep counting on the failure path and add `sync()`.** The counter is still
  written after the reset, so `sync()` rejects as well.
- **Count per interrupted run id when a turn run is replayed.** This was the
  first version of the fix. It misses a callback that dies before starting its
  turn, and a replay that dies after opening the incident replays the same run
  id, so it never counts again.
- **A single in-flight record instead of a list.** A replay and the callback
  it schedules can overlap in one isolate. With one record, the callback's
  entry replaces the replay's, and if the callback finishes first the replay's
  death goes uncounted.
- **Make the alarm breaker count ahead of time** (mark before dispatch, count
  leftover marks on the next wake). It would cover every capability, but its
  identity is the job row or the whole object, while each chat cycle creates a
  new turn run and a new recovery run. Only the incident spans the loop. Kept
  as a follow-up for non-chat recovery loops (Tasks, PiHarness).
- **Count in Tasks when it reclaims an interrupted step.** Same identity
  problem, and the chat-turn step replays once by design to run recovery.

## The decision

Accepted as proposed.

**Tradeoff.** The next isolate cannot tell a memory-limit reset from a deploy,
so the count ignores the cause. A turn interrupted five times in a row by
deploys is sealed too, which ends the earlier promise that a progressing turn
survives unbounded interruption.

**What remains unbounded.**

- A reset before the replay opens the incident (rebuilding a very large
  partial from the stream log) or during boot hydration. Neither re-runs the
  model, and counting it needs a terminal path that skips rebuilding the
  partial.
- The alarm breaker still counts strikes only while storage works, for example
  when a D1 memory-limit error surfaces in a healthy isolate. Its log now says
  when a strike could not be counted instead of printing `strike 1/3`.
