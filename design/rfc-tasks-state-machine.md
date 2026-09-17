Status: proposed

# Tasks: one durable state-machine engine, two APIs

**Base:** `packages/agents/src/tasks/` at PR #2274 (worktree
`agents-tasks-attempt-signal-and-budget`, `f28ffc2f`) over origin/main
`a7b29135`. Every `file:line` citation below is against that worktree
unless prefixed `agents-machine-primitive:`.

**Surface note.** The design panel's spec named the pieces `initial` /
`turn` / `abort`, with one `turn` handler containing a `switch`, a `task`
argument beside a `run` runtime, and `awaitAnswers`. The maintainer
settled the final surface on 2026-09-16 after the API survey: `initial` /
`phases` / `phase` / `onCancel` / `ctx`, one handler per phase, one
runtime object. This document is written in the final surface throughout;
the old spellings appear only where they are the subject — this note,
**The alternatives**, and the closing _Where this appendix departs from
the design panel's spec_.

**Shape note.** The decision record proper — _The problem_, _The
proposal_, _The alternatives_, _The decision_ — is the RFC, and it is
`design/AGENTS.md`-shaped: a few pages, records not essays, comparable to
`rfc-streams.md` and `rfc-fibers.md`. Everything after it is a
deliberately **non-conforming attachment**: the normative specification
the implementer works from, section-numbered as the design panel's spec
was so `§4.7`-style cross-references inside it stay meaningful. Read the
first half as the RFC; the appendix is reference, not argument, and its
length is not a house-style precedent.

---

## The problem

`agents/tasks` today is one Lifecycle capability holding named, versioned
durable programs of exactly one shape: `(input, step) => result`. Every
attempt replays the handler from its first line; `step.do()` returns
journaled results without re-executing; `step.sleep()` parks on a durable
deadline; a claim writes a fresh `generation` and every settle is fenced
on it (`rfc-fibers.md`). PR #2274 adds `step.signal`, `step.attempt`,
`step.interrupted`, a run `deadline` and a run-level `interruptions`
budget. That is a good durable-job engine and it is not in question here.

It is also the only shape we ship, and the consumers that need a
different one have each built their own. **Think holds six hand-rolled
machines**: the chat turn (`chat/turn-task.ts`, a `timeout: "1 day"`
single step wrapping a live closure keyed by nonce), the recovery
incident (`chat/recovery-engine.ts`, 1 041 lines, plus
`recovery-incident.ts`, 833), the approval wait
(`cf_think_action_pending_approvals` + `_sweepActionPendingApprovals`,
`think.ts:9651,9738`), the queued request and durable submission
(`cf_think_submissions`, `think.ts:10213-10240`, three purpose-built
indexes), the agent-tool child ledger (`cf_agent_tool_child_runs` +
`cf_agent_tool_milestones`, `think.ts:8419,8447`), and the messenger
reply (`__cf_messenger_recovery:<runId>`, `think.ts:4950`). **The
harnesses hold four more**: the pi lane driver with its
`MAX_PASSES_PER_DRIVER = 4_000` rotation, the codex kernel driver whose
state is a `checkpoint` column on its own table, the self-modifying
turn's attached/queued fork, and — outside this repo — flue's
coordinator. All ten are the same program: park with nothing resident,
wake on a message, do bounded work, commit, repeat.

What the step API cannot express, and why each is structural rather than
missing:

- **Park with nothing resident.** A replayed handler must re-reach its
  park. That is correct for a job with four steps and wrong for a
  conversation parked for a week: the way to wait is to be a phase, not
  to be a stack.
- **A mailbox.** `sendEvent`-shaped delivery into a _running_ program has
  no home, so every consumer built a table plus an idempotency index.
- **Correlated asks.** An approval answered from a WebSocket frame on an
  isolate that has never heard of the run needs an id-addressable
  durable question. Today that is `cf_think_action_pending_approvals`
  plus a sweep.
- **A turn-scoped journal.** `MAX_STEPS_PER_RUN = 10 000`
  (`replay.ts:55`, enforced `:292`) caps a _run_, which is why pi rotates
  its driver every 4 000 passes. A long-lived actor needs the journal to
  retire, and the only safe scope to retire on is the committed state.
- **Abort owning the outcome.** `#runAttempt` re-reads `cancel_requested`
  after the handler returns and settles `cancelled` unconditionally
  (`tasks.ts:1338-1352`). A conversation that wants "cancel this turn,
  keep the conversation" has nowhere to say so.

And the step API remains the right API for the jobs it is for.
`cloudflare:workflows` is the shape Cloudflare developers already know;
`docs/agents/tasks.md` teaches it; `examples/next/tasks` and
`examples/next/streams` are its regression tests; three example harnesses
run real agent loops through `step.do`. Replacing it to gain an actor
model would be a trade we do not have to make.

---

## The proposal

**One capability, one engine, two definition forms in the same
`definitions` map.** A definition is either today's durable function or a
durable state machine, and the second is not a second engine: the first
compiles onto it.

### The durable function — unchanged

```ts
"build-report@v1": async (input: ReportInput, step: TaskStep) => {
  const research = await step.do("research", { retries: { limit: 4 } },
    ({ signal, idempotencyKey }) => this.research(input.topic, { signal, idempotencyKey }));
  await step.sleep("cool-off", "30 seconds");
  const approval = await step.waitForEvent<{ ok: boolean }>("approval", {
    type: "report.approved", timeout: "1 day"
  });
  if (!approval.payload.ok) throw new NonRetryableError("rejected");
  return step.do("publish", () => this.publish(research));
}
```

Replay from the first line, `step.do` / `sleep` / `sleepUntil` / `status`
/ `idempotencyKey` / `signal` / `attempt` / `interrupted`,
`NonRetryableError`, run `deadline` and `interruptions` — all unchanged,
byte-identical idempotency keys included. It gains
`step.waitForEvent(name, { type, timeout })` and `tasks.sendEvent()`,
matching Workflows, with one deliberate superset: an event sent _before_
the run reaches the call is buffered in the mailbox and consumed when it
gets there.

### The durable state machine — code per state, no configuration objects

```ts
"chat@v1": {
  initial: (_seed: Seed): Chat => ({ phase: "idle", turnSeq: 0 }),
  phases: {
    idle: async (s, ctx) => {
      const msg = await ctx.receive({ kind: "message", within: "1 hour" });
      if (msg === ctx.timedOut) return s;
      return { phase: "turn", input: msg.payload, turnSeq: s.turnSeq + 1 };
    },
    turn: async (s, ctx) => {
      const turnId = ctx.memo(`turn:${s.turnSeq}`, nanoid());
      const r = await this.generate(s.input, await ctx.stream(), {
        signal: ctx.signal,
        steer: () => ctx.peekAll({ kind: "message" })
      });
      if (r.needsApproval) {
        return { phase: "awaiting", input: s.input, turnSeq: s.turnSeq,
                 asks: ctx.ask(Approve, r.approvals, { expiresIn: "7 days" }) };
      }
      return { phase: "idle", turnSeq: s.turnSeq };
    },
    awaiting: async (s, ctx) => {
      const decisions = await ctx.answers(s.asks, { within: "7 days" });
      if (decisions === ctx.timedOut) return { phase: "idle", turnSeq: s.turnSeq };
      this.apply(decisions);                       // Decision[], narrowed by the ask kind
      return { phase: "turn", input: s.input, turnSeq: s.turnSeq + 1 };
    }
  },
  onCancel: async (s, ctx) => (s.phase === "idle" ? ctx.complete(0)
                                                 : { phase: "idle", turnSeq: s.turnSeq }),
  migrate: (checkpoint, fromVersion, input) => ({ state: this.carryForward(checkpoint) })
} satisfies TaskMachine<Chat, UserInput, number, Seed>
```

`phases` is a mapped type over the discriminant —
`{ [P in State["phase"]]: (state: Extract<State, { phase: P }>, ctx) => … }`
— so it gives per-phase narrowing, exhaustiveness and unknown-key
rejection in one declaration, with no helper function and no `as const`.
`satisfies TaskMachine<State, Mailbox, Result, Seed>` is the declaration
form; a lint rule requires it on every `definitions` entry.

### One engine, and the type says so

`TaskContext extends TaskStep`. The object a phase handler receives as
`ctx` is the same object a function definition receives as `step` — one
journal, one claim path, one abort protocol. A function definition is
wrapped at dispatch by a single-phase machine whose one phase runs the
function and returns `ctx.complete(...)`; its checkpoint is a singleton
persisted as SQL `NULL`, so its `checkpoint_turn` is 0 forever, its
journal keys are today's keys, and it emits exactly today's eleven
`TaskEventType`s in today's order. "The workflow API is the state machine
with less freedom" is a type-level fact, not a slogan.

### Returning the next state is the commit

One phase handler invocation reads the committed checkpoint, does work,
and returns the next checkpoint or a terminal. That return **is** the
commit: one generation-fenced row write, with the journal of the
retiring turn deleted in the same transaction and a live engine-owned
stream settled in the same SQLite transaction via
`StreamWriter.onCommit`. There is no `setState`, no second commit path,
and no `commitWith`. Nothing durable about a run's own progress is
written outside the checkpoint write, the turn-scoped journal, the
mailbox/ask tables, and a stream the engine owns — and every one of those
is fenced on the attempt's `generation` and on the absence of an abort
mark.

### Parks, the mailbox, asks, children, streams

A phase handler parks by awaiting `ctx.receive` / `receiveAll` /
`answers` / `join` / `sleep` / `sleepUntil` / `waitForEvent`. A park
unwinds the invocation and leaves **nothing resident**: the run row
records `wait_reason` and, for an event-driven park, a NULL `next_at`, so
it holds no alarm at all. Every per-wait timeout is the run's existing
`next_at` column — no extra row — and it dies with the return, which is
Erlang's `state_timeout` semantics for free. A wait's timeout arrives as
a **value**: `ctx.timedOut` is a unit type (`typeof` an unexported unique
symbol) so `===` narrows, and an unguarded `receive()` is a type error
rather than a symbol silently leaking into the checkpoint. Timer
primitives never touch `setAlarm` — the wake queue owns the single
Durable Object alarm.

The **mailbox** is a per-run durable FIFO ordered by `seq` across kinds,
so one `receive()` expresses "a child settles **or** the user steers".
`send` is the only outside-in write; `requestId` dedupe is a primary-key
conflict, so a duplicate writes zero rows and reads nothing. Four modes,
with their costs stated: `receive` parks with nothing resident (1 DELETE
on consume); `peek` is a read (0 writes); steer-at-a-boundary is
`peekAll` (0 writes); `receiveAll` drains k matches in one synchronous
block (k DELETEs). A `send` to a terminal run writes nothing and returns
`{ accepted: false, reason: "terminal" }` — **a mailbox write never
resurrects a run** — and a send that arrives before the handler reaches
its `receive` is buffered, not lost.

**Asks** are correlated durable questions. `ctx.ask(Approve, payloads,
{ expiresIn })` is synchronous, writes one row per ask, and returns
`Pending<Decision>[]` — `{ id }` at runtime, so it serialises into the
checkpoint unchanged. The answer type travels with the _kind_, not with
the run, so `tasks.answer(askId, Approve, { approved: true })` type-checks
from another file. Ask ids embed their run id (`<runId>#<nanoid>`), which
is what makes an id-only answer routable from a WebSocket frame on an
isolate holding nothing in memory.

**Children** record `parent_run_id`; a child's settlement arrives as a
`kind: "child"` mailbox item, and `ctx.join(children, { within })` is
sugar over consuming those items, returning
`{ ok: true; output } | { ok: false; error }` per child rather than
throwing. `background` children are excluded from the abort cascade and
from the default join — structurally, because the exclusion is a column
on the child's own row.

**Streams** are `agents/streams` writers the engine owns:
`ctx.stream(name?)` returns a `StreamWriter` on the current epoch. A
reclaim after an interruption seals the old epoch and rotates, because
`Streams.open` throws `StreamClosedError` on a terminal id
(`streams/streams.ts:227-233`) — seal-and-re-attach is
self-contradictory. The stable `tag` is what a UI follows across epochs.

### `onCancel` and the tiers

`cancel(runId, reason?, { wait? })` marks, signals, joins the live
invocation (bounded by `CLAIM_SLACK_MS`), and then dispatches a **fresh,
fenced, non-reentrant** `onCancel(state, ctx)`. `onCancel` may return a
State — landing there and clearing the mark, which is how a machine
declines a cancel and keeps the conversation alive — or a terminal.
Definitions that declare no `onCancel` get today's behaviour verbatim,
inline: a parked run settles inside `cancel()` in one write, a live run
settles at its next step boundary. That is not a convenience;
`capability.test.ts:641-659` reads the terminal snapshot synchronously
after `await cancel()`, so the fresh-invocation protocol has to be
opt-in. `terminate(runId, reason?)` is the forceful tier: no `onCancel`,
no compensation. `pause`/`resume` stop and restart dispatch without
touching the checkpoint. The full disposition of open asks, unconsumed
mailbox items, the live stream epoch and non-background children across
cancel / terminate / deadline / pause is the table in appendix §6.8.

### Progress: two rules, because they catch two different failures

**Rule A — crash detection.** A turn that changes no checkpoint, parks on
nothing, credits no progress (no journal row completed, no mailbox row
consumed, no ask answered, no memo first-written, no stream segment
landed) has made none. `stall` increments; at `stallLimit` (default 1)
the run fails with `TaskNoProgressError` and `outcome: "faulted"`. Parks
are decided _above_ this rule in the post-turn decision list, so no
exemption list is needed and a legitimate re-park is never faulted.

**Rule B — liveness.** Rule A never catches `{ phase: "idle", n: n + 1 }`
looping forever, because every iteration _is_ progress — an unbounded
loop billing one row write per iteration. `TasksOptions.transitionBudget`
(default 1000) bounds transitions since the last park; exceeding it fails
the run with `TaskTransitionBudgetError` and `outcome: "faulted"`, naming
the last phases in the cycle. A park resets it. The counter is one
`transitions` INTEGER column, written in the same UPDATE as the
checkpoint.

### Versioning

A definition name is `base` or `base@vN`. There is **no replay**, so new
code reads old state — you escape Convex's "the implementation should
stay stable for the lifetime of active workflows", which is disqualifying
for a conversation parked for weeks. You inherit it for _state_ shape
instead, and `@vN` plus `migrate(checkpoint, fromVersion, input)` is the
lever. A live run whose `@vN` is unknown and unmigratable becomes
terminal `failed` with `outcome: "orphaned"`, its checkpoint preserved
even at `retain: false`, costing no alarm, and `tasks.reopen(runId)`
brings it back.

### What a Cloudflare developer sees, side by side

Three things, stated in the docs next to each other rather than buried:

1. **The one-sentence justification.** _The state machine parks with
   nothing resident and costs one SQLite row per transition; the durable
   function does neither._ If that is not visible from the two signatures
   side by side, the second form has not earned its place.
2. **The two guarantees, stated precisely.** (a) _Serialised execution
   per run, earned by generation fencing on a single-threaded object, not
   handed over by input gates_ — input gates are storage-scoped, so a
   handler awaiting a thirty-second model call holds nothing, and the
   `generation` column is what actually serialises. (b) _No replay, so
   new code reads old state_; state-shape versioning is inherited via
   `@vN`.
3. **The two costs owned.** No static transition graph — no
   `toMermaid()`, no `getNextTransitions()`, no model-based testing;
   partially recovered by annotating a handler's return as
   `Promise<Extract<Chat, { phase: "turn" }>>`, which costs nothing. And
   the row arithmetic: **one human approval round trip is
   `idle → turn → awaiting → turn → idle` — four transitions, so four
   checkpoint row writes, plus the run insert and the two index rows it
   touches (`idempotency_key UNIQUE` and `runs_definition`; Cloudflare
   bills a touched index as a row written), plus one ask row per
   approval, plus the `next_at` touches on park and wake.** Eight row
   writes, and at roughly 1000 reads per row write about 8 000
   read-equivalents for one approval. Print it beside the step API's
   per-step cost (one journal INSERT on entry plus one UPDATE at
   completion) and let users choose.

---

## The alternatives

**A separate `agents/machine` package (or a second capability).**
Rejected. Two capabilities means two claim paths, two abort protocols and
two journals, and the second would immediately want `do`/`sleep`/`status`
— which is the first. The step API _is_ the machine with less freedom,
and `TaskContext extends TaskStep` makes that checkable rather than
aspirational. A consumer would also have to install both and choose, for
a distinction the engine does not have.

**Replace the step API outright.** Rejected. `cloudflare:workflows`
parity is a feature, `docs/agents/tasks.md` teaches it, and 70 existing
scenarios (`capability.test.ts` 53, `memory-limit.test.ts` 13,
`agent.test.ts` 4) pin its behaviour. Compiling it onto the engine keeps
every one of them green.

**XState-style configuration objects** — `states` with `entry`/`exit`
slots, string-keyed `actions` implementations, a phantom `types` block, a
per-phase `timeouts` map, dotted hierarchical state values. Rejected as a
family: code per state is the point. Concretely, entry/exit doubles
invocations and row writes for zero expressiveness (one invocation of a
phase handler already _is_ the entry action), and an exit action cannot
be guaranteed to run when the isolate dies mid-phase — so anything that
must run on the way out belongs in `onCancel` or in a compensating pair
where the engine owns the guarantee. The phantom `types` block imposes an
`as const` tax on every returned state.

**The earlier spellings, and why each moved.** `start` → `initial`
(near-universal, and `start` collides with `tasks.run()`); `states` →
`phases` (the map is keyed by the discriminant, so `states` + `phase` is
a mismatch at the one place a reader looks — this is a coherence
argument, not a convergence one; the externally checkable field says
`states` unanimously and we are giving up the discoverable word); one
`turn(task, run)` with a `switch` → one handler per phase (the mapped
type gives narrowing and exhaustiveness that a `switch` in a single
handler gives only by hand); `abort` → `onCancel` (the engine already
says _cancel_ at every layer — `cancel_requested`, `cancel_reason`, the
`cancelled` terminal state — and the `on` prefix answers "it reads like a
verb"); `task` + `run` → one `ctx` (two objects for one runtime was two
mental models, and `ctx` is the survey's split with `state` playing the
data argument); `awaitAnswers` → `answers` parks, `peekAnswers` does not
(it mirrors `receive`/`peek` exactly).

**Decided open questions, one line of reason each.**

- **No `machine()` helper; `satisfies` plus a lint rule.** A helper is a
  second way to declare a definition for a benefit `satisfies` already
  delivers; the narrow hole it closes (a map of parameterless handlers
  compiles clean without `satisfies`) is closed more cheaply by
  requiring `satisfies` on every `definitions` entry.
- **Machine waits return `ctx.timedOut`; `step.waitForEvent` throws
  `TaskEventTimeoutError`.** A thrown timeout composes badly with
  return-the-next-state — you would catch it only to produce a
  transition — and Workflows throws, so the step layer keeps parity.
- **`ctx.peekAnswers(pending)` reads without parking; `ctx.answers(pending,
{ within?, mode? })` parks.** One vocabulary with `receive`/`peek`.
- **Both `ctx.join(children, { within? })` and `receive({ kind: "child" })`.**
  `join` is sugar over child mailbox items and returns
  `ChildResult<T>[] | typeof ctx.timedOut` with
  `{ ok: true; output } | { ok: false; error }` per child; the raw form
  survives because it also expresses "a child settles **or** the user
  steers", which `join` cannot.
- **`tasks.at(name, runId)` beside `handle(name)` and `run()`'s receipt.**
  A per-run typed handle removes the `runId` string from every call site;
  it does not replace `run()`'s return, because `TaskReceipt.accepted` is
  the entire point of durable acceptance.
- **Forceful stop is `terminate` (the Workflows name), not `kill`.**
  `pause`/`resume` exist; there is no `drain`, because `pause` already
  means "stop at the next boundary and keep the checkpoint".
- **`ctx.stream(name?)` returns an `agents/streams` `StreamWriter`,
  named.** One run may own several streams; singular would be a breaking
  change later.
- **No `forkWith`.** Background work is `spawn` or a stream; an
  un-awaited promise is not durable across eviction, and a second commit
  path makes invariant 5 unenforceable.
- **Per-effect `compensate` on `do` is v2.** It needs a compensation
  graph and an ordering model; the effect sandwich (commit intent →
  effect → commit outcome) is expressible today.
- **Mailbox `kind` is a free string**, with the payload typed by the
  `Mailbox` generic — a closed kind union would be a second naming space
  to keep in sync between `send` and `receive`.
- **`ctx.aborted(reason?)` stays** as the terminal `onCancel` uses to
  settle `cancelled` with the mark's reason.
- **Progress is Rule A _and_ Rule B.** Rule A alone cannot catch a
  state-changing infinite loop; Rule B alone would fault a healthy
  handler.

**Rejected borrowings from the survey, one line each.**

- `ctx.uuid()` / positional counters — a call-ordinal key is stable only
  if the ordinal is, which quietly reintroduces the replay determinism
  this design escapes; derive the memo _name_ from a checkpoint ordinal.
- `Behaviors.same` — an allocation optimisation for a resident actor that
  would make Rule A unenforceable.
- A per-phase `timeouts:` config map — put the timeout on the wait, where
  the return cancels it.
- Entry/exit actions — see above.
- A phantom `types: {} as {…}` block — pure inference workaround, and it
  taxes every returned state with `as const`.
- A fluent builder DSL — an object-literal map plus `keyof D` accumulates
  the same facts for free, without ten-overload signatures.
- `setState` on `ctx` — if returning the next state is the commit, a
  second writer makes "which write wins" a user question.
- A second `version` field beside `@vN` — two version namespaces that can
  disagree is a bug generator; the run row already stores `definition`.
- Replay-based determinism (Temporal / Convex / Vercel) — wrong trade for
  a library whose runtime is the user's own Durable Object class.
- gen_statem `postpone` — selective `receive({ kind })` subsumes it with
  no re-queue write.
- Rivet-style throttled auto-save — a one-second data-loss window by
  default; the return value _is_ the write.

**Pico5's shape.** Taken: the effect sandwich, the fresh fenced abort
invocation, `orphaned` for an unresolvable definition, and
inbox-as-a-document as the idea. Not taken: SQLite row economics change
the answers — the inbox is a _table_ with a `(run_id, key)` primary key
rather than a document, because dedupe then costs an `ON CONFLICT DO
NOTHING` with zero reads and zero index writes, and a document rewrite
per message would bill a row per steer. Likewise one capability rather
than a separate session runtime.

**The harness RFC's tables** (`rfc-codex-harness-capability.md`,
`rfc-pi-harness-example.md`) are subsumed, not competed with:
`cf_agents_harness_inbox` → the mailbox; `cf_agents_harness_requests` →
asks; harness "operations" → phases; the 4 000-pass driver rotation → a
turn-scoped journal retired at every checkpoint change.

**Akka Persistence's event/state split**
(`(State, Command) => Effect[Event, State]` plus a pure event handler).
Rejected explicitly rather than overlooked: it buys replay and audit at
the cost of a second serialised type and a second concept, and this
engine's whole premise is that there is no replay to reconstruct.

---

## The decision

**Pending discussion.**

Already decided by the maintainer, and not reopened by this RFC:

- **One capability, one engine, two definition forms** in the same
  `definitions` map — a durable function and a durable state machine —
  with `TaskContext extends TaskStep` and a function definition compiled
  onto the engine as a single-phase machine.
- **Names:** `initial` (a State value, or `(seed) => State`, the function
  form carrying the typed run seed), `phases`, discriminant `phase`,
  handler `(state, ctx)`, `onCancel`, `ctx`. `start`, `states`, `turn`,
  `abort` and `run` do not appear in the shipped surface.
