# Notes: pi-durable on a Durable Object

Working notes from moving this example from pi-agent-core's `AgentHarness`
(0.84, vendored) to `@earendil-works/pi-durable` (pi `main`, 2bbfcca4). They
record what we decided, what was hard, and what is still missing. Nothing
here is in `agents`.

## What changed

| Before (#2210)                               | Now                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------- |
| pi-agent-core `AgentHarness`                 | pi-durable `Harness`                                                 |
| `Tasks` run per lane, replay-driving pi      | `Driver` operation per submission                                    |
| intake table for queued submissions          | pi's own inbox, plus the driver row                                  |
| `Streams` log per operation, cursors, replay | pi's `watchEvents`: snapshot, then one batch per commit              |
| pi's 7 session tables namespaced by adapter  | pi's own `SqliteStorage` schema, prefixed `pi_` (`session-store.ts`) |
| own event and message projections            | pi's `AgentEvent`s on the wire, one reducer (`view.ts`)              |
| compaction config                            | none; pi-durable has no compaction yet                               |

`src/harness` went from about 3,600 lines to 1,900. The copied driver adds
about 1,000 lines, which go away once a driver ships in `agents`. The client
and the tests use the same reducer.

## Decision: driver, not Tasks or the state machine

pi-durable already is a durable execution engine. It has checkpointed tasks,
ownership trees, abort, replay-safe and unsafe tools, retries, and an inbox.
Around it, the SDK only has to do two things: keep a submission's intent
until pi has it, and wake the object when pi has work but no memory. Among
the three options, the driver is the one that does only that.

- **Driver (#2396).** `step(op)` admits the input into pi by request id
  (idempotent), waits for pi to settle it, and returns `done`. The driver
  owns the queue row and the alarm heartbeat. If the object is evicted
  mid-run, the heartbeat alarm restarts it, pi reopens and resumes its own
  tasks, and the step waits again. The step never replays model or tool
  work, since pi does that. `sleep` handles pi's long waits, `stop` maps to
  withdrawing the submission or aborting the conversation, and `onFail` to
  withdrawal. It fits in about 60 lines (`#step`, `#withdraw`, `#failed` in
  `pi-harness.ts`).
- **Tasks.** This was the old design. It works, but Tasks journals steps for
  replay, and pi is already the replay authority, so every Tasks step
  was a no-op wrapper around "ask pi". Registering a capability-owned driver
  also needed Tasks' internal apertures (`register` with a reserved name,
  the queued enqueue). That is more machinery and more private API for the
  same wake.
- **State machine (#2316–#2338).** #2338 ports the old example onto it with
  a drive/park machine, pass counters, and a poll interval. pi-durable makes
  that machine unnecessary, because pi has its own scheduler and there is
  nothing left to drive in passes. Child machines (#2333) overlap with
  pi's own child tasks and ownership. It would be a third state model next
  to pi's tasks and the driver's queue.

Because nothing but `agents/tasks` has shipped, the driver is copied into
`src/driver/` (from #2396 at 72b410cfd, without `DurableToolRuns`). The one
change is noted under "Driver needs a synchronous push" below.

## The harness interface

`PiHarness` has the shape the other `examples/next/harnesses` share:
`harness.prompt()`, `harness.submit()`, `harness.abort()`, `harness.wait()`,
`harness.messages()`, `harness.sessions` (`create`, `get`, `fork`, `list`),
`harness.session(id)` handles, and `webSockets()`. A session is a pi
conversation. The root is `"1"`.

The shared `Harness` capability in #2285 goes further than this. It has
`events({ previews })` from a cursor, `requests()`/`reply()` for permission
round trips, `compact`/`rewind`/`configure`, and capability flags. Gaps
against it:

- **Events have no cursor.** pi's watch always starts from a snapshot, and
  there is nothing to replay. That is simpler and correct for UIs, but an
  API that promises "replay from any cursor" cannot be built without a log
  that pi does not keep.
- **No requests or replies.** pi-durable has no approval or permission
  primitive yet. A tool could park on a pi document and a hook, but that is
  ours to invent.
- **No compaction.** `session.reset(handoff)` is the stand-in.

## Hard or unresolved

### Driver needs a synchronous push

#2396 inserts the queue row and pushes the job inside one `transactionSync`,
using a `jobs.pushSync` it adds to Lifecycle. The published Lifecycle has
only async `jobs.push`. The copy pushes the job first and then writes the
row. A job with an empty queue is a no-op, and a row with no job would sit
until the next start. The window is one microtask, because the continuation
after the awaited push runs before any other event. The same ordering is
used in `#resume`. To make this atomic, `pushSync` (or a push that takes an
open transaction) is needed in Lifecycle.

### pi's work is not bound to a driver step

`harness.resume()` lets pi run everything it has, on its own, in memory. The
driver only heartbeats while a step is waiting. Work with no driver operation
behind it gets no heartbeat, for example:

- a background subagent (pi-durable example 23)
- a child task that outlives its parent's run
- a follow-up pi places from its inbox after the operation that admitted it
  settled

If the object is evicted in the middle of that work, nothing wakes it
until the next request. The fix is a keep-alive derived from
`harness.inspect()` (live tasks, unsettled submissions) instead of from
driver operations. That could be a second driver scope, "pi has live work",
stepped whenever `inspect()` is non-empty. It is not built, because nothing
in the example spawns background work yet.

### pi's timers are in memory

pi sleeps with `setTimeout`: retry backoff, deferred polling, and the 100 ms
partial-commit throttle. Nothing outside pi can ask when it next needs to
wake. `#longWait` reads pi's `LiveDoc` (`generation.retry.at`,
`generation.deferred.pollAt`) and turns a wait more than 60 s away into a
driver `sleep`, so the alarm wakes the object instead. That reads pi's
presentation document as a control signal. **Ask for:** a "next wake time"
on `inspect()`, or an injectable timer/scheduler in `HarnessOptions`.

### Alarm wall time

A driver step runs inside an alarm invocation (`trackAlarmWork`), and alarm
handlers have a 15 minute wall-time limit. Outbound model streams keep an
object alive for at most 15 minutes too. The step therefore waits for at
most 10 minutes and then returns `continue`, which starts a new alarm
invocation. A single model request that streams for more than 15 minutes
is still at the platform's mercy.

### Graceful eviction waits for the step

`evictDurableObject` waits for in-flight work to drain. The heartbeat's
purpose is to keep a step in flight, so the tests crash the object with
`abortAllDurableObjects()` instead. A deploy behaves the same way: the
runtime gives in-flight work 30 s and then kills it. The recovery path is the
same either way, but it is worth knowing that a running pi turn never lets
the object drain.

### Reads the Harness does not offer

Two reads go to pi's `Storage` directly, outside the Session's line of
commits:

- `submissionByRequest(conversationId, requestId)`, to find the submission
  for a driver operation. The Harness can only reacquire a submission by
  its id, which the driver never learns if the eager admission was lost.
- `scanConversations()` for `sessions.list()`. The Harness has no
  conversation listing.

Both read committed state only, so they are safe here. **Ask for:**
`harness.submissionByRequest()` and `harness.conversations()`.

### Table prefix is a SQL rewrite

pi's SQLite schema uses bare names such as `tasks`, `entries`,
`conversations`, and `documents`, which easily collide in an object that
also hosts other state. `session-store.ts` rewrites identifiers outside
string literals, using the names it reads from pi's exported
`SQLITE_MIGRATIONS`. pi's conformance suite passes against it. It breaks if
a future pi statement puts a table name in a string literal or builds SQL
dynamically. **Ask for:** a `tablePrefix` option on `SqliteStorage`.

### Double admission

`submit()` writes the driver row, and then admits into pi immediately. This
lets pi's inbox place steers and follow-ups while a run is going, instead of
the driver holding them back until the current operation is done. The step
admits again with the same request id, and pi deduplicates it. Two
consequences:

- The driver's FIFO no longer orders anything. pi's inbox does. The
  driver's per-session queue only decides which submission's wait carries
  the heartbeat.
- A queued follow-up's operation is stepped only after the operation in
  front of it is done. A crash in between leaves pi with the follow-up and
  the driver with its row, and the step's re-admission is a no-op. That is
  correct, but it relies on pi's request-id deduplication.

### Abort needs tools that honor their signal

`conversation.abort()` resolves only once the conversation is idle. A tool
that ignores `context.abortSignal` hangs it. The test's gate tool had to
check the signal. `driver.stop()` gives an aborted step 5 s to unwind and
then moves on, but pi's abort itself has no grace period.

### Watches are per socket and in memory

Each socket gets its own `watchEvents` stream. After hibernation or eviction,
`onStart` re-watches every socket and sends a fresh snapshot, and the
client replaces its state. `LifecycleSockets` finds sockets by tag but
cannot give the tags of a socket, so the re-watch walks
`sessions.list()` and looks up each session's tag.

### Surprises in pi

- System-prompt changes are positional entries. On the first turn, the
  `system` message comes after the user's input in the model context. The
  faux script has to skip it to find the prompt.
- pi-ai's `openai-completions` API needs the `openai` SDK at runtime. The
  vendored pi-ai keeps it. The old 0.84 archive did not need it.
- Chord depends on `esbuild`, which is used only by its Node bundler. The
  vendored archive drops it.
- The npm release 0.99.1 predates the inbox, events, ownership, and
  subagents. `main` still carries the same version number. See
  `vendor/pi-dev/README.md`.

### Build

`vite build` needs `packages/codemode` built, because `agents/skills`
imports the optional `@cloudflare/codemode` peer. This is not new to this
example.

## Not done yet

- Subagents. pi-durable's subagent tools (examples 22 and 23) should work
  unchanged as registered tools. The background variant needs the "live work
  keep-alive" above.
- Compaction, which is pending upstream.
- `ExecutionEnv` for pi's `read`/`bash`/`edit`/`write` on Workspace or a
  Container. `PiHarnessOptions.env` is plumbed through but unused.
- Session deletion. pi has no conversation delete.
