# Notes: pi-durable on a Durable Object

Working notes from moving this example from pi-agent-core's `AgentHarness`
(0.84, vendored) to `@earendil-works/pi-durable` (pi `main`, 2bbfcca4). They
record what we decided, what was hard, and what is still missing. Nothing
here is in `agents`.

## What changed

| Before (#2210)                               | Now                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------- |
| pi-agent-core `AgentHarness`                 | pi-durable `Harness`                                                 |
| `Tasks` run per lane, replay-driving pi      | one `Driver` wake per session                                        |
| intake table for queued submissions          | pi's own inbox                                                       |
| `Streams` log per operation, cursors, replay | pi's `watchEvents`: snapshot, then one batch per commit              |
| pi's 7 session tables namespaced by adapter  | pi's own `SqliteStorage` schema, prefixed `pi_` (`session-store.ts`) |
| own event and message projections            | pi's `AgentEvent`s on the wire, one reducer (`view.ts`)              |
| compaction config                            | none; pi-durable has no compaction yet                               |

`src/harness` went from about 3,600 lines to 1,900. The copied driver adds
about 1,000 lines, which go away once a driver ships in `agents`. The client
and the tests use the same reducer.

## Decision: driver, not Tasks or the state machine

pi-durable already is a durable execution engine. It has checkpointed tasks,
ownership trees, abort, replay-safe and unsafe tools, retries, and an inbox,
and its `submit()` is durable before it resolves. Around it, the SDK only has
to do one thing: wake the object when pi has work but no memory. Among the
three options, the driver is the one that does only that.

- **Driver (#2396).** Each session has one driver operation, its wake.
  `step` waits while pi has live tasks in the session and parks when it has
  none. It never admits input and never replays model or tool work, since pi
  does both. If the object is evicted mid-run, the heartbeat alarm restarts
  it, pi reopens and resumes its own tasks, and the step waits again. Long
  pi waits become `sleep`. It fits in about 80 lines (`#ensureWake`, `#step`,
  `#failed` in `pi-harness.ts`).
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

Because nothing but `agents/tasks` has shipped, the driver is copied
unchanged into `src/driver/` (from #2396 at 72b410cfd, without
`DurableToolRuns`). It writes a queue row and its job in one
`transactionSync` with `jobs.pushSync`, which #2420 adds to Lifecycle. This
PR is stacked on #2420.

### One admission, one wake per session

`submit()` does three things, in this order:

1. `#ensureWake(session)`: the session's wake exists and has a job. From
   here on, if the object dies, that job's alarm restarts it.
2. `conversation.submit({ requestId })`: the one admission. pi's inbox
   places steers and follow-ups while a run is going, and deduplicates by
   request id.
3. `driver.wake(session)`: step now. If the wake had just parked, it sees
   the new work.

While a submit is between steps 1 and 2, the wake sleeps instead of parking
(an in-memory counter), so a step that runs early cannot cancel the job
before pi has the input. `onStart` also gives every session with live pi
tasks a wake. That covers a wake that failed out, and conversations a
subagent created without going through `submit()`.

`wait()`, `pending()`, and `abort(operationId)` read or change pi's
submissions directly. The driver holds no per-submission state.

## The harness interface

`PiHarness` has the shape the other `examples/next/harnesses` share:
`harness.prompt()`, `harness.submit()`, `harness.abort()`, `harness.wait()`,
`harness.messages()`, `harness.sessions` (`create`, `get`, `fork`, `list`),
`harness.session(id)` handles, and `session.events()`. A session is a pi
conversation. The root is `"1"`.

Transport is not part of the harness. The socket protocol (one session per
socket, a tool list on connect, commands) lives in the app's `sockets.ts` and
`protocol.ts`, and the UI reducer in `view.ts`. They use only the harness's
public API, so another app could put the same sessions on SSE or RPC
instead.

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

### Background work is polled

The wake waits with `conversation.waitForIdle()`, which ignores background
tasks, such as a background subagent's anchor (pi-durable example 23). When
only background tasks are left, the wake sleeps 30 s and checks again. The
alarm keeps the object alive, but a background task that finishes is only
noticed at the next check. A background task in another conversation shows
up under that conversation's wake, which `onStart` creates.

### pi's timers are in memory

pi sleeps with `setTimeout`: `runtime.sleep(until)` in the scheduler, which
the generation task uses for retry backoff (`{ phase: "retry", until }`) and
deferred polling (`{ phase: "poll", pollAt }`), and which custom tasks can
call too. The deadline is in the checkpoint, so a restart resumes the sleep
correctly. But a pending timer does not keep a Durable Object alive. If
nothing else is in flight, the object is evicted, the timer is gone, and
nothing wakes it until the next request.

While a wake step is waiting, it keeps the object alive through its alarm
invocation, so pi's timer fires. `#longWait` turns a wait more than 60 s
away into a driver `sleep` at the deadline. It finds the deadline by
reading pi's `LiveDoc` (`generation.retry.at`, `generation.deferred.pollAt`).
That is a presentation document used as a control signal, and it only
covers the generation task. A custom task's `runtime.sleep` is invisible,
and a wait under 60 s holds the alarm invocation open (billed wall time).

**Ask Mario** (either would do):

- **Scheduler-owned sleeps.** `runtime.sleep(until)` records the deadline
  as scheduler state, and `inspect()` returns `nextWakeAt`, the earliest
  deadline over live tasks, with a way to subscribe to changes. The host
  sets its alarm to `nextWakeAt`, and pi's own timer becomes an
  optimization.
- **An injectable timer.** `HarnessOptions.timers: { sleep(until, signal) }`,
  or an `onWakeNeeded(at)` callback, so a host can back every pi sleep
  with its alarm.

Either removes `#longWait` and makes custom task sleeps safe on Durable
Objects.

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

### Abort needs tools that honor their signal

`conversation.abort()` resolves only once the conversation is idle. A tool
that ignores `context.abortSignal` hangs it. The test's gate tool had to
check the signal. `driver.stop()` gives an aborted step 5 s to unwind and
then moves on, but pi's abort itself has no grace period.

### Watches are per socket and in memory

This is app glue in `sockets.ts`, not the harness. Each socket gets its own
`session.events()` stream. After hibernation or eviction, the host's
`onStart` calls `sockets.reattach()`, which re-watches every socket and
sends a fresh snapshot, and the client replaces its state.
`ctx.getWebSockets(tag)` finds sockets by tag, but nothing gives the tags of
a socket, so the re-watch walks `sessions.list()` and looks up each
session's tag.

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