- **Every item in the locked surface**: `satisfies` enforced by a lint
  rule with no helper; `ctx.timedOut` as a unit type on machine waits and
  `TaskEventTimeoutError` on `step.waitForEvent`; `peekAnswers` /
  `answers`; both `ctx.join` and `receive({ kind: "child" })`;
  `tasks.at(name, runId)` beside `handle(name)` and `run()`'s
  `TaskReceipt`; `terminate` / `pause` / `resume`, no `drain`, no `kill`;
  `ctx.stream(name?)` → `StreamWriter`; no `forkWith`; `compensate`
  deferred to v2; free-string mailbox `kind`; `ctx.aborted(reason?)`;
  progress Rule A **and** Rule B (`transitionBudget`, default 1000,
  `TaskTransitionBudgetError`, `outcome: "faulted"`, one `transitions`
  column); typed asks via `defineAsk` / `AskKind` / `Pending<A>`;
  branded `TaskTerminal<R extends TaskValue>`; `TaskState<D>` /
  `TaskOutput<D>` inferred from the return position — `TaskOutput` from
  `onCancel`'s as well as `phases`', since a machine's only terminal is
  often in `onCancel` (§2.8); `State` constrained to `{ phase: string }`
  only, with an opt-in structural `AssertJson<T>`.
- **`register(name, def)` keeps its name**, is promoted from "do not use"
  to documented `@internal`, and returns a `TaskInternalHandle` whose
  `run(input, { start })` is what the apertures were for. **The two
  `__DO_NOT_USE_WILL_BREAK__` apertures are deleted in this release**,
  and every in-repo caller moves in the same PR — onto the handle where
  the name is reserved, onto public `run(..., { start })` where it is
  not; the sequencing is in
  [tasks-cleanup-plan.md](./tasks-cleanup-plan.md).
- **The full feature ships in one release.** Nothing in the appendix is
  deferred except what §13 lists.
- **Breaking changes are allowed on the experimental `agents/tasks`
  surface** and are named in the changeset (§14.7). The root `agents`
  entrypoint and the `agents/chat` subpath are _not_ experimental and are
  untouched by this release.

---

# Appendix: normative specification

Section numbers are the design panel's, kept so `§n.m` cross-references
resolve. Where the spec and the API survey disagreed and the decisions
above do not settle it, the spec wins and the line says so.

## 1. Vocabulary and invariants

1. **Task definition** — one named, versioned durable program. Two forms,
   one engine: a **machine** `{ initial, phases, onCancel?, migrate? }`,
   or a **function** `(input, step) => result`. The constructor map is
   the registry, rebuilt on every wake (`tasks.ts:291-306`).
2. **Run** — one durable instance of a definition, addressed by `runId`.
   `runId` is the address: `run()` with an existing `runId` joins
   (`accepted: false`, `tasks.ts:1104-1146`).
3. **Checkpoint** — the run's durable state. For a machine it is the
   `State` union; for a function it is a fixed singleton that serializes
   to SQL `NULL`.
4. **Transition** — one invocation of one phase handler. **Returning the
   next checkpoint is the commit**: one generation-fenced row write.
   There is no second commit path.
5. **Invariant — the state is the commit.** Nothing durable about a run's
   own progress is written outside (a) the checkpoint write, (b) the
   turn-scoped journal, (c) the mailbox/ask tables, (d) a stream the
   engine owns. Every one of those is fenced on the attempt's generation
   and on the absence of an abort mark.
6. **Invariant — one engine, two APIs.** `TaskContext extends TaskStep`.
   A function definition is compiled to a single-phase machine whose one
   handler replays the function; `step.do` **is** `ctx.do` on the same
   journal, the same claim path, the same abort protocol.
7. **Invariant — a compiled function definition is behaviourally
   unchanged.** Its checkpoint never changes, so its turn counter is
   always 0, its journal keys are today's keys, its idempotency keys are
   byte-identical, and it emits exactly today's eleven `TaskEventType`s
   in today's order.
8. **Progress** — a monotone per-run counter of real durable work:
   journal rows completed, mailbox rows consumed, asks answered, memos
   first-written, and stream segments landed (derived from the chunk log
   at commit, never per append — the rule `ResumableStream.progressMarker`
   established, `chat/resumable-stream.ts:302-316`).
9. **Progress, Rule A (crash detection)** — a transition that changes no
   checkpoint, parks on nothing, and credits no progress has made none.
   `stall` increments; at `stallLimit` (default 1) the run fails with
   `TaskNoProgressError` and `outcome: 'faulted'`. Parks are decided
   **above** this rule (§5.4 rule 5 above rule 9), so no exemption list
   is needed.
10. **Progress, Rule B (liveness)** — `transitionBudget` (default 1000)
    bounds transitions since the last park. Exceeding it fails the run
    with `TaskTransitionBudgetError` and `outcome: 'faulted'`, naming the
    last phases. A park resets it. Rule A cannot catch a loop whose
    checkpoint differs every time; Rule B is that bound.
11. **Abort mark** — a durable `abort_mark` ∈
    `cancel | deadline | turn-deadline | parent | seal`. It is inside the
    fence predicate of every checkpoint-advancing write, so a live
    transition cannot commit past it. The engine **never invents an
    outcome**: `onCancel` owns it.
12. **Fresh cancel invocation** — when a definition declares `onCancel`,
    the engine signals the live invocation, **joins** it, and then
    dispatches `onCancel(state, ctx)` in a fresh invocation. With no
    `onCancel` the cancel is **inline**, matching today's `cancel()`
    timing exactly (`capability.test.ts:641-659` reads the terminal
    snapshot synchronously after `await cancel()`).
13. **Mailbox** — a per-run durable FIFO. `send` is the only outside-in
    write; `requestId` dedupe happens as a primary-key conflict, before
    any row is written.
14. **Ask** — a correlated durable question raised by a transition,
    answerable from any later isolate with **only the ask id**. Ask ids
    embed their run id (`<runId>#<nanoid>`), which is what makes an
    id-only `answer` routable.
15. **Ownership tree** — a spawned child records `parent_run_id`; abort
    cascades down it; `background` children are excluded from the cascade
    and from the default join.
16. **Outcome vs state** — `TaskRunState` keeps its six values and its
    `CHECK` constraint untouched. `faulted` and `orphaned` ride an
    `outcome` column beside `state: 'failed'`, which is what keeps the
    v2→v3 runs-table migration a plain `ALTER TABLE ADD COLUMN`.
17. **Serialised execution per run is earned, not free.** Cloudflare's
    input gates are storage-scoped, so a handler awaiting a model call
    for thirty seconds holds no mutual exclusion. What serialises a run
    is the `generation` column and the fence predicate on every mutation.
    Claim that, not "a Durable Object gives it to you".
18. **Discriminant-placement rule.** Two things route off the committed
    checkpoint and nothing else: an `answer(askId)` is admitted only if
    the checkpoint names that ask as outstanding, and the set of
    consumable messages is whatever `receive` call the _current_ phase
    handler makes. Therefore **any data that changes which asks can be
    answered or which messages can be consumed must live in the
    discriminated phase, not in a payload field**. `{ phase: "awaiting";
asks }` is correct; `{ phase: "turn"; pendingAsks }` is a bug,
    because two `turn` checkpoints would admit different answers under
    one phase key.

---

## 2. Public API

### 2.1 Definitions and the capability

```ts
/** A definition is either a machine or a Workflows-shaped function. */
export type TaskDefinition =
  | TaskMachine<any, any, any, any>
  | ((input: never, step: TaskStep) => TaskValue | Promise<TaskValue>);

/** Constraint for a Tasks definitions map. */
export type TaskDefinitions = Record<string, TaskDefinition>;

/** Back-compat alias: today's function-only constraint. */
export type TaskHandlers = Record<
  string,
  (input: never, step: TaskStep) => TaskValue | Promise<TaskValue>
>;

export interface TasksOptions<D extends TaskDefinitions = TaskCallbacks> {
  /** Named definitions; the map is the registry, rebuilt every wake. */
  readonly definitions?: D;
  /** Default step retry policy, overridable per `step.do()`. Unchanged. */
  readonly retries?: TaskRetryConfig;
  /** Default timeout of one step callback attempt. Default 5 minutes. Unchanged. */
  readonly stepTimeout?: number | TaskDurationString;
  /** Default per-transition watchdog. Defaults to `stepTimeout`. */
  readonly turnTimeout?: number | TaskDurationString;
  /** Rule A: consecutive no-progress transitions tolerated. Default 1. */
  readonly stallLimit?: number;
  /** Rule B: max transitions since the last park. Default 1000. */
  readonly transitionBudget?: number;
  /** Max unconsumed mailbox rows per run before `send` throws. Default 1000. */
  readonly mailboxLimit?: number;
  /** Observe terminal run failures, including ones recorded without a handler. */
  readonly onError?: (
    error: unknown,
    run: TaskFailedRun
  ) => void | Promise<void>;
}
```

### 2.2 The machine form

```ts
/** The checkpoint's only structural requirement. NOT `& TaskJson` — see §2.8. */
export type TaskPhased = { phase: string };

export interface TaskMachine<
  State extends TaskPhased,
  Mailbox = never,
  Result extends TaskValue = void,
  Seed = void
> {
  /** The checkpoint a fresh run starts from: a value, or a function of the
   *  run seed. The function form is what carries a typed seed (§2.8).
   *  Runs once, at accept, and must be re-runnable: anything
   *  non-deterministic in it belongs behind `ctx.memo`. */
  readonly initial: State | ((seed: Seed) => State);

  /** One handler per phase. The mapped type is what gives narrowing,
   *  exhaustiveness and unknown-key rejection with no helper. */
  readonly phases: {
    [P in State["phase"]]: (
      state: Extract<State, { phase: P }>,
      ctx: TaskContext<State, Mailbox, Result, Seed>
    ) => Promise<State | TaskTerminal<Result>>;
  };

  /** Cancel transition; owns the outcome. Runs in a fresh, fenced,
   *  non-reentrant invocation. May not park. Returning a State lands
   *  there and clears the mark. */
  readonly onCancel?: (
    state: State,
    ctx: TaskContext<State, Mailbox, Result, Seed>
  ) => Promise<State | TaskTerminal<Result>>;

  /** Carry an older version's checkpoint forward. Absent ⇒ `orphaned`. */
  readonly migrate?: (
    checkpoint: TaskJson,
    fromVersion: number,
    input: TaskJson
  ) => { state: State; input?: Seed };
}

/** Opaque terminal marker; only `ctx.complete/fail/aborted` produce one.
 *  The brand is NOT exported, so `{ done: true, result: 1 }` fails with
 *  "Property '[taskTerminal]' is missing", and a forgotten `return` fails
 *  as `Promise<void>`. `Result` is CONSTRAINED to `TaskValue`: without the
 *  constraint `TaskOutput<D>` infers an unconstrained `X`, resolves to
 *  `unknown`, and every `TaskRunSnapshot<TaskOutput<D>>` /
 *  `TaskRunView<TaskOutput<D>, …>` use site in §2.5 fails `TS2344`. */
declare const taskTerminal: unique symbol;
export type TaskTerminal<Result extends TaskValue> = {
  readonly [taskTerminal]: Result;
};

/** A UNIT type, so `x === ctx.timedOut` narrows. An object-typed sentinel
 *  narrows nothing and leaks into the committed checkpoint. */
declare const taskTimedOut: unique symbol;
export type TaskTimedOut = typeof taskTimedOut;

export type TaskChildRef = {
  readonly runId: string;
  readonly definition: string;
  readonly background: boolean;
  readonly ownerKey?: string; // set when the child lives on another facet
};
```

### 2.3 `TaskStep` — today's surface, plus `waitForEvent`

