# StateMachine — fixes for hosting pi on a Durable Object

Findings from reviewing `state-machine-3`/`-pi` against pi `0.87.1`'s published
`driveOperation()`. Full analysis: `reports/state-machine-fitness-for-pi.md`.

Numbering follows the report, so gaps 2 and 5 are deliberately absent:

- **Gap 2 (continuation for a long effect) — withdrawn.** Pi already owns
  stream-interruption recovery. `recoverAssistantGeneration` settles an
  orphaned generation from its committed frame prefix as `stopReason: "error"`,
  and `publishResponse` turns that into an `assistant.retry_wait` with an
  incremented attempt and a backoff deadline (`options.recovery === true`
  bypasses the retryable check). Adding a promise-handoff continuation would
  duplicate authority over retry — the exact failure the wrapped-runtime shape
  exists to avoid.
- **Gap 5 (effect durable only after the phase returns) — closed.**
  `effects.run()` landed and takes the safe path: `context.run()` calls
  `effects.plan()`, then `flushPending()` to commit the row, and only then
  `effects.execute()`. The effect is durable before execution starts, so the
  crash window `admit` exists to close stays closed.

---

## 1. Long dispatch trips the 30s hung timeout — **blocker**

A pi drive pass is turn-sized, not phase-sized. `driveOperation` is a `for(;;)`
loop that returns only on `settled` or `waiting`, and `waiting` comes only from
retry backoff and deferred polls. A healthy turn — generate, tools, generate,
settle — never yields, so one `drive()` call spans the whole turn inside one
inline `await` in one job dispatch.

Against `DEFAULT_HUNG_TIMEOUT_SECONDS = 30` that means, on every real turn,
`job:slow_dispatch` telemetry and a `console.warn`, and `isHungRow()` true at
30s — so a same-id redispatch can force-reset a healthy in-flight turn
(`job-driver.ts`).

### What is and is not at risk

An earlier draft of this file claimed "head-of-line blocking for every other
job on the object", by analogy with `Tasks`. That analogy does not survive
checking what a pi-hosting object actually queues. Of the capabilities the
example installs, `Streams` and `WebSockets` push no jobs at all
(request- and message-driven), and `PiHarness` pushes one `reconcile` at
startup. `StateMachine` is the only recurring producer. **The serial loop in
such an object is almost entirely one capability's own drive jobs**, so there
is little unrelated work to starve.

What remains, in descending order of how much it should worry us:

1. **The 15 minute alarm wall clock — withdrawn.** This was wrong, and the
   published source says so. `AgentLane.drive()` runs `driveOperation` in a
   floating promise owned by `this.activeDrive` (`runtime/lane.ts:976`), and a
   caller only observes it through `awaitWithContext`, which races the
   caller's await against the signal and never touches the underlying promise
   (`chord/context/index.ts:98`). An invocation that dies mid-pass therefore
   leaves the Drive intact, and a later pass re-attaches by operation id:
   a second `drive()` for a live `activeDrive` returns
   `{ kind: "observe", installed: false }` (`lane.ts:947`), and
   `driveOperation` is only ever called under `claim.installed`. So a long
   turn is not killed and does not retry-loop.

   The real hazard was the opposite of a missing timeout: the example set
   `timeoutMs: 120_000` on the drive effect, and an effect timeout aborts the
   effect's controller, which `#drivePass` forwarded to pi as a **durable**
   `requestAbort()`. A healthy turn past two minutes was cancelled rather than
   resumed. Fixed by removing the timeout.

2. **Steer latency — largely withdrawn, and addressed.** A boundary steer does
   not wait out a turn: pi reaches `at: "checkpoint"` after every tool batch,
   not only after a turn (`drive/tool-placement.ts:201`), and `boundary.ts` is
   where the inbox is claimed. So an ordinary steer lands at the next tool
   boundary. For the case that genuinely must not wait, `steer()` now takes
   `urgency: "interrupt"`, which uses pi's own primitive: `requestAbort()`
   drains the inbox and hands the steer back (`lane.ts:1047-1078`), exactly as
   `lane.abort()` does.
3. **Cross-run contention.** Job ids are per-`runId`, so two operations are two
   queue rows. Narrow in practice: pi's own lane admission serialises
   operations on one lane, so a second run usually parks on `LANE_BUSY_WAIT_MS`
   rather than the loop. It only bites with **several lanes on one object**,
   where lane B's turn waits behind lane A's whole turn.

- [x] **1a. Plumb `hungTimeoutSeconds` through `StateMachine.#pushJob`.**
      `LifecycleJobs.pushSync` already accepts it and `hungTimeoutMs()` already
      reads the column; `StateMachine` simply never sets it. Add a
      `jobHungTimeoutSeconds` option on the capability, default it well above a
      turn, and pass it on every push. Done: the option defaults to 600s.
