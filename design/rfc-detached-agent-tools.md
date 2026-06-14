# RFC: Detached ("background") agent-tool runs with a durable completion hook

Status: proposed

Related:

- [`rfc-helper-sub-agent-orchestration.md`](./rfc-helper-sub-agent-orchestration.md) — the accepted orchestration RFC. Its phasing already lists `detached` observer state as a Phase 5 follow-up; this RFC is that follow-up, generalised from "observer state" to "first-class dispatch mode".
- [`agent-tools.md`](./agent-tools.md) — agent tools as shipped (parent registry, child adapter, event replay, recovery).
- [`think.md`](./think.md) — Think's turn queue, durable submissions, and recovery model.
- [`think-durable-submissions.md`](./think-durable-submissions.md) — `submitMessages` + idempotency keys, the delivery primitive this RFC reuses.
- [cloudflare/agents#1752](https://github.com/cloudflare/agents/issues/1752) — the user report (a production data-import workload) that motivated this RFC, including a working ~200-line userland implementation.

## Summary

Add a supported **detached** dispatch mode to `runAgentTool` so a parent can kick
off a slow sub-agent, let its own turn continue, and be notified — durably,
exactly once — when the child finishes.

```ts
const { runId } = await this.runAgentTool(ImportAgent, {
  input: { fileKey },
  detached: { onFinish: "onImportFinished" }
});
// parent keeps working immediately; does NOT block on the import

async onImportFinished(run: AgentToolRunInfo, result: AgentToolLifecycleResult) {
  // fires once, even if the parent DO was evicted while the import ran
}
```

The mechanism is entirely additive. A detached run is an ordinary agent-tool run
(`cf_agent_tool_runs` row, `agent-tool-event` broadcast, child recovery, cost
hooks) — the only differences are that the parent does **not** await it and that
the framework owns the durable wakeup + exactly-once delivery that consumers
otherwise hand-roll.

It also adds **mid-run progress and milestone signalling** so a detached run is
not a black box: a cheap ephemeral tier (progress bars, heartbeats, ETAs) and a
durable, awaitable milestone tier that lets the parent start dependent work the
moment a prerequisite lands (e.g. `await` `"schema-ready"`, build the UI, while
the rest of the import continues detached). See "Progress and milestone
signaling".

## Problem

`runAgentTool` is await-shaped. The parent turn is parked for the child's entire
lifecycle. For fast helpers that is fine. For slow delegated work it serialises
wall-clock that has no data dependency on the parent continuing.

The reporter's worst case is a spreadsheet import: spin-up → schema design →
multi-minute ingest → verification. On an 80k-row file that is 4–6 minutes
during which the top-level agent cannot start building the app, even though
building does not depend on the import finishing. Running the import detached and
folding the result back in when it lands measured at **−33% total request time,
−44% time-to-live-app**, with the child's retries/hiccups disappearing into the
overlap instead of landing on the user's wait.

**The SDK is already ~90% of the way there.** Everything a run needs is set up
synchronously _before_ `runAgentTool` first awaits the child stream: the row is
inserted, `onAgentToolStart` fires, and the `started` event is broadcast. So
minting a `runId` and not awaiting the promise already produces a correct,
observable run. The reconciler (`_reconcileAgentToolRuns`) even re-fires
`onAgentToolFinish` for runs left non-terminal after a crash.

The missing 10% is the hard, easy-to-get-wrong part:

1. **No durable wakeup.** The reconciler runs from exactly one trigger —
   `onStart`. After an eviction nothing wakes the parent to notice the child
   finished; the run sits `running` until something else happens to instantiate
   the parent DO. The reporter manufactures that wakeup with a 20s
   `this.schedule` poll.
2. **`onAgentToolFinish` is not exactly-once across the detached boundary.**
   `_finishAgentToolRun` calls the hook unconditionally; a live `waitUntil`
   fast-path racing a scheduled reconcile can fire it twice. The reporter
   defends against double-notify with `submitMessages` idempotency keys.
3. **`inspectAgentToolRun`'s `null` contract is undocumented.** A single `null`
   is _not_ proof the run is gone — it can race the child's first write.
   Insta-failing on the first `null` turned every race into a spurious "outcome
   unconfirmed" notification (a real prod incident). The framework's own
   reconciler already tolerates this (`!inspection` ⇒ "still running") but the
   public adapter type says nothing about it.

Every consumer who wants background runs must currently re-discover all three.
That glue belongs in the framework.

## Design principles

- **Detached is a dispatch mode, not a new primitive.** Same run row, same
  events, same child, same recovery, same cleanup. The only new state is _how
  completion is delivered_.
- **Completion handlers are named methods, not closures.** This is the central
  DX decision (see below). A detached run can outlive the isolate that spawned
  it, so the callback must be addressable by name after rehydration — exactly
  like `this.schedule(when, "methodName", payload)`.
- **Exactly-once on the happy path, at-least-once under failure — the framework
  owns the dedup, the callback owns idempotency.** Consumers should never have to
  reason about consecutive-null tolerance, fast-path/reconcile races, or separate
  ledger slots for success vs give-up — the framework handles those via a guarded
  claim. But a _named user callback_ that runs a side effect and then crashes is
  re-delivered (lease expiry), so the honest contract is "exactly once unless your
  callback throws after a side effect, in which case at-least-once — make it
  idempotent." The Think convenience is idempotent for you (via `submitMessages`
  keys).