Unchanged members are marked ✓ (identical declaration and semantics to
`types.ts` at #2274).

```ts
export interface TaskStep {
  readonly attempt: number; // ✓
  readonly interrupted: {
    readonly name: string;
    readonly attempt: number;
  } | null; // ✓
  readonly signal: AbortSignal; // ✓
  do<T extends TaskValue>(
    name: string,
    cb: (a: TaskStepAttempt) => T | Promise<T>
  ): Promise<T>; // ✓
  do<T extends TaskValue>(
    name: string,
    config: TaskStepConfig,
    cb: (a: TaskStepAttempt) => T | Promise<T>
  ): Promise<T>; // ✓
  sleep(name: string, duration: number | TaskDurationString): Promise<void>; // ✓
  sleepUntil(name: string, when: number | Date): Promise<void>; // ✓
  status(message: string): Promise<void>; // ✓
  /** Stable external dedupe key. `scope:"run"` survives a checkpoint change. */
  idempotencyKey(name: string, options?: { scope?: "turn" | "run" }): string;
  /** NEW. Park until a matching event arrives; journaled under `name`.
   *  Throws `TaskEventTimeoutError` on timeout (Workflows parity). */
  waitForEvent<T extends TaskJson>(
    name: string,
    options: { type: string; timeout?: number | TaskDurationString }
  ): Promise<TaskStepEvent<T>>;
}

/** Mirrors `WorkflowStepEvent<T>` (workers-types experimental/index.d.ts:15430-15435). */
export interface TaskStepEvent<T> {
  readonly payload: Readonly<T>;
  readonly timestamp: Date;
  readonly type: string;
}
```

`idempotencyKey(name)` returns `${runId}:${name}` for a function
definition (byte-identical to `engine-port.ts`'s `stepIdempotencyKey`)
and `${runId}:t${turn}:${name}` inside a machine transition;
`{ scope: "run" }` returns `${runId}:${name}` in both. §3.4 states the
rule normatively.

### 2.4 `TaskContext` — the per-handler runtime

```ts
export interface TaskContext<
  State extends TaskPhased,
  Mailbox = never,
  Result extends TaskValue = void,
  Seed = void
> extends TaskStep {
  // ── run facts, as of this attempt's claim ──────────────────────────────
  readonly id: string; // runId
  readonly definition: string; // full name, `base@vN`
  readonly version: number; // N
  readonly input: Seed; // the run seed; written once at accept, never re-committed
  readonly turn: number; // checkpoint generation, 0-based
  readonly progress: number; // durable work credited so far
  readonly children: readonly TaskChildRef[]; // owned, non-terminal
  readonly background: boolean;
  readonly metadata?: Record<string, TaskJson>;
  readonly createdAt: number;

  // ── mailbox ────────────────────────────────────────────────────────────
  /** Park until one matching visible item; consume and return it. */
  receive(
    filter?: TaskMailboxFilter & { within?: number | TaskDurationString }
  ): Promise<TaskMailboxItem<Mailbox> | TaskTimedOut>;
  /** Park until at least one matches, then drain every match in one block. */
  receiveAll(
    filter?: TaskMailboxFilter & { within?: number | TaskDurationString }
  ): Promise<TaskMailboxItem<Mailbox>[] | TaskTimedOut>;
  /** Non-consuming, non-parking look at the next matching item. */
  peek(filter?: TaskMailboxFilter): TaskMailboxItem<Mailbox> | undefined;
  /** Non-consuming, non-parking look at every matching visible item. */
  peekAll(filter?: TaskMailboxFilter): TaskMailboxItem<Mailbox>[];
  /** Remove a still-queued item by key. False when it was already consumed. */
  withdraw(key: string): boolean;

  // ── asks ───────────────────────────────────────────────────────────────
  /** Raise durable correlated questions. Synchronous; one row write per ask. */
  ask<P, A>(
    kind: AskKind<P, A>,
    payloads: readonly P[],
    options?: TaskAskOptions
  ): Pending<A>[];
  /** Park until answers land (`all` by default, or the first under `any`). */
  answers<A>(
    pending: readonly Pending<A>[],
    options?: { within?: number | TaskDurationString; mode?: "all" | "any" }
  ): Promise<A[] | TaskTimedOut>;
  /** Read answers already durable, without parking. Mirrors peek/peekAll. */
  peekAnswers<A>(pending: readonly Pending<A>[]): (A | undefined)[];

  // ── run-scoped values ──────────────────────────────────────────────────
  /** First-writer-wins value that survives checkpoint changes. Nonces live
   *  here — derive the NAME from a checkpoint ordinal for fresh-but-stable. */
  memo<T extends TaskJson>(name: string, candidate: T): T;
  /** Read form; usable from `onCancel`. */
  memo<T extends TaskJson>(name: string): T | undefined;

  // ── children ───────────────────────────────────────────────────────────
  /** Start an owned child. Its settlement arrives as a mailbox item. */
  spawn(
    definition: string,
    input?: TaskJson,
    options?: TaskSpawnOptions
  ): Promise<TaskReceipt>;
  /** Sugar over consuming `kind:"child"` items until all named children settle. */
  join<T extends TaskValue>(
    children: readonly (TaskChildRef | TaskReceipt | string)[],
    options?: { within?: number | TaskDurationString }
  ): Promise<TaskChildResult<T>[] | TaskTimedOut>;

  // ── streams ────────────────────────────────────────────────────────────
  /** An engine-owned output stream. Settles with the checkpoint write. */
  stream(name?: string, options?: TaskStreamOptions): Promise<StreamWriter>;

  // ── liveness and progress ──────────────────────────────────────────────
  /** Push the transition deadline forward. Throttled to one write per 15 s. */
  heartbeat(): void;
  /** Credit work the stream log cannot see (a forwarded child's output). */
  creditProgress(units?: number): void;

  // ── terminals ──────────────────────────────────────────────────────────
  complete(result: Result): TaskTerminal<Result>;
  fail(error: unknown): TaskTerminal<Result>;
  aborted(reason?: string): TaskTerminal<Result>;
  /** The unit-typed timeout sentinel returned by every `within` wait. */
  readonly timedOut: TaskTimedOut;
  /** The mark that caused this cancel transition; null inside a phase handler. */
  readonly cancelling: TaskAbortMark | null;
}

export type TaskAbortMark =
  | "cancel"
  | "deadline"
  | "turn-deadline"
  | "parent"
  | "seal";

export type TaskChildResult<T extends TaskValue> =
  | { readonly ok: true; readonly runId: string; readonly output: T }
  | { readonly ok: false; readonly runId: string; readonly error: TaskError };

export interface TaskMailboxFilter {
  kind?: string | readonly string[];
  type?: string | readonly string[];
  key?: string;
  limit?: number;
}

export interface TaskMailboxItem<Payload = TaskJson> {
  readonly key: string; // requestId when one was supplied
  readonly seq: number; // FIFO order within the run
  readonly kind: string; // free string; "child" is engine-written
  readonly type?: string;
  readonly payload: Payload;
  readonly createdAt: number;
}

export interface TaskAskOptions {
  /** Duration or epoch ms after which the batch's asks flip to `expired`. */
  expiresIn?: number | TaskDurationString;
  /** JSON carried alongside for the UI. */
  metadata?: Record<string, TaskJson>;
}

/** The answer type travels with the ask KIND, not with the run. */
declare const askPayload: unique symbol;
declare const askAnswer: unique symbol;
export interface AskKind<P, A> {
  readonly name: string;
  readonly [askPayload]?: P;
  readonly [askAnswer]?: A;
}
export declare function defineAsk<P, A>(name: string): AskKind<P, A>;
/** `{ id }` at runtime, so it serialises into the checkpoint unchanged. */
export interface Pending<A> {
  readonly id: string;
  readonly [askAnswer]?: A;
}

export interface TaskAskRecord {
  readonly askId: string;
  readonly runId: string;
  readonly name: string;
  readonly state: TaskAskState; // "open" | "answered" | "expired" | "withdrawn"
  readonly question?: TaskJson;
  readonly answer?: TaskJson;
  readonly metadata?: Record<string, TaskJson>;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly answeredAt?: number;
}

export interface TaskSpawnOptions extends TaskRunOptions {
  /** Excluded from the abort cascade and from `receive({kind:"child"})`. */
  background?: boolean;
  /** Deliver the child's terminal outcome as a mailbox item. Default true. */
  notify?: boolean;
  /** Route the child onto another Lifecycle (a facet). */
  owner?: LifecycleRouteAddress;
}

export interface TaskStreamOptions {
  /** Stable UI identity across epochs. Defaults to `${runId}:${name}`. */
  tag?: string;
  metadata?: Record<string, StreamJson>;
  /** Opt out of engine ownership: no rotation, no cutover, no progress credit. */
  streamId?: string;
}
```

**Members proposed and cut, with reasons** — `ctx.commitWith(fn)` (a
second commit path makes invariant 5 unenforceable —
`StreamWriter.onCommit` is a hook _inside_ the one commit, §9.2); a
nameless `sleep(until)` (two ways to park on a clock; the named one is
turn-scoped, so the loop-index problem that motivated it is gone); a
`merge` send policy (`receiveAll` is the reader-side verb and already
expresses it); capability-level `tasks.ask()` (an ask is a question a
transition raises; an outside-in question is a `send`); `ctx.setState`
(if the return is the commit there must be exactly one writer);
`ctx.forkWith` (see The alternatives).

### 2.5 Run options, the capability, and handles

```ts
export interface TaskRunOptions {
  idempotencyKey?: string; // ✓
  runId?: string; // ✓ — the address; joins get-or-create
  metadata?: Record<string, TaskJson>; // ✓
  retain?: boolean; // ✓ (see §6.6 for faulted/orphaned)
  interruptions?: TaskRetryConfig; // ✓
  deadline?: number | Date; // ✓
  /** Per-transition watchdog for this run. Defaults to the capability's. */
  turnTimeout?: number | TaskDurationString;
  /**
   * Who drives the first attempt. `warm` and `queued` return on durable
   * acceptance; `attached` additionally drives that first attempt in the
   * caller's invocation and awaits it to its next durable boundary
   * (§5.11).
   */
  start?: "warm" | "queued" | "attached";
  /** Owned by another run. Set by `ctx.spawn`; rejected on the public surface. */
  parent?: never;
  background?: boolean;
}

export class Tasks<
  D extends TaskDefinitions = TaskCallbacks
> extends LifecycleCapability {
  constructor(options?: TasksOptions<D>);

  /** Durably accept one run and return a receipt. Same `runId`/key joins. */
  run<N extends keyof D & string>(
    definition: N,
    input?: TaskInput<D[N]>,
    options?: TaskRunOptions
  ): Promise<TaskReceipt>;
  /** A typed lens over one definition's runs. */
  handle<N extends keyof D & string>(
    definition: N
  ): TaskHandle<D[N], TaskInput<D[N]>, TaskState<D[N]>, TaskOutput<D[N]>>;
  /** A typed handle on ONE run. Does not replace `run()`'s receipt. */
  at<N extends keyof D & string>(
    definition: N,
    runId: string
  ): TaskRunHandle<D[N]>;
  /** @internal Framework aperture: register one reserved `__cf`-prefixed definition. */
  register(name: string, definition: TaskDefinition): TaskInternalHandle;

  /** Append one item to a run's mailbox. `requestId` dedupes before any write. */
  send(
    runId: string,
    payload: TaskJson,
    options?: TaskSendOptions
  ): Promise<TaskSendReceipt>;
  /** Workflows spelling of `send(..., { kind: "event", type })`. */
  sendEvent(
    runId: string,
    event: { type: string; payload: TaskJson; requestId?: string }
  ): Promise<TaskSendReceipt>;
  /** Remove a still-queued mailbox item. */
  withdraw(runId: string, key: string): Promise<boolean>;

  /** Answer one ask from anywhere, with only its id. Typed by the kind. */
  answer<P, A>(
    askId: string,
    kind: AskKind<P, A>,
    answer: A
  ): Promise<TaskAnswerReceipt>;
  /** Withdraw an open ask; the row is kept for the UI. */
  withdrawAsk(askId: string): Promise<boolean>;
  /** List asks, optionally for one run. */
  asks(options?: {
    runId?: string;
    state?: TaskAskState;
  }): Promise<TaskAskRecord[]>;

  get(runId: string): Promise<TaskRunSnapshot<TaskValue> | null>; // ✓
  getByIdempotencyKey(key: string): Promise<TaskRunSnapshot<TaskValue> | null>; // ✓
  list(options?: TaskListOptions): Promise<TaskRunSnapshot<TaskValue>[]>; // ✓
  /** The deep view: checkpoint, mailbox, asks, children, stream cursor, status. */
  view(runId: string): Promise<TaskRunView<TaskValue> | null>;
  /** Subscribe to change events for one run. Returns an unsubscribe. */
  watch(runId: string, listener: (change: TaskChange) => void): () => void;

  /** Request cooperative cancellation. True when a non-terminal run took the mark. */
  cancel(
    runId: string,
    reason?: string,
    options?: { wait?: boolean }
  ): Promise<boolean>;
  /** Force terminal without running `onCancel`. False on an already-terminal run. */
  terminate(runId: string, reason?: string): Promise<boolean>;
  /** Stop dispatching. A live transition is not interrupted. */
  pause(runId: string): Promise<boolean>;
  /** Resume a paused run. False when it was not paused. */
  resume(runId: string): Promise<boolean>;
  /** Re-resolve an `orphaned` run against the now-registered definition. */
  reopen(runId: string): Promise<boolean>;
  delete(options?: TaskDeleteOptions): Promise<number>; // ✓

  onStart(): Promise<void>; // ✓
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void>; // ✓
  onRoute(context: LifecycleRouteContext): Promise<unknown>; // ✓
  onMemoryLimit(context: MemoryLimitContext): Promise<void>; // ✓
  /** @internal Tri-capability contract with Scheduler and Queue. Unchanged signature. */
  __DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix(prefix: string): Promise<void>; // ✓
  // DELETED: `__DO_NOT_USE_WILL_BREAK__runAttached` and
  // `__DO_NOT_USE_WILL_BREAK__enqueue`. `register(name, def).run(input, { start })`
  // replaces both, and every in-repo caller moves in the same PR (§5.11).
}

export interface TaskInternalHandle {
  readonly name: string;
  run(input?: unknown, options?: TaskRunOptions): Promise<TaskReceipt>; // accepts `start`
}

export interface TaskSendOptions {
  /** Deduplication key. A repeat writes zero rows. Becomes the item's `key`. */
  requestId?: string;
  kind?: string;
  type?: string;
  /** How this send interacts with unconsumed items of the same kind+type. */
  policy?: "append" | "latest" | "drop" | "debounce";
  /** With `policy:"debounce"`: make the item visible this many ms from now. */
  debounceMs?: number;
}
export interface TaskSendReceipt {
  readonly accepted: boolean; // false: terminal run, duplicate requestId, or `drop`
  readonly key: string;
  readonly reason?: "duplicate" | "dropped" | "terminal" | "limit";
}
export interface TaskAnswerReceipt {
  readonly accepted: boolean; // false: already answered, expired, withdrawn, unknown
  readonly reason?:
    | "duplicate"
    | "expired"
    | "withdrawn"
    | "unknown"
    | "terminal";
}
```

`TaskHandle` is `Task` widened with the **definition type** as its first
parameter, a `State` parameter, and the machine verbs; the existing four
members keep their declarations. `D` on the lens is load-bearing, not
tidiness: it is what lets `at()` return a typed per-run handle and what
makes the three machine verbs conditional. Without it they can only be
declared unconditionally with concrete parameter types — so the comment
"these are `never`-typed on a function definition" would be false, and
`tasks.handle("build-report@v1").send("r1", {…})` on a _function_
definition would compile — `at()` can only return `TaskRunHandle<unknown>`,
whose `send(payload: TaskMailbox<unknown>)` is `send(payload: never)` and
therefore uncallable at all, and §14.4 step 4's "a function handle does
not expose `send`" probe cannot be written.

```ts
export interface TaskHandle<D, Input, State, Output extends TaskValue> {
  readonly name: string;
  run(input: Input, options?: TaskRunOptions): Promise<TaskReceipt>; // ✓
  get(runId: string): Promise<TaskRunSnapshot<Output> | null>; // ✓
  getByIdempotencyKey(key: string): Promise<TaskRunSnapshot<Output> | null>; // ✓
  cancel(runId: string, reason?: string): Promise<boolean>; // ✓
  at(runId: string): TaskRunHandle<D>;
  // machine definitions only — `never`, and so uncallable, on a function
  // definition, which is what the conditional buys over a plain method:
  send: D extends { phases: unknown }
    ? (
        runId: string,
        payload: TaskMailbox<D>,
        options?: TaskSendOptions
      ) => Promise<TaskSendReceipt>
    : never;
  view: D extends { phases: unknown }
    ? (runId: string) => Promise<TaskRunView<Output, State> | null>
    : never;
  watch: D extends { phases: unknown }
    ? (
        runId: string,
        listener: (change: TaskChange<State>) => void
      ) => () => void
    : never;
}
/** Back-compat alias retained: `Task<Input, Output>` =
 *  `TaskHandle<unknown, Input, unknown, Output>` — an untyped definition, so
 *  the three machine verbs read `never` on it, which is the honest answer
 *  for a lens that does not know its definition's shape. */
export type Task<Input, Output extends TaskValue> = TaskHandle<
  unknown,
  Input,
  unknown,
  Output
>;

/** One run, typed by its definition. Obtained from `tasks.at(name, runId)`. */
export interface TaskRunHandle<D> {
  readonly runId: string;
  readonly definition: string;
  send(
    payload: TaskMailbox<D>,
    options?: TaskSendOptions
  ): Promise<TaskSendReceipt>;
  sendEvent(event: {
    type: string;
    payload: TaskJson;
    requestId?: string;
  }): Promise<TaskSendReceipt>;
  answer<P, A>(
    askId: string,
    kind: AskKind<P, A>,
    answer: A
  ): Promise<TaskAnswerReceipt>;
  withdraw(key: string): Promise<boolean>;
  get(): Promise<TaskRunSnapshot<TaskOutput<D>> | null>;
  view(): Promise<TaskRunView<TaskOutput<D>, TaskState<D>> | null>;
  watch(listener: (change: TaskChange<TaskState<D>>) => void): () => void;
  cancel(reason?: string, options?: { wait?: boolean }): Promise<boolean>;
  terminate(reason?: string): Promise<boolean>;
}
```

### 2.6 Snapshots, views, events

`TaskRunSnapshot` keeps every field it has today, with **one breaking
change**: the `waiting` arm's `wakeAt` becomes optional, because an
event-driven park legitimately has no wake time and `rowToSnapshot`'s
`wakeAt: row.next_at ?? row.updated_at` (`store.ts`) would otherwise
report a past timestamp as a future wake.

```ts
| {
    runId: string; definition: string; state: "waiting";
    reason: TaskWaitReason;
    /** Absent for an event-driven park (mailbox, event, ask, child, paused). */
    wakeAt?: number;
    createdAt: number; statusMessage?: string; metadata?: Record<string, TaskJson>;
  }
```

Every terminal arm gains `outcome?: "faulted" | "orphaned"`; the
`running`/`waiting` arms gain `abortRequested?: true` and
`abortReason?: string`. `snapshot.state` keeps its meaning — the run
state, not the checkpoint. **The checkpoint is read from `view()`**;
renaming `state` would edit 41 assertion sites and break every external
consumer for a naming preference.

```ts
export type TaskWaitReason =
  | "sleep"
  | "retry"
  | "interrupted" // existing
  | "mailbox"
  | "event"
  | "ask"
  | "child"
  | "paused"; // new

export interface TaskRunView<Output extends TaskValue, State = unknown> {
  readonly snapshot: TaskRunSnapshot<Output>;
  readonly checkpoint: State;
  readonly turn: number;
  readonly progress: number;
  readonly transitions: number;
  readonly mailbox: readonly TaskMailboxItem[];
  readonly asks: readonly TaskAskRecord[];
  readonly children: readonly TaskChildRef[];
  readonly streams?: readonly {
    readonly name: string;
    readonly tag: string;
    readonly streamId: string;
    readonly epoch: number;
    readonly cursor: number;
    readonly state: StreamState;
  }[];
}

export type TaskChangeType =
  | "accepted"
  | "claimed"
  | "checkpoint"
  | "status"
  | "progress"
  | "mailbox"
  | "ask"
  | "answer"
  | "child"
  | "waiting"
  | "settled";
export interface TaskChange<State = unknown> {
  readonly type: TaskChangeType;
  readonly runId: string;
  readonly view: TaskRunView<TaskValue, State>;
}
```

`watch` carries no `from` cursor: a resumable cursor needs a durable
change log, i.e. one row write on the hottest paths. A late subscriber
calls `view()` once and then listens — sound, and free. It is
hibernation-safe because it holds nothing durable: a subscriber that dies
with its isolate re-subscribes and re-reads `view()`.

**Event types.** Today's eleven (`options.ts`) are unchanged and remain
the complete set a compiled function definition emits. Machine
definitions additionally emit `task:transition:started`,
`task:checkpoint`, `task:mailbox`, `task:ask`, `task:answer`,
`task:child`, `task:faulted`, `task:orphaned`, `task:paused`,
`task:resumed`.

### 2.7 Errors

Existing, unchanged: `NonRetryableError`, `DuplicateTaskStepError`,
`TaskReplayDivergedError`, `MissingTaskDefinitionError`,
`TaskInterruptionsExhaustedError`, `TaskDeadlineExceededError`,
`TaskSerializationError`.

New:

| Error                           | Raised when                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskNoProgressError`           | progress Rule A fires; run fails with `outcome:'faulted'`                                                                                                   |
| `TaskTransitionBudgetError`     | progress Rule B fires — `transitionBudget` transitions since the last park; run fails with `outcome:'faulted'`, message naming the last phases in the cycle |
| `TaskTurnDeadlineExceededError` | the per-transition watchdog fires and the default inline cancel settles the run                                                                             |
| `TaskCancelCannotParkError`     | an `onCancel` transition calls a parking member                                                                                                             |
| `TaskConcurrentParkError`       | a second parking member is awaited while one park is pending                                                                                                |
| `TaskEventTimeoutError`         | `waitForEvent`'s `timeout` elapses (Workflows throws here too)                                                                                              |
| `TaskMailboxFullError`          | `send` would exceed `mailboxLimit`                                                                                                                          |
| `TaskCheckpointTooLargeError`   | a returned checkpoint exceeds the checkpoint cap (§4.7); subclass of `TaskSerializationError` so existing catches still match                               |
| `TaskOrphanedDefinitionError`   | a live run's `@vN` is unknown and unmigratable; recorded with `outcome:'orphaned'`                                                                          |

**Rescoped.** `DuplicateTaskStepError` now means "used twice **within one
turn**" — `ReplayStep.#usedNames` is already per-invocation
(`replay.ts:239`), and dispatching another phase handler in the same
invocation constructs a fresh journal scope, so a name reused across
turns is legal and is exactly what a looping actor wants.
`TaskReplayDivergedError` now means "the journal row at
`(run_id, turn, name)` records a different `kind` than this replay asks
for" — divergence is detected within a turn only, because a checkpoint
change retires the previous turn's rows.

### 2.8 Types: the checkpoint, the extractors, and `satisfies`

The constraint on a definitions map is
`Record<string, TaskMachine<any, any, any, any> | TaskFn>`. Five probes
were run with `tsc --strict` on this repo's TypeScript:

| Probe                                                                           | Result                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `TaskMachine<any, any, any, any>` accepts a concrete machine                 | ✅ compiles                                                                                                                                                                                                                                         |
| 2. `TaskMachine<never, never, never, never>` accepts one                        | ❌ rejects every concrete machine — a handler's return `State \| TaskTerminal<R>` is not assignable to `never \| TaskTerminal<never>`                                                                                                               |
| 3. `TaskMachine<TaskJson & TaskPhased, …>` accepts one                          | ❌ same rejection, and separately rejects `interface`-spelled state with a seven-line index-signature error                                                                                                                                         |
| 4. `satisfies TaskMachine<State, Mailbox, Result, Seed>` at the definition site | ✅ per-phase narrowing; a missing phase is `TS2741` naming the missing key first, an unknown phase key `TS2353`, a wrong field `TS2339`, an out-of-union return and a forged terminal both error, and a forgotten `return` fails as `Promise<void>` |
| 5. **omitting** `satisfies`                                                     | ⚠️ partially silent. A handler that _touches_ its parameters is `TS7006` ×2 under `noImplicitAny`; a map of **parameterless** handlers with a bogus phase key and a missing required field compiles completely clean                                |

Therefore: **no helper is shipped.** `satisfies TaskMachine<…>` is the
documented form and is already this repo's idiom (`index.ts:1321`
documents `satisfies TaskHandlers` the same way), and **a lint rule
requires it on every `definitions` entry**, which closes probe 5's
remaining hole more cheaply than a branded `machine<…>({…})` wrapper —
which would additionally cost all contextual typing if it carried
branded diagnostics. Omission is a typing loss, never a correctness
loss. `tests-d/tasks-export.test-d.ts` pins probes 1–5 _including_ the
degraded shape, so a future change making omission loud is reviewed
rather than accidental.

**State is constrained to `TaskPhased` only.** Constraining to
`TaskPhased & TaskJson` rejects the spelling most users reach for first
(`interface UserInput { text: string }`). Serialisability is enforced two
other ways: an opt-in structural `AssertJson<T>` next to the state
declaration, and the runtime check at the first commit (`serialization.ts`
already owns that layer), which also enforces the 256 KiB checkpoint cap
(§4.7) and names the offending key path.

```ts
type TaskJsonish<T> = T extends string | number | boolean | null | undefined
  ? true
  : T extends readonly (infer E)[]
    ? TaskJsonish<E>
    : T extends Function
      ? false
      : T extends object
        ? { [K in keyof T]-?: TaskJsonish<T[K]> }[keyof T] extends true
          ? true
          : false
        : false;
/** Walks properties structurally, so `interface` members are accepted. */
export type AssertJson<T> =
  TaskJsonish<T> extends true ? T : { CHECKPOINT_NOT_SERIALISABLE: T };
```

**Extractors.** `TaskState` and `TaskOutput` infer from the **return**
position of the phases map: inferring a discriminated union from a
parameter position is contravariant, so multiple candidates intersect and
the union collapses to `never`. `TaskOutput` reads the return position of
`onCancel` **as well as** of `phases`, because a machine's only terminal
is often in `onCancel` — the `chat@v1` example of The proposal is exactly
that shape, and reading `phases` alone types it `void` where its declared
`Result` is `number`.

```ts
export type TaskInput<D> = D extends (
  input: infer I,
  ...rest: never[]
) => unknown
  ? I
  : D extends { initial: (seed: infer S) => unknown }
    ? S
    : D extends { phases: unknown }
      ? void
      : never;

export type TaskState<D> = D extends {
  phases: Record<string, (s: never, c: never) => Promise<infer R>>;
}
  ? Exclude<R, TaskTerminal<TaskValue>>
  : unknown;

export type TaskOutput<D> = D extends {
  phases: Record<string, (s: never, c: never) => Promise<infer R>>;
  onCancel?: (s: never, c: never) => Promise<infer R2>;
}
  ? [Extract<R | R2, TaskTerminal<TaskValue>>] extends [never]
    ? void
    : Extract<R | R2, TaskTerminal<TaskValue>> extends TaskTerminal<infer X>
      ? X extends TaskValue
        ? X
        : never
      : never
  : D extends (...args: never[]) => infer O
    ? Awaited<O> extends TaskValue
      ? Awaited<O>
      : never
    : never;

export type TaskMailbox<D> = D extends {
  phases: Record<
    string,
    (s: never, c: TaskContext<never, infer M, never, never>) => unknown
  >;
}
  ? M
  : never;
```

Three details are load-bearing and were each found by compiling the
declarations rather than reading them. (a) `TaskTerminal<Result>`
constrains `Result` to `TaskValue` (§2.2); without that, `infer X` is
unconstrained, `TaskOutput<D>` is `unknown`, and every use site in §2.5
that passes it to `TaskRunSnapshot<Output extends TaskValue>` or
`TaskRunView<Output extends TaskValue, …>` fails `TS2344`. (b) The
`[Extract<…>] extends [never] ? void` arm is wrapped in a tuple because a
bare `never extends TaskTerminal<infer X>` is _true_ and infers `X` as
`unknown`, so the naive `… ? X : void` spelling never reaches its `void`
arm. (c) The inner `X extends TaskValue ? X : never` is what today's
shipped `TaskOutput` (`types.ts:74-80`) already does on the function
branch; the machine branch needs it for the same reason. All four
extractors, and the whole §2.5 handle surface, compile clean under
`tsc 5.9.3 --strict` with these three in place.

Also recommended, and free: annotate a handler's return as
`Promise<Extract<Chat, { phase: "turn" }>>` to make the compiler enforce
that phase's legal successors. It partially recovers the static
transition graph this design gives up (§13).

### 2.9 Workflows correspondence

| `cloudflare:workflows` (workers-types `experimental/index.d.ts`)                  | `agents/tasks`                                                     | Same?                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowStep.do(name, config?, cb)` :15470-15488                                 | `step.do` / `ctx.do`                                               | shape same; we pass `TaskStepAttempt` where Workflows passes `WorkflowStepContext`, and we have no `rollbackOptions` (§13)                                 |
| `WorkflowStepConfig.retries/timeout` :15404-15412                                 | `TaskStepConfig`                                                   | same names; no `sensitive`, no `WorkflowDelayFunction` (§13)                                                                                               |
| `WorkflowBackoff` :15402                                                          | `TaskRetryConfig.backoff`                                          | identical union                                                                                                                                            |
| `step.sleep` / `sleepUntil` :15489-15490                                          | same names, same arity                                             | ✅                                                                                                                                                         |
| `step.waitForEvent(name, { type, timeout })` :15491-15497                         | same                                                               | shape ✅; **buffering differs** — see below                                                                                                                |
| `WorkflowStepEvent<T>` :15430-15435                                               | `TaskStepEvent<T>`                                                 | `payload`, `timestamp`, `type`; no `sensitive`                                                                                                             |
| `NonRetryableError` :17021                                                        | re-exported, and any error named `"NonRetryableError"` is honoured | ✅ (`errors.ts`, unchanged)                                                                                                                                |
| `WorkflowInstance.sendEvent({type,payload})` :17157                               | `tasks.sendEvent(runId, {type, payload})`                          | ✅ plus optional `requestId`                                                                                                                               |
| `WorkflowInstance.status(): InstanceStatus` :17153, `InstanceStatus` :17080-17095 | `tasks.get()` snapshot                                             | mapped in §9.5                                                                                                                                             |
| `WorkflowInstance.pause/resume` :17134,:17138                                     | `tasks.pause/resume`                                               | adopted with one stated deviation                                                                                                                          |
| `WorkflowInstance.terminate(options?)` :17143                                     | `tasks.terminate(runId, reason?)`                                  | adopted; no `rollback` option                                                                                                                              |
| `WorkflowInstance.restart(options?)` :17149                                       | —                                                                  | not adopted (§13)                                                                                                                                          |
| `WorkflowInstanceStatus.waitingForPause` :15499-15508                             | —                                                                  | **no analogue.** Our `pause()` does not interrupt a live transition; the run reads `running` until it parks or settles, then `waiting` + `reason:"paused"` |

**`waitForEvent` deviations, stated normatively.**

1. **Buffering.** An event sent before the run reaches the call is stored
   in the mailbox and consumed when the call is reached. Workflows makes
   no such promise. This is a deliberate superset and the reason
   approvals work at all (§8).
2. **Keys.** `name` is the _journal_ key (what memoizes the result across
   replays); `type` is the _match_ key. Two calls with the same `type`
   and different `name`s consume two distinct events, in call order.
3. **Timeout.** Elapsing throws `TaskEventTimeoutError`, retryable at the
   run level like any other thrown error — Workflows also throws. The
   machine layer's `within` waits return `ctx.timedOut` instead; the two
   layers differ deliberately, because a thrown timeout does not compose
   with return-the-next-state.

**`pause`/`resume` deviations.** `pause()` sets `paused = 1` and cancels
the wake mirror; a live transition runs to its next park or terminal,
then parks with `reason:"paused"`. `resume()` on a run that is not paused
returns `false` (Workflows `resume()` throws); we return a value rather
than throwing everywhere else — booleans on `cancel`, `withdraw`,
`withdrawAsk`, `terminate` and `reopen`, a receipt on `send` and `answer`
— and throwing here would be the only exception.

**`terminate` deviation.** Workflows errors on an already-terminal
instance; ours returns `false`, matching `cancel()` (`tasks.ts:975-1000`).
`terminate` lands on `state:'cancelled'` with `cancel_reason` set and
`outcome` unset — there is no new `terminated` state, because adding one
would change the `state` `CHECK` constraint and force a table rebuild
(§4.8).

---

## 3. The layering: how a step definition compiles onto the engine

### 3.1 The compilation

A function definition `f` is wrapped, at dispatch, by exactly this
machine:

```ts
/** The one phase every compiled function definition has. */
type TaskFnState = { phase: "run" };

const compiled = {
  initial: { phase: "run" } as TaskFnState,
  phases: {
    run: async (_s, ctx) => ctx.complete(await f(ctx.input, ctx))
  }
  // no `onCancel` — the inline default (§6.4)
  // no `migrate` — a function definition's checkpoint carries no shape
} satisfies TaskMachine<TaskFnState, never, Result, Input>;
```

- **The checkpoint is a singleton, persisted as SQL `NULL`.** The engine
  recognises the compiled singleton and writes `checkpoint = NULL`, so
  the column stays NULL for every function run. That is what the v2→v3
  migration leaves untouched on existing rows (§4.8) and what keeps
  `checkpoint_turn` at 0 forever.
- **`ctx` is `step`.** `TaskContext extends TaskStep`, and the object
  handed to the phase handler is the same `ReplayStep` instance `f`
  receives, so `step.do` and `ctx.do` are one method on one journal.
  There is no second journal, no second claim path, no second abort
  protocol.
- **`f` returning** is `ctx.complete(value)`, which is the terminal write
  today's `#runAttempt` already performs (`tasks.ts:1340-1370`).

### 3.2 Journal mapping, and why a park does not retire it

The journal key is `(run_id, turn, name)`. **`turn` advances only when
the committed checkpoint's serialized bytes differ from the bytes the
transition started with.** A park re-enters the _same_ turn.

Consequences, in order:

1. A function definition's checkpoint is always `NULL`, so `turn` is
   always 0, so its journal keys are `(run_id, 0, name)` — isomorphic to
   today's `(run_id, step_name)`.
2. `step.sleep` parks (`TaskSuspension`, `replay.ts:66-77`), the run
   wakes, and the handler replays from its first line **into the same
   turn**, finding every completed `do` row intact. This is the single
   most important consequence: had retirement been keyed on invocation
   rather than on checkpoint change, every sleep would wipe the journal
   and re-execute every completed step. It does not.
3. Retirement (`DELETE FROM cf_agents_task_journal WHERE run_id = ? AND
turn = ?`) happens in the same transaction as the checkpoint write,
   for the _previous_ turn. A machine's `ctx.do("charge")` in turn 1 and
   turn 7 are two engine-intended executions and get two rows.
4. `turn = -1` is reserved for run-scoped rows (`kind = 'memo'`), which
   retirement never touches.

### 3.3 Sleep, waitForEvent, and re-entry

| Call                                     | First execution                            | Park                                                              | Wake                              | Replay                                                                                                                            |
| ---------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `step.sleep(name, d)`                    | INSERT `kind:'sleep'`, `next_at`           | `wait_reason:'sleep'`, `next_at` set                              | claim, replay from top, same turn | row `completed` ⇒ return; row still future ⇒ park again (first deadline authoritative, `replay.ts:#sleepAt`)                      |
| `step.waitForEvent(name,{type,timeout})` | INSERT `kind:'event'`, `next_at = timeout` | `wait_reason:'event'`; `next_at` = the timeout, or NULL when none | a `send` wakes it, or the timeout | row `completed` ⇒ return the journaled `TaskStepEvent`; row `running` ⇒ try to consume one matching mailbox item, else park again |
| `step.do` retry park                     | as today                                   | `wait_reason:'retry'`                                             | as today                          | as today                                                                                                                          |

`waitForEvent`'s consume is one synchronous block: read the oldest
visible mailbox row matching `kind='event' AND type=?`, DELETE it, UPDATE
the journal row to `completed` with the event as its result. Two row
writes, and the event is memoized from then on.

### 3.4 Idempotency keys

Normative rule:

```
idempotencyKey(name)                      // function definition  → `${runId}:${name}`
idempotencyKey(name)                      // machine transition   → `${runId}:t${turn}:${name}`
idempotencyKey(name, { scope: "run" })    // either               → `${runId}:${name}`
```

A function definition is a single-phase machine whose `turn` is always 0,
and its key form deliberately omits the turn segment so it is
**byte-identical** to `engine-port.ts`'s `stepIdempotencyKey`. The two
forms coexist because they are keyed on the definition kind, which is
fixed for the life of a run. A machine that genuinely wants one external
dedupe key across turns asks for `scope:"run"` and gets the same string
the function form would have produced.

### 3.5 Retries, timeouts, deadlines

| Concept                                       | Where it lives after the change                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| per-step `retries` / `timeout`                | unchanged: `ReplayStep.#executeAttempt`, `resolveStepPolicy`                                       |
| capability `retries` / `stepTimeout` defaults | unchanged                                                                                          |
| run `deadline`                                | unchanged: `#enforceDeadline`, `#nextWake` brings it forward                                       |
| run `interruptions`                           | unchanged: counted on a `running` reclaim, cleared at any self-powered park (`tasks.ts:1230-1246`) |
| **new** run `turnTimeout`                     | the per-transition watchdog; `turn_deadline_at`, claim window = it + `CLAIM_SLACK_MS`              |

For a **function** definition the transition deadline is refreshed by
every step attempt (`refreshClaim()` at `replay.ts:424`, throttled to
`CLAIM_SLACK_MS / 2`), so it can only fire when no step has started for a
full `turnTimeout` — which is precisely today's claim-backstop
behaviour, unchanged, and which none of the 70 existing scenarios
reaches. For a **machine** transition that calls no step,
`ctx.heartbeat()` is the explicit refresh, and `ctx.stream()`'s writer
calls it for free once per throttle window on append.

### 3.6 `step.interrupted`

Derived exactly as today (`tasks.ts:1552-1560`), with the journal query
scoped to the current turn:

```sql
SELECT name, attempt FROM cf_agents_task_journal
WHERE run_id = ? AND turn = ? AND state = 'running'
ORDER BY started_at DESC LIMIT 1
```

It is still read **only** on a claim that follows an interruption
(`afterInterruption`), which is what keeps the documented caveat true: a
step retry park can leave a `Promise.all` sibling mid-execution with no
isolate lost, and that is not evidence of an interruption. For a function
definition `turn` is always 0, so the predicate is literally today's. A
sibling left `running` when the checkpoint changes is deleted with the
rest of that turn's rows — it can never be misread in a later turn.
`ctx.interrupted` is the same member, inherited: a machine re-entering
after a lost isolate needs it _more_ than a function does, because a
phase body is unjournaled and `ctx.attempt > 1` is true for every
transition after the first and therefore carries no information.

### 3.7 Concurrency rules on `ctx`

- `ctx.do` calls may overlap under `Promise.all` — unchanged, and
  explicitly supported.
- `ctx.receive`, `ctx.receiveAll`, `ctx.answers`, `ctx.join`, `ctx.sleep`,
  `ctx.sleepUntil`, `step.waitForEvent` are **parking** members. At most
  one may be in flight; a second throws `TaskConcurrentParkError`. A park
  unwinds the whole invocation, so "park concurrently with a `do`" is not
  a thing the engine can honour, and failing loudly beats silently
  discarding a sibling.
- `ctx.peek`, `ctx.peekAll`, `ctx.peekAnswers`, `ctx.ask`, `ctx.memo`,
  `ctx.withdraw`, `ctx.status`, `ctx.heartbeat`, `ctx.creditProgress` are
  non-parking and may be called anywhere.
- `ctx.spawn` and `ctx.stream` are async but non-parking.

### 3.8 The progress rule is unreachable for compiled step definitions

**Premise.** A compiled handler's body is
`ctx.complete(await f(input, ctx))`. Every `step.do`, `step.sleep` and
`step.waitForEvent` writes a journal row on first entry. Therefore any
path through `f` either (a) writes at least one journal row, (b) parks,
(c) returns, reaching `ctx.complete` — a terminal, or (d) throws,
reaching §5.4 rule 6.

**Theorem.** §5.4 rule 9 ("no checkpoint change, no park, no progress")
requires all of ¬(a), ¬(b), ¬(c), ¬(d) simultaneously. The premise shows
the four are exhaustive. Rule 9 is therefore unreachable on the compiled
path. Rule B is likewise unreachable: a compiled definition has exactly
one transition.

This is a proof from the premise, not an enumeration of test cases —
which is what makes it hold for consumer code the repo has never seen.

### 3.9 Event-sequence rule

**Normative:** _a compiled function definition emits exactly the eleven
`TaskEventType`s declared in `options.ts`, in the order the current
engine emits them. Machine-only event types are emitted only for machine
definitions._

This is what preserves `capability.test.ts:311-319`, which asserts full
equality of
`["task:accepted","task:attempt:started","task:step:started","task:step:completed","task:step:started","task:step:completed","task:completed"]`
— and `capability.test.ts:1712-1714`, which asserts `task:waiting` is
**not** emitted on an unbounded interruption replay.

### 3.10 Checklist: every existing step scenario still holds

70 scenarios: `capability.test.ts` 53 (5 + 28 + 20 across its three
describes), `memory-limit.test.ts` 13, `agent.test.ts` 4. Reproduce the
counts with `grep -c "  it(" packages/agents/src/tests/tasks/*.test.ts`.

| Scenario class                                                                | Why it holds                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| acceptance, dedupe, receipts, `runId`/key conflict (147, 232, 945, 955, 1875) | `#accept` unchanged except for the base-name comparison (§11.2)                                                                                                                                                                                                                                                                  |
| warm/queued/attached start (287, 325, 338, 375)                               | `start` carries the same three `TaskStartMode` values `#accept` already takes — **plus**, for `attached`, the drive-and-await tail that lives in the aperture body today (`if (receipt.accepted) await this.#executeRun(receipt.runId)`, `tasks.ts:681–683`), since `#accept` itself branches only on `"warm"` (`tasks.ts:1168`) |
| journaled steps, exact event sequence (287)                                   | §3.9                                                                                                                                                                                                                                                                                                                             |
| step retry park + replay without re-execution (415, 1038)                     | journal at turn 0; park re-enters the same turn (§3.2)                                                                                                                                                                                                                                                                           |
| interrupted reclaim, journal replay (455, 979, 1608)                          | §3.6; the interrupted query is literally today's at turn 0                                                                                                                                                                                                                                                                       |
| durable sleep, first deadline authoritative (512)                             | §3.3 row 1                                                                                                                                                                                                                                                                                                                       |
| `NonRetryableError` + `onError` (574)                                         | untouched                                                                                                                                                                                                                                                                                                                        |
| live gate on replayed `status` (592)                                          | `ReplayStep.#live` untouched                                                                                                                                                                                                                                                                                                     |
| cancel parked / cancel live (641, 661)                                        | inline default cancel (§6.4); `cancel()` still settles synchronously                                                                                                                                                                                                                                                             |
| step timeout on a signal-deaf callback (676)                                  | `#raceTimeout` untouched                                                                                                                                                                                                                                                                                                         |
| duplicate names, replay divergence (688, 700)                                 | rescoped to the turn; both are turn 0 here (§2.7)                                                                                                                                                                                                                                                                                |
| missing definition (737)                                                      | `MissingTaskDefinitionError` still fails the run; `outcome` stays unset unless `@vN` parsing finds a version mismatch (§11.3)                                                                                                                                                                                                    |
| shared alarm with Scheduler (765)                                             | wake mirror unchanged                                                                                                                                                                                                                                                                                                            |
| dispatch-budget detach (792)                                                  | unchanged; the re-entry loop only ever _shortens_ a transition                                                                                                                                                                                                                                                                   |
| platform-failure deferral (825, 859)                                          | `#settleThrown`'s platform branch untouched                                                                                                                                                                                                                                                                                      |
| retention (893, 915, 933)                                                     | plus the delete cascade of §4.6                                                                                                                                                                                                                                                                                                  |
| oversized input (945)                                                         | unchanged; the checkpoint cap is separate (§4.7)                                                                                                                                                                                                                                                                                 |
| all 20 run-budget scenarios (1077-1936)                                       | `interruptions`, `deadline`, backoff parks, zero-delay replay, budget-clear-on-park, schema v1 upgrade: every one is a run-row concern the transition loop does not touch                                                                                                                                                        |
| all 13 memory-limit scenarios                                                 | §5.7; the only edits are the mechanical ones below                                                                                                                                                                                                                                                                               |
| all 4 Agent scenarios                                                         | `taskDefinitions` bridge widened (§14.4 step 3); `agent.test.ts:120`'s `parked.wakeAt` comparison still compiles with `wakeAt` optional                                                                                                                                                                                          |

**Mechanical edits required — four classes, ~24 call sites, zero
semantic change**, the fourth being the aperture call-site moves this
release makes mandatory (§5.11, §14.4 step 2):

1. `memory-limit.test.ts:534` — `cf_agents_task_steps` →
   `cf_agents_task_journal`.
2. `tests/capabilities/tasks.ts:641` — `seedTaskStep` →
   `seedTaskJournal`, one extra `turn: 0` field, taken at each of its
   **13** call sites: `capability.test.ts:477, 714, 998, 1005, 1166,
1173, 1425, 1432, 1680, 1687`, `memory-limit.test.ts:514`,
   `agent.test.ts:79`, and — outside `tests/tasks/` and easy to miss —
   `tests/streams/capability.test.ts:584`.
3. The `memory-limit.test.ts:497` sealing test keeps all three assertions
   (run row gone, journal rows gone, wake job gone) against the new
   cascade, plus one added assertion that the mailbox and ask tables are
   empty for that run.
4. The call-site moves the spec scheduled here — the eight
   `__DO_NOT_USE_WILL_BREAK__enqueue` sites (`memory-limit.test.ts:189,
229, 277, 347, 380, 606` and `capability.test.ts:328, 830`, all of
   which pass **non-reserved** names, so public `run()` accepts them) and
   `capability.test.ts:127`'s `runAttached("__cf_test_registered", …)` —
   move to `tasks.run(name, input, { start: "queued" })` and
   `tasks.register(name, def).run(input, { start: "attached" })`. They
   move **in this release**, because the apertures they call are gone
   with it.

---

## 4. Storage

Schema version **3**. Everything on `cf_agents_task_runs` is a plain
`ALTER TABLE ADD COLUMN`, following the v1→v2 precedent in `store.ts`
(`addRunBudgetColumns`) — the `state` `CHECK` constraint is never
touched, so the runs table is never rebuilt.

### 4.1 `cf_agents_task_runs` — added columns

```sql
ALTER TABLE cf_agents_task_runs ADD COLUMN checkpoint TEXT;              -- serialized State; NULL for function definitions
ALTER TABLE cf_agents_task_runs ADD COLUMN checkpoint_turn INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN definition_base TEXT;         -- `definition` with @vN stripped
ALTER TABLE cf_agents_task_runs ADD COLUMN definition_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN outcome TEXT;                 -- NULL | 'faulted' | 'orphaned'
ALTER TABLE cf_agents_task_runs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN stream_retired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN stall INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN transitions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN abort_mark TEXT;              -- NULL | cancel | deadline | turn-deadline | parent | seal
ALTER TABLE cf_agents_task_runs ADD COLUMN abort_reason TEXT;
ALTER TABLE cf_agents_task_runs ADD COLUMN turn_deadline_at INTEGER;
ALTER TABLE cf_agents_task_runs ADD COLUMN turn_timeout_ms INTEGER;
ALTER TABLE cf_agents_task_runs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE cf_agents_task_runs ADD COLUMN parent_owner_key TEXT;
ALTER TABLE cf_agents_task_runs ADD COLUMN parent_notify INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cf_agents_task_runs ADD COLUMN background INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN stream_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_agents_task_runs ADD COLUMN stream_tag TEXT;
```

Column duties: `checkpoint` is the machine state; `checkpoint_turn` is
the journal scope and advances only on a checkpoint change;
`definition_base`/`definition_version` are **derived once at insert or
migrate** and are what `#accept`'s conflict check and definition
resolution compare on (§11.2); `outcome` carries the two non-`state`
terminal qualities; `progress` and `stream_retired` are stamped-derived
(like `chunk_count` on a settled stream row), not maintained per event;
`stall` is Rule A's counter and `transitions` is Rule B's, both written
in the same UPDATE as the checkpoint; `abort_mark` is the write barrier
and the fence's second predicate; `turn_deadline_at` is the watchdog and
the source of the claim window; `parent_*`/`background` are the ownership
tree; `stream_epoch`/`stream_tag` are the engine-owned stream's identity.

`cancel_requested` and `cancel_reason` are **kept and still written** —
in the same UPDATE that sets `abort_mark = 'cancel'` — so
`rowToSnapshot`'s `cancelled` arm and every test reading it are
untouched, at zero extra row writes.

Indexes: the existing `(definition, created_at)` index stays. **One new
index:**

```sql
CREATE INDEX IF NOT EXISTS cf_agents_task_runs_parent
ON cf_agents_task_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
```

Justified by the store's own stated rule: an index is worth its per-write
tax only when its columns never change after insert. `parent_run_id` is
written once at insert and never again, exactly like `definition`.
Without it, an abort cascade is a full-table scan on every cancel.

**Partial, not plain.** SQLite indexes NULL keys too, so a plain index
would be touched — and billed as a row written — by every top-level run's
insert, to store nothing but padding; measured, that is 4 billed rows per
accept instead of 3. `listChildren`'s `parent_run_id = ?` implies
`parent_run_id IS NOT NULL`, so the partial index is still the one SQLite
chooses (`EXPLAIN QUERY PLAN`: `SEARCH cf_agents_task_runs USING INDEX
cf_agents_task_runs_parent (parent_run_id=?)`), and §4.6's arithmetic —
"+1 `runs_parent` index when `parent_run_id` is set" — is true only in
this form.

### 4.2 `cf_agents_task_journal` — replaces `cf_agents_task_steps`

```sql
CREATE TABLE IF NOT EXISTS cf_agents_task_journal (
  run_id TEXT NOT NULL,
  turn INTEGER NOT NULL,              -- checkpoint_turn; -1 = run-scoped (memos)
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('do', 'sleep', 'event', 'memo')),
  state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'completed', 'failed')),
  result TEXT,
  error_name TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (run_id, turn, name)
) WITHOUT ROWID;
```

No secondary index: every read is a full or prefix match on the PK
(`(run_id, turn)` for retirement and the interrupted-step scan;
`(run_id, turn, name)` for `readStep`), and a `WITHOUT ROWID` table's PK
_is_ its b-tree.

### 4.3 `cf_agents_task_mailbox`

```sql
CREATE TABLE IF NOT EXISTS cf_agents_task_mailbox (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,                  -- requestId when supplied, else 'm' || seq
  seq INTEGER NOT NULL,               -- FIFO order within the run
  kind TEXT NOT NULL,                 -- free string; 'child' and 'event' are engine-written
  type TEXT,                          -- sendEvent/waitForEvent match key; NULL otherwise
  payload TEXT,
  visible_after INTEGER,              -- durable debounce; NULL = visible now
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, key)
) WITHOUT ROWID;
```

**PK `(run_id, key)` and no secondary index.** Dedupe becomes an
`ON CONFLICT DO NOTHING`, i.e. one statement, zero reads, zero extra
index writes. FIFO ordering is applied **in memory** over the run's own
PK prefix range, whose size is bounded by `mailboxLimit` (default 1000) —
not by `ORDER BY seq`, which would build a temp b-tree on top of that
range, since `seq` is not part of the key. Sorting a bounded range in
memory costs zero row writes, which is exactly the trade `store.ts`
already makes when it declines a `(state, next_at)` index, and the same
one `listAsks` makes below.

`seq` is assigned `COALESCE(MAX(seq), -1) + 1` over that same range, read
in the same synchronous block as the INSERT. A Durable Object runs one
synchronous block at a time, so the read-then-insert cannot interleave.
Reuse of a low `seq` after a full drain is harmless: the value is only
ever compared within the set of live rows, and a new row always outranks
every survivor.

`kind` is a free string (the `Mailbox` generic types the payload, not the
kind), so the column carries no `CHECK`. This is the one place the final
surface loosens the spec, which had
`CHECK (kind IN ('message','event','child'))`.

### 4.4 `cf_agents_task_asks`

```sql
CREATE TABLE IF NOT EXISTS cf_agents_task_asks (
  ask_id TEXT PRIMARY KEY,            -- '<runId>#<nanoid>' — the prefix is for legibility, NOT for routing
  run_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  name TEXT NOT NULL,
  question TEXT,
  answer TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'expired', 'withdrawn')),
  expires_at INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
) WITHOUT ROWID;
```

`ask_id` as the sole PK is what makes `tasks.answer(askId, kind, value)`
work from a WebSocket frame on a later isolate with nothing in memory —
the caller has one string and the engine needs nothing else. It resolves
the owner by reading the ask row's own `run_id` (or the route table for a
facet), never by splitting the id: the run-id prefix is there so a human
reading a log can tell which run an ask belongs to. Every ask operation
carries the owner predicate for the same reason — a forged or stale id
must read nothing rather than another run's row. `name` is the
`AskKind`'s name, which is also what the typed `answer` checks against.