- [ ] **1b. Answer two product questions, then size the fix.** Not the
      starvation decision an earlier draft described. First: are several lanes
      hosted per object? If not, contention (item 3 above) is moot. Second: how
      long may a steer sit unread? If seconds, a pass has to yield mid-turn; if
      a turn, it does not.
      If either answer demands yielding, the mechanism already exists and needs
      no change to the job driver. `AgentLane.drive()` runs `driveOperation` in
      a floating promise and returns `awaitWithContext(drive.completion, context)` (`runtime/lane.ts:975`), and pi documents that a caller's
      `abortSignal` firing after installation "rejects only that caller's
      invocation, never removing, replacing, or cancelling the Drive"
      (`docs/harness.md:890`). So `#drivePass` can pass a budgeted context,
      return `waiting` when it fires, and let a later pass re-attach to the same
      live `Drive` by operation id. Size the budget against the wall clock
      (minutes), not by analogy to `Tasks`' `DISPATCH_BUDGET_MS` (5s).
      **Verified since:** a second `drive()` for an operation with a live
      `activeDrive` does return `{ kind: "observe", installed: false }`
      (`lane.ts:947`), and `driveOperation` is only called under
      `claim.installed` (`lane.ts:976`), so re-attachment cannot
      double-execute. The steer half of this question is also settled — see
      item 2 above — which leaves only the multiple-lanes-per-object question.

- [ ] **1c. Raise a pass budget with the pi team.** A `DriveOptions.maxPassMs`,
      or a `waiting` outcome with `reason: "budget"`, would let a turn yield at
      a phase boundary and become several bounded passes — exactly the shape
      the `waiting` → park → drive cycle already handles. Lower priority now
      that observation-abort achieves most of this client-side, but still the
      cleaner fix, and it would make gap 4 moot.
      _(Upstream conversation — not code.)_

## 3. `external_id` is unconstrained — minor

Confirmed not reachable through `PiHarness`: runs are keyed `pi:${operationId}`
and effects are `PRIMARY KEY (run_id, effect_id)`, so two passes are distinct
rows in one run and two operations are separate runs. `external_id` is also
never a lookup key — every read takes it off a row already fetched by primary
key. So this is hardening for other hosts, not a live bug.

- [x] **3a. Add `UNIQUE (run_id, external_id)` as a partial index.** Cheap
      insurance for a third-party runtime that keys `externalId` carelessly.
      Must be a migration, not just a fresh-install DDL change.
- [ ] **3b. Document `idempotencyKey` as advisory.** It is derived
      (`${runId}:${effectId}`), never persisted, never checked. The name
      implies a guarantee the engine does not make.

## 4. One phase per job round-trip — moderate

Every `transition` pushes a job, so each pass costs a dispatch, a transaction
and a `rearm()`. Less severe than first assessed: passes are turn-sized, so
real counts are small and `MAX_DRIVE_PASSES = 4_000` is a runaway guard rather
than an expectation.

- [ ] **4a. Consider a same-invocation continue decision** that re-enters the
      drive loop without a job round-trip, bounded by a per-invocation budget.
      _(Optimisation — defer until measured. Superseded if 1c lands.)_

## 6. Definition-version bump hard-fails live runs — moderate

`state-machine.ts` calls `#commitFailure` on a version mismatch, so a live run
whose definition version changed is terminated and its operation lost.

Trigger is narrower than first stated: `PiRunState`'s only pi-shaped field is
`request: PiOperationRequest`, which is the example's own projection, not a pi
re-export. An ordinary pi upgrade does not bump the machine version — it takes
a deliberate change to `PiRunState` or the phase graph.

But the blast radius is real and the path is **completely untested**: every
definition in `tests/state-machine/` and `tests/capabilities/` is `version: 1`,
and `migration.test.ts` covers only the engine's own v1→v2 schema migration.

- [x] **6a. Pause instead of fail on version mismatch.** `pause`/`resume`
      already exist. A paused run is recoverable by a subsequent deploy; a
      failed one is not.
- [x] **6b. Add coverage for the mismatch path.** Currently zero.

## 7. No checkpoint migration path — moderate

`migrations.ts` migrates the engine's own tables. Nothing migrates
`checkpoint_json` payloads when a definition's `State` shape changes. With 6a
making mismatch recoverable, an upgrade hook is the natural follow-on.

- [ ] **7a. Consider `upgrade(oldState, oldVersion) => State` on the
      definition**, applied when `definition_version` is behind. Pairs with 6a:
      pause is the safe default, upgrade is the opt-in fix.
      _(Design work — larger than this pass.)_

## 8. `MAX_ACTIVE_EFFECTS` vs. the pass budget — minor

100 active effects per run versus a 4,000-pass budget looks contradictory. It
is fine, because each pass settles before the next is planned — but only for
that reason, and a future concurrent-pass design would hit the ceiling
silently.

- [ ] **8a. Document the interaction** at the constant.
- [ ] **8b. Consider pruning settled effect rows** for long-lived runs. Nothing
      reclaims them before `delete(runId)`, so a long conversation retains
      every pass's `input_json`.
      _(Needs a retention policy decision.)_
