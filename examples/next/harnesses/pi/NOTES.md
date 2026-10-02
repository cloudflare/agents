# Notes: pi-durable on a Durable Object

Working notes from moving this example from pi-agent-core's `AgentHarness`
(0.84, vendored) to `@earendil-works/pi-durable` (npm `^1.0.0`). They
record what we decided, what was hard, and what is still missing. Nothing
here is in `agents`.

## What changed

| Before (#2210)                               | Now                                                             |
| -------------------------------------------- | --------------------------------------------------------------- |
| pi-agent-core `AgentHarness`                 | pi-durable `Harness`                                            |
| `Tasks` run per lane, replay-driving pi      | one Lifecycle wake job per session                              |
| intake table for queued submissions          | pi's own inbox                                                  |
| `Streams` log per operation, cursors, replay | pi's `watchEvents`: snapshot, then one batch per commit         |
| pi's 7 session tables namespaced by adapter  | pi's own `SqliteStorage` schema, prefixed `pi_` (session store) |
| own event and message projections            | pi's `AgentEvent`s on the wire, one reducer (`view.ts`)         |
| compaction config                            | none; pi-durable has no compaction yet                          |

The harness went from about 3,600 lines to under 2,000, with no other SDK
primitive besides Lifecycle jobs. It now lives in `packages/agents` as
`agents/harness/pi`, with its models from `agents/models/pi-ai`. The client and the tests use the same
reducer.

## Decision: a Lifecycle job, not Tasks, a driver, or the state machine

pi-durable already is a durable execution engine. It has checkpointed tasks,
ownership trees, abort, replay-safe and unsafe tools, retries, and an inbox,
and its `submit()` is durable before it resolves. Around it, the SDK only has
to do one thing: wake the object when pi has work but no memory. That is one
Lifecycle job per session, owned by `PiHarness` (`#wake`, `#wakeStep`,
`#waitForIdle` in `pi-harness.ts`, about 90 lines).

- **Tasks.** This was the old design. Tasks journals steps for replay, and pi
  is already the replay authority, so every Tasks step was a no-op wrapper
  around "ask pi". A capability-owned Tasks driver also needed Tasks'
  internal apertures.
- **Driver (#2396).** We built this on the driver first, and it worked.
  But with pi owning admission and replay, all that was left of the driver
  was a queue row per session plus a heartbeat job. The job alone is the
  durable state. The driver's queue, operation ids, `stop`, `onFail`, and
  retries went unused, and its atomic row-plus-job write needed
  `jobs.pushSync` (#2420). A harness with its own durable engine does not
  need a shared driver, so it is not a primitive to share across harnesses.
- **State machine (#2316–#2338).** #2338 ports the old example onto it with
  a drive/park machine, pass counters, and a poll interval. pi's scheduler
  leaves nothing to drive in passes, and child machines (#2333) overlap with
  pi's own task ownership.

### One admission, one wake job per session

`submit()` does three things, in this order:

1. `#wake(session)`: push the session's wake job (`pi-wake:<session>`, due
   now). From here on, if the object dies, that job's alarm restarts it.
2. `conversation.submit({ requestId })`: the one admission. pi's inbox
   places steers and follow-ups while a run is going, and deduplicates by
   request id.
3. `#wake(session)` again: re-check now, so a wake that ran before the
   admission and was about to complete sees the new work.

A run of the job (`#wakeStep`) never admits or replays anything:

- **No live pi tasks in the session:** complete the job, so there is no alarm.
  If a submit is between steps 1 and 2 (an in-memory counter), reschedule
  instead.
- **A pi wait more than 60 s away:** reschedule to that deadline.
- **Only background tasks:** reschedule in 30 s.
- **Otherwise:** start `conversation.waitForIdle()` in the background,
  inside the alarm's work (`trackAlarmWork`), and reschedule the job 30 s out
  as a heartbeat. When the wait ends, push the job due now to re-check.

The whole thing relies on one Lifecycle rule: a same-id `push()` made while
the job is dispatching supersedes that dispatch's outcome. So a submit
cannot be lost to a wake that is completing.

`onStart` pushes a wake for every session with live pi tasks. That covers
restarts and conversations a subagent created without going through
`submit()`. `wait()`, `pending()`, and `abort(operationId)` read or change
pi's submissions directly. The wake holds no per-submission state.

## The harness interface

`PiHarness` has the shape the other `examples/next/harnesses` share:
`harness.prompt()`, `harness.submit()`, `harness.abort()`, `harness.wait()`,
`harness.messages()` (pi's own `EntryRecord`s), `harness.sessions` (`create`, `get`, `fork`, `list`),
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
away into a reschedule of the wake job at the deadline. It finds the deadline by
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

The wake's wait runs inside an alarm invocation (`trackAlarmWork`), and
alarm handlers have a 15 minute wall-time limit. Outbound model streams keep
an object alive for at most 15 minutes too. A wait therefore lasts at most 10
minutes and then pushes the job due now, which starts a new alarm
invocation. A single model request that streams for more than 15 minutes
is still at the platform's mercy.

### Graceful eviction waits for the wake

`evictDurableObject` waits for in-flight work to drain. The wake's purpose
is to keep a wait in flight, so the tests crash the object with
`abortAllDurableObjects()` instead. A deploy behaves the same way: the
runtime gives in-flight work 30 s and then kills it. The recovery path is the
same either way, but it is worth knowing that a running pi turn never lets
the object drain.

### Reads the Harness does not offer

Two reads go to pi's `Storage` directly, outside the Session's line of
commits:

- `submissionByRequest(conversationId, requestId)`, for `wait()`, `abort()`,
  and the `accepted` flag on a receipt. The Harness can only reacquire a
  submission by its pi id, and callers address operations by their own id.
- `scanConversations()` for `sessions.list()`. The Harness has no
  conversation listing.

Both read committed state only, so they are safe here. **Ask for:**
`harness.submissionByRequest()` and `harness.conversations()`.

### Table prefix is a SQL rewrite

pi's SQLite schema uses bare names such as `tasks`, `entries`,
`conversations`, and `documents`, which easily collide in an object that
also hosts other state. The session store rewrites identifiers outside
string literals, using the names it reads from pi's exported
`SQLITE_MIGRATIONS`. pi's conformance suite passes against it. It breaks if
a future pi statement puts a table name in a string literal or builds SQL
dynamically. **Ask for:** a `tablePrefix` option on `SqliteStorage`.

### Abort needs tools that honor their signal

`conversation.abort()` resolves only once the conversation is idle. A tool
that ignores `context.abortSignal` hangs it. The test's gate tool had to
check the signal. pi's abort has no grace period.

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
- pi-ai's `openai-completions` API needs the `openai` SDK at runtime, so
  pi-ai depends on it. The old 0.84 archive did not.
- Chord depends on `esbuild`, which is used only by its Node bundler and is
  never reached from a Worker. It is ~12 MB installed. Worth an upstream ask
  that chord move it to an optional peer.
- The npm release 0.99.1 predates the events API, which is why this example
  was first built against a vendored `main`. **0.99.2 ships it** — plus
  `watchEvents`, `AgentEvent`, `AgentEventStream`, and the compaction types —
  so the vendor is gone and the deps are ordinary npm ranges. The inbox and
  ownership were already in published 0.99.1. Subagents are still absent from
  any published release.

### Workspace tools

The model's tools are computer's `createPiTools`, adapted in
`src/workspace.ts`, not pi's own `read`/`bash`/`edit`/`write` on an
`ExecutionEnv`. computer's set comes with the Workspace's limits, locks and
schemas, and its `exec` runs on a Workspace backend. What came up:

- **Two loop models.** `createPiTools` returns declarations and one
  `execute(call)` for a hand-written loop. pi-durable wants a
  `ToolRegistration` per tool, so the adapter pairs them by name. The
  declarations are JSON Schema, not TypeBox. pi validates with TypeBox, which
  accepts either, so only the static type needs a cast.
- **Replay is ours to choose.** computer has no replay notion. Reads,
  searches, whole-file `write` and forced `delete` are marked safe. `edit`
  would fail on text it already replaced, and `exec` runs arbitrary code, so
  both are unsafe.
- **`exec`'s description assumes shells.** It is built for a choice of
  backends and talks about `npm test`. With one JavaScript backend that
  misleads the model, so the adapter replaces the description and the
  `command` parameter's text. It documents the typed `ws:git` interface
  rather than its `cli()`, which gives the model return values it can use
  directly. The model still sometimes tries `node:path` first; the error
  names the module and it recovers.
- **Git is opt-in twice.** The backend installs `ws:git`, but every call
  fails until the `Workspace` gets `git: createGitClient()`, which needs the
  optional `@platformatic/vfs` peer. Network operations also need
  `allowGitNetwork: true` on the backend.
- **`ws:git` paths are not the client's.** The git client's types say `dir`
  defaults to `/`. Through `ws:git` the host resolves `dir` against the
  module's working directory and keeps it inside the backend root. The
  `exec` description follows the bridge.
- **Tool calls run in parallel.** pi runs one round's tool calls at once by
  default. In testing the model sent a `clone` and a `log` in the same
  round, and the `log` ran before the clone finished. Marking `exec`
  `executionMode: "sequential"` would order them; not done yet.

### Build

`vite build` needs `packages/codemode` built, because `agents/skills`
imports the optional `@cloudflare/codemode` peer. This is not new to this
example.

## Not done yet

- Subagents. pi-durable's subagent tools (examples 22 and 23) should work
  unchanged as registered tools. The background variant needs the "live work
  keep-alive" above.
- Compaction. No longer pending upstream: 0.99.2 ships `CompactionPolicy`,
  `CompactionHooks` and the rest, wired into `HarnessOptions`. Not yet used
  or tested here.
- `ExecutionEnv` for pi's own `read`/`bash`/`edit`/`write`. Unused here:
  the Workspace tools come from computer instead (see "Workspace tools").
- Session deletion. pi has no conversation delete.