Listing a run's asks is a **scan filtered on `run_id`**, not the `ask_id`
prefix scan an earlier draft assumed: a run id is caller-chosen and may
itself contain `'#'`, so the prefix range `[runId + '#', …)` could reach
another run's asks. No `run_id` index is added to avoid it — the index
would tax every ask INSERT with an index row write to accelerate a delete
path and the view read, and the set a run owns is bounded by the
checkpoint cap. `listAsks` orders in memory rather than in SQL so the
scan does not also build a temp b-tree.

### 4.5 `cf_agents_task_routes` — root-side owner index

```sql
CREATE TABLE IF NOT EXISTS cf_agents_task_routes (
  run_id TEXT PRIMARY KEY,
  owner_path TEXT NOT NULL,
  owner_path_key TEXT NOT NULL,
  parent_run_id TEXT,
  parent_owner_key TEXT,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cf_agents_task_routes_owner  ON cf_agents_task_routes (owner_path_key);
CREATE INDEX IF NOT EXISTS cf_agents_task_routes_parent ON cf_agents_task_routes (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
```

**This table exists because the wake-mirror job cannot be the owner
index.** `#syncWake` computes `#nextWake`, and a run whose `next_at` and
`deadline_at` are both NULL causes
`this.lifecycle.jobs.cancel(jobId)` (`tasks.ts:791-800` local branch;
`#syncRoutedWake` at `:856-866` for the routed mirror). §5.12 says a
mailbox/ask/child park legitimately carries a NULL `next_at`. So the
moment a facet-hosted run parks on an ask with no deadline, the wake
mirror is _deleted_ and the root would lose every record of which facet
owns it — breaking `tasks.answer(askId)` and `tasks.send(runId, …)` at
the root, which is exactly where approvals arrive.

The route row is written at accept and deleted at settle or subtree
cleanup. It exists only for **routed** runs; a root-local run pays
nothing. Both indexes are on columns written once at insert, and the
parent one is partial for the reason §4.1 gives: a route row for a
top-level run carries a NULL parent, and an index entry for it would be
one more billed row write per accept for nothing.

### 4.6 Row writes per operation

"Job" = one `cf_agents_jobs` row, elided where noted. Counts exclude
index rows except where an index is touched (noted).

| Operation                                    | Rows written                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run()` / accept, local                      | 1 run (+1 `idempotency_key` unique index, touched even when the value is NULL; +1 `runs_definition` index; +1 `runs_parent` index when `parent_run_id` is set) + ≤1 job |
| `run()` / accept, routed                     | as above, on the facet + 1 route row + ≤1 job on the root                                                                                                               |
| `send`, plain, target live in this isolate   | 1 mailbox; **wake elided** (the park boundary re-reads before parking)                                                                                                  |
| `send`, plain, target parked                 | 1 mailbox + 1 job                                                                                                                                                       |
| `send`, duplicate `requestId`                | **0** (`ON CONFLICT DO NOTHING`)                                                                                                                                        |
| `send`, `policy:"latest"`                    | 1 DELETE touching k rows + 1 INSERT (k is normally 1 ⇒ 2)                                                                                                               |
| `send`, `policy:"drop"` with an item present | **0** (a read)                                                                                                                                                          |
| `send`, `policy:"debounce"` re-arm           | 1 (`ON CONFLICT DO UPDATE SET visible_after`)                                                                                                                           |
| `send` to a terminal run                     | **0**, `{accepted:false, reason:"terminal"}`; never resurrects                                                                                                          |
| `send` routed (root → facet owner)           | 1 route read on the root, then the owner's own count above                                                                                                              |
| `receive`                                    | 1 DELETE                                                                                                                                                                |
| `receiveAll` draining k                      | k DELETEs, one synchronous block                                                                                                                                        |
| `withdraw`                                   | 1 (or 0 when already consumed)                                                                                                                                          |
| `peek` / `peekAll` / `peekAnswers`           | **0**                                                                                                                                                                   |
| **transition** (checkpoint changed)          | 1 fenced run UPDATE + j DELETEs retiring the previous turn's journal + ≤1 job                                                                                           |
| re-entry (progress, no checkpoint change)    | 1 fenced run UPDATE (progress, stall reset)                                                                                                                             |
| park                                         | 1 fenced run UPDATE (`state='waiting'`, reason, next_at) + ≤1 job                                                                                                       |
| `do` first entry                             | 1 INSERT + 1 UPDATE at completion (unchanged from today)                                                                                                                |
| `do` journal hit                             | **0**                                                                                                                                                                   |
| `sleep` first entry, future                  | 1 INSERT (unchanged)                                                                                                                                                    |
| `sleep` already elapsed                      | 1 INSERT born-completed (unchanged, `engine-port.ts:insertCompletedSleep`)                                                                                              |
| `waitForEvent` first entry                   | 1 journal INSERT                                                                                                                                                        |
| `waitForEvent` consume                       | 1 mailbox DELETE + 1 journal UPDATE                                                                                                                                     |
| `memo` first write                           | 1 INSERT (turn −1); a repeat is 0 + 1 read                                                                                                                              |
| `ask`                                        | 1 per ask in the batch                                                                                                                                                  |
| `answer`                                     | 1 (+1 job when the run was parked; +1 route read when routed)                                                                                                           |
| `spawn` local                                | child accept count + 1 `runs_parent` index                                                                                                                              |
| `spawn` cross-facet                          | child accept count on the facet + 1 route row on the root                                                                                                               |
| child settles → parent notified              | 1 mailbox row (+1 job when the parent is parked)                                                                                                                        |
| `heartbeat`                                  | 1, at most once per `CLAIM_SLACK_MS / 2` (15 s)                                                                                                                         |
| `status(m)`                                  | 1 per _distinct_ message (unchanged de-dupe in `engine-port.ts:writeStatus`)                                                                                            |
| `pause`                                      | 1 run UPDATE + 1 job cancel                                                                                                                                             |
| `resume`                                     | 1 run UPDATE + 1 job                                                                                                                                                    |
| `cancel` (parked)                            | 1 run UPDATE (settles in one write, unchanged) + 1 job cancel                                                                                                           |
| `cancel` (live, declared `onCancel`)         | 1 run UPDATE setting the mark + 1 job; the cancel transition's own writes follow                                                                                        |
| settle terminal, `retain:true`               | 1 run UPDATE + 1 job cancel + (j + m + a) deletes of journal/mailbox/ask rows for that run                                                                              |
| settle terminal, `retain:false`              | the above + 1 run DELETE (+1 route DELETE when routed)                                                                                                                  |
| `delete({status, settledBefore})`, per run   | same cascade as the retained settle, plus the run row                                                                                                                   |
| facet subtree cleanup, per run               | 1 route DELETE + k parent-mailbox DELETEs + 1 job cancel                                                                                                                |

**The arithmetic to publish.** One human approval round trip is
`idle → turn → awaiting → turn → idle`: four transitions ⇒ four
checkpoint row writes, plus the run insert _and the index rows it
touches_ — two for a top-level run (`idempotency_key`, which
`cf_agents_task_runs` declares `TEXT UNIQUE` (`store.ts:110`) and SQLite
implements as an automatic index touched on every insert, NULL values
included; and `runs_definition`), three for a child (`runs_parent`) —
plus one ask row per approval, plus `next_at` touches on park and wake.
Eight row writes for a one-approval round trip on a top-level run, and at
roughly 1000 reads per row write about **8 000 read-equivalents** — which
belongs in the docs beside the step API's
per-step cost (one INSERT on entry, one UPDATE at completion, zero on a
journal hit) so a user can choose a layer on numbers. The store's own
stated rule is what forces the index rows into the count: _Cloudflare
bills each touched index as a row written_ (`store.ts:126-131`).

**Delete cascade contract.** Every path that removes a run —
`retain:false` settle (`#finishTerminalSettlement`), `tasks.delete()`,
the sealing purge, facet subtree teardown — removes, in one synchronous
block: journal rows (`run_id` prefix), mailbox rows (`run_id` prefix),
ask rows (filtered on `run_id`, per §4.4), the route row, the settlement
note this run wrote into its parent's mailbox — a primary-key point
delete on `(parentRunId, 'child:' + runId)`, which is why `deleteRun`
reads the parent before it drops the run row — and the run row itself.
`TaskStore.deleteRun` grows from two statements to six. A test asserts
zero orphan rows in all five tables after each of the four paths.