- **Give-up and finish are independent deliveries, one callback.** "I stopped
  watching" (give-up / budget) is an observer state, not a hard seal: a run the
  parent gave up on can still complete later. So internally there are _two ledger
  slots_ (give-up, finish) — collapsing them into one "delivered" bit silently
  drops a late real result (a documented production incident in #1752). But both
  surface through the single `onFinish` callback, which branches on
  `result.status`; the two-slot subtlety stays in the implementation, not the API.
- **Don't give up on healthy long work; do backstop leaks.** The core ships a
  finite absolute ceiling (not `Infinity` — an abandoned detached run has no
  observer to notice the leak). The progress layer then adds, following the
  accepted `rfc-chat-recovery-work-budget` lesson, a _no-progress_ window that
  **resets on every progress signal** so a child is given up on for going
  _silent_, never for taking a long time. The no-progress budget belongs with
  progress because without progress signals there is nothing to reset on.
- **Push when alive, poll as a backstop.** The happy path should be low-latency
  (child notifies parent on terminal); the durable backbone exists only to
  survive eviction, and self-cancels once no detached run is outstanding.
- **Progress informs; milestones gate.** Mid-run signalling is split into a
  cheap ephemeral tier (best-effort, latest-snapshot-only) and a durable
  milestone tier (persisted, awaitable, replayable). The framework never
  promises delivery of every ephemeral tick, but a milestone is a real join
  point that survives eviction.

## Why a named method, not a callback closure

The obvious API is `runAgentTool(Cls, { input, onFinish: (result) => { ... } })`.
We reject it. A closure captures the current isolate's heap. A detached run's
whole point is to outlive the spawning turn — and frequently the spawning
isolate, via hibernation or eviction. When the parent DO is rehydrated to
deliver the completion, the closure is gone. A name survives:

```ts
detached: {
  onFinish: "onImportFinished";
} // keyof this, persisted in the run row
```

The framework persists the method name on the `cf_agent_tool_runs` row and, when
the run reaches terminal, resolves `this[name]` on the freshly constructed parent
and invokes it with `this` bound. This is the same contract `schedule` already
teaches (`callback: keyof this`), so it is not a new concept for users — it is
the _consistent_ one. `validateScheduleCallback`-style validation rejects a
detached dispatch whose `onFinish` is not a method at dispatch time, so the
failure is loud and immediate rather than silent two minutes later.

## Proposal

### API surface

`RunAgentToolOptions` gains an optional `detached` field:

The **core** surface is deliberately small — one callback, one budget. Progress
(`onProgress`) is a separable layer that arrives in a later phase; it is shown
here for completeness but is not part of the minimal feature.

```ts
type DetachedAgentToolConfig<Self> = {
  /**
   * Method invoked once per terminal delivery. Branch on `result.status`:
   * `"completed" | "error" | "aborted" | "gave-up"`. "gave-up" means the parent
   * stopped watching (budget); because that is an observer state and not a hard
   * seal, a child that later completes can still fire `onFinish` again with
   * `"completed"` — so a give-up never hides a late real result. Make the handler
   * idempotent (see delivery ledger).
   */
  onFinish?: keyof Self;
  /**
   * [Progress layer — later phase] Method invoked for each progress signal the
   * child emits while running. See "Progress and milestone signaling".
   */
  onProgress?: keyof Self;
  /**
   * Absolute safety ceiling — a backstop against a child that runs forever. On
   * expiry the parent gives up watching (delivers `onFinish` with `"gave-up"`)
   * and tears the child down. Default: parent-level `detachedMaxBudgetMs`
   * (proposed 24h). The progress layer adds a *resetting no-progress* budget on
   * top of this; without progress signals there is nothing to reset on, so the
   * core ships only this absolute ceiling.
   */
  maxBudgetMs?: number;
};

interface RunAgentToolOptions<Input> {
  input: Input;
  runId?: string;
  parentToolCallId?: string;
  displayOrder?: number;
  signal?: AbortSignal;
  inputPreview?: unknown;
  display?: AgentToolDisplayMetadata;
  detached?: boolean | DetachedAgentToolConfig<this>;
}
```

When `detached` is set, `runAgentTool` returns **after dispatch**, not after
completion:

```ts
type DetachedRunAgentToolResult = {
  runId: string;
  agentType: string;
  // "running" on success; "error" if dispatch itself failed (e.g. the
  // maxConcurrentAgentTools cap was exceeded — rejected synchronously, no
  // child started, no callback wired).
  status: "running" | "error";
  error?: string;
};
```

`detached: true` is fire-and-forget: the run is observable via
`agent-tool-event` frames and the global `onAgentToolFinish` hook still fires,
but no per-run callback is wired. `detached: { onFinish }` adds the targeted,
durable callback.

### Lifecycle (happy path)

1. `runAgentTool` inserts the row (`status: "starting"`), fires
   `onAgentToolStart`, broadcasts `started` — **identical to the awaited path**.
2. It persists the detached columns on the run row — `detached` flag, the
   `detached_on_finish` callback name, `detached_max_budget_at`, and the two
   per-slot ledger columns (`finish_claimed_at` / `finish_delivered_at` /
   `give_up_claimed_at` / `give_up_delivered_at` — two slots, one callback) —
   starts the child, marks `running`, and returns the handle. The parent turn
   continues. (The progress layer adds `detached_on_progress`,
   `detached_no_progress_budget_ms`, `last_signal_at`, and `progress_json`.)
3. The child runs to terminal in its own facet. On terminal it pushes a
   notification to its parent (it already knows `parentPath`) via loopback RPC —
   the **fast path**, low-latency while either isolate is warm.
4. The parent's delivery function (below) claims the finish slot, transitions the
   row to the terminal status (guarded), and invokes `this[detached_on_finish]`.

### Lifecycle (eviction path — the durable backbone)

The fast path is best-effort. The guarantee comes from a self-scheduling
reconcile the parent owns whenever any detached run is outstanding:

- On the first detached dispatch, the parent arms a recurring schedule
  (`this.schedule`, exponential-ish cadence, e.g. 5s → 30s → 2m, capped) keyed to
  a single "detached reconcile" callback. Sub-agent scheduling already routes
  facet alarms through the root, so this works for nested parents too.
- On parent `onStart`, the backbone is **re-armed** if any detached run is still
  non-terminal — the schedule row survives in SQLite, but recovery verifies it
  exists and recreates it if a dispatching turn crashed after inserting the run
  row but before arming the schedule. Re-issuing a detached `runAgentTool` for an
  existing non-terminal `runId` (e.g. chat recovery re-running the dispatching
  turn) likewise ensures the backbone is armed rather than returning a stale
  handle.
- Each tick runs a **detached-aware** reconcile over `<detached, non-terminal>`
  runs. Crucially this is _not_ the awaited-path reconcile: a still-running,
  not-tailable detached run is **kept waiting** (its observer being gone is the
  normal state), not sealed `interrupted` the way an awaited run would be. See
  "Reconcile fork" below.
- When no detached run remains non-terminal, the schedule cancels itself. Zero
  steady-state cost once everything has landed.
- A run is given up on when the absolute `maxBudgetMs` ceiling elapses (the
  progress layer adds a resetting no-progress window on top). The parent records a
  **give-up** (an observer state, not a hard terminal), delivers `onFinish` once
  with `status: "gave-up"`, and tears the child down (via the existing
  `_teardownGivenUpAgentToolChild`) so it stops consuming a fiber. If teardown
  cannot confirm the child stopped and it later completes anyway, `onFinish` fires
  again with `"completed"` (see ledger below) — give-up does not consume the
  finish slot.

#### Delivery: two ledger slots, guarded transitions, run inside a turn

Both the fast path and the backbone funnel through one delivery function, with
**separate ledger slots** for finish vs give-up, each delivered at-least-once via
a claim + lease:

```
deliverDetachedTerminal(runId, kind):   // kind ∈ { finish, giveUp }
  read row
  if row.<kind>_delivered_at is set      → return            // already done
  if row.<kind>_claimed_at is set AND now - claimed_at < LEASE
                                         → return            // another path is mid-delivery
  atomically claim: set row.<kind>_claimed_at = now           // guarded CAS; one winner
  if claim lost                          → return
  if kind == finish:
    set HARD terminal status (guarded: status NOT IN hard-terminals)
  // both slots route through the one onFinish; status carries the distinction
  result.status = (kind == giveUp ? "gave-up" : terminalStatus)
  runInTurnContext(() => this[detached_on_finish](runInfo, result))   // may throw
  set row.<kind>_delivered_at = now                           // only on success
```

- **Concurrent double-fire is prevented** by the guarded claim: a fast-path push
  racing a backbone tick — both reading `delivered_at` unset — still has exactly
  one winner of the CAS.
- **Crash-after-side-effect is at-least-once, not lost.** If a handler runs its
  side effect then crashes before `delivered_at` is written, the lease expires
  and a later reconcile re-delivers. This is why handlers must be idempotent (the
  Think `notify` path is, via `submitMessages` keys) — the framework owns the
  dedup of the common races, the handler owns idempotency for the crash tail.
- **Two slots, one callback.** `interrupted` is a **soft** terminal in the
  existing code (`_updateAgentToolTerminal` deliberately lets a later child
  completion repair `interrupted` → `completed`). A give-up followed by a real
  completion is legitimate: `onFinish` fires once with `"gave-up"` from the budget
  path, then a later fast-path/reconcile sees the repaired `completed` row and
  fires `onFinish` again with `"completed"`. The two ledger slots keep these as
  independent deliveries; a single shared bit would dedup the real result away —
  the exact bug the reporter hit. Handlers therefore branch on `result.status` and
  must tolerate a `"gave-up"` that is later superseded by `"completed"`.

`runInTurnContext` matters for two reasons the first draft missed:

1. **Context.** The backbone fires from a scheduled alarm, outside any
   turn/connection/`agentContext`. `onFinish` must run inside
   `agentContext.run({ agent: this, ... })` (as `onStart` does) so a handler that
   itself calls `runAgentTool`, `setState`, or `submitMessages` works —
   `runAgentTool` hard-requires `agentContext.getStore()?.agent`.
2. **Serialization.** The fast-path push can land _mid-turn_. Firing `onFinish`
   (which may mutate state) concurrently with an active LLM turn is a data race.
   Delivery is therefore serialized against the parent's turn queue: it runs
   between turns, never interleaved. The Think `notify` path is already safe
   because `submitMessages` enqueues FIFO; the generic named callback gets the
   same ordering guarantee.

#### Reconcile fork: detached runs are not sealed on restart

The shipped reconcile (`_reconcileAgentToolRuns`, fired once from `onStart`) was
designed for awaited runs: a still-running, not-tailable run whose observer is
gone is sealed `interrupted`, because for an awaited run a lost observer means the
dispatching turn cannot continue. For a **detached** run a lost observer is the
_normal_ state, not a failure — sealing it would defeat the entire feature.

So the reconcile gains a fork keyed on the `detached` column:

- **Awaited rows:** unchanged behaviour (re-attach if tailable, else seal
  `interrupted`).
- **Detached rows:** never sealed on the basis of "no observer". On restart,
  reconcile (a) re-delivers any run that is _already_ terminal but whose ledger
  slot is unset, and (b) for runs still non-terminal and within budget,
  **keeps them alive and re-arms the recurring backbone** rather than marking them
  interrupted. Only the budget (no-progress / absolute give-up) or explicit
  `cancelAgentTool` ends a detached run the parent dispatched.

This also closes the dispatch-turn-crash window: if a turn crashed after inserting
the run row but before arming the backbone schedule, the `onStart` reconcile finds
the outstanding detached row and arms it. Idempotent re-dispatch of the same
`runId` (chat recovery re-running the dispatching turn) takes the same path —
ensure-armed, return the live handle — instead of returning a stale result.

### `inspectAgentToolRun` contract (documentation deliverable)

Independent of the dispatch mode, document the adapter contract the reconciler
already relies on:

> `inspectAgentToolRun(runId)` returns `null` when the child has **no record**
> of the run _at this instant_. `null` is **not** proof the run is gone — it can
> race the child facet's first durable write. Recovery treats `null` as "still
> running, keep waiting"; a caller polling directly MUST tolerate N consecutive
> `null`s before concluding the run is lost. A terminal result is only ever a
> non-null inspection with a terminal `status`.

This is a cheap, standalone win that de-risks anyone already not-awaiting
`runAgentTool` today, and it ships even if the rest of this RFC slips.

### Cancellation: detached runs do not inherit the turn signal

The awaited path wires `options.signal` to child cancellation, so the child dies
when the spawning turn aborts. A detached run must **outlive** that turn, so when
`detached` is set the framework deliberately threads `signal: undefined` to the
child and ignores any `options.signal` (with a dev-time warning if both are
passed — they are contradictory). Explicit cancellation is a separate, by-id
path:

```ts
await this.cancelAgentTool(runId); // idempotent; late cancel never rewrites a terminal
```

Cancelling delivers through the same function with terminal status `aborted`; if
`onFinish` was wired it still fires once with that status (callers branch on
`result.status`).

### Observation model: who tails a detached run

This is the subtlety that the rest of the design (chunk forwarding, progress, the
"free" UX) depends on, so it is stated explicitly.

On the **awaited** path, the child's chunks reach the parent's clients because
the dispatching turn runs a live tail loop (`tailAgentToolRun` /
`_forwardAgentToolStream`) for the child's whole lifecycle. A **detached** parent
returns early and runs _no_ tail loop. So a detached run is precisely the
"observer is gone" case the orchestration RFC deferred as "no late live-tail
reattach" — there is no parent-side reader of the child's stream by default.

The design resolves this with **two distinct transports**, and they must not be
conflated:

1. **Child → parent push (the live, parent-facing path).** The child pushes
   discrete signals to its immediate parent via loopback RPC — the same channel
   as the terminal fast-path: `terminal`, plus `progress` (milestones are
   progress signals with a `milestone` name). These pushes feed the parent's
   `onProgress` / `onFinish` hooks, reset the no-progress timer, and let the
   parent **re-broadcast** to its
   own clients so `useAgentToolEvents` on the parent connection works without the
   parent holding a tail. Pushes are best-effort while warm; durability comes from
   the child's own persistence (below) plus the backbone reconcile.
2. **Child-side durable record (the replay / drill-in path).** The child persists
   its chunks (resumable stream) and milestones in its own SQLite, exactly as
   today. A client that **drills into the child** (`useAgent({ sub: [...] })`)
   replays the full stream directly from the child. This is also what a
   reconnecting parent reads on recovery (via `inspectAgentToolRun`, extended with
   milestones + latest progress snapshot) to reconstruct state it never observed
   live.

So: progress and milestones are _encoded_ as reserved data parts on the child's
durable chunk stream (for drill-in + replay), **and** pushed as discrete RPC
signals to the parent (for live hooks + re-broadcast). The earlier "rides the
chunk stream, no new transport" framing is true for the child-side record and the
awaited path, but for the detached parent the live delivery is the RPC push — not
the parent passively tailing a stream it isn't reading.

A consequence worth stating: if both the child and parent isolates are evicted,
live progress simply stops until one is woken; the latest snapshot + milestones
are recovered from the child on the next reconcile tick. Ephemeral progress
during that gap is lost by design; milestones are not.

### Progress and milestone signaling

A terminal-only callback makes a detached run a black box for minutes. Letting
the child signal _while it runs_ is what turns "non-blocking" into "fast" — the
parent can show live progress, start dependent work the instant a prerequisite
lands, and steer or abort early. The same channel also hardens recovery and cost
control. This applies to awaited runs too, but it is most valuable for detached
runs, where the parent has no other window into the child.

#### What it unlocks (four distinct payoffs)

1. **Observability / UX (passive).** Progress bars, ETAs, phase labels,
   heartbeats — "Ingested 40k/80k rows", "Verifying…", "~2 min left". Richer than
   raw chat tokens for a status UI.
2. **Control-flow unblocking (the performance multiplier).** The parent overlaps
   _precisely up to a dependency_ instead of overlapping an opaque whole. Dispatch
   the import detached, `await` only the `"schema-ready"` milestone (seconds),
   start building the schema-dependent UI while the multi-minute ingest continues
   detached, then fold the loaded data in on `onFinish`. A milestone is an
   awaitable join point — it converts an all-or-nothing detached run into a
   _partially-awaited_ one.
3. **Steering / early decisions (active).** A progress signal lets the parent (or
   the parent model) cancel early ("found 50 matches, that's enough"), redirect,
   abort on a token/cost budget, or escalate to a human ("child needs approval to
   overwrite a table").
4. **Framework-internal.** Each progress signal resets the no-progress reattach
   timer (`agentToolReattachNoProgressTimeoutMs`), so a legitimately busy child
   stops being mistaken for a hung one; and streamed token usage lets the parent
   meter cost mid-run instead of only at terminal.

#### Two tiers: ephemeral progress vs durable milestones

Treating all signals equally would force a bad tradeoff (persist everything and
bloat the DB, or persist nothing and lose join points). So the design splits
them:

|                            | Ephemeral progress                      | Durable milestone                                 |
| -------------------------- | --------------------------------------- | ------------------------------------------------- |
| Emitter                    | `this.reportProgress({ ... })`          | `this.reportProgress({ milestone: "name", ... })` |
| Frequency                  | high (per batch / per step / heartbeat) | low (named phase boundaries)                      |
| Persistence                | latest snapshot only, on the run row    | one persisted row per milestone                   |
| Delivery if parent evicted | dropped (snapshot read on wake)         | survives; replays; re-resolves waiters            |
| Parent reception           | `onProgress` hook                       | `onProgress` hook, `awaitAgentToolMilestone`      |
| Purpose                    | inform                                  | gate / unblock / branch                           |

This mirrors the existing soft/hard split elsewhere in the agent-tool code and
keeps the steady-state write cost bounded: only milestones and the single latest
progress snapshot touch storage. There is **one emit method** — naming a
`milestone` is what promotes a signal from ephemeral to durable, so the child
never has to reach for a second API to cross the tiers.

#### Emit side (child)

The child is a chat agent, so there are three natural emit points, all backed by
the **one** `reportProgress` method — naming a `milestone` promotes that call to
the durable tier:

```ts
// inside a long-running child tool implementation (most useful for the import case)
this.reportProgress({
  fraction: ingested / total,
  message: `Ingested ${ingested}/${total} rows`
});
this.reportProgress({ milestone: "schema-ready", data: { tables: 4 } }); // durable
```

- **Programmatic**, from the child's own tool implementations — the ingest tool
  emits row counts as it processes batches. This is the highest-value path: the
  slow work lives in a tool, and that tool knows the real progress.
- **Model-callable tool**, `report_progress({ fraction, message, milestone? })`,
  auto-injected when the agent runs as a tool — lets an LLM-driven child narrate
  semantic progress (and mark milestones) without app wiring.
- **Deterministic**, from Think hooks (`onStepFinish`, `afterToolCall`) — "step N
  of M complete" for free.

`reportProgress` is a no-op with a dev warning when the agent is **not** running
as an agent tool (top-level chat), except that a top-level agent may still
broadcast progress to its own clients. The framework injects the current `runId`
from execution context; the child never threads it manually.

The payload is a generic `T`, but the framework defines a small well-known
envelope so generic UI works without per-app convention. A present `milestone`
field is the single switch that makes the signal durable, persisted, and
awaitable:

```ts
type AgentToolProgress<T = unknown> = {
  fraction?: number; // 0..1, drives a progress bar
  message?: string; // human-readable status line
  phase?: string; // coarse stage label
  milestone?: string; // present ⇒ durable, persisted, awaitable join point
  data?: T; // app-specific escape hatch
};
```

#### Transport: encoding details

The two transports themselves are covered in "Observation model" above (child-side
durable record for replay/drill-in; child→parent RPC push for the detached live
path). The concrete encoding: signals ride the child's own chunk stream as
**reserved data parts** — `data-agent-progress` as a **transient** part (not
persisted, matching the ephemeral tier) and `data-agent-milestone` as a
**persisted** part (durable, so replay and `awaitAgentToolMilestone` work without a
bespoke store). The client reducer (`applyChunkToParts`) already understands data
parts, so a drill-in client and the awaited parent's tail loop get them for free.

The typed `agent-tool-event` additions below are the _server- and client-facing
projection_ the parent re-broadcasts, not a third wire format:

```ts
type AgentToolEvent =
  | /* ...started | chunk | finished | error | aborted | interrupted... */
  | {
      kind: "progress";
      runId: string;
      data: AgentToolProgress;
      // no envelope sequence: latest-wins, coalesced
    }
  | {
      kind: "milestone";
      runId: string;
      name: string;
      data?: unknown;
      sequence: number; // monotonic per run; dedupes replay/live races
    };
```

#### Receive side (parent)

Two shapes, each suited to a different payoff above:

```ts
// 1. Named hook (durable-callback style, consistent with onFinish).
//    Fires for every signal; milestones are the ones with p.milestone set.
detached: {
  onProgress: "onImportProgress",
  onFinish: "onImportDone"
}
async onImportProgress(run: AgentToolRunInfo, p: AgentToolProgress) {
  // update UI / meter cost; steer from here:
  if (p.data?.matches >= 50) { await this.cancelAgentTool(run.runId); }
}

// 2. Awaitable milestone — the unblocker (payoff 2)
const { runId } = await this.runAgentTool(ImportAgent, { input, detached: true });
await this.awaitAgentToolMilestone(runId, "schema-ready"); // resolves from persisted milestones
// ...now build schema-dependent UI while ingest continues detached...
```

Steering (payoff 3) is done from inside `onProgress` — there is no separate
`streamAgentToolProgress` async-iterator in V1. A pull-style stream would suspend
the parent turn across child signals, which fights chat recovery (a re-run turn
cannot resume a half-consumed iterator); the push hook is recovery-safe and
covers the steering case without the extra surface.

`awaitAgentToolMilestone` is durable by _replay_, not by promise suspension:
because milestones persist, a parent evicted mid-await does not resume a suspended
promise — the turn re-runs via chat recovery and re-executes the `await`, which
resolves immediately if the milestone already landed (idempotent by construction).
It takes a **default ~60s timeout** (override explicitly for longer) and
**rejects** (never hangs, never seals the run) on timeout, on give-up/budget, or
on a terminal-without-the-milestone. Because it re-blocks the turn, it is meant
for short waits (seconds) — see "Edge cases & resolved decisions".

#### Durability, ordering, throttling

- **Ephemeral coalescing.** `reportProgress` is throttled/coalesced (latest-wins)
  before broadcast and snapshot-write, so a tight per-row loop cannot spam the
  parent or the DB. Only the latest snapshot persists, on a `progress_json`
  column of the run row.
- **Milestone ordering.** Milestones carry a monotonic per-run `sequence`; replay
  and live races dedupe on `(runId, sequence)`, matching the existing chunk dedup
  key.
- **Recovery extension.** `inspectAgentToolRun` (and the recovery inspect) gains
  the milestone list + latest progress snapshot, so a rehydrated parent
  reconstructs "where is this run" without having observed the live stream.
- **Post-terminal signals are ignored.** A progress/milestone that arrives after
  the run is terminal is dropped by the same guard that protects terminal status.

#### Think convenience for progress

Just as `detached: { notify: true }` folds the _result_ into chat, Think can fold
_milestones_ in when they should surface to the user/model — e.g.
`detached: { notify: { onMilestones: ["schema-ready"] } }` submits an idempotent
synthetic message (keyed `detached-ms:${sessionId}:${runId}:${name}`) when a
named milestone lands, so the agent can react in-conversation ("Schema's ready —
sketching the dashboard now") before the full import finishes. Ephemeral progress
is **not** folded into chat by default (too noisy for the model); it stays on the
`agent-tool-event` stream for UI.

### Think convenience: fold the result into the chat

For chat agents the overwhelmingly common `onFinish` body is "tell the model the
background task is done so it can react." Think ships a built-in for exactly
that, layered on the core named-callback mechanism:

```ts
this.runAgentTool(ImportAgent, {
  input,
  detached: { notify: true } // Think wires onFinish to an internal submitter
});
```

On completion Think calls `submitMessages([...], { idempotencyKey: \`detached:${sessionId}:${runId}\` })`,
injecting a synthetic user-role message that summarises the result as the
parent's next-turn input (FIFO behind any running turn). The message carries
`metadata.source = "agent-tool"`so the rendered transcript can filter it out
while the model still sees it. The idempotency key is derived from`runId`, so
the durable backbone and fast path cannot double-submit — reusing the exact
primitive (`submitMessages`+`UNIQUE(idempotency_key)`) the reporter already
validated, but framework-owned. Apps override the wording via
`formatDetachedCompletion(run, result): UIMessage`.

This keeps the core generic (any `Agent` gets named callbacks) while giving Think
users the one-liner that matches the motivating workload.

## UX: what the end user sees

Detached runs reuse the existing observer surface, so the UI story is mostly
free:

- **Live progress, via parent re-broadcast.** A detached parent does not tail the
  child (see "Observation model"), so the parent re-broadcasts the child's pushed
  `progress`/`milestone`/terminal signals as `agent-tool-event` frames on its own
  connection. `useAgentToolEvents` already surfaces runs with no
  `parentToolCallId` as `unboundRuns` — render those as a "background tasks" tray.
  With progress signalling, `AgentToolRunState` also carries `progress` (a
  `fraction`/`message` snapshot for a bar + ETA) and a `milestones` list, so the
  tray shows "Importing… 50% — schema ready, ingesting rows" instead of a bare
  spinner. No new _client_ protocol (the existing reducer handles the new event
  kinds); the new plumbing is server-side re-broadcast, not client tailing.
- **Full transcript on demand.** For the child's complete streamed output (not
  just the status snapshot), a client drills into the child directly
  (`useAgent({ sub: [{ agent, name: runId }] })`) and replays its durable stream
  — the same gated drill-in path agent tools already use.
- **Immediate responsiveness.** The agent answers right away ("Importing your
  data in the background — starting on the app now") instead of going silent for
  minutes. The serialized wall-clock that used to land on the user disappears
  into overlap.
- **A real "done" moment.** When the run lands, the terminal `agent-tool-event`
  flips the tray entry to done and (via the Think `notify` convenience) the
  agent produces a natural follow-up turn ("Your 80k rows finished loading —
  wiring them into the dashboard"). Clients can also toast off the terminal
  frame.
- **Honest failure.** `error` / `aborted` / `interrupted` render distinctly, and
  a `"gave-up"` terminal (delivered through `onFinish`) gives the agent a chance to
  tell the user "the import is taking unusually long" rather than hanging forever.

## Real-world use cases

1. **Data import / ingestion (motivating case).** Kick off ingest, build
   schema/UI/queries in parallel, fold the loaded data in on completion. With
   milestones: `await` `"schema-ready"` to start the schema-dependent UI the
   instant the schema exists, while ingest continues detached.
2. **Build / deploy + verify.** Start a deploy or long build, keep planning the
   next change, react when it goes green/red. Milestones (`"compiled"`,
   `"deployed"`) unblock the next stage before the whole pipeline finishes.
3. **Background research & enrichment.** Answer the user immediately while a
   slow web/research sub-agent enriches context; merge findings when ready.
   Progress streams partial sources so the parent can begin synthesis early.
4. **Report / artifact generation.** "Generate the Q3 report" returns a tracking
   id instantly; progress drives a "62% — rendering charts" bar; notify (and
   link the artifact) when rendering finishes.
5. **Long external jobs.** Video render, large batch model job, third-party API
   that takes minutes — wrap as a detached sub-agent, get a durable callback.
   Heartbeat progress keeps the run from being mistaken for hung.
6. **Fan-out without a fan-in barrier.** Dispatch several slow specialists
   detached and fold each in as it lands, instead of `Promise.all` blocking on
   the slowest.
7. **HITL-bridged tasks.** A detached child that itself waits on human approval
   shouldn't pin the parent turn; a `"needs-approval"` milestone surfaces the
   prompt to the user, and the parent reacts when approval + work complete.
8. **Early-exit / budget steering.** A search/scrape child streams match counts
   or token usage; the parent (or model) cancels once it has enough or once a
   cost budget is hit, instead of paying for the full run.

## Concurrency and cost

Detached runs hold a `maxConcurrentAgentTools` slot for their _entire_ life, not
just a turn — a different cost profile from awaited runs. Decisions:

- Detached runs count against the **same** `maxConcurrentAgentTools` cap
  (default `Infinity`), so the existing fail-fast guard still applies. Exceeding
  it returns an `error` handle synchronously at dispatch.
- A separate `maxConcurrentDetachedAgentTools` is **deferred** — start with one
  cap and observe. But because `Infinity` + detached accumulation is a real
  footgun with no observer to notice, the framework emits an observability
  **warning event** when the live _detached_ count crosses a threshold (proposed
  50), rather than silently accumulating. The separate cap lands only if evidence
  shows the single cap is conflating two genuinely different budgets (awaited
  fan-out vs long-lived detached).
- The global `onAgentToolStart` / `onAgentToolFinish` hooks still fire for
  detached runs (the reporter merges child token cost in `onAgentToolFinish`),
  so existing metering keeps working unchanged. The per-run `onFinish` is
  additive, not a replacement.

## Edge cases & resolved decisions

These were surfaced reviewing the design against the shipped recovery /
idempotency code. Each now has a decided position; the rationale for the
contestable ones is below.

- **Cleanup, and clear-while-in-flight: cancel, suppress user-facing delivery,
  still meter.** `clearAgentToolRuns(...)` deletes the milestone rows and the
  `progress_json` snapshot for each run and cancels the recurring backbone once no
  detached run remains. Clearing the session _while a detached run is in flight_
  follows the orchestration RFC's cancel-then-delete ordering, and the
  cancel path clears the run's pending delivery + idempotency rows **before**
  deleting the session. **Decision:** the user-facing delivery
  (`onFinish` and the Think `notify` submission) is **suppressed** for
  a cleared run — folding a "your import finished" message into a session the user
  explicitly cleared is confusing. But the **global `onAgentToolFinish` still
  fires with `status: "aborted"`** so cost/metering accounting stays correct.
  Metering ≠ notification; they have different lifetimes.

- **Progress `data`: non-persisted by default, opt-in to persist.** The
  orchestration RFC persists only a redacted, "safe to inspect" `inputPreview`.
  Progress is the highest-frequency signal and the most likely to smuggle raw row
  contents / PII into a durable, inspectable table, and the failure mode is silent.
  **Decision:** `progress_json` persists `fraction`/`phase`/`message` only; the
  free-form `data` field is **live-only**, with an explicit opt-in
  (`reportProgress({ ... }, { persist: true })`) for apps that want it durable.
  A signal with a `milestone` name _does_ persist its `data` — it is app-named,
  low-cardinality, and deliberately authored.

- **`awaitAgentToolMilestone`: default timeout, short-wait contract, reject don't
  hang.** Awaiting inside an LLM tool call **re-blocks that turn** (intended for
  the partial-await pattern) and makes no forward progress while blocked, so a long
  wait can trip the **chat-recovery no-progress window**. **Decision:** the await
  takes a **default timeout (~60s)** so misuse fails fast and legibly instead of
  mysteriously tripping recovery; an explicit longer timeout signals the caller
  understands the tradeoff. On eviction the promise does **not** suspend-and-resume
  — the turn re-runs via chat recovery and re-executes the `await`, resolving
  immediately _because milestones are durable_. The await **rejects** (never hangs,
  never seals the run) on timeout, on give-up/budget, and on a
  terminal-without-the-milestone.

- **`report_progress` model tool: exempt from `maxSteps`, transient parts.** It
  must not consume the child's step budget or bloat its transcript, and the
  programmatic `this.reportProgress(...)` path (no model round-trip) is preferred
  for the high-value cases.

- **Keep `detached: true` fire-and-forget as a first-class shape.** Not requiring
  `onFinish` is deliberate — it serves "kick this off, I'll observe via the tray /
  global hook" and avoids pushing people back to the not-awaiting-the-promise
  footgun this RFC replaces.

- **`onAgentToolFinish` becoming exactly-once is a behaviour change.** Today it
  fires unconditionally, including on every reconcile repair; gating it on the
  terminal transition changes that for existing users. Ship with a changeset note;
  the per-run detached callbacks are new surface and unaffected.

- **Backbone cadence on a new dispatch.** When a detached run is added to a parent
  already in slow-poll, the cadence resets to the fast end (5s) so the new run is
  not stuck waiting up to the slow interval for its first reconcile. The fast path
  makes this moot in the warm case; it matters only after eviction.

- **Progress / milestone ordering.** Coalesced ephemeral progress can
  legitimately arrive after a milestone for the same logical point; the framework
  does not promise a global order across the two tiers. Milestones are ordered
  among themselves by `sequence`; ephemeral progress is latest-wins with no
  ordering guarantee. Both surface through the same `onProgress` hook.

- **Nested detached fan-out.** A detached child that itself dispatches detached
  grandchildren arms a backbone at each level. This is correct (each parent owns
  its children) but multiplies recurring alarms under deep nesting; acceptable for
  V1, revisit if it shows up in practice.

## Non-goals

- **Automatic retry of failed detached runs.** Delivery is honest; retry is a
  caller decision inside `onFinish` (branching on `result.status`).
- **Cross-parent / cross-tenant detached dispatch.** Tenancy is inherited from
  the parent, same as awaited runs.
- **A second scheduling engine.** The backbone is `this.schedule`, not a new
  alarm system.
- **A second wire format for progress.** Progress and milestones ride the
  existing child chunk stream as reserved data parts; the typed
  `agent-tool-event` kinds are a projection, not a new transport.
- **Guaranteed delivery of every ephemeral progress tick.** The ephemeral tier
  is best-effort and coalesced by design; durable join points are milestones.
- **A down-channel / bidirectional control protocol.** Progress flows child →
  parent. The parent steers only with the existing levers (`cancelAgentTool`,
  milestone-gated re-dispatch, and not awaiting), which cover most needs. Sending
  arbitrary directives _into_ a running child needs its own durability/ordering/
  delivery story — that is "interactive sub-agents," not "background sub-agents,"
  and belongs in a **separate future RFC**, named here so the boundary is
  deliberate rather than an omission.
- **Closure-based completion handlers.** Explicitly rejected (see above).
- **Multi-turn detached runs.** One `runId` ⇒ one child turn, same as the
  shipped agent-tool contract.

## Alternatives

### Keep it userland (status quo)

Rejected. It works — the reporter proved it — but it requires every consumer to
re-implement durable wakeup, fast-path/reconcile dedupe, consecutive-null
tolerance, and separate success/give-up idempotency keys. Two of those were
production incidents for the reporter. This is exactly the "fragile glue the
framework should own" pattern the orchestration RFC already used to justify the
parent registry.

### Closure callback `onFinish: (result) => {...}`

Rejected. Does not survive eviction; gives a false sense of durability. The
named-method form is the only one that can honour the exactly-once-across-
eviction guarantee.

### Reuse the global `onAgentToolFinish` as the only hook

Rejected as _sufficient_, kept as _additive_. The global hook has no per-run
delivery ledger and fires unconditionally, so it cannot be made exactly-once
without the per-run `delivered` bit this RFC adds. We keep it for metering and
add the targeted callback for control flow.

### Poll-only backbone (no fast path)

Rejected as the end state. A pure 20s poll (the reporter's approach) adds
latency to every completion. Pushing from the child on terminal — it already
knows its parent — makes the warm path near-instant; the poll is the durable
backstop, not the primary path.

### `detached` as a separate method (`dispatchAgentTool`)

Rejected. A flag on `runAgentTool` keeps one mental model and one set of
semantics (idempotent by `runId`, same registry, same events). A second method
would duplicate the surface and invite drift.

### Auto-arm the backbone for _all_ non-terminal runs

Rejected. Awaited runs already have a live observer; arming a schedule for them
is wasted work. Only detached runs lack an observer, so only they need the
backbone.

### Treat chat chunks as the progress signal (no new API)

Rejected as _sufficient_. The child's chat tokens are already forwarded, and you
_can_ scrape them for status. But they are unstructured, model-generated, and
token-level — there is no reliable `fraction`, no named join point to `await`, and
no clean signal to reset the no-progress timer or meter cost against. A structured
`reportProgress` call is a different, app-defined channel that happens to _travel_
on the same stream.

### Progress alternatives (channel, tiers, scope)

Rejected, briefly: (a) _a separate durable progress channel_ — duplicates the
persistence/replay/reducer logic that reserved `data-agent-progress` (transient)
and `data-agent-milestone` (persisted) parts already provide; (b) _one flat tier_
— forces persist-everything (DB bloat) or persist-nothing (no awaitable join
points); the ephemeral/milestone split keeps status cheap and boundaries durable;
(c) _progress on awaited runs only_ — backwards, since the detached parent is
exactly the one with no other window into the child, and the same emit path works
for both.

## Decision

_Proposed — pending discussion._ The contestable design points have a taken
position (rationale in "Edge cases & resolved decisions"); they are summarised
here so reviewers can challenge them directly:

- **Core budget is a finite absolute ceiling (default ~24h); the progress phase
  adds a _resetting no-progress_ window (default ~1h) on top.** Finite (not
  `Infinity`) because a detached run holds a slot + live facet with no observer.
  The resetting window mirrors `rfc-chat-recovery-work-budget` — never give up on a
  child still signalling, only on one gone silent — and ships with progress because
  without signals there is nothing to reset on.
- **Progress `data` is live-only by default; `fraction`/`phase`/`message` and
  milestone `data` persist.** Safe-to-inspect by default, opt-in to persist the
  free-form blob.
- **Clear-while-in-flight cancels the run, suppresses the user-facing delivery,
  but still fires the global metering hook (`aborted`).**
- **One concurrency cap for now** (`maxConcurrentAgentTools`), plus a warning
  event past a live-detached threshold; a separate detached cap is deferred until
  evidence demands it.
- **`awaitAgentToolMilestone` has a default ~60s timeout and rejects rather than
  hangs.**
- **`detached: true` (no callback) stays a first-class shape.**
- **A bidirectional down-channel is explicitly punted to a future "interactive
  sub-agents" RFC.**

Suggested phasing:

1. **Docs-only:** specify the `inspectAgentToolRun` `null` contract and the
   `onStart`-gated reconcile behaviour on `agent-tools.md`. Ships independently.
2. **Core (`Agent`):** `detached: boolean | { onFinish, maxBudgetMs }`; the single
   `onFinish` callback delivering all terminal states (branch on `result.status`,
   including `"gave-up"`), backed by **two ledger slots** (finish / give-up) and the
   claim+lease guarded delivery function run inside `agentContext` and serialized
   against the turn queue; the self-scheduling reconcile backbone with the
   **detached reconcile fork** (don't seal on lost observer) and re-arm-on-restart;
   child→parent fast-path push; the finite absolute `maxBudgetMs` ceiling;
   `cancelAgentTool(runId)`; signal-isolation. Make `onAgentToolFinish`
   exactly-once internally as part of this (changeset note).
3. **Think convenience:** `detached: { notify }`, `submitMessages`-based
   idempotent fold-in, `formatDetachedCompletion` override, transcript filter.
4. **Progress & milestones:** the single `reportProgress` emit API (a `milestone`
   name promotes to durable), `data-agent-progress`/`data-agent-milestone`
   transport, `progress`/`milestone` event projections, the `onProgress` hook and
   `awaitAgentToolMilestone`, the resetting `noProgressBudgetMs` window (resets the
   no-progress timer), the `progress_json` snapshot + milestone rows in recovery
   inspect, and the `AgentToolRunState` client fields. The emit API works for
   awaited runs too. `notify: { onMilestones }` Think convenience layers on top.
5. **Example + docs:** extend `examples/agents-as-tools` (or a new
   `examples/background-tasks`) with the import-overlap pattern, milestone
   unblocking, and the background-tasks tray UI with live progress bars; distil
   user-facing guidance into `/docs`.

Phase 2 must not ship without the durable hook: a `detached` flag _without_
exactly-once delivery would make the floating-promise footgun a blessed,
advertised API. The flag and the guarantee land together or not at all.

Phase 4 (progress) is independently shippable and valuable on its own — awaited
runs benefit too — so it need not block on Phase 2/3. The milestone tier is the
higher-value half; ephemeral progress can follow if the milestone work lands
first.
