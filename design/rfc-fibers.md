# Design record: Tasks — durable replayable execution

Status: shipped as `agents/tasks` (originally proposed under the working
name "Fibers"; this document records the shipped design and how it evolved
during implementation).

## The problem

Agents need object-local background work that survives process loss,
deployments, and hibernation: multi-step jobs with retries and sleeps,
model turns that must not be double-billed, deliveries that must not be
double-sent. Before this capability, that machinery existed twice — the
public `runFiber()`/`startFiber()` engine baked into the Agent class, and
bespoke recovery scans inside the chat frameworks — and not at all for
plain Durable Objects.

## The shipped design

One `Tasks` capability instance per Lifecycle Object owns any number of
named definitions, declared in its constructor:

```ts
readonly tasks = new Tasks({
  definitions: {
    "generate@v1": async (input: GenerateInput, step: TaskStep) => {
      const a = await step.do("fetch", () => fetchIt(input)); // journaled
      await step.sleep("cool-off", "30 seconds"); // durable deadline
      return step.do("write", { retries: { limit: 5 } }, () => write(a));
    }
  }
});
readonly lifecycle = Lifecycle.install(this).use(this.tasks);
```

The constructor map **is** the registry. It is rebuilt identically on every
Durable Object wake, so persisted definition names always resolve — the
property that makes recovery correct by construction. (An earlier draft
allowed `create()` at arbitrary times; it was rejected because a name
registered after startup cannot be resolved on the wake that needs it.)

### Execution model

- **Acceptance is durable and idempotent.** `tasks.run(name, input,
  options)` inserts the run row and returns a receipt without waiting for
  terminal state; an existing `runId` or `idempotencyKey` joins the run
  (`accepted: false`) instead of duplicating it.
- **Replay from the top.** Every execution attempt invokes the handler from
  its beginning. Completed `step.do()` steps return journaled results
  without re-executing; `step.sleep()`/`step.sleepUntil()` treat the first
  recorded deadline as authoritative; reaching a not-yet-due boundary
  suspends the attempt instead of holding the invocation open.
- **Generation fencing.** Each claim writes a fresh generation; every
  settle/park mutation is fenced on it, so a superseded attempt unwinds
  without clobbering the run.
- **Retries are step policy.** Per-step `retries` (limit/delay/backoff) and
  `timeout`, with capability-level defaults; a step that exhausts retries
  fails the run. `NonRetryableError` settles immediately.
- **Cancellation is cooperative.** A parked run settles at once; a live
  attempt is aborted through its signal and settles at its next step
  boundary.
- **Claim backstop.** A claimed attempt carries a durable deadline
  (`stepTimeout` plus slack); if its isolate dies, the deadline wakes the
  object and the run is reclaimed and replayed.

### Interruption is replay plus evidence — there is no recovery mode

An unclean interruption (a claimed attempt whose isolate died) simply
replays the handler on the next wake. Replay safety comes from two
patterns, both first-class:

- **Idempotency keys.** Every step attempt receives a stable
  `idempotencyKey` (identical across attempts and replays) to pass to
  external services.
- **Durable evidence.** `step.interrupted` is `{ name, attempt }` when a
  lost attempt left a step mid-execution (`null` on clean attempts), so a
  handler branches before re-entering irreversible work; and durable state
  the handler wrote — a [stream](./rfc-streams.md)'s cursor, a rows-written
  count — is read at the top of the work. A producer that starts its loop
  at `stream.cursor` resumes rather than redoes, no matter how many times
  it replays.

A `task:attempt:interrupted` event mirrors the interrupted step for
observability. A step callback that throws is **not** an interruption; the
retry policy owns it.

### Wake scheduling: one queue job per run

Tasks never touches the physical alarm. Every non-terminal run's
authoritative `next_at` deadline (acceptance, sleeps, retries, claim
backstops all write it) is mirrored as one job in the Lifecycle work queue
— `id = the run id`, so a retime is a same-id push. Wakes dispatch through
`onJob`, whose outcome is derived from the run row after execution: the
row is the single source of truth for whether and when the run wakes
again, superseding any same-id push made mid-drive. Mirror maintenance
lives inside the settle/park helpers so a state transition cannot forget
its wake. See [alarm-coordination.md](./alarm-coordination.md) for the
queue model itself.

### Module layout