### 4.7 Checkpoint size

`serializeTaskValue` caps every stored value at
`MAX_SERIALIZED_BYTES = 1 MiB` (`serialization.ts:13,48-54`). A
full-replacement checkpoint written every transition hits this
differently from a one-shot input: an actor whose state grows fails at
some future transition, mid-run.

Normative rules:

- The checkpoint cap is **`MAX_CHECKPOINT_BYTES = 262_144` (256 KiB)**,
  deliberately a quarter of the value cap. A checkpoint is re-serialized
  and re-written every transition; the tighter cap is the point at which
  a growing state becomes a cost problem rather than a correctness one,
  and it fails early enough to be actionable.
- Exceeding it throws
  `TaskCheckpointTooLargeError extends TaskSerializationError` from the
  commit. Because serialization runs **before** the fenced UPDATE, **the
  previous checkpoint survives intact**.
- The run then settles `failed` with `outcome:'faulted'` — not a plain
  application failure, because the transition's own logic succeeded and
  re-running it would fail identically. `onError` sees it.
- Bulk state belongs in a stream, a `Sessions` row, or the host's own
  table; the checkpoint holds the phase and its identifiers. Documented
  in §12(a)'s worked example, where a conversation's checkpoint is
  ~200 bytes. The one growing field to watch is
  `asks: Pending<A>[]`, which is rewritten on _every_ transition, not
  only the ones that touch it.
- The same first-commit check validates serialisability structurally and
  names the offending key path, which is the runtime half of §2.8's
  `AssertJson`.

### 4.8 Migration from v1 / v2

`cf_agents:tasks_schema_version` (`tasks.ts:112`) takes three new values.

**Version 2.5 — journal rebuild in progress.** A cursor key
`cf_agents:tasks_journal_cursor` holds the last-copied `run_id`.

```
onStart():
  v = get(schema_version) ?? 0
  if v < 2: ensureTables(); addRunBudgetColumns()          # unchanged v0/v1 path
  if v < 3:
     addMachineColumns()                                   # §4.1, all ADD COLUMN, idempotent
     createTable(journal | mailbox | asks | routes)
     backfill definition_base / definition_version          # one UPDATE over the table
     UPDATE ... SET abort_mark='cancel' WHERE cancel_requested=1 AND state NOT IN (terminal)
     put(schema_version, 2.5)
     rebuildJournal()                                      # batched, see below
```

`rebuildJournal()` copies `cf_agents_task_steps` into
`cf_agents_task_journal` with `turn = 0`, in batches of 2 000 rows,
**each batch in its own `transactionSync`**, advancing the cursor inside
the same transaction. When the cursor reaches the end it drops
`cf_agents_task_steps` and writes `schema_version = 3`, again in one
transaction.

- A crash mid-rebuild leaves version 2.5 and a cursor; the next start
  resumes from it. Rows already copied are not re-copied (the cursor is
  durable and advances with the data).
- **Definitions do not dispatch while the version is 2.5.**
  `#executeRun` returns immediately and `#syncWake` leaves the mirror
  alone, so a half-copied journal is never read by a replay. The first
  start after the rebuild completes re-arms normally.
- The rebuild is **skipped entirely** when `cf_agents_task_steps` is
  absent or empty (the common case on a fresh object: zero work, zero
  writes).
- Above 10 000 retained step rows it logs one warning naming
  `tasks.delete({ settledBefore })`.
- Per-batch cost: 2 000 journal INSERTs + 2 000 step DELETEs + 1 cursor
  write.

**What survives.** In-flight runs resume from their journals at turn 0;
no completed step re-executes; `stepIdempotencyKey` is byte-identical
(§3.4); `TaskRunState`, the `state` CHECK, and every `TaskRunSnapshot`
field but `wakeAt`'s optionality are unchanged. Nothing is reset.

---

## 5. Scheduler and invocation rules

### 5.1 Claim

Unchanged in shape (`tasks.ts:1264-1286`): one UPDATE writes
`state='running'`, `attempt+1`, a fresh `generation`, `interruptions`,
and `next_at`. Two additions: `turn_deadline_at = now + turnTimeoutMs`,
and `next_at = turn_deadline_at + CLAIM_SLACK_MS`. `#syncWake` still
fires before the handler runs, for the reason already documented (a
routed run's root has no other way to learn the claim, and the push
clears the queue row's in-flight marker).

### 5.2 Fence predicate

Every checkpoint-advancing, park, and settle write carries:

```sql
WHERE run_id = ? AND generation = ? AND state = 'running' AND abort_mark IS NULL
```

Adding `abort_mark IS NULL` makes the mark a **write barrier**, closing
the window between the mark landing and the generation bump: a live
transition that races the mark cannot commit past it, and no separate
"did the mark land?" read is needed. The cancel transition's own writes
use a different predicate (`abort_mark IS NOT NULL`), so they are not
self-blocked. **This is also the fence the spec's Risk 22 asked for**: it
distinguishes "this attempt was cancelled out from under it" from "this
attempt _is_ the cancel transition", so `#runAttempt`'s
cancel-wins-over-result guard (`tasks.ts:1338-1352`) no longer discards
what `onCancel` returns.

### 5.3 Heartbeat

`ctx.heartbeat()` is one fenced UPDATE of `turn_deadline_at` and
`next_at`, throttled to `CLAIM_SLACK_MS / 2` — the same throttle, the
same sizing argument, and the same "a fenced-out refresh writes nothing"
behaviour as `engine-port.ts:refreshClaim`. `ReplayStep.#executeAttempt`
calls it for function definitions; `ctx.stream()`'s writer calls it on
append once per window; a machine transition that does neither calls it
explicitly.

### 5.4 The post-transition decision list

After a phase handler settles — returned, parked, or threw — the engine
re-reads the run row **inside the same invocation** and applies the first
matching rule:

1. **Superseded.** `generation` is not this attempt's ⇒ unwind, write
   nothing (`AttemptSupersededError`, unchanged).
2. **Terminal.** The handler returned `ctx.complete/fail/aborted` ⇒ one
   fenced settle + `#finishTerminalSettlement`.
3. **Platform failure thrown.** Rethrow. The claim backstop is the
   durable wake (unchanged, `#settleThrown`).
4. **Abort mark present.** End and join this invocation, then run the
   cancel transition (§6).
5. **Parked.** `TaskSuspension` (sleep/retry) or a park sentinel
   (mailbox/event/ask/child/paused) ⇒ one fenced UPDATE to
   `state='waiting'` with the reason and `next_at` (NULL for an
   event-driven park), **same turn, journal intact**. `transitions`
   resets to 0 (Rule B).
6. **Application error thrown.** Settle `failed` (unchanged).
7. **Checkpoint changed** (serialized bytes differ) ⇒ commit it,
   `checkpoint_turn + 1`, retire the previous turn's journal rows,
   `stall = 0`, `transitions + 1`; if `transitions > transitionBudget`,
   settle `failed` with `TaskTransitionBudgetError` and
   `outcome:'faulted'`; otherwise **dispatch the handler for the new
   phase in this same invocation**.
8. **Checkpoint unchanged, but progress advanced** (a journal row
   completed, a mailbox row was consumed, a memo was first-written, an
   ask was answered, or the stream cursor moved) ⇒ commit `progress`,
   `stall = 0`, re-dispatch the same phase's handler in this same
   invocation.
9. **Nothing changed, no park, no progress** ⇒ `stall + 1`; at
   `stallLimit` settle `failed` with `TaskNoProgressError` and
   `outcome:'faulted'`; otherwise park on a short backoff
   (`reason:'retry'`).

**Rule 5 sits above rule 9 by construction**, which is why Rule A needs
no exemption list: a healthy handler that parks is never faulted, and a
park that reproduces the same deadline is still a park. Rule 7's budget
check is Rule B, and it is the only thing that catches
`{ phase: "idle", n: n + 1 }`, which rule 9 never can because every
iteration changes the checkpoint.

**Retry before faulting.** A fenced-out write (rule 1) is "the engine
could not line the checkpoint up", not "the handler made no progress";
it unwinds and the wake re-dispatches. Only rules 9 and 7's budget
produce `faulted`.

### 5.5 Dispatch budget and handoff

Re-entry under rules 7 and 8 is bounded by `DISPATCH_BUDGET_MS` (5 s,
`tasks.ts:157`). Past it the invocation detaches exactly as today —
`trackAlarmWork(this.#active.get(runId)?.promise ?? runAttempt)` — and
the loop continues in the same isolate while it lives. Durability never
depends on the await: the claim backstop is the wake.

### 5.6 The routed loop

`#dispatchRoutedRun` (`tasks.ts:565-575`) deliberately has no budget —
"the root that sent this message races its own await of the call
instead". That is fine for a bounded attempt and wrong for a machine
whose loop keeps finding work: the facet would hold the RPC
indefinitely.

**New rule:** the facet-side loop re-dispatches for at most
`DISPATCH_BUDGET_MS`, then stops, calls `#syncWake` (which routes
`syncWake` to the root with `next = now`), and returns. The root
re-dispatches on its next alarm. The already-running attempt keeps its
existing treatment: refresh the claim and return, since it is already
tracked against whichever alarm's breaker domain dispatched it.

### 5.7 Memory-limit policy

`onMemoryLimit` (`tasks.ts:591`) / `#applyMemoryLimit` (`:631`) keeps its
shape, including the routed forward and the
`setTaskRoutedMemoryLimitHandler` twin bridge. (The bridge's _shape_ is
what survives, not necessarily its spelling: if the cleanup plan's PR 5
lands first it is already `TasksOptions.onRoutedMemoryLimit`, and the
engine keeps the option instead of the WeakMap setter — same end state.)
Three changes:

- **Sealed:** unchanged — `#failWithoutAttempt` with
  `TaskMemoryLimitSealed`, now also writing `outcome:'faulted'`, plus the
  delete cascade of §4.6. The `memory-limit.test.ts:497` assertions all
  still hold.
- **Non-sealed strike:** the `next_at` floor is applied to
  `state IN ('pending','running')` and to `waiting` rows whose
  `wait_reason IN ('sleep','retry','interrupted')`. An **event-driven
  park keeps `next_at` NULL** — one write either way (the claim strip),
  and no spurious wake that would claim the run, find an empty mailbox,
  and cost a claim write plus a re-park write per strike.
- A sealed strike marks the run's non-background children at
  `context.nextTime` through the cascade, without re-triggering the
  breaker.

### 5.8 Parking and wake sources

| Park                                   | `wait_reason` | `next_at`                                                     | Woken by                       |
| -------------------------------------- | ------------- | ------------------------------------------------------------- | ------------------------------ |
| `step.sleep` / `sleepUntil`            | `sleep`       | the deadline                                                  | the queue job                  |
| step retry backoff                     | `retry`       | the backoff                                                   | the queue job                  |
| interruption backoff                   | `interrupted` | the backoff                                                   | the queue job                  |
| `ctx.receive` / `receiveAll`           | `mailbox`     | the `within` deadline, else NULL or the run deadline          | `send`, `cancel`, the deadline |
| `step.waitForEvent`                    | `event`       | the timeout, or NULL                                          | `sendEvent`, the timeout       |
| `ctx.answers`                          | `ask`         | the `within` deadline or the earliest `expires_at`, else NULL | `answer`, expiry               |
| `ctx.join` / `receive({kind:"child"})` | `child`       | the `within` deadline, else NULL                              | a child settling               |
| `pause()`                              | `paused`      | NULL                                                          | `resume()`                     |

**Every `within` is the run's existing `next_at` column — no extra row,
and no `setAlarm` call.** A run parks on exactly one wait at a time,
because the handler is a single function, so one column suffices, and the
timer dies with the return. Only two things need a deadline that outlives
a wait: an ask's `expires_at` (bounded per _batch_, not per ask) and the
run-level `deadline`. **Timer primitives never touch `setAlarm` — the
wake queue owns the single Durable Object alarm.**

**Wake elision.** A `send`/`answer` whose target run has a live attempt
in `#active` on this object writes no job row: the parking member
re-reads the mailbox/ask table at the park boundary, inside the same
synchronous block in which it would park, so an item that landed during
the transition converts the park into a re-entry. Only a parked or cold
target gets a job row.

### 5.9 Facets and routing

`#syncWake`'s routed branch, `#syncRoutedWake`, `onRoute`,
`#dispatchRoutedRun` and `onMemoryLimit`'s forward are all kept verbatim.
The routed message union grows:

```ts
type TaskRouteMessage =
  | { type: "syncWake"; runId: string; next: number | null } // existing
  | { type: "dispatch"; runId: string } // existing
  | { type: "memoryLimit"; runId: string; context: MemoryLimitContext } // existing
  | { type: "mailboxPush"; runId: string; item: TaskMailboxWire } // new
  | { type: "answer"; askId: string; answer: TaskJson } // new
  | { type: "childSettled"; parentRunId: string; child: TaskChildWire } // new
  | {
      type: "abortCascade";
      runId: string;
      mark: TaskAbortMark;
      reason?: string;
    } // new
  | { type: "view"; runId: string }; // new
```

**The owner of the target run always writes the row.** A routed
`mailboxPush` carries the payload; the owner's `Tasks` executes the same
local `send` code path, so the write counts of §4.6 apply unchanged on
the owner's side. The sender's side writes nothing beyond the route-row
read. If the target object is gone, the routed call rejects; the caller
deletes the stale route row and returns `{accepted:false}`.

The **root** resolves a target from `cf_agents_task_routes`:
`tasks.send(runId, …)` looks up `run_id`; `tasks.answer(askId, …)` splits
the ask id at `#` and looks up the prefix. Absent route row ⇒ the run is
root-local and the write is local.

### 5.10 Startup reconcile

`#reconcile` (`tasks.ts:1670-1683`) keeps its first statement unchanged
(a `running` row with a generation is an interrupted attempt; make it due
now). Its second statement is **narrowed** — the unnarrowed
`state IN ('pending','waiting') AND next_at IS NULL` would floor every
event-driven park to now on every single startup:

```sql
UPDATE cf_agents_task_runs SET next_at = ?, updated_at = ?
WHERE (state = 'pending' AND next_at IS NULL)
   OR (state = 'waiting' AND next_at IS NULL
       AND wait_reason IN ('sleep', 'retry', 'interrupted'))
```

The `pending` half is kept explicitly because a `pending` row carries
`wait_reason = NULL` and would otherwise fall out of a naive
`wait_reason IN (...)` narrowing. `#syncAllWakes` is unchanged, including
its `rearm()` fallback.

### 5.11 `register()` and the internal start path

`register()` keeps its name and its `__cf`-prefix requirement (renaming
it to `internal()` or `define()` would edit five tests and buy nothing in
this release); it is promoted from "do not use" to documented
`@internal`, and it now **returns a handle**:

```ts
export interface TaskInternalHandle {
  readonly name: string;
  run(input?: unknown, options?: TaskRunOptions): Promise<TaskReceipt>; // accepts `start`
}
```

Public `run()` continues to reject `__cf` names
(`#validateDefinitionName`, `tasks.ts:308-333`). This is why
`run({ start })` alone cannot replace the apertures: **every production
caller of `runAttached`/`enqueue` passes a reserved name** —

| Call site                                            | Name                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `think.ts:4922` (`_enqueueChatRecovery`)             | `__cf_internal_chat_recovery` (`chat/recovery-task.ts:17`) |
| `ai-chat/src/index.ts:784` (`_enqueueChatRecovery`)  | same                                                       |
| `think.ts:5013` (`_runMessengerReplyTask`)           | `__cf_internal_messenger_reply` (`think.ts:2789`)          |
| `think.ts:5078` (`_runChatRecoveryFiber`)            | `__cf_internal_chat_turn` (`think.ts:2935`)                |
| `ai-chat/src/index.ts:841` (`_runChatRecoveryFiber`) | `__cf_internal_chat_turn` (`ai-chat/src/index.ts:4661`)    |

All five move to `handle.run(input, { start })`, where `handle` is what
`register()` already returned in the same constructor.
`__DO_NOT_USE_WILL_BREAK__runAttached` and
`__DO_NOT_USE_WILL_BREAK__enqueue` are then **deleted — in this release,
in the same PR as the moves**, not left behind as deprecated wrappers.
Every remaining in-repo reference moves with them in the same PR:

- the nine sites in `tests/tasks/` (§3.10 — eight pass a non-reserved
  name and so go to public `run(..., { start })`; `capability.test.ts:127`
  takes the handle);
- the four **test-subclass** sites in the two test workers
  (`ai-chat/tests/worker.ts:2549, 2565`; `think-session.ts:8185, 8220`),
  which start `__cf_internal_chat_recovery` — a definition their _base_
  class registered from a private method. A subclass cannot reach it
  otherwise: public `run()` rejects `__cf`, `tasks.handle(name)` runs the
  same `#validateDefinitionName` first, and a second `register()` throws
  "already registered". These four need a protected accessor on
  `AIChatAgent`/`Think` handing out that handle, landed with the handle
  itself;
- `ai-chat/tests/worker.ts:3532`, a plain `enqueue` call;
- the three example harnesses (`pi-harness.ts:824`,
  `codex-harness.ts:257`, `self-modifying-harness.ts:394, 399`), whose
  definitions are `__cf`-prefixed and registered through `register()`, so
  they take the handle rather than public `run()`;
- and the one reference that is not a call: the
  `ai-chat/tests/worker.ts:3374–3404` monkey-patch, which saves,
  replaces and restores `runAttached` through an `as unknown as` cast
  that `tsc` will not flag, and must be repointed at the handle's `run`.

The full call-site list is in
[tasks-cleanup-plan.md](./tasks-cleanup-plan.md).

`__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix` **survives unchanged** — it
is a tri-capability contract called on Scheduler, Tasks and Queue
together (`dynamic-agents/dynamic-agents.ts:262-273`) and typed as such
(`dynamic-agents/host.ts:54-62`). Its contract is _extended_: deleting a
facet subtree must now also delete the root's `cf_agents_task_routes`
rows under the prefix and reap any parent's `kind:'child'` mailbox rows
pointing into the deleted subtree.

### 5.12 Event-driven parks carry no wake

A run parked on a mailbox with no `within`, an event without a timeout,
an ask without an expiry, a child, or a pause has `next_at IS NULL` and
`deadline_at IS NULL`, so `#nextWake` returns null and `#syncWake`
cancels the mirror job. **That is correct and costs nothing** — an
event-driven park should not hold an alarm. The owner index (§4.5) is
what keeps it routable; the reconcile narrowing (§5.10) is what keeps it
parked across restarts.

---

## 6. Abort protocol and deadlines

### 6.1 The five causes

| Mark            | Set by                                          | Notes                                             |
| --------------- | ----------------------------------------------- | ------------------------------------------------- |
| `cancel`        | `tasks.cancel(runId, reason)`                   | also writes `cancel_requested=1`, `cancel_reason` |
| `deadline`      | the run `deadline` passing (`#enforceDeadline`) | unchanged detection                               |
| `turn-deadline` | the per-transition watchdog                     | replaces `chat/stall-watchdog.ts`                 |
| `parent`        | an owning run's cascade                         | non-background children only                      |
| `seal`          | the memory-limit breaker sealing                | terminal by policy                                |

`tasks.terminate(runId, reason?)` is a sixth path that is deliberately
_not_ a mark: it settles immediately without running `onCancel`.

### 6.2 The protocol

```
1. one fenced UPDATE sets abort_mark (+ abort_reason)      # the write barrier
2. signal the live invocation's AbortController
3. JOIN it, bounded by CLAIM_SLACK_MS
4. dispatch a FRESH invocation running onCancel(state, ctx)
5. onCancel returns a checkpoint or a terminal; the engine writes exactly that
```

Step 3 is what makes the handler safe: the live transition is provably no
longer running when `onCancel` starts, so both can touch the same stream
and the same external handle without racing. The join awaits a promise
already tracked in `#active`; a signal-deaf invocation does not block it
(the engine proceeds, fenced — §6.5).

`onCancel` may return a checkpoint, which **clears the mark and resumes
the run** — that is how a machine declines a cancel.
`tasks.terminate(runId)` is the forced tier afterwards; it settles
without running `onCancel`.

`onCancel` is **non-reentrant**: a cancel arriving while it runs sets the
mark but does not re-dispatch it. It may not park; calling a parking
member throws `TaskCancelCannotParkError`, which settles the run `failed`
with `outcome:'faulted'`.

**One honest limitation, documented rather than fixed.** `onCancel` runs
in a fresh fenced invocation, so anything the cancelled handler
accumulated in memory is gone by construction; anything it journaled is
readable through `ctx.memo(name)`'s read form and `ctx.interrupted`.
Trigger.dev's `onCancel` closes over in-flight locals; ours cannot, and
that is the correct trade for a handler that must be fenced.

### 6.3 `cancel()` semantics

```ts
cancel(runId, reason?, options?: { wait?: boolean }): Promise<boolean>
```

- Returns `true` when a non-terminal run **accepted the mark**, `false`
  otherwise (unchanged for every existing caller).
- With no declared `onCancel`: the run is terminal when `cancel()`
  resolves (§6.4).
- With a declared `onCancel`: between acceptance and the cancel
  transition, `get()` reports the run's prior `state` (`running` or
  `waiting`) plus `abortRequested: true` and `abortReason`. To await
  terminality, pass `{ wait: true }` — which resolves when the run
  reaches a terminal state or the join+dispatch fails — or subscribe with
  `watch`.

### 6.4 The inline default

A definition with **no declared `onCancel`** — which is every function
definition and every machine that does not opt in — gets today's
behaviour verbatim:

- a **parked** run settles in one write inside `cancel()`
  (`#settleCancelled`, `tasks.ts:975-1000`);
- a **live** run has its signal aborted and settles at its next step
  boundary (`ReplayStep.#enterStep` throws `TaskCancellation`).

This is not a convenience: `capability.test.ts:641-659` reads
`await tasks.get()` synchronously after `await cancel()` and expects
`state === "cancelled"` plus a second `cancel()` returning `false`. An
asynchronously dispatched handler would fail it. The fresh-invocation
protocol is opt-in precisely so the existing contract is preserved by
construction.

The inline default for each mark: `cancel` ⇒ `cancelled`; `deadline` ⇒
`failed` + `TaskDeadlineExceededError`; `turn-deadline` ⇒ `failed` +
`TaskTurnDeadlineExceededError`; `parent` ⇒ `cancelled` with reason
`"parent aborted"`; `seal` ⇒ `failed` + `TaskMemoryLimitSealed`.

### 6.5 Zombie fencing

A signal-deaf invocation is not waited on past `CLAIM_SLACK_MS`. It keeps
running until its isolate goes, and every durable write it attempts is
refused:

- run-row writes fail the fence (`generation` mismatch, or
  `abort_mark IS NOT NULL`);
- journal writes go through `assertCurrent()` (`engine-port.ts`), which
  throws `AttemptSupersededError`;
- mailbox, ask and checkpoint writes carry the same fence;
- **stream appends throw `StreamClosedError`**
  (`streams/streams.ts:548-553`) because the cancel transition sealed the
  epoch.

Its late settlement is discarded by `#raceTimeout`, exactly as today.
This is also the general safety property to state out loud: **a late
result addressed to a phase the run has left is discarded, because the
checkpoint moved.**

### 6.6 Deadlines and retention

- **Run `deadline`** — unchanged, including `#nextWake` bringing a parked
  run's wake forward and `#enforceDeadline` settling under the attempt's
  generation before aborting the signal.
- **Transition deadline** — `turn_deadline_at`. When a due wake finds the
  run live in `#active` and `turn_deadline_at <= now`, it sets
  `abort_mark = 'turn-deadline'` and runs §6.2. This is the stall
  watchdog: a model turn that produces nothing for `turnTimeout` is
  aborted and `onCancel` owns the recovery.
- **`retain:false` + `faulted`/`orphaned`.** `#finishTerminalSettlement`
  deletes the run row when `retain === 0`, and chat recovery depends on
  that (`recovery-task.ts:170`, `chatRecoveryTaskRunOptions` sets
  `retain:false` so the idempotency key is released). **`faulted` and
  `orphaned` override `retain:false`**: the run row and its checkpoint
  are preserved regardless, because "never silently delete" is the whole
  point of both outcomes and because `reopen()` needs something to
  reopen. `completed`/`failed`/`cancelled` honour `retain:false`
  unchanged.

### 6.7 Children and open streams during a cancel

The cancel transition inherits the run's engine-owned streams:
`ctx.stream(name)` inside `onCancel` returns a writer on the **same**
live epoch, so it can append a final "cancelled" frame, and the terminal
write seals it in the same transaction. The cascade to non-background
children is issued in the same synchronous block as the mark (§10.3).

### 6.8 Disposition table

What each cause does to the four things a run owns. This is the first
question an operator asks and it is published rather than inferred.

|                                    | open asks                                                                         | unconsumed mailbox items                                                                  | the live stream epoch                                                     | non-background children |
| ---------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| **`cancel`**                       | marked `withdrawn`; **rows kept** for the UI                                      | **preserved** when `onCancel` lands on a State; deleted by the terminal cascade otherwise | sealed; partial output retained until the terminal cascade                | cascade mark `parent`   |
| **`terminate`**                    | marked `withdrawn`; rows kept                                                     | deleted by the terminal cascade                                                           | sealed; partial output retained until the terminal cascade                | cascade mark `parent`   |
| **`deadline`** (run or transition) | marked `withdrawn`; rows kept                                                     | preserved when `onCancel` lands on a State; deleted by the terminal cascade otherwise     | sealed; partial output retained until the terminal cascade                | cascade mark `parent`   |
| **`pause`**                        | **untouched** — a human may still answer, and `resume()` finds the answer waiting | **untouched**                                                                             | sealed on the next park or terminal like any boundary; no rotation forced | **untouched**           |

Notes. "Rows kept" means an expired, withdrawn or answered ask stays
readable in `view()` and `tasks.asks()` until the run's delete cascade
removes it (§4.6) — the UI can still show what was asked and why it
lapsed. A `seal` mark is a `terminate`-shaped row of this table by
policy. Background children are excluded from every cascade,
structurally, because the exclusion is a column on the child's own row.

---

## 7. Mailbox

### 7.1 Item shape and ordering

`TaskMailboxItem` (§2.4). Ordering is FIFO by `seq` **across kinds** — a
`child` settlement and a user `message` interleave in arrival order,
which is what lets a handler express "whichever comes first".
`visible_after` in the future hides an item from `receive`/`peek` without
changing its `seq`, so a debounced item keeps its place when it becomes
visible. The guarantee to state is the honest one: **messages are
received in the order in which they were sent** (per-sender / causal);
nothing implies a global order across senders.

### 7.2 `send` policies

| Policy             | Meaning                                                             | Use                                                                                             |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `append` (default) | one more item                                                       | ordinary messages                                                                               |
| `latest`           | delete every unconsumed item of the same `kind`+`type`, then append | Think's _latest_ submit strategy                                                                |
| `drop`             | write nothing when a matching unconsumed item exists                | Think's _drop_ submit strategy                                                                  |
| `debounce`         | upsert the same `key`, setting `visible_after = now + debounceMs`   | Think's _debounce_ strategy; **durable**, so it survives eviction, which a `setTimeout` did not |

Think's _merge_ strategy has no send policy: it is a reader verb.
`ctx.receiveAll({ kind: "message" })` drains and the handler folds. A
second policy shape for one reader is not earned.

### 7.3 `requestId` dedupe

`requestId` becomes the row's `key`; the INSERT is
`ON CONFLICT (run_id, key) DO NOTHING`. A duplicate writes **zero rows,
performs zero reads, and touches zero indexes**, and returns
`{accepted:false, reason:"duplicate"}`. This is what replaces Think's
`cf_think_submissions.idempotency_key UNIQUE`.

Permanent idempotency _inside_ a transition is
`ctx.memo(requestId, …)` in the admit phase (§12a).

### 7.4 Withdraw, limits, terminality, buffering

- `withdraw(runId, key)` deletes a still-queued item; `false` when it was
  already consumed. It is what expresses Think's "withdraw a queued
  steer".
- `mailboxLimit` (default 1000) is checked before the write; exceeding it
  throws `TaskMailboxFullError` rather than growing without bound.
- **Terminality, in writing:** a `send` to a terminal run writes nothing
  and returns `{accepted:false, reason:"terminal"}`. **A mailbox write
  never resurrects a run.**
- **Buffering, in writing:** data sent before the handler reaches its
  `receive` is buffered durably and delivered when it gets there. There
  is no listener-registration race to lose a message to, and
  `waitForEvent` inherits the same promise (§2.9).
- `TaskSendReceipt.accepted: false` is **not an error** — it is the
  house convention `TaskReceipt` already established for `run()`.

### 7.5 The four reading modes, with their costs

| Mode                                    | Blocks?                     | Residency                                    | Row writes                |
| --------------------------------------- | --------------------------- | -------------------------------------------- | ------------------------- |
| `receive(filter & { within? })`         | parks the run               | **nothing resident**; the invocation unwinds | 1 DELETE when it consumes |
| `peek(filter)`                          | no                          | in-invocation read                           | **0**                     |
| `peekAll(filter)` — steer at a boundary | no                          | in-invocation read                           | **0**                     |
| `receiveAll(filter & { within? })`      | parks until ≥1, then drains | nothing resident while parked                | k DELETEs in one block    |

Selective `receive({ kind })` leaves non-matching items in the mailbox,
which is what subsumes gen_statem's `postpone` with no re-queue write.

### 7.6 Workflows mapping

`tasks.sendEvent(runId, {type, payload})` ≡
`send(runId, payload, {kind:"event", type})`.
`step.waitForEvent(name, {type, timeout})` ≡ a journaled
`receive({kind:"event", type})` with a deadline (§3.3). `send` is the
general verb; `sendEvent` is the Workflows spelling of one shape of it,
and the docs say so in one line.

### 7.7 Think's strategies, mapped

| Think                                     | New API                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| submit strategy `latest`                  | `send(..., { policy: "latest" })`                                                                   |
| submit strategy `drop`                    | `send(..., { policy: "drop" })`                                                                     |
| submit strategy `debounce`                | `send(..., { policy: "debounce", debounceMs })`                                                     |
| steer at turn boundary                    | `ctx.peekAll({kind:"message"})` inside the `turn` phase, consumed at the boundary with `receiveAll` |
| follow-up after the turn                  | the `idle` phase's `receive()`                                                                      |
| `TurnQueue` (in-memory)                   | the mailbox itself; ordering is `seq`                                                               |
| `SubmitConcurrencyController` (in-memory) | the checkpoint phase (`idle` vs `turn`) plus `policy`                                               |

---

## 8. Asks

### 8.1 Model

`ctx.ask(kind, payloads, opts)` writes one row per payload and returns
`Pending<A>[]`, each `{ id: '<runId>#<nanoid>' }`. It is **synchronous**,
so a phase handler can raise asks and return the next checkpoint holding
them in one expression. The handler then either continues
(fire-and-forget, e.g. a notification) or parks on
`ctx.answers(pending, { mode, within })`. `mode:"all"` (default) parks
until every ask is answered/expired/withdrawn; `mode:"any"` returns on
the first. The park's `next_at` is the `within` deadline, else the
earliest `expires_at` among them, else NULL.
`ctx.peekAnswers(pending)` reads what is already durable without parking.

`Pending<A>` is `{ id }` at runtime, so it serialises into the checkpoint
unchanged — and, per invariant 18, it belongs in the phase that admits
its answers, not in a payload field of a phase that does not.

### 8.2 Answering

`tasks.answer(askId, kind, value)` needs **only the ask id** — one write
plus at most one wake, and the run id it needs for routing is the prefix
before `#`. This is what makes an approval that arrives as a WebSocket
frame, on an isolate that has never heard of the run, work with nothing
in memory. The `kind` argument is what types `value`: the answer type
travels with the kind, so `{ yes: true }` where a `Decision` is expected
is a compile error, from another file, with no per-run generics.

A second `answer` on the same ask returns
`{ accepted: false, reason: "duplicate" }` rather than throwing — the
same convention as `send` and `run`. Answering an expired, withdrawn or
unknown ask returns the corresponding reason. An answer is applied
exactly once even if two isolates race it, because the write is a fenced
conditional UPDATE on `state = 'open'`.

The answer is deliberately whatever the kind says it is, not a boolean:
an approval that may rewrite the asked-about input, install a durable
rule, or deny with a message is the normal agent case, and
`{ approved: boolean }` is under-powered for it.

### 8.3 Expiry and withdrawal

An ask batch with `expiresIn` folds that time into the parked run's
`next_at`; the wake flips the rows to `expired` **without deleting
them**, so the UI can still show what was asked and why it lapsed.
Expiry is bounded **per batch**, not per ask, which is what keeps it one
wake rather than one per question. `tasks.withdrawAsk(askId)` and
settlement both mark open asks `withdrawn` rather than deleting them; the
delete cascade removes them with the run (§4.6). Every ask gets an
expiry or it can park a human-blocking question forever.

### 8.4 Think's approvals, mapped

| Think today                                                               | New API                                                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cf_think_action_pending_approvals` (+ its `created_at` index)            | the ask table                                                                                                                           |
| `_sweepActionPendingApprovals` (`think.ts:9738`)                          | `expires_at` folded into the park's wake                                                                                                |
| tool approval ends the turn, continuation admitted via a debounce barrier | the `approval` phase parks on `ctx.answers`; the answer wakes the same run into the `turn` phase — **no continuation turn, no barrier** |
| durable action approvals with a payload                                   | `ask(kind, payloads)` carries the payload; the answer carries the decision                                                              |

---

## 9. Streams and progress

### 9.1 Identity and lifetime

An engine-owned stream is `(name, tag, epoch)`: stream id
`${runId}:${name}#${epoch}`, with `name` defaulting to `"main"` and `tag`
defaulting to `${runId}:${name}` and stable across epochs.
`ctx.stream(name?)` opens the current epoch, or resumes it if it is still
`streaming`. Streams are **named and plural** — one run may produce
several (an assistant stream and a tool-trace stream), and a singular
`stream()` would be a breaking change later.

`Streams.open` **throws `StreamClosedError` on a terminal id**
(`streams/streams.ts:227-233`), so "seal and re-attach" is
self-contradictory. Therefore: a reclaim after an interruption **seals
the old epoch and rotates**. The replayed transition's `ctx.stream()`
opens `epoch + 1`, the sealed epoch's final cursor folds into
`stream_retired`, and a UI following the `tag`
(`Streams.list({tag, limit:1})`, which the tag was designed for) sees
continuous output across the rotation. `TaskStreamOptions.streamId` opts
out of engine ownership entirely — no rotation, no cutover, no progress
credit.

### 9.2 The atomic cutover

Returning the next checkpoint from a transition that holds a live
engine-owned stream settles the stream and writes the checkpoint in
**one SQLite transaction**, via `writer.close({ commit })` where `commit`
is the engine's synchronous checkpoint UPDATE (`StreamSettleOptions.commit`,
`streams/types.ts:83-103`).

Two consequences:

- **`commit` must not await.** That is already the documented contract,
  and it is exactly why `LifecycleJobs.pushSync` is needed (§14.3): the
  wake re-arm is async and cannot live inside the transaction.
- **`close()` returning `false` is not success.** `Streams.#settle`
  returns false without running `commit` when the row did not transition
  — "a repeat, or a deleted stream, is a no-op and returns false: the
  caller's `commit` does not run" (`streams/streams.ts:661-664`). If a
  reclaim already sealed this epoch, the checkpoint would silently not be
  written. **Normative:** the engine checks the return value; `false`
  means the transition was fenced out and is unwound like
  `AttemptSupersededError` — no state advance, no settle, no event.

**New `StreamWriter` member:**

```ts
/** Register a synchronous callback to run inside this stream's settle transaction.
 *  Same contract as StreamSettleOptions.commit: must not await; a throw rolls the
 *  settle back and leaves the stream live. */
onCommit(fn: () => void): () => void;
```

It is a hook _inside_ the one commit, not a second commit path, which is
what keeps invariant 5 enforceable. It is a public `agents/streams`
change and carries its own file edits, doc section and changeset line
(§14.3, §14.6, §14.7).

### 9.3 Progress credit

`progress` is computed at each commit or park write as

```
progress = stream_retired + (live epoch cursors, read from each chunk log's tail)
         + journal rows completed this run
         + mailbox rows consumed + asks answered + memos first-written
```

and stamped into the same UPDATE that was happening anyway. **Nothing is
written per append** — this is `ResumableStream.progressMarker`'s exact
design (`chat/resumable-stream.ts:229-240,302-316`), which replaced a
get-and-put per credited chunk on the streaming hot path.
`ctx.creditProgress(n)` is the explicit credit for work the log cannot
see (a parent forwarding a sub-agent's output), mapping one-to-one to
`ResumableStream.creditProgress`.

Progress does two jobs: it refreshes `turn_deadline_at` (real work is
liveness) and it resets both `stall` and the run's `interruptions`
counter, so a long-lived actor's budget is never spent by deploy churn.

### 9.4 Replay and preview for UIs

`view()`'s `streams` field carries `{name, tag, streamId, epoch, cursor,
state}` per stream. A UI reads
`Streams.readBatches(streamId, {from})` for backfill and `onUpToDate` for
the live cutover — unchanged Streams surface. A `watch` subscriber gets a
`progress` change whenever the stamped value moves, which is at every
commit and park, not per chunk.

### 9.5 `InstanceStatus` correspondence

| `TaskRunSnapshot`                                                                | `InstanceStatus.status` (workers-types :17080-17095) |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pending`                                                                        | `queued`                                             |
| `running`                                                                        | `running`                                            |
| `waiting` + reason `sleep`/`retry`/`interrupted`/`mailbox`/`event`/`ask`/`child` | `waiting`                                            |
| `waiting` + reason `paused`                                                      | `paused`                                             |
| `completed`                                                                      | `complete` (+ `output`)                              |
| `failed`                                                                         | `errored` (+ `error: {name, message}`)               |
| `failed` + `outcome:'faulted'` or `'orphaned'`                                   | `errored`                                            |
| `cancelled`                                                                      | `terminated`                                         |
| —                                                                                | `waitingForPause` — **no analogue** (§2.9)           |
| —                                                                                | `unknown` — we return `null` from `get()` instead    |

The six `TaskRunState` values and their correlated snapshot payloads
(`result` on completed, `error` on failed, `reason` on cancelled,
`reason`/`wakeAt?` on waiting) are kept exactly as shipped. Collapsing
the three terminals into one, as some surveyed systems do, would destroy
that correlation.

---

## 10. Children

### 10.1 Spawn

`ctx.spawn(definition, input, options)` accepts a run of `definition`
with `parent_run_id` set to this run, `parent_owner_key` set when the
parent lives on a facet, plus `background` and `notify`. Cross-facet
spawn passes `options.owner`; the child is accepted on that Lifecycle and
a route row is written on the root.

A child's `runId` should be **derived from durable state**, not from a
call counter: ``runId: `tool:${call.id}` `` or `` `child:${s.turnSeq}:${i}` ``. A counter-derived id is stable only if the
call ordinal is, which re-introduces exactly the replay determinism this
engine escapes.

### 10.2 Join

A child's terminal outcome arrives as a mailbox item:

```ts
{ kind: "child", type: definition, key: `child:${childRunId}`,
  payload: { runId, definition, state, result?, error?, outcome? } }
```