`tasks.ts` holds the state machine (~900 lines); `store.ts` owns the two
tables (`cf_agents_task_runs`, `cf_agents_task_steps`: DDL, row access,
fenced writes, snapshot projection); `engine-port.ts` builds the
storage-side port `ReplayStep` drives; `replay.ts` is the replay/journal
engine; types, errors, serialization, and duration parsing are their own
modules.

### Agent integration and the chat replatform

`Agent` installs the capability as experimental `this.tasks`. Subclass
definitions go on the overridable `taskDefinitions` field; framework
definitions attach through a composition-root resolver
(`setTaskDefinitionResolver`) so they never occupy the user's map, and
reserved `__cf`-prefixed names cannot be started through the public
`run()`. An internal aperture (`runAttached`) accepts a run durably and
executes it inline while the isolate lives — the shape a request-driven
chat turn needs.

Think and AIChatAgent run their chat turns and messenger replies on this
capability. The shared turn definition lives once in `agents/chat`
(`createChatTurnTaskDefinition`): a live turn executes its closure with
`stash()` persisted to host storage; a replay whose closure is gone — the
producing isolate died — enters the unchanged ChatRecoveryEngine with that
snapshot plus stream evidence. One hard-won constraint from this
migration: **queue-driven dispatch must never await an unbounded turn.**
The recovery schedule callbacks await only the bounded pre-turn phase and
detach at the turn boundary (a platform transient before the turn still
defers the queue job; one after it re-defers itself), because a single
hanging turn awaited inside the queue driver starves every job on the
object.

## How the design evolved

Implementation changed the proposal in four significant ways, each driven
by using the API rather than reasoning about it:

1. **Runtime `create()` → constructor map.** Registration after startup
   cannot survive a wake; the map makes the registry a pure function of
   the class.
2. **Alarm contribution → job queue.** The original design had each
   capability contribute its earliest deadline (`getNextAlarm()`) to a
   Lifecycle-owned alarm. When Lifecycle grew a durable work queue
   (#2175), Tasks was ported onto it and the per-capability batching knob
   (`maxRunsPerAlarm`) was deleted — dispatch pacing is the queue driver's
   job.
3. **Custom recovery shipped, then was removed.** The first release paired
   handlers with an optional `recover(interruption)` callback
   (`TaskInterruption`, `TaskRecoveryDecision`, a `recovering` state with
   a backoff budget, step `checkpoint()`). Migrating chat onto the API —
   the reason the surface was built — showed it was unnecessary: the
   Streams capability turned interruption evidence into durable state a
   replayed handler reads directly, and chat's recovery engine expresses
   its decision as a branch at handler entry. The removal deleted the most
   complex third of the engine; `step.interrupted` and the interruption
   event preserve the evidence recover existed to deliver.
4. **"Fibers" → "Tasks".** The public vocabulary follows what users
   schedule (tasks), not the execution mechanism; the legacy `runFiber`
   engine keeps its name.

## Alternatives considered

- **A general work-queue table with leases.** Rejected in the original
  proposal in favor of run-row deadlines plus generation fencing and
  hang-detection; the Lifecycle queue that later arrived is a *dispatch*
  mechanism, not a lease manager, and the run row remains authoritative.
- **Delegating to Cloudflare Workflows.** A separate product for
  cross-service orchestration: runs leave the object, cannot touch its
  live state (streams, connections, SQL) transactionally, and carry their
  own billing and latency. Object-local work needs an object-local engine;
  the two compose (a task step may start a workflow).
- **One Durable Object per run.** Maximizes isolation but breaks the point
  of agent-local work: sharing the agent's state and identity.

## Deliberately deferred

- `waitForCompletion` on `run()` — callers poll snapshots or settle
  through their own channel.
- Runs on routed sub-agents (facets) — needs owner-path routed dispatch,
  the pattern the Scheduler uses for facet schedules; facet chat turns
  stay on the legacy fiber engine until then.
- `runFiber()`/`startFiber()` deprecation — released public API; untouched
  until the facet migration lands and in-flight rows can drain.

## Verification stance

Real Durable Objects only: capability suites drive a real Lifecycle over
real SQLite (replay memoization proven by instance counters, seeded
interruptions reclaimed by dead-generation fencing, workerd's real alarm
behavior); SIGKILL e2e suites kill wrangler mid-run and prove journaled
steps do not re-execute and interrupted runs replay to completion; the
chat suites (think 887, ai-chat 737 plus its recovery e2es) are the
replatform's parity ratchet.