so `ctx.receive({kind:"child"})` is the raw join — and `ctx.receive()`
with no filter is "a child settles **or** the user steers", which a
dedicated join verb cannot express. `ctx.join(children, { within })` is
**sugar over exactly that**: it consumes `kind:"child"` items until every
named child has settled and returns
`TaskChildResult<T>[] | typeof ctx.timedOut`, each result being
`{ ok: true, output } | { ok: false, error }` rather than a throw,
because a child failing for a business reason is data. (The spec's §10.2
said there should be no `join` member; the maintainer's decision adds it
as sugar and keeps the raw form, and that is the one place this appendix
departs from the spec's own text.)

`notify:false` suppresses the item for a child whose outcome the parent
reads some other way. A child settling **after** its parent is terminal
is a zero-row no-op (§7.4's terminality rule), locally and routed alike.

Child asks surface on the parent: `tasks.asks({ runId })` on a parent
lists its own asks, and a UI that wants the subtree walks `children`.

### 10.3 Cascade

Setting an abort mark on a parent, in the same synchronous block:

- local children:
  `SELECT run_id FROM cf_agents_task_runs WHERE parent_run_id = ? AND background = 0 AND state NOT IN (terminal)`
  (the `runs_parent` index, §4.1), then one mark write each;
- cross-facet children:
  `SELECT run_id, owner_path_key FROM cf_agents_task_routes WHERE parent_run_id = ?`
  on the root, then one routed `abortCascade` each.

Background children are excluded from the cascade and from the default
`receive({kind:"child"})` — structurally, because the exclusion is a
column on the child's own row rather than a list the parent has to
maintain. **Publish the in-tree/detached list**: non-background children
are in the tree and are cancelled with the parent; `background: true`
children are detached and run to completion.

### 10.4 Facet subtree deletion

`cleanupRoutePrefix(prefix)` additionally deletes route rows whose
`owner_path_key` matches the prefix and reaps any parent's `kind:'child'`
mailbox rows naming a run under it, so a parent parked on a child that no
longer exists is not parked forever. It stays the same tri-capability
method with the same signature.

---

## 11. Versioning and migration

### 11.1 Name shape

A definition name is `base` or `base@vN` where `N` is a positive integer.
Parsing splits on the **last** `@v` followed only by digits; anything
else is part of the base. `definition_base` and `definition_version` are
derived at insert and at migrate, and stored. **There is one version
namespace** — the definition name — and no `version` field beside it.

### 11.2 Resolution and joining

- `#resolveDefinition(name)` first matches the exact persisted string
  (today's behaviour, `tasks.ts:291-306`). On a miss, it looks for the
  **highest registered version of the same base**.
- `#accept`'s conflict check (`tasks.ts:1110-1121`) compares **base
  names**, not full names. Joining an existing `chat@v1` run by address
  under `chat@v2` is therefore legal and is the intended upgrade path for
  `runId`-as-address.
- On a version mismatch, `migrate(checkpoint, fromVersion, input)` runs
  at the start of turn 0 of the next claim, before any handler. Its
  result is written with the new `definition`, `definition_version`, and
  checkpoint in **one** row write, and the previous turn's journal is
  retired in the same transaction.

### 11.3 `orphaned`

A live run whose persisted `definition` resolves to nothing **and** whose
base has no registered higher version, or whose registered version
declares no `migrate`, or whose `migrate` throws, settles
`state:'failed'` with `outcome:'orphaned'` and
`TaskOrphanedDefinitionError`. **The checkpoint, journal, mailbox and
asks are preserved** — `retain:false` is overridden (§6.6) — and the run
costs no alarm. It does **not** silently resume against new code.

`MissingTaskDefinitionError` keeps its exact behaviour for the
unversioned case, which is what preserves `capability.test.ts:737`'s
three assertions.

### 11.4 `reopen`

`tasks.reopen(runId)` moves an `orphaned` run back to `pending` from its
preserved checkpoint and wakes it. It is explicit rather than automatic
because automatic startup re-resolution would resurrect a `failed` row
and cost a scan on every start; an explicit call is loud, cheap, and
revertible. This is the engine's answer to "a rename or a drop must not
terminally destroy in-flight rows": the rows survive, visibly, until
someone reopens them.

---

## 12. Worked examples

### (a) Think's conversation as ONE machine

All six hand-rolled machines — turn, recovery incident, approval wait,
queued request + durable submission, agent-tool child, messenger reply —
become phases of one machine addressed by
``runId = `conv:${conversationId}` ``.

```ts
type ConvState =
  | { phase: "idle" }
  | { phase: "admit"; requestId: string }
  | { phase: "turn"; turnId: string; requestId: string; continuation: boolean }
  | { phase: "approval"; turnId: string; asks: Pending<ApprovalDecision>[]; toolCallIds: string[] }
  | { phase: "children"; turnId: string; childRunIds: string[] }
  | { phase: "reply"; nonce: string; replyTo: string }
  | { phase: "recover"; turnId: string; mark: TaskAbortMark; budget: number };

type ConvSeed = { conversationId: string };
type ConvMessage = { text: string } | { kind: "messenger.reply"; to: string };

const ToolApproval = defineAsk<
  { toolCallId: string; input: TaskJson },
  ApprovalDecision
>("tool-approval");

readonly tasks = new Tasks({
  turnTimeout: "1 day",          // a model turn; heartbeats come free from the stream
  stallLimit: 2,
  transitionBudget: 1000,
  definitions: {
    "conversation@v1": {
      initial: (_seed: ConvSeed): ConvState => ({ phase: "idle" }),

      phases: {
        // One park covers "user sends", "user steers", "child settles",
        // "messenger reply arrives" — the six machines' entry points.
        idle: async (_s, ctx) => {
          const item = await ctx.receive();
          if (item === ctx.timedOut) return { phase: "idle" };
          if (item.kind === "child") return { phase: "idle" };
          if (item.type === "messenger.reply") {
            return { phase: "reply", nonce: item.key, replyTo: String(item.payload) };
          }
          return { phase: "admit", requestId: item.key };
        },

        // Durable submission: first-writer-wins, survives every replay.
        admit: async (s, ctx) => {
          const turnId = ctx.memo(`turn:${s.requestId}`, nanoid());
          return { phase: "turn", turnId, requestId: s.requestId, continuation: false };
        },

        turn: async (s, ctx) => {
          const writer = await ctx.stream("assistant");   // epoch rotates on reclaim
          const result = await this.generate(s.turnId, writer, {
            signal: ctx.signal,
            steer: () => ctx.peekAll({ kind: "message" }),  // steer at the boundary
            credit: () => ctx.creditProgress()              // forwarded sub-agent output
          });

          if (result.kind === "needs-approval") {
            // `ask` is synchronous: raise the questions and commit the phase
            // that admits their answers, in one expression (invariant 18).
            return {
              phase: "approval",
              turnId: s.turnId,
              toolCallIds: result.toolCalls.map((c) => c.id),
              asks: ctx.ask(
                ToolApproval,
                result.toolCalls.map((c) => ({ toolCallId: c.id, input: c.input })),
                { expiresIn: "1 day" }
              )
            };
          }

          if (result.kind === "agent-tools") {
            const kids: string[] = [];
            for (const call of result.calls) {
              const receipt = await ctx.spawn("agent-tool@v1", call.input, {
                owner: call.facet, runId: `tool:${call.id}`   // children may live on facets
              });
              kids.push(receipt.runId);
            }
            return { phase: "children", turnId: s.turnId, childRunIds: kids };
          }

          // The returned state IS the commit; the stream settles in the same transaction.
          return { phase: "idle" };
        },

        approval: async (s, ctx) => {
          const decisions = await ctx.answers(s.asks, { within: "1 day" });
          if (decisions === ctx.timedOut) return { phase: "idle" };
          await this.applyApprovals(s.toolCallIds, decisions);   // ApprovalDecision[]
          // No continuation turn, no debounce barrier: the same run re-enters `turn`.
          return { phase: "turn", turnId: s.turnId, requestId: s.turnId, continuation: true };
        },

        children: async (s, ctx) => {
          const results = await ctx.join(s.childRunIds, { within: "1 hour" });
          if (results === ctx.timedOut) return { phase: "recover", turnId: s.turnId, mark: "turn-deadline", budget: 1 };
          for (const r of results) await this.applyToolResult(r);
          return { phase: "turn", turnId: s.turnId, requestId: s.turnId, continuation: true };
        },

        reply: async (s, ctx) => {
          await ctx.do("deliver", { retries: { limit: 1 }, timeout: "1 day" },
                       ({ signal }) => this.deliverReply(s.replyTo, { signal }));
          return { phase: "idle" };
        },

        // The recovery engine's job, expressed as a phase: the checkpoint IS the
        // stash, and the stream cursor IS the evidence.
        recover: async (s, ctx) => {
          const repaired = await this.repairTranscript(s.turnId);
          if (!repaired || s.budget <= 0) return ctx.fail(new Error("unrecoverable"));
          return { phase: "turn", turnId: s.turnId, requestId: s.turnId, continuation: true };
        }
      },

      onCancel: async (s, ctx) => {
        if (ctx.cancelling === "turn-deadline" && s.phase === "turn") {
          // Stall watchdog: repair rather than kill.
          return { phase: "recover", turnId: s.turnId, mark: "turn-deadline", budget: 2 };
        }
        await this.markTurnCancelled(s);
        return ctx.aborted(ctx.cancelling ?? undefined);
      },

      migrate: (checkpoint, fromVersion) =>
        fromVersion === 0 ? { state: { phase: "idle" } as ConvState } : (() => {
          throw new Error(`no migration from v${fromVersion}`);
        })()
    } satisfies TaskMachine<ConvState, ConvMessage, void, ConvSeed>
  }
});

await this.tasks.run("conversation@v1", { conversationId }, { runId: `conv:${conversationId}` });

const conv = this.tasks.at("conversation@v1", `conv:${conversationId}`);
await conv.send({ text }, { requestId, kind: "message", policy: "latest" });
await conv.answer(askId, ToolApproval, { behavior: "allow" });  // any isolate, id only
```

The checkpoint is roughly 200 bytes — a phase tag and a few ids — well
inside §4.7's cap. Everything bulky (the transcript, the stream) lives
where it already lives.

What disappears: `_liveChatTurnClosures`, `TurnQueue`,
`SubmitConcurrencyController`, `PreStreamTurns`,
`AutoContinuationController`, `ContinuationState`, `liveReplies`,
`AbortRegistry`, `cf_think_submissions`,
`cf_think_action_pending_approvals`, the
`__cf_chat_turn_snapshot:<runId>` stash key, the
`__cf_messenger_recovery:<runId>` key, and the 2 176 lines of
`recovery-engine.ts` + `recovery-incident.ts` + `recovery-task.ts` +
`stall-watchdog.ts`.

### (b) A Workflows-shaped job with `waitForEvent` — the high-level API, unchanged

```ts
"build-report@v1": async (input: ReportInput, step: TaskStep) => {
  const research = await step.do(
    "research",
    { retries: { limit: 4 }, timeout: "5 minutes" },
    ({ signal, idempotencyKey }) => this.research(input.topic, { signal, idempotencyKey })
  );
  await step.sleep("cool-off", "30 seconds");
  const approval = await step.waitForEvent<{ ok: boolean }>("approval", {
    type: "report.approved",
    timeout: "1 day"
  });
  if (!approval.payload.ok) throw new NonRetryableError("rejected");
  return step.do("publish", () => this.publish(research));
}

await this.tasks.run("build-report@v1", { topic }, {
  runId: `report:${topic}`, deadline: Date.now() + 7 * 86_400_000,
  interruptions: { limit: 5, delay: "10 seconds" }
});
await this.tasks.sendEvent(`report:${topic}`, { type: "report.approved", payload: { ok: true } });
```

Compiled: checkpoint `NULL`, `turn` 0 forever, journal rows
`(runId, 0, "research"|"cool-off"|"approval"|"publish")`, idempotency
keys `${runId}:research` etc. Replay from the first line on every
attempt. A timeout here **throws** `TaskEventTimeoutError` — Workflows
parity — where the machine layer's `within` would have returned
`ctx.timedOut`.

### (c) A harness driver (pi / codex / flue)

The harness RFC's four tables and its 4 000-pass rotation collapse into a
machine. `cf_agents_harness_inbox` → the mailbox;
`cf_agents_harness_requests` → asks; the fixed-`runId`, `retain:false`,
rotate-every-4000-passes driver run → one run whose journal is retired at
every checkpoint change, so `MAX_STEPS_PER_RUN` is never approached; the
"first execution vs replay" in-memory bookkeeping → the state parameter.

```ts
type DriveState =
  | { phase: "idle" }
  | { phase: "operating"; operationId: string; wireSeq: number }
  | { phase: "awaiting"; operationId: string; asks: Pending<PermissionDecision>[] };

const Permission = defineAsk<PermissionRequest, PermissionDecision>("permission");

"harness-session@v1": {
  initial: (_seed: { sessionId: string }): DriveState => ({ phase: "idle" }),
  phases: {
    idle: async (_s, ctx) => {
      const item = await ctx.receive();          // prompt | interrupt | reply | compact
      if (item === ctx.timedOut) return { phase: "idle" };
      if (item.kind !== "message") return { phase: "idle" };
      const operationId = ctx.memo(`op:${item.key}`, nanoid());  // replaces the admission row
      return { phase: "operating", operationId, wireSeq: 0 };
    },
    operating: async (s, ctx) => {
      const writer = await ctx.stream(s.operationId);
      const outcome = await this.runtime.drive({
        sessionId: ctx.input.sessionId, operationId: s.operationId,
        writer, signal: ctx.signal, step: ctx,                   // TaskContext IS TaskStep
        inbox: { peek: () => ctx.peekAll(), take: (k) => ctx.withdraw(k) },
        heartbeat: () => ctx.heartbeat()
      });
      if (outcome.kind === "permission") {
        return {
          phase: "awaiting",
          operationId: s.operationId,
          asks: ctx.ask(Permission, outcome.requests, { expiresIn: "1 hour" })
        };
      }
      return { phase: "idle" };                                   // settles the operation log
    },
    awaiting: async (s, ctx) => {
      const decisions = await ctx.answers(s.asks, { within: "1 hour" });
      if (decisions === ctx.timedOut) return { phase: "idle" };
      this.applyPermissions(decisions);
      return { phase: "operating", operationId: s.operationId, wireSeq: 0 };
    }
  },
  onCancel: async (_s, ctx) => ctx.aborted(ctx.cancelling ?? undefined)
} satisfies TaskMachine<DriveState, HarnessMessage, void, { sessionId: string }>
```

```
await this.tasks.run("harness-session@v1", { sessionId },
                     { runId: `session:${sessionId}`, turnTimeout: "1 hour" });
```

— no rotation, no `retain:false` trick, no inbox table.

### (d) Chat recovery on the new API

`createChatRecoveryTaskDefinition` (`chat/recovery-task.ts:186-203`) is
already a two-step function definition (`step.sleep("backoff")` then
`step.do("continuation")`). It **keeps working unchanged** as a compiled
function definition, and that is the migration's first release.

Its second release deletes it, because the `recover` phase of §12(a) does
its job with no separate run at all: no `chatRecoveryTaskRunOptions`, no
`retain:false` key-release trick, no `dispatchChatRecoveryToHandoff`
model-handoff dance (the dispatch budget's own re-entry loop replaces
it), no `redefer` dedupe key, no incident table. The chat turn's
`__cf_chat_turn_snapshot:<runId>` storage key
(`chat/turn-task.ts:56,100-124` — an unbatched `storage.put` outside any
transaction, deleted fire-and-forget) is replaced by the checkpoint,
which is transactional by construction. `ChatTurnTaskHooks.handleRecovery`
/ `withStash` / `getLiveClosure` all go.

**The drain rule, because this is the one place a shim can double a
user-visible turn.** Keep the original step definition registered,
unmodified, until its rows settle. An in-flight recovery run's durable
state is not only the incident record — it is the journal, and a run
whose `continuation` step already completed would, under a
hand-off shim, be re-run and produce a second recovery turn for a user
who already got one. The rows are `retain:false` and short-lived, so one
release is ample. If a hand-off is wanted instead, the shim must read the
journal (`continuation` completed ⇒ settle, do not re-dispatch) first.

---

## 13. Deliberately out of scope for v1

| Not shipping                                                                                  | Why                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowInstance.restart({ from })`                                                          | needs a rewindable journal; we deliberately retire the journal at every checkpoint change, which is what caps a long-lived actor's storage                                                                         |
| Step rollback / per-effect `compensate` (`WorkflowStepRollbackOptions`, workers-types :15465) | needs a compensation graph and an ordering model; the effect sandwich (commit intent → effect → commit outcome) is the supported idiom, expressible today. v2                                                      |
| `WorkflowStepConfig.sensitive: "output"`                                                      | needs storage-level redaction across journal, view and events                                                                                                                                                      |
| `WorkflowDelayFunction` dynamic delays (:15398)                                               | a durable park must compute its wake time without running user code at wake                                                                                                                                        |
| `WorkflowStepContext.step.count` (:15437-15440)                                               | per-name occurrence counting; loop steps take a stable suffix, as `DuplicateTaskStepError`'s message already advises. This also closes `restart({from})` permanently, since `count` addressing is its prerequisite |
| `waitForCompletion` on `run()`                                                                | acceptance is durable and asynchronous by design; `watch` + `view` is the await                                                                                                                                    |
| `watch({ from })` resumable cursor                                                            | needs a durable change log = one write per change on the hottest paths                                                                                                                                             |
| `ctx.forkWith(state, effect)`                                                                 | an un-awaited promise is not durable, and a second commit path breaks invariant 5; background work is `spawn` or a stream                                                                                          |
| A `drain()` verb                                                                              | `pause()` already means "stop at the next boundary and keep the checkpoint"                                                                                                                                        |
| A `kill()` verb                                                                               | `terminate()` is the Workflows name for the same tier                                                                                                                                                              |
| Cross-object / cross-Worker orchestration                                                     | a run's storage lives where it was accepted; cross-object is Workflows' job                                                                                                                                        |
| Automatic checkpoint compaction or a size heuristic                                           | §4.7 fails loudly instead; an automatic heuristic would hide a growing state until it was expensive                                                                                                                |
| An ask spill table (asks beyond N move out of the checkpoint)                                 | the 256 KiB cap plus per-batch expiry is the bound for v1; revisit if a real consumer parks thousands of open asks                                                                                                 |
| CRDT / multi-writer mailbox merge                                                             | `receiveAll` + a handler fold is sufficient and explicit                                                                                                                                                           |
| A static transition graph (`toMermaid()`, `getNextTransitions()`, model-based testing)        | code per state has no declarative graph to read; annotating a handler's return recovers part of it at zero cost (§2.8)                                                                                             |
| Making a missing `satisfies` a compile error                                                  | probe 5 shows the parameterless case degrades silently; making it loud requires a constraint that rejects every concrete machine (probes 2 and 3). The lint rule is the answer                                     |

---

## 14. Implementation plan

### 14.1 Files under `packages/agents/src/tasks/`

| File                                        | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.ts` (1 712 lines)                    | **rewrite in place.** Keep verbatim: `#accept` (± base-name compare), `#syncWake`/`#syncRoutedWake`/`onRoute`, `onMemoryLimit`/`#applyMemoryLimit` (± §5.7), `#dispatchRun`'s budget race, `#wakeOutcome`/`#nextWake`, `#settleThrown`'s platform branch, `#settleFailed`/`#settleCancelled`, `#runRetryPolicy`/`#parkInterruption`, `#reconcile` (± §5.10), `#syncAllWakes`, `register`, `cleanupRoutePrefix`. **New:** the transition loop, the decision list, the abort protocol, mailbox/ask/child/route verbs, `view`/`watch`, `at`, `pause`/`resume`/`terminate`/`reopen`. **Deleted:** `__DO_NOT_USE_WILL_BREAK__runAttached` and `__DO_NOT_USE_WILL_BREAK__enqueue`; `register(name, def).run(input, { start })` replaces both, and every in-repo caller moves in the same PR. |
| `store.ts` (242)                            | **extend.** Keep `fencedWrite`, `sql`, `write`, `rowToSnapshot`, `ensureTables`, `addRunBudgetColumns`, the index rationale comment. Add `addMachineColumns`, the four new tables, `rebuildJournal`, the six-statement `deleteRun` cascade, `rowToView`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `replay.ts` (536)                           | **keep, rename the class to `TaskContextImpl`, extend.** `ReplayStep`'s replay semantics, `TaskSuspension`, `TaskCancellation`, `AttemptSupersededError`, `resolveRetryPolicy`/`resolveStepPolicy`/`computeRetryDelayMs`, `#executeAttempt`, `#raceTimeout`, `#enterStep`, `#sleepAt` are all untouched logic. Add the machine members as new methods on the same class — this is what makes `TaskContext extends TaskStep` one implementation. Export `ReplayStep` as a deprecated alias.                                                                                                                                                                                                                                                                                             |
| `engine-port.ts` (179)                      | **extend.** Same port shape; journal methods gain a `turn` parameter, `stepIdempotencyKey` gains the scope rule (§3.4), and `cancellationRequested` reads `abort_mark = 'cancel'`. New port methods for mailbox, asks, memos, children, checkpoint and progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `types.ts` (410)                            | **extend** with §2's declarations. `TaskHandlers`, `TaskCallbacks`, `TaskInput`, `TaskOutput`, `Task` keep their names as aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `options.ts` (54)                           | **extend** `TasksOptions` (`turnTimeout`, `stallLimit`, `transitionBudget`, `mailboxLimit`) and `TaskEventType`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `errors.ts` (152)                           | **extend** with §2.7's nine new classes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `serialization.ts` (68), `duration.ts` (55) | **unchanged**, plus `MAX_CHECKPOINT_BYTES` and the structural first-commit check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `index.ts` (39)                             | **extend** the export list (`defineAsk`, `AskKind`, `Pending`, `TaskMachine`, `TaskContext`, `TaskTerminal`, `TaskTimedOut`, `AssertJson`, `TaskState`, `TaskMailbox`, `TaskRunHandle`, the new errors).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `machine.ts`                                | **new** — the function→machine compiler (§3.1), ~60 lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mailbox.ts`, `asks.ts`                     | **new** — the two verb families, behind the engine port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 14.2 What to reuse, explicitly

Generation-fenced writes (`store.fencedWrite`); the claim-backstop +
heartbeat sizing argument (`engine-port.ts`'s `claimRefreshAfterMs`
comment); `syncWake`/`onRoute`/`onMemoryLimit` routing; the
dispatch-budget race and `trackAlarmWork` handoff; `ReplayStep` wholesale
as the high-level layer; `isPlatformFailure` /
`isDurableObjectCodeUpdateReset` / `isDurableObjectMemoryLimitReset`
classification; the store's index-cost rule (an index is worth its
per-write tax only for columns written once);
`ResumableStream.progressMarker`'s derive-don't-maintain pattern for
`progress`; `Streams.#settle`'s transaction for the cutover; the shipped
`TaskDurationString` + `parseTaskDuration` for every duration (do not
introduce a second spelling); the shipped `TaskReceipt` /
`idempotencyKey` acceptance convention for `send` and `answer` (do not
invent a third spelling of get-or-create).

### 14.3 Sibling-capability work items — **already landed**

**Status: both of these shipped on this branch in commit `785a68dd`**
("feat(lifecycle,streams): jobs.pushSync/cancelSync and
StreamWriter.onCommit"), after the `f28ffc2f` base this document's
citations are written against. `pushSync`/`cancelSync` are at
`lifecycle/job-queue.ts:130,140` and `lifecycle/durable-object-lifecycle.ts:760,765`;
`StreamWriter.onCommit` is at `streams/types.ts:108` and
`streams/streams.ts:561`; the doc sections are in `docs/agents/lifecycle.md`
and `docs/agents/streams.md`, and the changesets are
`.changeset/lifecycle-jobs-push-sync.md` and
`.changeset/streams-writer-on-commit.md`. **The engine PR therefore has
no sibling-capability work to schedule and must not re-publish either
changeset** — it consumes what is already there. The specification below
is kept because it is what the engine depends on.

```ts
// lifecycle/job-queue.ts — additions to LifecycleJobs (:108-129)
/** Push one job WITHOUT re-arming the alarm. The caller MUST call `rearm()`
 *  after its transaction commits. For use inside `storage.transactionSync`,
 *  where the async re-arm cannot run. */
readonly pushSync: (options: LifecycleJobPushOptions) => LifecycleJob;
/** Cancel one owned job without re-arming. Same contract. */
readonly cancelSync: (id: string) => boolean;
```

These are the same `JobQueue.push` / `JobQueue.cancel` calls
(`job-queue.ts:223`, already synchronous) minus the `rearmAfter` wrapper
built in `#jobsForOwner` (`durable-object-lifecycle.ts:735-752`).
Contract: _the caller re-arms after commit._ Startup rule:
`rearmAlarm()` is a no-op while `status === "starting"` and sets
`#rearmRequestedDuringStart` (`:762-767`), so a `pushSync` during startup
needs no explicit re-arm — the coalesced post-startup re-arm covers it. A
lost re-arm outside startup is repaired by `#syncAllWakes` on the next
start.

What that took, all of it now landed at `785a68dd`: the two signatures,
the `LifecycleJobs` doc comments, `tests-d/lifecycle-export.test-d.ts`,
`docs/agents/lifecycle.md`, and a changeset line; plus, on the Streams
side, `StreamWriter.onCommit` in `streams/types.ts` and
`streams/streams.ts`, `docs/agents/streams.md`, and its own changeset
line (§9.2).

### 14.4 Consumer migrations, in order

Each numbered item is one release with its own green test suite. The
detailed, PR-numbered version of this list, with its blocked-on gates, is
[tasks-cleanup-plan.md](./tasks-cleanup-plan.md); **this is the ordering
the engine depends on, and the ordering is what the plan must preserve —
where it groups two of these items into one changeset, splits one into
several PRs, or lands two of them in the other order because one depends
on the other, it says so inline.** Steps 1 and 2 are the standing
example: they ship as **one** release, and inside it the plan's order is
handle (PR 3) → call-site moves and aperture deletion (PR 4) → engine
(PR 7), because the moves land on a handle only step 2 creates.

1. **Engine + schema v3.** All 70 existing scenarios pass with three of
   the four mechanical edit classes of §3.10. The fourth — the aperture
   call-site moves — belongs to step 2 and lands _before_ the engine (the
   plan's PR 4), because it needs the handle step 2 creates. Nothing
   outside `packages/agents/src/tasks/` changes semantically. Ships with
   step 2, one release.
2. **`register()` returns a handle, and the two start apertures are
   deleted.** This is §3.10's fourth mechanical edit class, and it lands
   ahead of the engine. The five production call sites of §5.11 move to
   `handle.run(input, { start })`, and `capability.test.ts:127` moves
   with them; the eight `enqueue` test sites go to public
   `run(name, input, { start: "queued" })`, since every one of them
   passes a non-reserved name (§3.10). The deletion lands in that same
   PR (the plan's PR 4) — no wrapper survives it, and no consumer waits
   for a later release to move.
3. **`Agent`'s bridge widens.**
   `declare readonly taskDefinitions?: TaskDefinitions` (was
   `TaskHandlers`, `index.ts:1326`); `TaskDefinitionResolver` returns
   `TaskDefinition | undefined`; the cast at `index.ts:1931-1935` widens
   correspondingly. **Stated limitation:** per-definition `State`
   inference is _impossible_ through a lazy resolver — the resolver is
   keyed by `string` and its return type cannot depend on the key — so an
   Agent subclass's `this.tasks.run()` stays input-typed but
   state-untyped, exactly as it is today. An Agent that wants a typed
   machine handle constructs its own `new Tasks({ definitions })` and
   installs it, which is the documented path. `TaskHandlers`,
   `TaskCallbacks`, `TaskInput`, `TaskOutput` stay exported;
   `TaskInput`/`TaskOutput` are widened to read both forms (§2.8), which
   is what keeps `tests-d/tasks-export.test-d.ts:72-84` compiling.
4. **`Tasks.handle()` returns `TaskHandle`; `tasks.at()` lands.**
   `Task<Input, Output>` becomes an alias for
   `TaskHandle<unknown, Input, unknown, Output>` (§2.5). The lens carries
   the **definition type** as its first parameter, which is what makes
   the probe below writable at all: one `tests-d` probe pins that a
   machine handle exposes `send`/`view`/`watch` and that on a function
   handle all three are `never` and so uncallable, and that `at()` types
   `send`'s payload from `TaskMailbox<D[K]>`.
5. **`LifecycleJobs.pushSync`/`cancelSync`** and
   **`StreamWriter.onCommit`** — **already landed** at `785a68dd`
   (§14.3). Not a release of its own; item 1 consumes them, and its
   changeset must not re-announce them.
6. **Facet parity.** Routed mailbox/ask/child/route paths;
   `cleanupRoutePrefix`'s extended contract; `memory-limit.test.ts` gains
   three routed cases. The stale "no runs on routed sub-agents" claims
   come out of `docs/agents/tasks.md:283-291`, `think.ts:5045-5047`,
   `ai-chat/src/index.ts:808-810` and `think.ts:11268` — the capability
   has mirrored routed wakes since owner-path dispatch landed (#2194) and
   the comments were never updated.
7. **Chat turn.** `chat/turn-task.ts` → a machine phase. The
   `__cf_chat_turn_snapshot:<runId>` key is replaced by the checkpoint;
   `ChatTurnTaskHooks.getLiveClosure`/`withStash`/`handleRecovery` are
   deleted. **`ai-chat` moves in lockstep with `think`** — they register
   the _same_ two definitions (`think.ts:4850,4870`;
   `ai-chat/src/index.ts:712,732`) and share
   `createChatTurnTaskDefinition`, so a one-sided change breaks the other
   package's suite.
8. **Chat recovery.** `chat/recovery-task.ts` keeps working unchanged as
   a compiled function definition through releases 1–7; here the
   `recover` phase replaces it and `_enqueueChatRecovery` goes, under the
   drain rule of §12(d).
9. **Think's in-memory machinery**, one structure per PR, each with its
   suite staying green: `_liveChatTurnClosures`, `TurnQueue`,
   `SubmitConcurrencyController`, `AbortRegistry`, `PreStreamTurns`,
   `AutoContinuationController`, `ContinuationState`, `liveReplies`.
10. **Think's messenger reply** → the `reply` phase;
    `ThinkMessengerRuntime`'s
    `hasLiveReply`/`executeLiveReply`/`initialReplySnapshot` and the
    `__cf_messenger_recovery:<runId>` key go.
11. **Think's submissions, approvals, agent-tool children.**
    `cf_think_submissions` (`think.ts:10214`) → the mailbox;
    `cf_think_action_pending_approvals` + its `created_at` index +
    `_sweepActionPendingApprovals` (`think.ts:9651,9663,9738`) → asks;
    `runAgentTool`'s `_readAgentToolRun`/`_armDetachedBackbone` ledger →
    `ctx.spawn` + child mailbox rows. One-time data migration: a startup
    pass `tasks.send`s each non-terminal `cf_think_submissions` row onto
    the conversation run with `requestId = submission_id` — the PK
    conflict makes the pass idempotent — then marks the row migrated; the
    table drops a release later.
12. \*\*Delete `ChatRecoveryEngine` (1 041) + `recovery-incident.ts` (833)
    - `recovery-task.ts` (203) + `stall-watchdog.ts` (99) = 2 176
      lines\*\*, once nothing calls `handleRecovery` — which includes
      `chat/turn-task.ts:82` (release 7) as well as the fiber scan.
13. **The legacy fiber engine.** `runFiber()` / `startFiber()` are
    **kept and deprecated**, not deleted, until the cleanup plan's
    deprecation window closes: they are released public API with their
    own recovery scan (`index.ts:4021,4045,4393-4559`) and their own
    suites (`tests/run-fiber.test.ts`, `e2e-tests/fiber-eviction.test.ts`,
    `e2e-tests/concurrent-fibers.test.ts`). `FiberRecoveryContext`
    (`index.ts:485`) stays exported because it is the recovery seam's
    public type. Their JSDoc gains a `@deprecated` line pointing at
    Tasks, and the docs' "facet-hosted work stays on the legacy fiber
    engine" sentence is deleted, since that was the last reason to reach
    for them.
14. **Example harnesses**
    (`examples/next/harnesses/{pi,codex,self-modifying}` in this
    worktree) onto §12(c). `examples/next/harnesses/claude-code` exists
    only in the `agents-harness-capability` worktree, so **that migration
    is ordered after the harness capability lands** and is tracked there,
    not here. **flue** (external, withastro/flue): publish the mapping as
    a migration guide; do not vendor it.

### 14.5 Tests to write

_Storage and fencing._ Write-count assertions for every row of §4.6.
Two probe shapes already exist and they are different mechanisms: a
per-cursor `rowsWritten` sum, in `tests/capabilities/sessions.ts:15-42`
(the `BilledRows` wrapper, and the closest match to §4.6's index-inclusive
arithmetic, since a touched index shows up in `rowsWritten` but not in
`total_changes()`) and `sqlite-strategies-bench.ts:71-74`; or a
`total_changes()` delta, in `streams-bench.ts:16,145`. Use the per-cursor
one. Fence rejection under `abort_mark`. A seeded dead-generation
transition whose every late write is refused. Atomicity: kill between a
run INSERT and its queue job, between a mailbox INSERT and its wake,
between a stream settle and a checkpoint write — each asserted impossible
by the transaction.

_Scheduler._ Each of the nine post-transition rules, by exact row-write
count and resulting row. **A park that reproduces the same deadline is
not a fault** (rule 5 above rule 9). `stallLimit` at 1 and 3.
`transitionBudget` at 3, with a `{ phase: "idle", n: n + 1 }` machine
faulting with `TaskTransitionBudgetError` and the phase cycle in the
message, and a park resetting the counter to 0. Transition-loop re-entry
within one invocation (a two-phase effect sandwich: one claim, two
checkpoint writes, one journal retirement). Dispatch-budget detach with a
looping machine, **and the routed equivalent** (§5.6): a facet-side loop
yields at the budget and re-syncs its wake. `#reconcile` leaves a
mailbox-parked run's `next_at` NULL across a restart, and still floors a
`pending` row (§5.10, both halves of the predicate).

_Abort._ Inline default for a function definition (the #2274 tests, by
construction). Declared `onCancel` with a terminal return; with a
checkpoint return that clears the mark and resumes; declining a cancel
then `terminate()`. `onCancel` that tries to park →
`TaskCancelCannotParkError`. Non-reentrancy: a second cancel during
`onCancel` does not re-dispatch it. The join happens before the fresh
invocation (observed by an instance counter). `cancel(runId, {wait:true})`
vs. the intermediate snapshot (`abortRequested:true`). Zombie: a
signal-deaf transition whose post-mark writes are all refused and whose
stream append throws `StreamClosedError`. **Transition deadline on a live
healthy isolate** fires the watchdog and `onCancel` owns the outcome; a
function definition whose steps keep calling `refreshClaim` never reaches
it. The disposition table of §6.8, one case per cell.

_Mailbox._ FIFO by `seq` across kinds; filter non-consumption;
`requestId` dedupe writing **zero** rows; `latest` and `drop` and durable
`debounce` surviving a simulated eviction; `withdraw` before and after
consumption; `mailboxLimit`; send to a terminal run returns
`{accepted:false}` and resurrects nothing; a send that lands before the
handler reaches `receive` is buffered and delivered. **Wake elision:** a
send to a live run writes one row and is still observed, including the
park-boundary re-read that converts a park into a re-entry. `seq`
assignment after a full drain. `receive({ within })` returning
`ctx.timedOut` without a second row write.

_Asks._ Park on many with `mode:"all"` and `"any"`; answer from a fresh
isolate with only the ask id; double answer returns
`{accepted:false, reason:"duplicate"}`; expiry folded into `next_at` and
flipping to `expired` without deleting; withdrawal at settle; `asks()`
across runs; a `Pending<A>[]` round-tripping through the checkpoint
unchanged; `answers({ within })` returning `ctx.timedOut`.

_Children._ Local and cross-facet spawn; `receive({kind:"child"})` join
and the `ctx.join` sugar over the same rows; `background` excluded from
both the default join and the cascade; cascade on abort, local and
routed; a child settling after the parent is a zero-row no-op;
`notify:false`; deleting a facet subtree reaps route rows **and** the
parent's child mailbox rows.

_Streams._ Cutover atomicity (a throwing `commit` leaves the stream live
and the checkpoint unadvanced); **`close()` returning `false` unwinds the
transition instead of silently skipping the checkpoint** (§9.2 — the
settle-already-happened path); **reclaim seals the old epoch and the
replayed transition opens the next one cleanly** (the regression this
design exists for — a naive re-attach throws `StreamClosedError`); sealed
segments fold forward so `progress` never regresses; two named streams on
one run settling independently; progress refreshing `turn_deadline_at`;
the interruption-budget reset on advanced `progress`.

_Observation._ Every field of `TaskRunView` — all nine of them (§2.6) —
against a run in each phase; each of the eleven `TaskChangeType`s fires
once; a `watch` subscriber that
dies with its isolate re-subscribes and re-reads `view()` with no gap in
durable state; `watch` over the WebSockets capability with a hibernated
socket; a `tests-d` probe pinning the `TaskRunSnapshot` →
`InstanceStatus.status` mapping of §9.5, including that
`waitingForPause` has no source.

_Versioning._ Migrate across `@vN`: one write, journal retired,
`definition` rewritten; joining an existing `@v1` run by address under
`@v2`; unmigratable → `failed` + `outcome:'orphaned'` with the checkpoint
preserved **even at `retain:false`**; `reopen()` after redeploying
resumes from that checkpoint; an orphan costs no alarm.

_Types (`tests-d/tasks-export.test-d.ts`)._ The five probes of §2.8 as
`expectTypeOf` assertions, **including probe 5's partially silent
degradation** — pinned deliberately so a future change to loudness is
reviewed; the lint rule's own fixture; `TaskInput`/`TaskState`/
`TaskOutput`/`TaskMailbox` extracting from both definition forms —
**including `TaskOutput` on a machine whose only terminal is in
`onCancel`** (§12(a)'s and The proposal's `chat@v1` are both that shape,
and a `phases`-only reading types them `void`), and an exactness
assertion rather than an assignability one, since `unknown` is assignable
from anything and would pass a loose check; a forged terminal, a
forgotten `return`, and an unguarded `receive()` each failing to compile; `AssertJson` accepting an `interface`-spelled state
and rejecting a `ReadableStream` field.

_Migration._ v0→v3, v1→v3, v2→v3. A v2 object with an in-flight run
parked on a sleep and one completed step: assert the run resumes, the
step does not re-execute, `stepIdempotencyKey` is byte-identical, and
`cf_agents_task_steps` is gone. The batched copy across two starts above
the threshold, with the second start resuming from the cursor and **no
dispatch at version 2.5**. `cancel_requested = 1` backfilling
`abort_mark = 'cancel'`.

_Delete cascade._ Zero orphan rows in all five tables after each of:
`retain:false` settle, `tasks.delete()`, the sealing purge, facet subtree
teardown.

_Facets and memory limit._ The whole existing `memory-limit.test.ts` with
only the mechanical edits of §3.10, plus: a routed machine run's mailbox
and asks on the facet with wakes mirrored to the root; **`answer(askId)`
on a facet-hosted run parked with no wake at all** (the §4.5
regression); a sealed strike marking children at `context.nextTime`
without re-triggering the breaker; a non-sealed strike leaving an
event-only park's `next_at` NULL (§5.7).

_E2E (`src/e2e-tests/worker.ts`, alongside
`tasks-capability-eviction.test.ts` and `stream-cutover-crash.test.ts`)._
A machine definition beside the existing step definition. SIGKILL
mid-transition → the checkpoint resumes and no effect ran twice; SIGKILL
between the halves of an effect sandwich → the intent phase is re-entered
exactly once; SIGKILL mid-stream → the epoch rotates and the truncated
output stays readable; a run accepted under schema v2 and resumed under
v3 (the migration's real acceptance test).

_Parity ratchets._ Think and ai-chat keep their full suites green at
every step of §14.4. The baseline is whatever
`pnpm --filter @cloudflare/think exec vitest --run` and
`pnpm --filter @cloudflare/ai-chat exec vitest --run` report on the
commit each PR branches from, recorded in that PR's description.

### 14.6 Docs

Rewrite `docs/agents/tasks.md` as "two APIs, one engine", **leading with
the unchanged one** so existing readers find their page intact:

1. What a Task is — one durable program, two ways to write it.
2. **Durable jobs** — today's `## The step API` and
   `## Replay semantics` sections verbatim, plus `waitForEvent` +
   `sendEvent`, with the three Workflows deviations of §2.9 in a callout.
3. **Durable actors** — the machine: `initial`/`phases`/`onCancel`, the
   `satisfies TaskMachine<State, Mailbox, Result, Seed>` rule and the
   lint rule that enforces it, **and the honest note that omitting it on
   a map of parameterless handlers degrades silently**.
4. The runtime — mailbox (with the four-mode cost table of §7.5, the
   buffering and terminality guarantees of §7.4, and the per-sender
   ordering guarantee of §7.1), asks, memo, spawn/join, stream, status,
   heartbeat, and the rule that **timer primitives never touch
   `setAlarm`**.
5. **One engine** — §3, ending on "the workflow API is the state machine
   with less freedom", with the `TaskContext extends TaskStep`
   declaration as the proof.
6. Replay, progress and faults — the post-transition decision list, Rule
   A and Rule B, `step.interrupted`, why there is no recovery callback.
7. Abort and deadlines — the five causes, the fresh-invocation rule, the
   inline default, the transition watchdog, and the disposition table of
   §6.8.
8. Versioning — `@vN`, `migrate`, `orphaned`, `reopen`, and the
   discriminant-placement rule (invariant 18).
9. Observation — `get`/`view`/`watch`/`status`, `tasks.at()`, and the
   `InstanceStatus` table of §9.5.
10. Choosing a layer — the existing `## Choosing an API` table
    (`docs/agents/tasks.md:274-281`) gains a row: _a job has a beginning
    and an end; an actor has an address_ — and the row-write arithmetic
    of §4.6 beside the step API's per-step cost, so the choice is made on
    numbers.
11. Current limits → §13. **Delete the stale "no runs on routed
    sub-agents / stays on the legacy fiber engine" sentence in
    `## Current limits` (`:283-291`)**, and mark `runFiber`/`startFiber` deprecated rather than
    merely "unchanged".

Also: `docs/agents/lifecycle.md` for `pushSync`/`cancelSync`;
`docs/agents/streams.md` for `StreamWriter.onCommit`;
`design/alarm-coordination.md`'s Tasks paragraph (:26-31 and :72-87) for
the transition deadline, for event-driven parks carrying no wake, and to
drop the "until Tasks can mirror child wakes to the alarm owner" caveat;
mark `design/rfc-fibers.md` superseded in its execution half, noting that
its "deferred: facets" line was already stale.

### 14.7 Changeset

```md
---
"agents": minor
---

`agents/tasks` becomes one durable state-machine engine with two APIs.

The Workflows-shaped step API is unchanged — `(input, step) => result`,
replay from the first line, `step.do`/`sleep`/`sleepUntil`/`status`/
`idempotencyKey`/`signal`/`attempt`/`interrupted`, `NonRetryableError`,
run `deadline` and `interruptions` — and gains
`step.waitForEvent(name, { type, timeout })` with `tasks.sendEvent()`,
matching `cloudflare:workflows`. One deliberate difference: an event sent
before the run reaches the call is buffered and consumed when it gets
there.

Alongside it, a definition may now be a durable state machine:
`{ initial, phases, onCancel?, migrate? }`. `initial` is the first
checkpoint — a value, or a function of the run's input. `phases` holds
one handler per phase, `(state, ctx) => next`, keyed by the state union's
`phase` discriminant: it receives the durable checkpoint, does work, and
returns the next one. Returning is the commit, one generation-fenced row
write. Annotate the definition
`satisfies TaskMachine<State, Mailbox, Result, Seed>` and each handler's
state narrows to its own phase; no helper function, no registration step.

`ctx` is the per-handler runtime, and it EXTENDS `step`: the same object,
with a durable mailbox (`receive`/`receiveAll`/`peek`/`peekAll`/
`withdraw`, with `latest`/`drop`/`debounce` send policies and
`requestId` dedupe before any write), correlated durable asks
(`defineAsk`, `ctx.ask`/`answers`/`peekAnswers`, answerable from any
later isolate with only the ask id and typed by the ask kind), `memo`,
owned children (`spawn`/`join`, cross-facet, with abort cascade and
background exclusion), `stream(name?)` whose settlement and the
checkpoint write commit in one SQLite transaction, `heartbeat` and
`creditProgress`. Every wait takes `within` and returns `ctx.timedOut`
rather than throwing, and the timer dies with the return. A step
definition is compiled onto that engine as a single-phase machine whose
one handler replays the function, and `step.do` is `ctx.do` on the same
journal. There is no second journal, no second claim path, no second
abort protocol.

Also: `tasks.send`, `sendEvent`, `withdraw`, `answer`, `asks`, `view`,
`watch`, `pause`, `resume`, `terminate`, `reopen`, and
`tasks.at(name, runId)` for a per-run typed handle; `run(..., { start,
background, turnTimeout })` plus a handle returned by `register()`, which
between them replace the `__DO_NOT_USE_WILL_BREAK__runAttached` and
`__DO_NOT_USE_WILL_BREAK__enqueue` apertures — **both removed in this
release**, with every in-repo caller moved, and the Removed paragraph
below says which of the two replacements a given call takes; `onCancel` as a
fresh, fenced, non-reentrant transition that may return a state (decline
the cancel) or a terminal, with `terminate()` as the forceful tier; a
per-transition watchdog separate from the run deadline, refreshed by real
stream progress; an interruption budget that counts attempts which made
no real progress; and two progress rules — a transition that changes
nothing, parks on nothing and writes nothing fails the run with
`TaskNoProgressError`, and a run that takes more than `transitionBudget`
(default 1000) transitions without parking fails with
`TaskTransitionBudgetError`. Runs on routed sub-agents (facets) are
supported, and the docs saying otherwise were stale.

Schema version 3 adds the checkpoint, progress, transition, abort-mark,
parent and stream-epoch columns to `cf_agents_task_runs` by plain
`ALTER TABLE ADD COLUMN`, adds mailbox, ask and routed-owner tables, and
rebuilds `cf_agents_task_steps` as `cf_agents_task_journal` keyed by
turn. The rebuild runs in batches under a durable cursor at an
intermediate version, each batch in its own transaction, and no
definition dispatches until it completes. In-flight runs migrate at turn
0 and resume from their journals with byte-identical step idempotency
keys; nothing is reset. Objects holding a large retained journal should
call `tasks.delete({ settledBefore })` before upgrading, since the
rebuild copies every retained row once.

Breaking, experimental surface. **Removed:**
`__DO_NOT_USE_WILL_BREAK__runAttached` and
`__DO_NOT_USE_WILL_BREAK__enqueue`. If the definition name is
`__cf`-prefixed, hold the handle `register(name, definition)` now returns
and call `handle.run(input, { start: "attached" | "queued" })` — public
`run()` still rejects reserved names, so `run(name, input, { start })`
throws for one. If the name is your own, call
`tasks.run(name, input, { start })`.
`__DO_NOT_USE_WILL_BREAK__cleanupRoutePrefix` is unchanged.

**Two type changes:** `TaskWaitReason` widens
to `sleep | retry | interrupted | mailbox | event | ask | child |
paused`, and `TaskRunSnapshot`'s `waiting` arm makes `wakeAt` OPTIONAL,
because a run parked on a mailbox, an ask or a child has no wake time and
reporting `updated_at` as a future wake was wrong. `TaskRunState` keeps
its six values; `faulted` and `orphaned` ride a new `outcome` field
beside `failed`. `runFiber()` / `startFiber()` are unchanged: facet-hosted
work no longer needs them, and they are deprecated in a following release
(§14.4 step 13) rather than in this one.
```

This one changeset covers the plan's PR 4 as well as PRs 7–9 — they are
one release — so the **Removed** paragraph above _is_ PR 4's changeset
line, not a second file to publish beside it.

### 14.8 Risk register

| Risk                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The journal rebuild is slow on a large retained ledger              | skipped when the table is absent or empty; warns above 10 000 rows; batched under a durable cursor at version 2.5, **each batch in its own transaction**, with no dispatch until the cursor completes; a crash resumes from the cursor rather than restarting                                                                                                             |
| Rule A faults a healthy handler                                     | parks are decided above it (§5.4 rule 5), so no exemption list is needed; `stallLimit` is tunable; every fault emits `task:faulted` and reaches `onError`, never silently. Proved unreachable on the compiled step path from a stated premise (§3.8), not from an enumeration                                                                                             |
| Rule B faults a legitimately busy machine                           | the budget counts transitions **since the last park**, and any park resets it; 1000 transitions with no park at one row write each is already a billing incident, which is the condition it is there to stop; it is tunable per capability                                                                                                                                |
| The cancel join changes cancel timing                               | the join awaits a promise already tracked in `#active`, bounded by `CLAIM_SLACK_MS`; a signal-deaf invocation does not block it (the engine proceeds, fenced). Function definitions never reach it — their default is inline (§6.4), which is what `capability.test.ts:641-659` requires                                                                                  |
| `onCancel`'s returned state is clobbered by the cancel-wins guard   | the fence predicate distinguishes the two cases (§5.2): ordinary writes require `abort_mark IS NULL`, the cancel transition's require `abort_mark IS NOT NULL`                                                                                                                                                                                                            |
| A stream cutover silently skips the checkpoint                      | the engine checks `close()`'s boolean and treats `false` as fenced-out (§9.2), with a dedicated test for the already-sealed path                                                                                                                                                                                                                                          |
| The stream epoch breaks a consumer expecting one stable id          | the shared `tag` is the stable identity and `Streams.list({tag, limit:1})` was designed for it; `view()`/`watch()` carry the epoch; an explicit `streamId` opts out of engine ownership entirely                                                                                                                                                                          |
| `satisfies` is easy to forget, and the parameterless case is silent | it is a typing loss, never a correctness loss — the definition still runs; docs and every example lead with it; a lint rule requires it on every `definitions` entry; `tests-d` pins the degraded shape so a change to loudness is reviewed. No helper is shipped, because every constraint that would make omission loud rejects every concrete machine (probes 2 and 3) |
| `pushSync` inside a caller's transaction diverges from `push`       | it is the same `JobQueue.push` call (`job-queue.ts:223`, already synchronous) minus the `rearmAfter` wrapper; the only contract is "caller re-arms after commit"; during startup `rearmAlarm` is already a coalescing no-op; a lost re-arm outside startup is repaired by `#syncAllWakes`                                                                                 |
| An event-parked facet run becomes unroutable                        | the wake-mirror job is cancelled by design for such a park (`tasks.ts:791-800`, `:856-866`), so the owner index is a separate durable table written once at accept (§4.5), covered by an explicit "answer an ask on a facet-hosted run with no wake" test                                                                                                                 |
| A routed machine loop holds a facet's RPC forever                   | the facet-side loop gets its own `DISPATCH_BUDGET_MS` cap and re-syncs its wake before returning (§5.6), tested on the routed path as well as the local one                                                                                                                                                                                                               |
| A growing checkpoint fails mid-run                                  | a 256 KiB cap, a quarter of the value cap, failing early and loudly with the previous checkpoint intact (§4.7); docs put bulk state in streams and sessions; the field to watch is an accumulating `Pending<A>[]`                                                                                                                                                         |
| No static transition graph                                          | owned, not mitigated: no `toMermaid()`, no `getNextTransitions()`, no model-based testing. Annotating a handler's return as `Promise<Extract<S, { phase: "…" }>>` recovers per-handler successor checking at zero cost (§2.8)                                                                                                                                             |
| Consolidating Think's six machines is a large diff                  | §14.4 steps 7–12 are six independent releases, each with its own suite green, and `ai-chat` moves in lockstep at step 7 because both packages register the same two definitions                                                                                                                                                                                           |

---

## Where this appendix departs from the design panel's spec

Everything else in the spec stands. These five changes are the
maintainer's, not the panel's, and are recorded so a reader of both is
not confused:

1. **Names.** `initial`/`phases`/`phase`/`onCancel`/`ctx` replace
   `initial`/`turn`/`abort`/`task`+`run`; one handler per phase replaces
   one `turn` with a `switch`; `answers` parks and `peekAnswers` reads,
   replacing `awaitAnswers`/`answers`; `ctx.cancelling` replaces
   `run.aborting`; `TaskCancelCannotParkError` replaces
   `TaskAbortCannotParkError`.
2. **`ctx.join` exists** as sugar over `receive({ kind: "child" })`,
   where the spec's §10.2 said there should be no join member. The raw
   form is kept, and remains the only way to express "a child settles or
   the user steers".
3. **Waits take `within` and return `ctx.timedOut`.** The spec had no
   per-wait timeout on the machine side; the survey's unit-typed sentinel
   is adopted, and it costs no extra row because a run parks on one wait
   at a time and the run's existing `next_at` carries it.
4. **Asks are typed and `ctx.ask` is synchronous**, batched, with
   `expiresIn` per batch; `Pending<A>` replaces raw ask-id strings in the
   checkpoint. The spec's ask table is otherwise unchanged.
5. **Progress gains Rule B** (`transitionBudget`, `transitions`,
   `TaskTransitionBudgetError`). The two start apertures are **not** a
   departure: they are deleted in the engine release and their call sites
   move with them, exactly as the spec's §5.11 and §3.10 have it.

Two smaller ones: streams are **named** (`ctx.stream(name?)`), so a run
may own several and `view()` carries an array; and the mailbox `kind`
column drops its `CHECK` constraint because `kind` is a free string typed
only by convention, with the `Mailbox` generic typing the payload.
