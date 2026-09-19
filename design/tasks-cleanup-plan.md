# Tasks cleanup plan: collapsing `agents/tasks` onto one engine with two APIs

**Produced 2026-09-16**, against `origin/main` `a7b29135` in
`/Users/matt/Documents/Github/agents-machine-primitive` and PR #2274 at
`f28ffc2f` in `/Users/matt/Documents/Github/agents-tasks-attempt-signal-and-budget`.
Line numbers are from the PR worktree unless marked `[main]`. One later
commit is also cited: `785a68dd` (this worktree, on top of `f28ffc2f`)
landed `LifecycleJobs.pushSync`/`cancelSync` and `StreamWriter.onCommit`,
which the engine depends on and which PR 7 therefore does not schedule.

This is the consumer-side companion to
[rfc-tasks-state-machine.md](./rfc-tasks-state-machine.md). The RFC
specifies the engine; this document says what survives on the way to it,
in what form, and in what order. **Where the two disagree, the RFC wins**
— every such override is called out inline as _RFC override_.

**What kind of document this is.** Neither of `design/AGENTS.md`'s two
categories, and deliberately so: it is not a design doc (it does not
describe how anything works _right now_) and it is not an RFC (it decides
nothing; the RFC does). It is a **forward plan with a shelf life** —
a surface-by-surface inventory and a sequenced PR order — and it is
expected to be deleted, not maintained, once the last PR in §4 lands.
Treat every line number in it as a pin to the two commits named above,
not as a live pointer.

**Terms.** _Engine_ = the durable state machine: a fenced run row, one
phase-handler invocation per transition, the returned state is the
commit. _Machine API_ = the definition shape
`{ initial, phases, onCancel?, migrate? }`, one handler per phase,
`(state, ctx) => next`. _Step API_ = today's `(input, step) => result`,
compiled onto the engine as a single-phase machine whose one handler
replays the function. _`ctx`_ = the per-handler runtime — `ctx.signal`,
`ctx.do`, `ctx.receive`, … — and `TaskContext extends TaskStep`, so it is
the same object the step API calls `step`.

**Five corrections to the briefed inventories, up front, because they
move verdicts:**

1. **The routed machinery is not made unnecessary by the layering — it
   grows.** The inventories (written under a two-package framing) send
   `onRoute` / `#syncRoutedWake` / `#dispatchRoutedRun` / owner-path
   payloads / the memory-limit breaker to Lifecycle. Under one primitive
   on facets they must _stay and gain more route messages_: mailbox
   delivery, answers, child settlement and the abort cascade all cross
   the facet boundary (RFC §5.9). Today `onRoute` (tasks.ts:828) handles
   three cases. Verdict: **Keep in Tasks**; de-duplicating the
   Scheduler/Queue/Tasks copies into Lifecycle is a separate,
   non-blocking track and the _worst_ possible thing to attempt
   mid-flight.
2. **The fiber tables do have a migration ratchet.** The fibers inventory
   says the DDL is unconditional `CREATE TABLE IF NOT EXISTS` on every
   wake. It is not: `cf_agents_runs`, `cf_agents_facet_runs`,
   `cf_agents_fibers` are created inside
   `if (schemaVersion < CURRENT_SCHEMA_VERSION)`
   [main index.ts:1563–1764], with `CURRENT_SCHEMA_VERSION = 11` and key
   `cf_agents:schema_version`. Dropping them is a migration step, not an
   orphan-or-nothing choice — but see §6: the drop cannot be v12, because
   readers outlive it.
3. **`TaskAttemptsExhaustedError` / `TaskDeadlineExceededError` /
   `TaskFailedRun` / `TaskRetryConfig` are unreleased.** Verified absent
   from `[main] packages/agents/src/tasks/index.ts` and from
   `packages/agents/dist/`. Renaming them is free _today_ and a published
   break _after_ #2274 ships. The rename was not code-only —
   `docs/agents/tasks.md` taught run-level `retries` in prose and in a
   runnable snippet and named `TaskAttemptsExhaustedError` twice, and that
   page ships in the npm tarball — **and both halves landed together in
   `f28ffc2f`**, the commit this plan pins as its base. Verified there:
   `grep -n TaskAttemptsExhaustedError docs/agents/tasks.md` returns
   nothing, the page reads `interruptions` at :109, :119, :128, :234 and
   :237, and the only surviving `retries:` is :42, a per-_step_ config.
   _RFC override: settled — the shipped names are
   `TaskRunOptions.interruptions` and `TaskInterruptionsExhaustedError`,
   and the RFC uses them throughout. No doc edit is owed._
4. **The fiber surface is published from the _stable_ root entrypoint,
   and it is nine type names, not two.**
   `packages/agents/src/index.ts` exports `FiberContext` (:391),
   `FiberStatus` (:402), `StartFiberOptions` (:410), `FiberInspection`
   (:417), `StartFiberResult` (:430), `FiberRecoveryResult` (:434),
   `ListFibersOptions` (:456), `DeleteFibersOptions` (:462),
   `FiberRecoveryContext` (:485) — all present in
   `dist/index.d.ts:152–189`. The `agents` root entrypoint carries **no**
   `@experimental` annotation anywhere, unlike `agents/tasks` (module
   JSDoc at `tasks/index.ts:1–5` and the doc page's banner).
   `FiberStatus` is structurally reachable from `ListFibersOptions`,
   `DeleteFibersOptions` and `FiberInspection`, so it cannot be removed
   independently. The deprecation release's aliasing budget is 4.5× what
   the inventories assumed.
5. **The chat Task modules are public API, not internals.**
   `packages/agents/src/chat/index.ts:54–68` re-exports
   `createChatTurnTaskDefinition`, `ChatTurnClosureEntry`,
   `ChatTurnTaskHooks` from `turn-task.ts` and eight symbols from
   `recovery-task.ts` (`CHAT_RECOVERY_TASK_NAME`,
   `chatRecoveryTaskRunOptions`, `createChatRecoveryTaskDefinition`,
   `dispatchChatRecoveryToHandoff`, `ChatRecoveryHandoff`,
   `ChatRecoveryTaskHooks`, `ChatRecoveryTaskInput`,
   `ChatRecoveryTaskReason`). `./chat` is a first-class subpath in the
   package exports map (package.json:243–247). Unlike `isPlatformFailure`
   in the same barrel, the turn-task exports carry no `@internal` marker
   at all, and `recovery-task.ts`'s module-level `@internal` does not
   survive into `dist/chat/index.d.ts`. There is also an in-repo
   cross-package consumer through the public path:
   `packages/think/src/tests/agents/think-session.ts:49–55` imports
   `CHAT_RECOVERY_TASK_NAME` and `chatRecoveryTaskRunOptions` from
   `"agents/chat"`, not a relative path. **Deleting these modules is a
   published break.**

One more: **`flue` is not in this repo.** The only occurrence is
`scuffi/flue` in `agent-think/src/run-context.ts:2`'s repo allowlist;
every other hit is the word "fluent". Treat it as an out-of-repo consumer
of the published `agents` package — bound only by the public surface, and
therefore by whatever the deprecation release breaks. It must be surveyed
before the deprecation PR, not before PR 1.

And one omission from the inventories worth naming here: **`agent-think`
is a workspace package**, listed in `pnpm-workspace.yaml:2` ahead of
`examples/*`, named `@cloudflare/agent-think`. It is the only top-level
source directory outside `packages/`, `examples/`, `experimental/` and
`guides/` that is in the workspace, and it writes Think's private tables
directly (`agent-think/test/submission-status.test.ts:22` INSERTs into
`cf_think_submissions`). It is a consumer of every Think-table change
below.

---

## 1. What survives, in what form

Grouped for readability; every member of today's surface appears exactly
once.

### 1a. Capability methods

| Member                                                                                         | Verdict                                         | New form / home                                                                                                          | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tasks` class                                                                                  | **Unchanged**                                   | —                                                                                                                        | Still the one capability. `definitions` now accepts both definition shapes, discriminated at registration (`typeof def === "function"` → step API; an object with `phases` → machine API). That resolved shape is the **only** step-vs-machine discriminator; see §6 on why the row column is not one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tasks.run(name, input, opts)`                                                                 | **Reshaped — signature unchanged, new options** | `TaskRunOptions.start`, `turnTimeout`, `background`                                                                      | `runId` becomes documented as _the address_. But an address is only an address if it can be re-run: `#accept` (tasks.ts:1105–1143) joins an existing row in **any** state, terminal included, with no restart branch, and `TaskDeleteOptions` (tasks.ts:220–224) exposes only `status`/`settledBefore`/`limit`. A settled address is currently unusable forever. See Risk 17 — **the one item this plan asks for that the RFC's §2.5 does not yet carry.**                                                                                                                                                                                                                                                                                                                                                                                         |
| `tasks.get(runId)`                                                                             | **Unchanged**                                   | —                                                                                                                        | Machine runs report the same six states; `result` is the value passed to `ctx.complete`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tasks.getByIdempotencyKey(key)`                                                               | **Unchanged**                                   | —                                                                                                                        | Still the at-least-once join.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tasks.list(options)`                                                                          | **Survives, widened**                           | `TaskListOptions` gains `metadata` equality filters and `order`                                                          | Today: `definition`/`status`/`limit`, ordered `created_at DESC` (tasks.ts:211–215). That cannot serve the queries Think's tables answer (Risk 19), and narrowing it is what would strand PR 12. _Not in the RFC's §2.5; additive, and owed by PR 7._                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tasks.cancel(runId, reason?)`                                                                 | **Reshaped**                                    | Marks, signals, joins, then dispatches `onCancel(state, ctx)`                                                            | Today cancel settles at a step boundary with a fixed outcome. Under the engine the definition owns the outcome; definitions with no `onCancel` — every step definition — get today's behaviour verbatim and inline (RFC §6.4). Gains `{ wait?: boolean }`. The fence that keeps `onCancel`'s return from being clobbered is RFC §5.2 — Risk 22.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tasks.delete(options)`                                                                        | **Survives, widened**                           | `TaskDeleteOptions` gains `runId`                                                                                        | Omitted from the brief's enumeration; keep — a DO has no background GC. Widening is what frees a settled machine address (Risk 17). See Risk 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tasks.handle(name)`                                                                           | **Unchanged, widened**                          | —                                                                                                                        | Gains `send`/`view`/`watch`/`at` alongside `run`/`get`/`getByIdempotencyKey`/`cancel`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tasks.at(name, runId)`                                                                        | **New**                                         | `TaskRunHandle<D[K]>`                                                                                                    | _RFC addition._ A per-run typed handle — `send`, `sendEvent`, `answer`, `withdraw`, `get`, `view`, `watch`, `cancel`, `terminate` — so a caller stops retyping the `runId` string. It does **not** replace `run()`'s `TaskReceipt`; `accepted` is the point of durable acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tasks.register(name, def)`                                                                    | **Reshaped — name kept**                        | Documented `@internal`, returns `TaskInternalHandle`                                                                     | _RFC override._ The earlier verdict was "becomes public `define(name, def)` with no `__cf` requirement". The RFC keeps the name, keeps the `__cf` requirement, and makes `register()` return a handle whose `run(input, { start })` is what the apertures were for. The composition-registry need the three example harnesses have is **real and unsatisfied** by that — they construct their capability separately from the `Tasks` instance and already call `register()` with a cargo-culted `__cf` prefix — so a public `define()` remains a named follow-up (PR 14a), not a cancelled idea.                                                                                                                                                                                                                                                   |
| `runAttached`                                                                                  | **Deleted this release**                        | `register(name, def).run(input, { start: "attached" })`                                                                  | _RFC override:_ it is deleted in the engine release, not kept as a deprecated wrapper. All **six** references in the tree move in the same PR (PR 4): `think:5013` (messenger reply, `__cf_internal_messenger_reply`), `think:5078` and `ai-chat:841` (chat turn, `__cf_internal_chat_turn`), `examples/next/harnesses/self-modifying:394`, `capability.test.ts:127`, and the `ai-chat/tests/worker.ts:3374–3404` monkey-patch, which saves, replaces and restores the method rather than calling it. Risk 16 on why the four production/harness sites are like-for-like edits rather than a gate — and PR 4 on the two that are not.                                                                                                                                                                                                              |
| `enqueue`                                                                                      | **Deleted this release**                        | `register(name, def).run(input, { start: "queued" })`, or public `run(..., { start: "queued" })` for a non-reserved name | The split is production vs test, not one site vs the rest: **every production caller passes a `__cf` name** (think:4922, ai-chat:784, plus the harnesses) — which, with the gate kept, is exactly why the _handle_ and not public `run()` is the replacement — while **all eight test `enqueue` sites pass non-reserved names** already declared in the harness `definitions` map (`tests/capabilities/tasks.ts:53`), so `#validateDefinitionName` (tasks.ts:308–327) would accept every one of them on public `run()`: `memory-limit.test.ts:189` `twinLateOom`, `:229` `oomBeforeCleanSibling`, `:277` and `:380` `lateOomStepLoop`, `:347` `lateSuccess`, `:606` `sleeper`; `capability.test.ts:328` `pipeline`, `:830` `exhaustedPlatformStep`. They are the proof `start` belongs on `run()`. This dissolves the old ordering trap (Risk 15). |
| `cleanupRoutePrefix`                                                                           | **Survives, contract extended**                 | Unchanged signature                                                                                                      | Shared tri-capability protocol member (`dynamic-agents/host.ts:54–62`), not accretion. Extended contract: a deleted facet subtree must also drop the root's `cf_agents_task_routes` rows under the prefix and reap the parent's `kind:'child'` mailbox rows (RFC §10.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `setTaskDefinitionResolver`                                                                    | **Deleted**                                     | `TasksOptions.definitions` accepts a thunk `() => TaskDefinitions`                                                       | Removes the module WeakMap, the exported `TaskDefinitionResolver` type, and the free function. Not public (`[main] tasks/index.ts` does not re-export it) → non-breaking in code; it _is_ documented in `design/rfc-fibers.md:117`, which must be corrected. _Note: RFC §14.4 step 3 widens the resolver's return type rather than removing it, because release 1 changes no consumers. If the thunk lands first (PR 5), the engine widens the thunk instead — same end state, one fewer type._                                                                                                                                                                                                                                                                                                                                                    |
| `setTaskRoutedMemoryLimitHandler`                                                              | **Reshaped**                                    | `TasksOptions.onRoutedMemoryLimit`                                                                                       | Same WeakMap-to-option move; the bridge itself stays because a facet's Lifecycle never sees the root's alarm. *Note: RFC §5.7 says `onMemoryLimit`/`#applyMemoryLimit` keeps its shape "including the `setTaskRoutedMemoryLimitHandler` twin bridge" — that is the bridge's *shape*, not its spelling. If PR 5 lands first the engine inherits the option instead of the setter; same end state, one fewer module WeakMap. Exactly the situation the `setTaskDefinitionResolver` row already carries a note for.*                                                                                                                                                                                                                                                                                                                                  |
| `tasks.send` / `sendEvent` / `withdraw` / `answer` / `asks` / `withdrawAsk` / `view` / `watch` | **New**                                         | —                                                                                                                        | `sendEvent` is the Workflows spelling of `send(..., { kind: "event", type })`. `answer(askId, kind, value)` is typed by the ask kind and needs only the id. `watch` is the settle channel that `_liveChatTurnClosures` + the out-of-band settle promise are today. **There is no capability-level `ask`** — an ask is a question a transition raises; an outside-in question is a `send`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tasks.pause` / `resume` / `terminate` / `reopen`                                              | **New**                                         | —                                                                                                                        | _RFC override of the old "defer `pause`/`resume`" verdict._ They are cheap in the wake model and they are the Workflows vocabulary; `terminate` is the forceful tier (no `onCancel`), `reopen` un-orphans a run whose definition came back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `onStart` / `onJob` / `onRoute` / `onMemoryLimit`                                              | **Unchanged**                                   | —                                                                                                                        | Lifecycle capability protocol; `onRoute`'s message union grows (RFC §5.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 1b. `TaskRunOptions`

| Member                                    | Verdict                                  | New form                                    | Note                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotencyKey`                          | Unchanged                                | —                                           |                                                                                                                                                                                                                                                         |
| `runId`                                   | Unchanged                                | —                                           | Documented as the address. Aliasing to `id` for Workflows parity is **not** worth it (Risk 3).                                                                                                                                                          |
| `metadata`                                | **Survives; load-bearing in queries**    | —                                           | Field kept. The `list()+metadata` scan _idiom_ is deleted where an address answers the question; Think's submission queries still need `list({ metadata })` as a real filter, not a scan (Risk 19).                                                     |
| `retain`                                  | Unchanged                                | —                                           | Widening to a duration is parity polish, not scope. Note the RFC's one carve-out: `faulted` and `orphaned` override `retain:false` (RFC §6.6).                                                                                                          |
| `interruptions` (#2274, run-level budget) | **Survives; already renamed**            | —                                           | `TasksOptions.retries` = step defaults; `TaskRunOptions.interruptions` = the interruption budget. Code and docs were renamed together in `f28ffc2f`; `docs/agents/tasks.md` already reads `interruptions` (:109, :119, :128, :234, :237). Nothing owed. |
| `deadline` (#2274)                        | Unchanged                                | —                                           | Its abort path becomes the `deadline` mark that `onCancel` owns (RFC §6.1).                                                                                                                                                                             |
| `turnTimeout`                             | **New**                                  | `number \| TaskDurationString`              | Per-transition watchdog, separate from the run deadline; replaces `chat/stall-watchdog.ts`.                                                                                                                                                             |
| `start`                                   | **New (public)**                         | `"warm" \| "queued" \| "attached"`          | Public form of the two apertures' start modes. Warm stays the default: a latency win with no correctness role, and dropping it regresses `examples/next/tasks`.                                                                                         |
| `background`                              | **New**                                  | `boolean`                                   | Excluded from a parent's abort cascade and from the default join. Set through `ctx.spawn`.                                                                                                                                                              |
| `replace`                                 | **New — asked for here, not in the RFC** | `"never" \| "ifSettled"`, default `"never"` | `"never"` is today's behaviour verbatim (join in any state). `"ifSettled"` is what makes `runId` an address a machine can be re-entered at after it settles. Risk 17.                                                                                   |

### 1c. `TasksOptions`

| Member                | Verdict                                  | New form                                                                 | Note                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definitions`         | **Reshaped**                             | Accepts a map **or a thunk**; values may be a step function or a machine | The thunk is what deletes `setTaskDefinitionResolver`.                                                                                                                                                                          |
| `retries`             | Unchanged                                | —                                                                        | Unambiguous now that run-level is `interruptions`.                                                                                                                                                                              |
| `stepTimeout`         | Unchanged                                | —                                                                        | Load-bearing beyond a default: it sizes the claim lease via `CLAIM_SLACK_MS` (tasks.ts:128, 279), for both layers. Do not rename.                                                                                               |
| `turnTimeout`         | **New**                                  | Capability default for the per-transition watchdog                       | Defaults to `stepTimeout`.                                                                                                                                                                                                      |
| `stallLimit`          | **New**                                  | Progress Rule A, default 1                                               | Consecutive no-progress transitions tolerated before `TaskNoProgressError`.                                                                                                                                                     |
| `transitionBudget`    | **New**                                  | Progress Rule B, default 1000                                            | Max transitions since the last park before `TaskTransitionBudgetError`. Rule A cannot catch a loop whose checkpoint differs every iteration; this is that bound.                                                                |
| `mailboxLimit`        | **New**                                  | Default 1000                                                             | `send` beyond it throws `TaskMailboxFullError` rather than growing unbounded.                                                                                                                                                   |
| `interruptionBackoff` | **New — asked for here, not in the RFC** | Engine-level default for un-policied runs                                | The fiber engine's `FIBER_RECOVERY_MAX_BACKOFF_MS` is the only thing today that stops a poison run hot-looping; #2274's backoff is opt-in and off by default. Deleting one without defaulting the other reopens #1707. Risk 18. |
| `onError(error, run)` | Unchanged                                | —                                                                        | Keep as observability. Do **not** grow into a settle channel — `tasks.watch` is that (Risk 12).                                                                                                                                 |
| `TaskFailedRun`       | Unchanged                                | —                                                                        |                                                                                                                                                                                                                                 |

### 1d. `TaskStep` and the `ctx` it is part of

`TaskContext extends TaskStep`: there is one object, and the machine
members are additions on it, not twins of it. That is the correction that
retires the whole "does the machine API need its own X?" column.

| Member                                                         | Verdict                      | On `ctx`                                   | Note                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step.do(name, config?, cb)`                                   | **Unchanged**                | `ctx.do` — **turn-scoped** memoised effect | The anchor. One journal _table_, two scopes: a step run is one turn, so its rows are unchanged; a machine scopes names to the current turn and the previous turn's rows are retired in the commit transaction. Risk 10 — the correction that makes "one journal" safe.                                                                                                                          |
| `step.sleep(name, d)` / `sleepUntil`                           | **Unchanged**                | same                                       | Parks and re-enters the same turn.                                                                                                                                                                                                                                                                                                                                                              |
| `step.signal` (#2274)                                          | **Unchanged**                | `ctx.signal`                               | Same object, same abort reasons. Inside a handler an abort surfaces as the signal firing and whatever you awaited throwing; the _transition_ is still a return, from a fresh fenced `onCancel`.                                                                                                                                                                                                 |
| `step.attempt` (#2274)                                         | **Unchanged**                | `ctx.attempt`                              | Keep, but do **not** read it as interruption evidence: it increments on every claim, sleep wakes included (tasks.ts:1265; types.ts:139–146 says so).                                                                                                                                                                                                                                            |
| `step.interrupted`                                             | **Unchanged, and inherited** | `ctx.interrupted`                          | _Verdict reversed from the inventories, and settled by `extends`._ A machine re-entering after a lost isolate needs half-applied-effect evidence **more** than a step run does, because a phase body is unjournaled — and `ctx.attempt > 1` is true for every transition after the first, so it carries zero information. Risk 21.                                                              |
| `step.status(message)`                                         | **Unchanged**                | `ctx.status`                               | One column, one fenced write, same replay-silence semantics; the harness callers keep working.                                                                                                                                                                                                                                                                                                  |
| `step.idempotencyKey(name)`                                    | **Kept**                     | `ctx.idempotencyKey(name, { scope })`      | _RFC override._ The earlier verdict was "delete — zero real callers". The RFC keeps it and gives it the scope rule: `${runId}:${name}` for a step definition (byte-identical to `engine-port.ts`'s `stepIdempotencyKey`, which the migration requires), `${runId}:t${turn}:${name}` inside a machine, `{ scope: "run" }` for the legacy form in both. The `docs/agents/tasks.md:154` row stays. |
| `step.waitForEvent(name, {type, timeout})`                     | **New**                      | also on `ctx`                              | A journaled single-shot receive with a deadline. Workflows parity down to throwing `TaskEventTimeoutError`; the machine layer's `within` waits return `ctx.timedOut` instead, deliberately.                                                                                                                                                                                                     |
| `ctx.receive` / `receiveAll` / `peek` / `peekAll` / `withdraw` | **New**                      | —                                          | The looping mailbox. One-shot (`waitForEvent`) vs loop is the clean line between the layers.                                                                                                                                                                                                                                                                                                    |
| `ctx.ask` / `answers` / `peekAnswers`                          | **New**                      | —                                          | Typed by `defineAsk<P, A>`; `ctx.ask` is synchronous and batched, `answers` parks, `peekAnswers` reads.                                                                                                                                                                                                                                                                                         |
| `ctx.memo(name, candidate)` / `memo(name)`                     | **New**                      | —                                          | First-writer-wins per run, journal `turn = -1`. Derive the _name_ from a checkpoint ordinal for fresh-but-stable ids; there is no `uuid()` and no call counter.                                                                                                                                                                                                                                 |
| `ctx.spawn` / `join`                                           | **New**                      | —                                          | `join` is sugar over `receive({ kind: "child" })`; results are `{ ok, output } \| { ok: false, error }`, not throws.                                                                                                                                                                                                                                                                            |
| `ctx.stream(name?)`                                            | **New**                      | —                                          | An `agents/streams` `StreamWriter` the engine owns; settles in the checkpoint's transaction. Named and plural.                                                                                                                                                                                                                                                                                  |
| `ctx.heartbeat()` / `creditProgress()`                         | **New**                      | —                                          | Liveness for a transition that calls no step; explicit credit for work the chunk log cannot see.                                                                                                                                                                                                                                                                                                |
| `ctx.complete` / `fail` / `aborted`                            | **New**                      | —                                          | Branded `TaskTerminal<R>`; forgetting `return` fails as `Promise<void>`.                                                                                                                                                                                                                                                                                                                        |
| `TaskStepAttempt.attempt` / `.idempotencyKey` / `.signal`      | **Unchanged**                | —                                          | What `tests-d/tasks-export.test-d.ts:91–92, 125–127` destructure.                                                                                                                                                                                                                                                                                                                               |
| `TaskStepConfig.retries` / `.timeout`                          | **Unchanged**                | —                                          | `delay`-as-function and `sensitive`/rollback are documented gaps (RFC §13), not scope.                                                                                                                                                                                                                                                                                                          |

### 1e. Errors and constants

| Member                                                           | Verdict                                          | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NonRetryableError`                                              | **Unchanged**, ctor widened                      | Add a `(message, name?)` overload so the `cloudflare:workflows` class and this one are interchangeable in both directions. `isNonRetryableError` already honours foreign ones by name.                                                                                                                                                                                                                                                               |
| `DuplicateTaskStepError`                                         | **Survives, rescoped**                           | Keep it fatal, now meaning "used twice **within one turn**". `#usedNames` is a `ReplayStep` instance field (replay.ts:239) constructed per attempt (tasks.ts:1327), so it has never been a cross-attempt guard. Turn scoping (§1d) is what makes a name reused across turns legal rather than silently stale.                                                                                                                                        |
| `TaskReplayDivergedError`                                        | **Survives, rescoped**                           | Within a turn only: a checkpoint change retires the previous turn's rows, so there is nothing to diverge from.                                                                                                                                                                                                                                                                                                                                       |
| `MissingTaskDefinitionError`                                     | **Survives, unchanged for the unversioned case** | _RFC override._ The earlier verdict was "park with a bounded grace, then fail". The RFC's answer is `outcome: 'orphaned'` — terminal, checkpoint/journal/mailbox/asks **preserved even at `retain:false`**, no alarm, and an explicit `tasks.reopen(runId)` — which is strictly more recoverable than a grace window and needs no per-name shim either. `capability.test.ts:737`'s three assertions are preserved for the unversioned case. Risk 23. |
| `TaskInterruptionsExhaustedError` (#2274)                        | **Survives**                                     | Already renamed from `TaskAttemptsExhaustedError`, in code and in `docs/agents/tasks.md` (:119, :237), both in `f28ffc2f`. The old name appears nowhere in the tree.                                                                                                                                                                                                                                                                                 |
| `TaskDeadlineExceededError` / `TaskSerializationError`           | **Unchanged**                                    | `TaskCheckpointTooLargeError` subclasses the latter so existing catches match.                                                                                                                                                                                                                                                                                                                                                                       |
| New errors                                                       | **Added**                                        | `TaskNoProgressError`, `TaskTransitionBudgetError`, `TaskTurnDeadlineExceededError`, `TaskCancelCannotParkError`, `TaskConcurrentParkError`, `TaskEventTimeoutError`, `TaskMailboxFullError`, `TaskCheckpointTooLargeError`, `TaskOrphanedDefinitionError`.                                                                                                                                                                                          |
| `AttemptSupersededError` / `TaskSuspension` / `TaskCancellation` | **Reshaped**                                     | Stay unexported classes; **export `isTaskControlSignal(error): boolean`**. Fixes a real surface bug: `codex-harness.ts:445` identifies a control value by the magic string `"AttemptSupersededError"` because nothing else is available.                                                                                                                                                                                                             |
| `MAX_SERIALIZED_BYTES`                                           | **Deleted from the public export**               | Zero callers anywhere. Constant stays internal; the 1 MiB limit is already in the docs. `MAX_CHECKPOINT_BYTES = 262_144` joins it as an internal constant, documented but not exported.                                                                                                                                                                                                                                                              |
| `MAX_STEPS_PER_RUN` / `MAX_STEP_NAME_LENGTH`                     | **Survive internal**, documented                 | `MAX_STEPS_PER_RUN = 10_000` (replay.ts:55, enforced :292) is why the pi harness rotates at 4 000 passes. It stops being a cap on machine lifetime **only because** §1d scopes the journal per turn and retires the previous turn on commit — not because the machine API removes journalling.                                                                                                                                                       |

### 1f. Events, snapshots, types

| Member                                                        | Verdict                                                        | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All 11 `task:*` event names + `TaskEventType`                 | **Unchanged, plus machine-only additions**                     | A compiled step definition emits exactly today's eleven in today's order (RFC §3.9), which is what preserves `capability.test.ts:311–319`. Machines additionally emit `task:transition:started`, `task:checkpoint`, `task:mailbox`, `task:ask`, `task:answer`, `task:child`, `task:faulted`, `task:orphaned`, `task:paused`, `task:resumed`. `diagnostics.ts:36` routes by string prefix and is unaffected.                                                                                                                                                                                                                                                                                               |
| The 9 `fiber:*` events + the `fiber` observability group type | **Deleted at the engine deletion, with three named consumers** | Declared in `packages/agents/src/observability/agent.ts:105–177`. `packages/agents/src/observability/index.ts:70` exports ``fiber: Extract<ObservabilityEvent, { type: `fiber:${string}` }>`` — deleting the arms **silently collapses a published type to `never`** rather than erroring, so nothing in CI catches it. Test consumers: `packages/agents/src/tests/observability.test.ts:323, 349` and `packages/think/src/tests/think-session.test.ts:3324`. Doc consumer: `docs/agents/observability.md:32` publishes the `agents:fiber` channel row, on a page with no experimental note that ships in the tarball.                                                                                    |
| `TaskRunState` (6 values)                                     | **Unchanged**                                                  | Do **not** rename to Workflows' vocabulary (Risk 3). Persisted values behind a SQL `CHECK`. `faulted`/`orphaned` ride a new `outcome` column beside `failed`, which is what keeps the runs-table migration a plain `ALTER TABLE ADD COLUMN`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TaskWaitReason`                                              | **Survives, widened**                                          | `"sleep" \| "retry" \| "interrupted"` \*\*+ `"mailbox" \| "event" \| "ask" \| "child" \| "paused"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TaskReceipt`                                                 | **Unchanged**                                                  | `accepted: false` is not an error, and it is reused verbatim as the shape of `TaskSendReceipt` / `TaskAnswerReceipt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TaskRunSnapshot.*`                                           | **Widened, with one break**                                    | Every existing field survives. `wakeAt` on the `waiting` arm becomes **optional**, because an event-driven park has no wake time and `rowToSnapshot`'s `wakeAt: row.next_at ?? row.updated_at` (`store.ts:183–241`) would report a past timestamp as a future wake. Terminal arms gain `outcome?`; `running`/`waiting` gain `abortRequested?`/`abortReason?`. _RFC override of Risk 19's first half: the committed checkpoint is **not** added to the snapshot — `snapshot.state` keeps its meaning (renaming it would edit 41 assertion sites), and the checkpoint is read from the new `tasks.view(runId)`, which also carries mailbox, asks, children, streams, `turn`, `progress` and `transitions`._ |
| `TaskRunView` / `TaskChange` / `TaskChangeType`               | **New**                                                        | The deep read and the change feed. `watch` has no `from` cursor: a resumable cursor needs a durable change log, i.e. one write per change on the hottest paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Task<Input,Output>` handle                                   | **Unchanged, widened**                                         | Becomes an alias of `TaskHandle<Input, unknown, Output>`; gains `send`/`view`/`watch`/`at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `TaskHandlers` / `TaskCallbacks` / `TaskInput` / `TaskOutput` | **Reshaped**                                                   | Must admit the machine shape as well as the function shape. `TaskInput` reads a function's first parameter or `initial`'s seed parameter; `TaskState`/`TaskOutput` infer from the **return** position of the `phases` map (a parameter-position inference intersects a union to `never`). New: `TaskState<D>`, `TaskMailbox<D>`, `AssertJson<T>`.                                                                                                                                                                                                                                                                                                                                                         |
| `TaskJson` / `TaskValue`                                      | **Unchanged**                                                  | JSON-only, documented. The checkpoint is constrained to `{ phase: string }` only — `& TaskJson` rejects `interface`-spelled state — with serialisability enforced by the opt-in `AssertJson` and the first-commit runtime check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TaskRetryConfig` (#2274)                                     | **Unchanged**                                                  | Correctly shared by step config and run `interruptions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TaskListOptions` / `TaskDeleteOptions`                       | **Both widened**                                               | `TaskListOptions` gains metadata filters + ordering; `TaskDeleteOptions` gains `runId`. See §1a and Risks 5, 17, 19.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TaskDurationString`                                          | **Widened**                                                    | Add `month`, `year` to match `WorkflowDurationLabel`. One line. Do not introduce a second duration spelling anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TaskDurationUnit`                                            | **Deleted from the public export**                             | Zero external callers; reachable through `TaskDurationString`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Agent.tasks`                                                 | **Unchanged**                                                  | Stays unconditional — one capability, not two (Risk 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Agent.taskDefinitions`                                       | **Unchanged**                                                  | The user surface survives verbatim; only its _bridge_ changes (thunk instead of WeakMap), widened to `TaskDefinitions`. Per-definition `State` inference through a lazy resolver is impossible — the resolver is keyed by `string` — so an Agent subclass's `this.tasks.run()` stays input-typed and state-untyped, exactly as today.                                                                                                                                                                                                                                                                                                                                                                     |
| The 9 root-entrypoint fiber types                             | **Deprecated then deleted**                                    | `FiberContext`, `FiberStatus`, `StartFiberOptions`, `FiberInspection`, `StartFiberResult`, `FiberRecoveryResult`, `ListFibersOptions`, `DeleteFibersOptions`, `FiberRecoveryContext`. Stable entrypoint, no experimental note. Correction 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The 11 `agents/chat` Task exports                             | **Deprecated then deleted**                                    | `createChatTurnTaskDefinition` + 2 types; `CHAT_RECOVERY_TASK_NAME` + 7. Stable subpath, no experimental note on the turn-task block. Correction 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MESSENGER_REPLY_FIBER_NAME`                                  | **Renamed — a published break on a second package**            | Re-exported from `packages/think/src/messengers/index.ts:36`, and `./messengers` is a declared subpath in `packages/think/package.json:80`. Risk 9 previously implied this was internal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 2. Keep / Reshape / Delete — internal surface

### DELETE

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Consumers today                                                                                                                                                               | Why the replacement removes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setTaskDefinitionResolver` (tasks.ts:86) + `TaskDefinitionResolver` (:72) + its WeakMap (:76)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `[main] index.ts:174, 1931`; documented in `design/rfc-fibers.md:117`                                                                                                         | A WeakMap side-channel plus a free function for a one-line requirement (subclass field-initializer ordering). `definitions` as a thunk expresses it as an option.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `setTaskRoutedMemoryLimitHandler`'s WeakMap + free function (tasks.ts:105)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `index.ts:175, 1912` only                                                                                                                                                     | Same shape problem. The _bridge_ survives as `TasksOptions.onRoutedMemoryLimit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MAX_SERIALIZED_BYTES` export, `TaskDurationUnit` export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | none / none                                                                                                                                                                   | Zero code callers each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The whole legacy fiber engine: `runFiber`, `startFiber`, the 7 inspection/control methods, `_runFiberInternal`, `_runFiberWithStashWrapper`, `_checkRunFibers`, `_checkFacetRunFibers`, `_cf_checkRunFibersForFacet`, `DynamicAgents.checkRunFibers`/`checkRunFibersAtPath`, `_onAlarmHousekeeping` + the `cf:housekeeping` job, `_hasPendingFiberRecovery`, `_nextHousekeepingWakeMs`, the recovery backoff constants, the 3 `fiberRecovery*` static options, `onFiberRecovered`, the 9 `fiber:*` events + `agents:fiber` channel + the `fiber` observability group type, the 8 managed-fiber types, the 9 root-exported fiber types, 3 tables | §5                                                                                                                                                                            | A bare "run a closure, keep a row, call me back if you died". The engine covers it with journaled steps, the state-return commit, and routed dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Raw SQL over `cf_agents_task_runs` / `cf_agents_task_steps` — **three sites, not one**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | (a) `think.ts:11194–11280`; (b) `examples/next/harnesses/codex/src/stress/worker.ts:106, 112`; (c) `packages/think/src/tests/agents/think-session.ts:91, 112, 123, 128, 8237` | (a) reads another capability's private table by hand, tests a `'recovering'` state the `CHECK` constraint forbids (dead arm, latent bug), and compares `metadata` by exact JSON string (second latent bug) — the question becomes "does a run exist at this address", one `tasks.get`. (b) hard-codes `state, attempt, error_name` and `step_name, kind, state, attempt, error_name` for a `steps(operationId)` diagnostic, inside the very harness the migration touches. (c) reads _and_ UPDATEs both tables in five places, including backdating `cf_agents_task_steps.next_at`. **All three break harder than the original plan assumed: `cf_agents_task_steps` does not gain a column, it is _replaced_ by `cf_agents_task_journal` and dropped** (§6). They bypass the engine by construction and need engine-level equivalents written first. |
| The `parentPath.length > 0` facet fallback blocks (ai-chat:811–812, think:5048–5049)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the only **production** callers of `_runFiberWithStashWrapper` in `packages/`                                                                                                 | §5 — the comment is stale; routed dispatch landed in #2194. Note: deleting them does _not_ make the method dead in `packages/` (Risk 20).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Removed from the DELETE list by RFC decision**, each with what replaced
the reasoning:

- **The `__cf` reserved-name policy** (tasks.ts:308–327
  `#validateDefinitionName`, called from `run()` at :380; :346–366
  `register()`'s requirement; `replay.ts`'s step-name refusal). The RFC
  keeps it. It exists so a user cannot `run()` a framework definition,
  and with the two apertures deleted in favour of `register()`'s handle,
  the gate is still doing that job. **The
  consequence is that the old ordering trap disappears** — the
  replacement for `enqueue` is `register(...).run(input, { start })`,
  which accepts a reserved name by construction, so nothing has to be
  un-gated first (Risk 15). What the gate does _not_ answer is the
  composition-registry need (§2 RESHAPE, `register`), which is why a
  public `define()` is scheduled as PR 14a rather than dropped.
- **`__DO_NOT_USE_WILL_BREAK__runAttached` / `enqueue`**: _back on the
  DELETE list._ The maintainer's 2026-09-16 decision withdraws the
  keep-them-as-wrappers instruction: both are deleted in PR 4, in the
  same diff that moves every in-repo caller.
- **`#acceptReserved` (tasks.ts:703) + `TaskStartMode "attached"`
  (tasks.ts:203)**: both survive under the handle's
  `run(input, { start })` — but they are not the whole of it. `#accept`
  takes the three-valued `startMode` and acts on exactly one:
  `if (startMode === "warm" && this.lifecycle.status() !== "starting")
void this.#executeRun(runId)` (tasks.ts:1168). The _attached_
  behaviour is the next two lines of the aperture body,
  `if (receipt.accepted) await this.#executeRun(receipt.runId)`
  (tasks.ts:681–683). So `start: "attached"` is `#acceptReserved(…)`
  **plus** that drive-and-await step, and both `TaskInternalHandle.run`
  and public `run()` must carry it. A handle that only forwards the mode
  degrades `attached` to `queued`, which hangs every caller that awaits
  an outcome its handler settles (`think.ts:5013`, `:5078`,
  `ai-chat/src/index.ts:841`) until the queue wake. `start` additionally
  becomes a public `TaskRunOptions` member for non-reserved names.
- **`step.idempotencyKey(name)`**: kept, with the scope rule (§1d).

### RESHAPE

| Item                                                                                                                    | Consumers                                                                                                                                                             | New form / reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tasks#register` (tasks.ts:346)                                                                                         | ai-chat ×2, think ×3, pi, codex, self-modifying, 2 test workers; documented in `design/rfc-fibers.md:122` and sampled in `design/rfc-codex-harness-capability.md:602` | **Keeps its name and its `__cf` requirement; becomes documented `@internal` and returns `TaskInternalHandle { name, run(input, options) }`.** _This is the direct answer to the brief's question, revised._ The apertures carry **three** conflated needs. (a) _Start mode_ — answered by the handle's `run(input, { start })` and by public `run(..., { start })`. (b) _Namespace protection_ — **kept**, not dropped (Risk 2 reverses). (c) **Composition registry — still unanswered.** All three example harnesses are ordinary user-land capabilities constructed _separately from_ the `Tasks` instance, so the constructor `definitions` map cannot serve them; they already use `register()` with a cargo-culted `__cf` prefix. A public `define(name, definition)` makes that honest, and is PR 14a. |
| `onRoute` + `TaskRouteMessage` (tasks.ts:828, :189)                                                                     | `capability-runner.ts:363`, exercised only from `ai-chat/src/tests/worker.ts`                                                                                         | **Gains four cases** (`mailboxPush`, `answer`, `childSettled`, `abortCascade`) plus `view`, and routed stream cutover (RFC §5.9). This is the one piece of routed machinery that grows. Keep in Tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `#syncRoutedWake` (tasks.ts:856), `#dispatchRoutedRun` (tasks.ts:565), `TaskWakeJobPayload.owner_path`/`owner_path_key` | as above                                                                                                                                                              | Keep; unchanged shape, plus a `DISPATCH_BUDGET_MS` cap on the facet-side re-entry loop so a looping machine cannot hold the root's RPC forever (RFC §5.6). Lift to Lifecycle only on the separate track.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `onMemoryLimit` (tasks.ts:591) + `#applyMemoryLimit` (tasks.ts:631)                                                     | `capability-runner.ts:61`, `memory-limit.test.ts` (654 lines)                                                                                                         | Keep the policy; **make an OOM strike count as an interruption** against the run's budget so the seal is the unbounded backstop rather than a second name for "this run kept dying" (Risk 6). #2274 already routes the sealed branch through `#failWithoutAttempt` (tasks.ts:643) — finish the wiring there, add `outcome:'faulted'`, and leave an event-only park's `next_at` NULL on a non-sealed strike (RFC §5.7).                                                                                                                                                                                                                                                                                                                                                                                        |
| `cf_agents_task_steps` + `replay.ts` (536 lines)                                                                        | the step engine                                                                                                                                                       | **The journal survives as one mechanism with a turn scope — but as a new table.** `cf_agents_task_journal` is keyed `(run_id, turn, name)` and `cf_agents_task_steps` is rebuilt into it and dropped at schema 2.5→3 (§6). `replay.ts` becomes the _compiler_ from `(input, step)` onto the engine, not a second engine; its class is renamed `TaskContextImpl` and `ReplayStep` stays as a deprecated alias. `step.do` and `ctx.do` write the same rows.                                                                                                                                                                                                                                                                                                                                                     |
| `MissingTaskDefinitionError` handling (tasks.ts:1200–1207)                                                              | every rename/drop migration                                                                                                                                           | `orphaned` + preserved checkpoint + explicit `reopen()` instead of a terminal fail (Risk 23).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The cancel-wins-over-result guard (tasks.ts:1338–1352)                                                                  | `#runAttempt`                                                                                                                                                         | Fenced by `abort_mark IS NULL` on ordinary writes and `abort_mark IS NOT NULL` on the cancel transition's, which is what distinguishes "this attempt was cancelled out from under it" from "this attempt _is_ the cancel transition" (Risk 22).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `dynamic-agents/host.ts:54–62` triple structural declaration of `cleanupRoutePrefix`                                    | `dynamic-agents.ts:262–277`                                                                                                                                           | One `lifecycle.jobs.cancelByOwnerPrefix(prefix)` replaces three declarations and three `dist` entries. Separate Lifecycle track; not a blocker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FIBER_SCHEMA_VERSION_KEY` / `CURRENT_FIBER_SCHEMA_VERSION` (tasks.ts:112–114)                                          | `onStart` (tasks.ts:421–430)                                                                                                                                          | Rename the _identifiers_ off `FIBER_`; the persisted key string `"cf_agents:tasks_schema_version"` **must not change**. It takes the intermediate value 2.5 and then 3 (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `_handleInternalFiberRecovery`, `stash()` / `_withFiberStash` / `_fiberALS`, `FiberRecoveryContext` / `FiberContext`    | ai-chat:721–722, think:4859–4860, `chat/turn-task.ts:41,51`, `think.ts:4957`, `messengers/delivery.ts:361`                                                            | **Not legacy.** All three are load-bearing on the _Tasks_ path today. Rename off the fiber vocabulary when chat turns move; do not sweep them with a `grep -i fiber`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### KEEP (unchanged)

| Item                                                                                                                                                 | Consumers                                       | Reason                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The claim heartbeat: `CLAIM_SLACK_MS` (:128), `#claimTimeoutMs` (:279), `#refreshClaim` (:495), `engine.refreshClaim`, `claimRefreshAfterMs` (:1545) | tasks/ only                                     | The actual durability mechanism of DO-hosted durable execution, and the machine API needs it identically — plus `ctx.heartbeat()` for a transition that calls no step. Keep, and keep invisible: the lease should be touched from one place.                                                     |
| The wake mirror: `WAKE_JOB_PREFIX`/`WAKE_JOB_FN`, `#syncWake`, `onJob`, `#wakeOutcome`                                                               | 9 internal call sites                           | The DO backend of the engine, and the multiplexer that owns the single alarm — **timer primitives never call `setAlarm`**. `#wakeOutcome` existing alongside `#syncWake` is a smell; collapse it behind one wake port during the engine PR.                                                      |
| `#syncAllWakes` (:912), `#reconcile`, `lifecycle.jobs.rearm()`                                                                                       | `onStart`                                       | The run table, not the queue, is the source of truth. `#reconcile`'s NULL-`next_at` repair is **narrowed** to `pending` rows or `waiting` rows with a timed reason, so an event-driven park is not floored to now on every startup (RFC §5.10) — and that narrowing is also why Risk 18 matters. |
| `WAKE_JOB_RETRY = { maxAttempts: 1 }` (:150)                                                                                                         | 4 internal uses                                 | Correct policy (the engine owns its own retry budget); a Lifecycle-level "my jobs are single-attempt" declaration is the separate-track cleanup.                                                                                                                                                 |
| `DISPATCH_BUDGET_MS` + both budget races + the 3 `trackAlarmWork` handoffs (:475, :519, :544)                                                        | tasks.ts only                                   | _Verdict changed from the internal inventory._ A transition is as unbounded as a step attempt, so the serial-job-loop budget is exactly as necessary after the layering as before — and it now also bounds the in-invocation re-entry loop. Keep both copies until the Lifecycle track lands.    |
| `lifecycle.runInHostContext` (:1197, :1300, routed hook)                                                                                             | tasks.ts                                        | The counter-example: one narrow Lifecycle contract applied uniformly. Nothing to do.                                                                                                                                                                                                             |
| `onError` / `#observeError` / `#failWithoutAttempt` (:1496)                                                                                          | `index.ts:1905`, 4 internal failure paths       | #2274's shape is the shape the engine inherits; `faulted` and `orphaned` reach it too. Settle it now, do not grow it later.                                                                                                                                                                      |
| `Agent.taskDefinitions` (index.ts:1326)                                                                                                              | `tests/agents/tasks.ts:16`, e2e worker ×2, docs | Genuine user surface; only its bridge changes.                                                                                                                                                                                                                                                   |

---

## 3. Consumer migrations onto the machine API

Ordered by dependency. "Needs" names the Tasks-side change each
migration is waiting on.

**1. pi harness lane driver** — `examples/next/harnesses/pi/src/harness/pi-harness.ts`
_Becomes:_ one machine per lane, addressed `pi:lane:<lane>`; an `idle`
phase parks on `ctx.receive()`, an `operating` phase drains the
submissions mailbox and returns the next lane state, `onCancel` drains
and lands back on `idle`.
_Deletes:_ the `MAX_PASSES_PER_DRIVER = 4_000` rotation and the fresh-run
handoff (:837, :862–870) — **only because §1d scopes the journal per turn
and retires the previous turn on commit**; under a run-scoped journal the
rotation would still be required at 10 000; the `list()+metadata.lane`
liveness scan (:818–822) — `tasks.get("pi:lane:<lane>")` answers
liveness, **and `tasks.view("pi:lane:<lane>")` returns the lane's
phase**; the `ENSURE_DRIVER_FN` Lifecycle rotation job; `retain:false` +
`pi:<lane>:<uuidv7>` run ids.
_Needs:_ `register()`'s handle (it registers from its own capability
constructor), `start:"queued"`, `replace:"ifSettled"` (a lane that
settles must be restartable at the same address — Risk 17), the machine
API. **Port this first** — it is the purest machine, has no public API
surface, and shakes out the machine API before anything irreversible is
committed.

**2. codex harness kernel driver** — `examples/next/harnesses/codex/src/codex-harness.ts`
_Becomes:_ a machine whose state _is_ `cf_codex_operations.checkpoint`;
`ctx.do` per effect (unchanged from `step.do`).
_Deletes:_ the `checkpoint`/`action` columns as a _separate_ store (the
engine checkpoint subsumes them; keep the table for prompt/status/
transitions); the `error.name === "AttemptSupersededError"` string catch
(:440–448); `step.status` calls that duplicate the phase name.
_Also repoints:_ `src/stress/worker.ts:106, 112` — the raw
`cf_agents_task_runs` / `cf_agents_task_steps` SELECTs behind the
`steps(operationId)` diagnostic, onto `tasks.view` plus a public
step-inspection accessor. Omitted from the original delete list; it
hard-codes five columns, and its `cf_agents_task_steps` reads stop
working outright at schema 3.
_Needs:_ `isTaskControlSignal()` export, `start:"queued"`, the machine
API. Mostly function-shaped today — it is the best existing proof the
step API carries a real agent loop, so it should keep using `ctx.do`
_inside_ its phases.

**3. self-modifying harness turn** — `examples/next/harnesses/self-modifying/src/self-modifying-harness.ts`
_Becomes:_ one machine keyed `self-modifying-turn:<turnId>`; the
attached/queued fork collapses into `run(..., { start })` +
`ctx.stream()`.
_Deletes:_ the `getByIdempotencyKey` → read-metadata-back
admission-conflict dance (:362–380); the `attached`/`queued` mode
argument (:394, :399); the prior-terminal-outcome re-emission on replay
(:432–462) — the stream cutover does it.
_Needs:_ `ctx.stream()`. Its two `runAttached` calls (:394, :399) moved
onto the handle in PR 4 with every other caller, so this port is no
longer a **gate on** the `runAttached` deletion (Risk 16).

**4. chat recovery** — `packages/agents/src/chat/recovery-task.ts`, `recovery-engine.ts` (1 041 lines), `recovery-incident.ts` (833)
_Becomes:_ the `recover` phase of the conversation machine (RFC §12a),
or — if the conversation machine has not landed — a machine keyed by
`incidentId`. `recovery-engine.ts` is already an actor written longhand —
budgets, phases, transitions, a persisted record, an abort path — behind
an adapter seam that isolates it from both hosts. It ports nearly as-is:
phases `backoff → continue → settle`, `onCancel` = give-up.
_Deletes:_ `recovery-task.ts` entirely (203 lines) —
`chatRecoveryTaskRunOptions`, `dispatchChatRecoveryToHandoff`, the
`redefer(dedupeKey)` re-enqueue loop (a completed run cannot own the next
attempt; a machine can), the "run to the handoff then detach" dance; the
incident storage record `cf:chat-recovery:incident:<id>` (→ checkpoint),
`cf:chat-recovery:progress`; the `metadata.callback`/
`metadata.recoveredRequestId` lookup index; `_enqueueChatRecovery` in
both hosts.
_Also:_ removes **8 published symbols** from the `agents/chat` barrel
(index.ts:60–68) and must repoint
`packages/think/src/tests/agents/think-session.ts:49–55`, which imports
two of them through `"agents/chat"`. This makes the PR breaking.
_Keeps:_ `cf:chat:recovering` and `cf:chat:last-terminal` (user-visible
status, not machine state).
_Needs:_ the machine API, `ctx.sleep`, `tasks.watch`, and the drain rule
of §6. Do **both hosts in one change** — they are line-for-line twins.

**5. chat turn** — `packages/agents/src/chat/turn-task.ts` + `_runChatRecoveryFiber` in both hosts
_Becomes:_ one `chat-turn` machine keyed by `requestId`, hosting root
**and** facet turns. The `timeout: "1 day"` single step that wraps a live
closure is a phase, not a journal entry.
_Deletes:_ `turn-task.ts` entirely (132 lines) —
`createChatTurnTaskDefinition`, `ChatTurnClosureEntry`,
`ChatTurnTaskHooks`, all three **published from `agents/chat` with no
`@internal` marker at all**; the `_liveChatTurnClosures` map and the
nonce scheme in both hosts; the out-of-band settle promise +
`outcome.catch(() => {})` guard; the `__cf_chat_turn_snapshot:<runId>`
storage key (an unbatched `storage.put` outside any transaction, deleted
fire-and-forget — `turn-task.ts:56,100–124`) → the checkpoint, which is
transactional by construction; the `parentPath.length > 0` fork; the
`chatFiberPrefix()` name-sniffing gate — the hook is declared at
`recovery-engine.ts:300` (on `ChatFiberWakeHooks`, :298) and the gate
itself is `:408`; the `keepAlive` hold on the turn path.
_Keeps:_ `wrapChatFiberSnapshot`/`createChatFiberSnapshot` (renamed) —
the envelope is how a replay reconstructs a dead turn.
_Needs:_ routed mailbox delivery, `ctx.stream()`, `tasks.watch`.
**Biggest single migration**; chat recovery hangs off it, so it lands
after #4. It is **not** a gate on the `runAttached` deletion — PR 4 moved
those call sites onto the handle long before this port (Risk 16).

**6. Think messenger reply** — `think.ts:4930–5024`, `messengers/chat-sdk.ts`, `messengers/delivery.ts`
_Becomes:_ the `reply` phase of the conversation machine, or one machine
per thread. Structurally identical to the chat turn.
_Deletes:_ `MESSENGER_REPLY_TASK_DEFINITION` and its 1-day single step;
the `liveReplies` closure registry;
`__cf_messenger_recovery:msgr_<nonce>` (think.ts:4950) → the checkpoint;
`startFiber`/`resolveFiber` from the `MessengerThinkHost` interface
(`chat-sdk.ts:149–154`) and the 3 `resolveFiber` calls;
`handleFiberRecovery`'s non-`persistRecoverySnapshot` branch;
`tryHandleNonChatFiberRecovery` on the recovery adapter (no implementor
left); the `FiberRecoveryContext` Think constructs by hand at
`think.ts:4957`; **both aperture call sites (think.ts:5013, 5078)** —
already repointed at `register()`'s handle in PR 4, so what this
migration deletes is the call, not the aperture.
_Renames:_ `MESSENGER_REPLY_FIBER_NAME` — **a published break on
`@cloudflare/think`'s `./messengers` subpath** (`messengers/index.ts:36`,
package.json:80), not a Think-internal rename.
_Needs:_ the machine API; the fiber ledger drain window (§6).

**7. Think's own hand-rolled machines** — the largest consumer-side deletion, and the one the inventories under-counted

| Table                                                                                                                                                                                                                   | What it is                              | Becomes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cf_think_submissions` (think.ts:10213–10240) — `idempotency_key UNIQUE`, status machine, `request_id`, `stream_id`, `messages_applied_at`, `error_message`, 3 indexes                                                  | a durable programmatic submission       | `tasks.send(runId, payload, { requestId })` onto the conversation machine — the mailbox's `ON CONFLICT (run_id, key) DO NOTHING` **is** the `idempotency_key UNIQUE` constraint, at zero rows for a duplicate. **Reduced to a query projection, not deleted outright** — the run row is _not_ the record: "submissions for request X", "oldest queued submission" and "has this submission applied its messages" are inexpressible against `TaskListOptions` (`definition`/`status`/`limit`, `created_at DESC`) plus a snapshot whose payload fields are `result`/`error`. Either §1a's widened `list()` lands first and the table goes, or a 4-column index survives. Decide in PR 12, not PR 7. **`agent-think/test/submission-status.test.ts:22` INSERTs into this table directly** and must be rewritten either way. |
| `cf_think_action_pending_approvals` (:9651) + `_emitActionPauseEvent` + `_sweepActionPendingApprovals` (:9738)                                                                                                          | a paused action awaiting a human answer | `ctx.ask(kind, payloads, { expiresIn })` + `tasks.answer(askId, kind, value)`; the sweep becomes `expires_at` folded into the parked run's wake. **Table deleted** — this is the single clearest thing asks exist for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cf_think_action_ledger` (:9348) — `key PK`, `input_hash`, status, `result_json`, sweep index                                                                                                                           | idempotent action execution             | `ctx.do(key, cb)` — but note §1d makes `ctx.do` **turn-scoped**; a ledger entry that must survive across turns belongs in the committed checkpoint or in `ctx.memo` (journal `turn = -1`), not in the turn's journal. **Table deleted** once that distinction is written into the port's docs. Also referenced by `experimental/ops-approval-agent` (README:52, `src/server.ts:125`).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cf_agent_tool_child_runs` (:8419) + `cf_agent_tool_milestones` (:8447) — status, `progress_json`, `last_signal_at` driving a resetting no-progress budget across eviction, monotonic `sequence` for replay/live dedupe | a detached agent-tool child run         | `ctx.spawn`/`ctx.join` for an owned child + `ctx.stream()` for milestones (the atomic cutover _is_ the replay/live dedupe; the no-progress budget _is_ progress Rule A plus the transition watchdog). **Both tables deleted**; the child-run→request attribution SQL at :4146–4202 goes with them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cf_think_scheduled_tasks` (:9779)                                                                                                                                                                                      | declarative cron                        | **Out of scope** — Scheduler, not Tasks. Untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

_Deletes additionally:_ `think.ts:11194–11280` (the raw-SQL probes, both
latent bugs) and the `tasks.list({ limit: Number.MAX_SAFE_INTEGER })`
scan at :11253 — **and the `listSchedules()` fallback at :11268–11281**,
whose comment ("Dynamic-agent recovery still uses root-owned routed
schedules until Tasks can mirror a child run's wake to its alarm owner")
is the _third_ live statement of a limitation #2194 removed, and the one
PR 1's original list missed.
_Needs:_ `ctx.ask`/`tasks.answer`, `ctx.spawn`/`join`, `ctx.stream()`,
`ctx.do`, `tasks.view`, widened `list()`.

**8. AIChatAgent** — `packages/ai-chat/src/index.ts`
_Becomes:_ zero direct Tasks imports. `CHAT_FIBER_NAME` becomes a
definition name (renamed).
_Deletes:_ `_registerChatTurnTaskDefinition`,
`_registerChatRecoveryTaskDefinition`, `_dispatchChatRecovery`,
`_enqueueChatRecovery`, `_runChatRecoveryFiber`,
`_handleInternalFiberRecovery`'s legacy edge.
_Falls out of_ migrations 4 + 5; no independent work.

**9. Agent's `taskDefinitions` bridge and agent tools** — `packages/agents/src/index.ts`
_Becomes:_
`new Tasks({ definitions: () => this.taskDefinitions, onRoutedMemoryLimit: …, onError: … })`
— one constructor call, no WeakMaps, no imports of the two setters at
:174–175. `taskDefinitions` widens from `TaskHandlers` to
`TaskDefinitions` (index.ts:1326), and the cast at :1931–1935 widens
correspondingly.
_Deletes:_ `setTaskDefinitionResolver` (:1931–1935) and
`setTaskRoutedMemoryLimitHandler` (:1912–1919) call sites.
_Note:_ Agent-side agent tools (`packages/agents/src/agent-tools.ts`,
`chat/agent-tools.ts`) have **no** Tasks coupling today (verified: zero
hits). They _gain_ one when Think's detached child runs become spawned
child machines — a new capability, not a migration.
_Needs:_ the thunk `definitions` option only. **Deletable today**,
independent of everything else.

**10. `examples/next/tasks` and `examples/next/streams`**
_Becomes:_ unchanged. These are the regression test for "did we keep the
shape". The streams example's "resume from the stream cursor after
interruption" is the load-bearing proof of the step API and must keep
passing byte-for-byte through the engine cutover.
_Deletes:_ nothing. `step.status` and `step.idempotencyKey` both survive.

**11. `agent-think`** — the workspace package the inventories omitted
_Becomes:_ a consumer of whatever §3.7 decides about
`cf_think_submissions`.
_Needs:_ nothing of its own; it must simply be in PR 12's file list,
which it was not.

**12. `flue` and other out-of-repo consumers**
_Not in this repo._ Constrained only by the published surface. It is
affected by exactly six things: the **9** root-entrypoint fiber type
removals; the `runFiber`/`startFiber`/`onFiberRecovered`/`stash()`
deprecations; the **two** `__DO_NOT_USE_WILL_BREAK__` start-aperture
removals (`tasks/tasks.ts:672`, `:694`; `cleanupRoutePrefix` at `:895`
is in the same published `.d.ts` regardless of the `@internal` tag, but
survives — §2, RFC §5.11);
the `MAX_SERIALIZED_BYTES`/`TaskDurationUnit` export removals; the **11
`agents/chat` Task exports**; and the `fiber:*` observability union
members plus the `fiber` group type (which degrades to `never` rather
than erroring). Survey before the deprecation PR — and before PR 4 for
the two aperture removals, which now land there rather than at the
deprecation. flue's own coordinator
is the fourth harness-shaped machine (RFC §12c) and gets a published
migration guide, not a vendored port.

---

## 4. Sequenced PR plan

Breaking changes are allowed (`agents/tasks` is experimental) but each
one is named — and note that **the root `agents` entrypoint and the
`agents/chat` subpath are not experimental**, so breaks there need the
deprecation-then-delete treatment, not a changeset line. "Blocked on"
names the gate.

**PRs 7, 8 and 9 are one release** with one changeset (the RFC's §14.7);
they are three PRs only so the engine, the mailbox/ask surface and the
routed paths can be reviewed separately. Everything after PR 9 is a
consumer migration on a shipped engine.

_RFC override, deliberate:_ the RFC's §14.4 counts its items 1, 4 and 6
(engine / `handle()` + `at()` / facet parity) as **three** releases, each
with its own green suite. They are one release here because the machine
API is unusable without a mailbox to park on and unusable on a facet
without routed delivery — shipping item 1 alone would publish a feature
nobody can call, and shipping item 4 alone would publish a typed handle
whose verbs have no implementation. The RFC's _ordering_ is preserved
exactly; only the changeset boundary moves. The RFC's §14.4 item 5
(`pushSync`/`cancelSync`, `onCommit`) is not in this sequence at all
because it **already landed** on the branch at commit `785a68dd` — see
the note under PR 7.

**PR 0 — #2274 lands, with two amendments.** _Not folded into the
replacement._
Every member it adds survives verbatim onto the machine API
(`ctx.signal`, `ctx.attempt`, the run deadline, the abort-owns-the-
outcome semantics), and it is the smallest version of that surface.
Folding it in would delay the engine by its review cost and strand the
deadline/abort semantics the machine API is built on. Amendments before
merge: (a) cut the docs line that frames `step.signal` as a licence for
body-held work — it is the actor use case and the machine API is its
home; (b) tighten the `step.attempt` JSDoc's "not the counter a run's
`interruptions` bounds" wording so nothing downstream reads
`attempt > 1` as interruption evidence (Risk 21).
_Struck: the `retries` → `interruptions` /
`TaskAttemptsExhaustedError` → `TaskInterruptionsExhaustedError` rename
was the third amendment and is **already done** — `f28ffc2f`, the commit
this plan pins as its base, renamed the code and
`docs/agents/tasks.md` in one diff. Correction 3 above records it._
_Tests:_ as written. _Changeset:_ the existing
`.changeset/tasks-attempt-budget.md`, already edited for the rename in
`f28ffc2f`. _Breaking:_ no (unreleased surface).

**PR 1 — Correct the record. Docs only, no code.**
Stale-limitation sites — **six, and three of them are live code
comments**: `docs/agents/tasks.md`'s `## Current limits` (:283–291),
`design/rfc-fibers.md:190–192` ("Runs on routed sub-agents (facets) …
facet chat turns stay on the legacy fiber engine until then"),
`packages/agents/CHANGELOG.md:285`'s 0.23.0 note ("facet-hosted turns
stay on the legacy engine until routed Fibers land"), the two twin
comments (`packages/ai-chat/src/index.ts:808–810`,
`packages/think/src/think.ts:5045–5047`), **and
`packages/think/src/think.ts:11268`** ("Dynamic-agent recovery still uses
root-owned routed schedules until Tasks can mirror a child run's wake to
its alarm owner"). All six say facet work stays on the legacy engine;
routed dispatch landed in #2194.
_Not in this list:_ `design/sub-agent-routing.md:156–160` was previously
counted here and does not belong. It reads "`runFiber()` works on facets.
Fiber rows and snapshots live in the child SQLite database, while the
root parent keeps a small index of active facet fibers…" and "Think chat
recovery works on facets" — a _description of legacy-fiber facet
support_, and of the facet-run index PRs 15/16 remove, not a claim that
Tasks cannot run there. It is a PR 15/16 doc update, and it is listed
there.
Also correct `design/rfc-fibers.md` where it is the design-of-record for
four things later PRs delete or reshape, none of which scheduled a doc
edit: `setTaskDefinitionResolver` (:117), `Tasks#register` (:122), the
`__cf` reserved-name policy (:126–127), `runAttached` (:127), and the
two-table description (:107). Same for
`design/rfc-codex-harness-capability.md:602`'s `tasks.register(DRIVER, …)`
sample.
_Correction to the original PR 1:_ **do not "delete the duplicate doc
`packages/agents/docs/tasks.md`".** That path is a **generated build
artifact** — `.gitignore:95` ignores `packages/*/docs`, and
`packages/agents/package.json:414–419` declares an nx build input of
`{workspaceRoot}/docs/agents/**/*` plus `scripts/copy-package-docs.ts`
with output `{projectRoot}/docs`. It is 246 lines (not 32), and `diff`
against `docs/agents/tasks.md` shows the delta is exactly #2274's
additions — i.e. it is a stale copy from a pre-#2274 build that
regenerates on the next `build`. Deleting it is a no-op that returns, and
repointing the README at the site doc would break the packaged docs that
ship in the tarball (`package.json:400` lists `"docs"` in `files`). Edit
`docs/agents/**` only; the package copy follows.
_Blocked on:_ nothing. _Breaking:_ no.

**PR 2 — Lift the facet gate.** Port
`e2e-tests/fiber-eviction.test.ts:447` ("recover a sub-agent runFiber
after process kill via the parent alarm") onto a Tasks routed run; then
delete both `parentPath.length > 0` blocks (`ai-chat:811–812`,
`think:5048–5049`).
_Why here:_ it proves routed dispatch carries a real chat turn before the
machine API depends on it, and it removes the last **production** caller
of `_runFiberWithStashWrapper` in `packages/`.
_Correction to the original PR 2's payoff claim:_ this does **not** make
`_runFiberWithStashWrapper` dead in `packages/`, and it does not unblock
~1 300 lines of deletion independently of the engine schedule. Four live
call sites remain: `packages/agents/src/tests/agents/run-fiber.ts:440,
470, 505` and `packages/ai-chat/src/tests/worker.ts:3362–3403`, which
monkey-patches the method by saving and restoring the original. Those
test agents are rewritten in PR 15. The _same block_ also monkey-patches
`runAttached` (`worker.ts:3374–3404`); that half cannot wait for PR 15,
because PR 4 deletes the method it patches — **PR 4 repoints it**, and
only the `_runFiberWithStashWrapper` half is left here.
_Tests:_ add the ported e2e; delete nothing yet. _Breaking:_ no.
_Blocked on:_ PR 1 (so the published limitation and the behaviour stop
disagreeing).

**PR 3 — `register()` returns a handle; `start` becomes public.**
_(Rewritten twice. The original PR 3 deleted the `__cf` gate and renamed
`register()` to `define()`; the RFC keeps both, so this PR lands the
handle instead. The apertures were briefly to become deprecated wrappers
here; they are now deleted outright, with their callers, in PR 4.)_
`register(name, def)` returns `TaskInternalHandle { name, run(input,
options) }`, implemented over the existing `#acceptReserved` **plus** the
aperture's drive-and-await tail (`if (receipt.accepted) await
this.#executeRun(receipt.runId)`, tasks.ts:681–683) — `#accept` itself
branches only on `start: "warm"` (tasks.ts:1168), so forwarding the mode
alone would silently degrade `attached` to `queued` (§2);
`TaskRunOptions.start: "warm" | "queued" | "attached"` becomes public for
non-reserved names. `register()` is promoted from "do not use" to
documented `@internal`. The apertures are untouched here — there is no
deprecation window, because their callers move in the same PR that
removes them.
_Why the old ordering trap is gone:_ public `run()` still refuses
`__cf`-prefixed names (`#validateDefinitionName`, tasks.ts:317–320) and
**every** production aperture caller passes one — but the replacement is
now the handle, which accepts reserved names by construction, so nothing
has to be un-gated first (Risk 15 reverses).
_Also here, because PR 4 needs it:_ a `protected` accessor on
`AIChatAgent` and `Think` that hands a subclass the chat-recovery handle.
The base class registers `__cf_internal_chat_recovery` from a private
method (`ai-chat/src/index.ts:732`, `think.ts:4870`), and once the
apertures are gone a subclass has **no** route to a reserved definition
it did not register itself: public `run()` rejects `__cf`
(tasks.ts:317–320), `tasks.handle(name)` runs the same
`#validateDefinitionName` first (tasks.ts:390–393) and rejects it too,
and re-calling `register()` throws "already registered"
(tasks.ts:360–363). Any one of three shapes closes it — the protected
accessor, `register()` returning the existing handle for an
already-registered name, or an internal `handleReserved(name)` — and one
of them must land here, because PR 4's four subclass call sites
(`ai-chat/tests/worker.ts:2549, 2565`; `think-session.ts:8185, 8220`)
have nothing to call without it.
_Tests:_ `capability.test.ts:68–73, 100–104, 126, 954` keep their
validation branches; add a handle round-trip, a `start:"queued"` case on
a non-reserved name, and an attached case proving the handle's `run`
resolves only after the first attempt reaches its durable boundary.
_Breaking:_ no (additive).
_Blocked on:_ nothing.

**PR 4 — Move the aperture call sites, and delete both apertures.**
_(Folds in the first half of the original PR 14; the deletion is no
longer a follow-up.)_ Three destinations for the moves: two chosen by
whether the name is reserved, and one for the reference that patches an
aperture instead of calling it.

Onto `handle.run(input, { start })`, because the name is `__cf`-prefixed:
the five production callers (`think.ts:4922, 5013, 5078`,
`ai-chat/src/index.ts:784, 841`), the three harnesses (pi:824, codex:257,
self-modifying:394, :399), `capability.test.ts:127`
(`runAttached("__cf_test_registered", …)`), `think-session.ts:8185, 8220`
and `ai-chat/tests/worker.ts:2549, 2565, 3532`. Four of those are **not**
the like-for-like edit Risk 16 describes: `ai-chat/tests/worker.ts:2549,
2565` (`ChatRecoveryTestAgent extends AIChatAgent`, worker.ts:1816) and
`think-session.ts:8185, 8220` (`ThinkRecoveryTestAgent extends Think`,
think-session.ts:6643) all start `CHAT_RECOVERY_TASK_NAME`
(`__cf_internal_chat_recovery`), which their **base** class registered
privately — they reach a handle only through PR 3's protected accessor,
and this PR is blocked on it.

Onto the same handle but by _patching_ rather than calling it:
`ai-chat/tests/worker.ts:3374–3404`, the `simulated runFiber failure`
e2e, which saves `__DO_NOT_USE_WILL_BREAK__runAttached` off `this.tasks`,
replaces it with a thrower and restores it in `finally`. Repoint it at
the registered handle's `run` (save/replace/restore `handle.run`, or stub
the internal start path the handle wraps). The access goes through
`this.tasks as unknown as { __DO_NOT_USE_WILL_BREAK__runAttached:
RunAttached }`, so **`tsc` will not catch the deletion** — the e2e
instead fails at runtime on
`originalRunAttached = tasksInternal.__DO_NOT_USE_WILL_BREAK__runAttached.bind(…)`
with "Cannot read properties of undefined". This is one block of PR 15's
`ChatRecoveryTestAgent` rewrite pulled forward; the
`_runFiberWithStashWrapper` half of the same block stays in PR 15.

Onto public `run(name, input, { start: "queued" })`, because the name is
_not_ reserved and is declared in the harness `definitions` map: **all
eight `enqueue` test sites** — `memory-limit.test.ts:189` `twinLateOom`,
`:229` `oomBeforeCleanSibling`, `:277` and `:380` `lateOomStepLoop`,
`:347` `lateSuccess`, `:606` `sleeper`, and `capability.test.ts:328`
`pipeline`, `:830` `exhaustedPlatformStep`. Sending these through the
internal handle would be busywork _and_ would lose the coverage that
public `start:"queued"` works, which is the point of making it public
(RFC §3.10 states the same eight).

Then delete `__DO_NOT_USE_WILL_BREAK__runAttached` and
`__DO_NOT_USE_WILL_BREAK__enqueue` in the same diff. The three
destination lists above are the whole tree: the **27** in-repo references
that `grep -rn "__DO_NOT_USE_WILL_BREAK__runAttached\|__DO_NOT_USE_WILL_BREAK__enqueue"
--include="*.ts" packages examples` returns, minus the two declarations
in `tasks/tasks.ts` itself. The one easy to miss is the
`worker.ts:3374–3404` patch, which does not _call_ either method and
which the compiler cannot flag.
_Tests:_ the moved sites, plus the two aperture coverage cases
re-pointed at their replacements. _Breaking:_ **yes** — both are in the
published typings (`runAttached` `tasks/tasks.ts:672`, `enqueue` `:694`),
so the survey note for external consumers rides here (Risk 13).
_Changeset:_ minor — and it is the RFC's §14.7 text, not a second file:
PR 4 and PRs 7–9 are one release, and §14.7's **Removed** paragraph
carries the migration rule for these two.
_Blocked on:_ PR 3 (the handle **and** its protected chat-recovery
accessor), and the external-consumer survey of §3.12 item 12 / Risk 13 —
`flue` included — for the two published-typing removals.

**PR 5 — Constructor-shaped composition.** `TasksOptions.definitions`
accepts a thunk; `TasksOptions.onRoutedMemoryLimit` added; delete
`setTaskDefinitionResolver`, `setTaskRoutedMemoryLimitHandler`, both
WeakMaps, and the `TaskDefinitionResolver` type. Rename
`FIBER_SCHEMA_VERSION_KEY`/`CURRENT_FIBER_SCHEMA_VERSION` identifiers
(persisted key string unchanged).
_Tests:_ rewrite `tasks/agent.test.ts:37` ("runs subclass
`taskDefinitions` with journaled steps and host context") — the file has
four tests (`:37, :54, :66, :106`) and none is named "resolved lazily".
_Breaking:_ no (neither setter is re-exported from `agents/tasks`;
`design/rfc-fibers.md:117` corrected in PR 1). _Blocked on:_ nothing.

**PR 6 — Surface trim, parity polish, and the first deprecation wave.**
Delete the `MAX_SERIALIZED_BYTES` export and the `TaskDurationUnit`
export. Export `isTaskControlSignal(error)` and document "a broad `catch`
must re-throw control signals"; repoint `codex-harness.ts:445` off the
magic string. Add `month`/`year` to `TaskDurationString`; add the
`NonRetryableError(message, name?)` overload. Widen `TaskListOptions`
(metadata filters, ordering) and `TaskDeleteOptions` (`runId`).
_Changed from the original:_ `step.idempotencyKey` is **not** deleted —
the RFC keeps it and gives it a scope rule, and the
`docs/agents/tasks.md:154` row stays.
**Also:** mark `@deprecated` the 11 `agents/chat` Task exports
(index.ts:54–68) and the 9 root fiber types, pointing at their
replacements. Deprecating on a stable entrypoint one release ahead of
deletion is what turns PRs 10/11/14 from silent breaks into announced
ones.
_Tests:_ `tests-d/tasks-export.test-d.ts` updated; add a control-signal
predicate test; add `list()`/`delete()` filter tests. _Breaking:_ **yes**
(two `agents/tasks` export removals; deprecations only elsewhere).
_Blocked on:_ nothing.

**PR 7 — The engine.** The machine API lands behind the existing `Tasks`
class; the step API is recompiled onto it as a single-phase machine.
`replay.ts` becomes the compiler (`TaskContextImpl`, with `ReplayStep` as
a deprecated alias). Storage schema 2.5 → 3 (§6). `#wakeOutcome`
collapses into the wake port. Lands, specifically and by name: the
**turn-scoped journal** in its own table (Risk 10), `ctx.interrupted`
(Risk 21), progress Rule A **and** Rule B, the default
`interruptionBackoff` (Risk 18), `tasks.view()` carrying the checkpoint
(Risk 19), `TaskRunOptions.replace` (Risk 17), `orphaned` + `reopen()`
for an unresolvable definition (Risk 23), the abort fence (Risk 22).
_Tests:_ every existing `tests/tasks/*`, `tests/capabilities/tasks.ts`,
`tests/streams/capability.test.ts:535–602`, and both e2e eviction suites
must pass **with only three of the four mechanical edit classes of the
RFC's §3.10** (the fourth, the aperture call-site moves, already landed
in PR 4) — that is the acceptance criterion for "existing step-API
consumers keep working", **with three named exceptions that bypass the
engine by construction and need engine-level equivalents written first**:
`packages/think/src/tests/agents/think-session.ts:91, 112, 123, 128,
8237` (raw SELECT/UPDATE on both tables, including backdating
`cf_agents_task_steps.next_at`) and
`examples/next/harnesses/codex/src/stress/worker.ts:106, 112`. Add the
machine contract tests of the RFC's §14.5.
_Sibling capabilities:_ **nothing to schedule.**
`LifecycleJobs.pushSync`/`cancelSync` (`lifecycle/job-queue.ts:130,140`,
`lifecycle/durable-object-lifecycle.ts:760,765`) and
`StreamWriter.onCommit` (`streams/types.ts:108`, `streams/streams.ts:561`)
— which the RFC's §9.2 makes the stream/checkpoint atomic cutover depend
on, `pushSync` existing precisely because the wake re-arm cannot run
inside `storage.transactionSync` — **already landed** on this branch at
commit `785a68dd`, with `docs/agents/lifecycle.md`,
`docs/agents/streams.md` and the changesets
`.changeset/lifecycle-jobs-push-sync.md` and
`.changeset/streams-writer-on-commit.md`. PR 7 consumes them and **must
not re-publish either changeset**; the RFC's §14.3 and §14.4 step 5 are
marked landed for the same reason.
_Changeset:_ minor. _Breaking:_ the two type changes of the RFC's §14.7
(`TaskWaitReason` widening, optional `wakeAt`); the largest behavioural
risk in the plan. _Blocked on:_ PRs 3, 4, 5 and 6 — the shape changes the
engine is built on top of. **PR 4 is now among them.** With the apertures
deleted rather than wrapped, the engine cannot be built under their old
shape, and the RFC's §14.4 step 1 no longer ships "with no consumer
changes": its steps 1 and 2 are one release here, in the order handle
(PR 3) → call sites and deletion (PR 4) → engine (PR 7).

**PR 8 — Mailbox, asks and observation surface.** `tasks.send`/
`sendEvent`/`withdraw`/`answer`/`asks`/`withdrawAsk`/`view`/`watch`/
`pause`/`resume`/`terminate`/`reopen` on the capability;
`tasks.at(name, runId)`; `defineAsk`/`AskKind`/`Pending`;
`step.waitForEvent(name, {type, timeout})` compiled onto a journaled
single-shot receive; `TaskWaitReason` gains its five new values.
_Tests:_ one-shot vs loop boundary; a `waitForEvent` timeout throwing
where a machine `within` returns `ctx.timedOut`; the mailbox, ask and
observation suites of the RFC's §14.5. _Breaking:_ no (additive).
_Blocked on:_ PR 7.

**PR 9 — Routed parity.** `onRoute` gains `mailboxPush`, `answer`,
`childSettled`, `abortCascade` and `view`; the `cf_agents_task_routes`
owner index; routed stream cutover; the facet-side dispatch budget;
`cleanupRoutePrefix`'s extended contract. This is the gate for
facet-hosted machines.
_Tests:_ extend the `ai-chat/src/tests/worker.ts` facet fixtures with a
routed `send`, a routed `answer` **on a run parked with no wake at all**
(the §4.5 regression), and a routed cascade. _Breaking:_ no.
_Blocked on:_ PRs 7, 8.

**PR 10 — Chat recovery onto the machine API.** Delete
`recovery-task.ts`; port `recovery-engine.ts` + `recovery-incident.ts`;
both hosts in one change. Remove the 8 recovery exports from
`packages/agents/src/chat/index.ts:60–68` and repoint
`packages/think/src/tests/agents/think-session.ts:49–55`. Rename
`FiberRecoveryContext`/`FiberContext`/`ChatFiberWakeHooks`/
`chatFiberPrefix` off the fiber vocabulary (with root-entrypoint aliases;
the two DTOs are published there). Apply the drain rule of §6: the
original step definition stays registered, unmodified, until its rows
settle.
_Tests:_ rewrite `chat/__tests__/recovery-task.test.ts`,
`recovery-engine.test.ts`, `recovery-cutover.test.ts`; **rewrite the e2e
row-count probes** (`ai-chat/src/e2e-tests/worker.ts:94–99, 327–332` and
a dozen in `think/src/e2e-tests/worker.ts`) that sum
`cf_agents_runs + cf_agents_task_runs` — they will otherwise pass
vacuously.
_Breaking:_ **yes** — 8 symbols removed from the stable `agents/chat`
subpath (deprecated in PR 6). _Changeset:_ required. _Blocked on:_
PRs 6, 9.

**PR 11 — Chat turn onto the machine API.** Delete `turn-task.ts`,
`_liveChatTurnClosures`, the nonce scheme, the
`__cf_chat_turn_snapshot:` key, the `chatFiberPrefix` gate. Remove the 3
turn-task exports from `chat/index.ts:54–58`. Keep the snapshot envelope
(renamed).
_Tests:_ re-point the #1406 regression (`ai-chat/src/index.ts:3286` —
cleanup when turn _setup_ throws) at the new start path rather than
deleting it; the hazard survives the migration.
_Breaking:_ **yes** — 3 symbols removed from the stable `agents/chat`
subpath, none of which ever carried an `@internal` marker (deprecated in
PR 6). _Changeset:_ required. _Blocked on:_ PR 10.

**PR 11.5 — Rewrite the teaching surface first.** _Expanded: the
original list named 3 of 11 doc pages and 5 of 11 example/experimental
surfaces._
Code: `examples/playground/src/demos/durable/` and
`examples/chat-sdk-messenger` onto Tasks; `experimental/forever-fibers`,
`pi-recovery`, `tanstack-recovery` onto the machine API or deleted;
`experimental/ops-approval-agent` (README:52, `src/server.ts:125`, both
pointing at `cf_think_action_ledger`, deleted in PR 12).
`examples/deploy-churn`: the `hasFiberRows` probes (`src/server.ts:527,
931`) **and the two places the result is rendered and reported** —
`src/client.tsx:63, 293–294` (a labelled UI tile flagged `danger`) and
`scripts/deploy-rollback.ts:84, 200` / `scripts/churn.ts:87, 389, 438,
524, 672, 753`. A re-pointed probe alone leaves a dashboard reading
"Orphaned fiber rows: no" for a reason that no longer exists.
Docs — **all eleven pages that teach
`runFiber`/`startFiber`/`stash()`/`onFiberRecovered`/
`FiberRecoveryContext`**, every one of which ships inside the npm tarball
via the nx docs copy: `docs/agents/agent-class.md` (a dedicated
`### this.runFiber and this.startFiber` API-reference section at :407,
plus :412, :432, :436), `docs/agents/webhooks.md:426–428`,
`docs/agents/long-running-agents.md:205`,
`docs/agents/durable-execution.md`, `docs/agents/index.md`,
`docs/agents/chat-agents.md`, `docs/agents/sub-agents.md`,
`docs/agents/server-driven-messages.md:54`, `docs/think/index.md:330,
346, 352`, `docs/think/workflows.md:212`,
`docs/think/programmatic-submissions.md:158, 163, 169, 172`,
`docs/think/sub-agents.md:357, 379`, plus `packages/think/README.md` and
`examples/think-submissions/README.md:87` (which _recommends_
`startFiber()`). Also `docs/agents/observability.md:32`'s `agents:fiber`
channel row.
Split `keepAlive` out of `docs/agents/durable-execution.md` (:50–95) into
its own home before retiring the rest of that page.
_Why before the deprecation release:_ a deprecation warning that fires in
the shipped playground demo, or an API-reference section that still
teaches the deprecated call, is worse than the deprecation.
_Breaking:_ no.

**PR 12 — Messenger replies + Think's hand-rolled machines.** Migration
items 6 and 7 of §3. Delete `cf_think_action_pending_approvals`,
`cf_think_action_ledger`, `cf_agent_tool_child_runs`,
`cf_agent_tool_milestones`; resolve `cf_think_submissions` per §3.7;
delete `think.ts:11194–11280` **including the `listSchedules()` fallback
at :11268–11281**; drop `startFiber`/`resolveFiber` from
`MessengerThinkHost`; remove **both** `runAttached` call sites
(think.ts:5013, 5078).
_Tests:_ `think/src/e2e-tests/worker.ts:1934` (`startReplyFiber`)
rewritten; `messengers.test.ts:1144`'s throwing stub deleted;
**`packages/think/src/e2e-tests/messenger-recovery.test.ts`** rewritten —
omitted from the original list, and it is the SIGKILL-level proof that a
messenger reply survives process death, the direct analogue of the
`fiber-eviction.test.ts:447` acceptance test the plan treats as a gate
elsewhere; submission/approval/action-pause/agent-tool suites rewritten
against the machine; **`agent-think/test/submission-status.test.ts`**
rewritten (workspace package, omitted entirely from the original plan).
_Breaking:_ **yes, two counts the original accounting missed** —
`MESSENGER_REPLY_FIBER_NAME` is published from `@cloudflare/think`'s
`./messengers` subpath, and the Think table drops are user-visible to
anyone reading them (see §6). _Blocked on:_ PRs 8, 11.

**PR 12a — Think's remaining in-memory machinery, one structure per PR.**
_Added: the RFC's §14.4 step 9 is a release of its own and the earlier
sequence scheduled only two of its eight structures._ `_liveChatTurnClosures`
goes with the chat turn (PR 11) and `liveReplies` with the messenger
reply (PR 12); the other six have no home yet and each is a live
in-memory replacement for something the checkpoint now holds:
`TurnQueue` and `SubmitConcurrencyController` (→ the mailbox plus the
`idle`/`turn` phase and a `send` policy, §1a and RFC §7.7),
`AbortRegistry` (→ `ctx.signal` plus the abort mark), `PreStreamTurns`
and `AutoContinuationController` and `ContinuationState` (→ the
`turn`/`approval` phases re-entering the same run, with no continuation
turn and no debounce barrier, RFC §8.4). Ship them **one structure per
PR, with Think's suite green at each step** — the rule the RFC states,
and the reason this is a sub-list rather than one commit: each of the six
is an independent in-memory invariant and a combined diff makes a
regression unbisectable. `§12(a)`'s "what disappears" list is the
checklist; it is done when all eight are gone.
_Breaking:_ no (all six are private to `packages/think`).
_Blocked on:_ PR 11 (which lands the first of the eight).

**PR 13 — Harnesses onto the machine API.** pi, codex, self-modifying
(§3 items 1–3), including the codex stress worker's raw SQL. Doubles as
the machine-API migration guide, and the flue guide is written from it.
_Breaking:_ example code only. _Blocked on:_ PR 9. _(Note: the pi port
should be prototyped against PR 7 before PR 7 merges — Risk 25.)_

**PR 14 — The fiber deprecation release.** _(The aperture deletion that
was this PR's first half is folded into PR 4; `runAttached` and `enqueue`
are long gone by the time this lands.)_ Mark `@deprecated`: `runFiber`,
`startFiber`, `onFiberRecovered`, the 7 inspection/control methods, the 3
`fiberRecovery*` static options, the 9 `fiber:*` events, the `fiber`
observability group type, `stash()`, and the 9 root-entrypoint fiber
types.
_Why the apertures did not wait for it:_ the original plan's PR 12
deleted `runAttached` before the messenger reply (`think.ts:5013, 5078`)
and the self-modifying harness (`:394`) migrated, and neither declared it
as a gate. The fix is not a later deletion but a like-for-like move onto
`register()`'s handle in PR 4, which needs neither migration (Risk 16).
_Breaking:_ no — deprecations only, now that the aperture removals sit in
PR 4. _Changeset:_ minor, with the survey note for external
consumers, enumerating the remaining published-surface changes from §3.12.
_Blocked on:_ PRs 11, 11.5, 12, 13.

**PR 14a — Public `define(name, definition)`.** The composition-registry
need the RFC deferred: a public, prefix-free way for a capability
constructed separately from the `Tasks` instance to contribute a
definition, which is what all three example harnesses actually want. It
carries Risk 2's trade — a shared definition namespace with no reserved
half — so it is its own decision, landed after the apertures are gone and
`register()` is the only internal path left. May be folded into PR 14 if
the trade is accepted then. _Blocked on:_ PR 14.

**PR 15 — Delete the fiber engine.** Agent schema drops `cf_agents_runs`
and `cf_agents_fibers` + indexes (**not `cf_agents_facet_runs` in the
same step — §6, Risk 24**). Delete ~1 300 lines (index.ts:388–514,
1608–1668, 3462–4611, 4646–4766), `_cf_checkRunFibersForFacet`,
`DynamicAgents.checkRunFibers`/`checkRunFibersAtPath`,
`dynamic-agents/host.ts:64,71`, the `cf:housekeeping` job, the `fiber:*`
event arms in `observability/agent.ts:105–177`, the `fiber` group type at
`observability/index.ts:70`, the `agents:fiber` channel, the 9 root type
exports, and the fiber test suites.
_Test budget — the original "~3 100 lines" counted only
`packages/agents/`._ Add Think's own fiber test surface, which drives the
private `_checkRunFibers` scan through casts:
`packages/think/src/tests/agents/fiber.ts:91–92`,
`packages/think/src/tests/fiber.test.ts`, four more `_checkRunFibers()`
drivers in `packages/think/src/tests/agents/think-session.ts:2195, 2210,
4959, 7911, 7928` (one of which hand-inserts a fiber-ledger row to make
the scan find it interrupted), and
`packages/think/src/e2e-tests/messenger-recovery.test.ts`. Also
`packages/agents/src/tests/agents/run-fiber.ts:440, 470, 505` and
`packages/ai-chat/src/tests/worker.ts:3362–3403` (the
`_runFiberWithStashWrapper` monkey-patch), which PR 2 does **not** clear.
The `runAttached` half of that same block (`worker.ts:3374–3404`) is
**not** waiting here: PR 4 repoints it, because PR 4 deletes the method
it patches.
_Keep:_ the poison-row-aging and scan-deadline scenarios, re-pointed at
the engine's progress rules and default `interruptionBackoff`, and
`sub-agent.test.ts:1231` (stale-lease pruning) for the drain window.
_Docs:_ `design/sub-agent-routing.md:156–160`'s two bullets — "`runFiber()`
works on facets. Fiber rows and snapshots live in the child SQLite
database, while the root parent keeps a small index of active facet
fibers…" and "Think chat recovery works on facets" — describe the engine
and the facet-run index this PR deletes, so they are rewritten here (not
in PR 1, where they were previously and wrongly counted as a stale Tasks
limitation). The facet-run-index sentence survives one more release and
goes with PR 16.
_Breaking:_ **yes, major.** _Blocked on:_ PR 14 plus one full release of
drain (§6).

**PR 16 — Drop `cf_agents_facet_runs`.** One release after PR 15, when
every reader is gone. See Risk 24. Finish
`design/sub-agent-routing.md:156–160` here: the "root parent keeps a
small index of active facet fibers" clause is the last reader's
documentation.

**What is deletable today, before anything else lands:** PRs 1, 2, 5, 6 —
the record correction, the facet gate, both WeakMap apertures, the two
zero-caller exports, and the first deprecation wave; plus PR 3's
additive handle and PR 4, which moves every aperture call site and
deletes both start apertures behind it. That is the whole "framework
apertures the layering makes unnecessary" bucket, the two start apertures
included. **One qualification:** PR 4 is the only member of this bucket
with an external precondition — the consumer survey of §3.12 item 12 /
Risk 13 runs before it, because both removals are in the published
typings. Everything else here is unconditional.
**Only after the engine ships (PRs 7–9):** every consumer migration.
**Only after each consumer migrates:** the fiber engine (PR 15, after 14

- drain), `cf_agents_facet_runs` (PR 16), Think's tables (PR 12, after
  8 + 11), Think's eight in-memory structures (PRs 11, 12 and 12a, one
  structure per PR).

---

## 5. Legacy fibers: removal path and its gate

**The stated blocker is stale, and that is the whole story.** Both hosts
carry a byte-identical comment saying "the Tasks capability does not
accept runs on routed sub-agents yet". Commit `6da4c44b` (#2194) — the
same commit that merely _renamed_ that comment from "Fibers" to "Tasks" —
added full routed support: `#syncWake` branches on
`lifecycle.routes.source` and mirrors to the root via
`routes.toRoot({type:"syncWake"})` (tasks.ts:794–802); `#syncRoutedWake`
(tasks.ts:856) pushes the mirror job; `onJob` dispatches back into the
owning facet on `timing?.owner_path`; `onRoute` (tasks.ts:828) handles
all three messages; `cleanupRoutePrefix` (tasks.ts:895) cancels a deleted
subtree's mirrors. The sibling call in the _same method_,
`_enqueueChatRecovery` (`ai-chat:777–787`), already runs on Tasks on
facets with no gate at all. The comment's second clause ("facet recovery
routes through the root's facet-run index") is stale too:
`_handleInternalFiberRecovery` reads only the passed
`FiberRecoveryContext`, local storage and local streams.

So lifting the gate is verification, not construction.

**Removal path:**

1. **Correct the published record** (PR 1) — all **six** sites:
   `docs/agents/tasks.md:283–291`, `design/rfc-fibers.md:190–192`,
   `packages/agents/CHANGELOG.md:285`, `ai-chat/src/index.ts:808–810`,
   `think.ts:5045–5047`, and `think.ts:11268`'s `listSchedules()`
   fallback comment, which asserts the same removed limitation and is
   also a live code path PR 12 deletes. (`design/sub-agent-routing.md`
   is **not** among them — see PR 1.) Shipping a limitation that no
   longer exists is the current worst state.
2. **Port the acceptance test** — `e2e-tests/fiber-eviction.test.ts:447`
   is the only SIGKILL-level proof that facet-hosted durable work
   survives process death via the root alarm. Port it onto a Tasks routed
   run. _This is the gate._
3. **Delete the two gate blocks** (PR 2). `_runFiberWithStashWrapper`
   loses its last _production_ caller in `packages/`; four test call
   sites remain (`run-fiber.ts:440, 470, 505`;
   `ai-chat/tests/worker.ts:3362–3403`), so the ~1 300-line deletion is
   **not** unblocked here — it waits on PR 15's test rewrite. (That
   block's `runAttached` patch, `worker.ts:3374–3404`, moves earlier, in
   PR 4.)
4. **Rewrite examples and docs** (PR 11.5), **deprecate** (PR 14),
   **drain one release**, **delete** (PR 15), **drop the last table**
   (PR 16).

**The gate for the machine API specifically — and it is a different
gate.** "A machine must run on facets" needs four routed capabilities,
only one of which exists:

| Routed need                                                               | Status                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a routed run's wake mirror                                                | **Exists** (#2194) — this is what PR 2 verifies                                                                                                                                                      |
| routed mailbox delivery (`tasks.send`/`sendEvent` into a facet-owned run) | **Does not exist.** `onRoute` has three message types; `mailboxPush` must be added — PR 9                                                                                                            |
| routed answers, child settlement and abort cascade                        | **Do not exist** — PR 9, plus the `cf_agents_task_routes` owner index, because a facet run parked on an ask with no expiry has its wake mirror cancelled by design and would otherwise be unroutable |
| routed stream cutover (`ctx.stream()` across the facet boundary)          | **Does not exist** — PR 9                                                                                                                                                                            |

That means the fiber deletion gate (PR 2, verification only) and the
facet-hosted-machine gate (PR 9, construction) are independent, and the
fiber removal should **not** wait for the second. Doing PR 2 early is what
decouples them.

**Three things a `grep -i fiber | delete` sweep would break, all
load-bearing on the _new_ path:** `_handleInternalFiberRecovery` (passed
as `handleRecovery` into the Tasks turn-task adapter at ai-chat:721,
think:4859); `stash()`/`_withFiberStash`/`_fiberALS` (its own comment
says it exists so `this.stash()` keeps working for turns on the Tasks
capability); `FiberRecoveryContext`/`FiberContext` (`think.ts:4957`
constructs one _inside_ the Tasks messenger-reply definition, and both
are root-entrypoint published types). Rename, do not delete — until their
consumers migrate in PRs 10–12, at which point `stash()` deprecates with
the rest and the two DTOs become `TaskRecoveryContext`/`TaskRunContext`
with aliases. (Not `TaskContext`: the RFC takes that name for the
per-handler runtime.)

**One constraint to carry forward, and its replacement must exist before
the removal.** The recovery backoff (`FIBER_RECOVERY_MAX_BACKOFF_MS`,
`_recoveryNoProgressScans`) exists because #1707 found a
repeatedly-throwing recovery hook woke the DO every `keepAliveIntervalMs`
forever. The engine's progress rules are the _detector_; they are not by
themselves the _containment_, and #2274's backoff is opt-in (Risk 18).
PR 7 must ship a default `interruptionBackoff` before PR 15 removes the
fiber one. The _test_ cases (`poison-row-backoff.test.ts`,
`poison-row-aging.test.ts`) should be re-pointed at it rather than
deleted.

---

## 6. Storage transition

**`cf_agents_task_runs`: MIGRATE in place. `cf_agents_task_steps`:
REBUILD into `cf_agents_task_journal`, then drop. Neither is orphaned.**

The whole point of compiling the step API onto the engine is that
in-flight step runs survive the cutover. A step run compiles to a
single-phase machine whose checkpoint is a singleton persisted as SQL
`NULL`, so its journal keys are `(run_id, 0, name)` — isomorphic to
today's `(run_id, step_name)`. **No row rewrite is needed beyond the
table move.** A run accepted by version N and interrupted resumes under
version N+1 by replaying its journal, unchanged, with **byte-identical
`stepIdempotencyKey`s**. That is the acceptance criterion for PR 7 and it
must be an e2e test (SIGKILL under N, restart under N+1), not a unit
test.

**Schema version 3** (key `"cf_agents:tasks_schema_version"` unchanged;
identifiers renamed off `FIBER_`). The full DDL is the RFC's §4; the
transition-relevant parts:

- `cf_agents_task_runs` gains 20 columns by plain `ALTER TABLE ADD
COLUMN`, following the v1→v2 precedent (`addRunBudgetColumns`,
  store.ts). The `state` `CHECK` constraint is **never touched**, so the
  runs table is never rebuilt — which is exactly why `faulted` and
  `orphaned` ride an `outcome` column instead of becoming new states. The
  load-bearing ones here are `checkpoint` (NULL for every step run),
  `checkpoint_turn` (0 forever for a step run), `definition_base` /
  `definition_version` (backfilled by one UPDATE), `abort_mark`
  (backfilled from `cancel_requested = 1` on non-terminal rows), and
  `transitions`.
- **`cf_agents_task_journal` is a new table**, keyed
  `(run_id, turn, name)` `WITHOUT ROWID`, and `cf_agents_task_steps` is
  copied into it at `turn = 0` and dropped. _This replaces the original
  plan's "`ALTER TABLE cf_agents_task_steps ADD COLUMN turn`": the PK has
  to change, and SQLite cannot add a column to a PK._ The rebuild runs in
  batches of 2 000 rows, **each batch in its own `transactionSync`**,
  under a durable cursor `cf_agents:tasks_journal_cursor`, at an
  intermediate `schema_version = 2.5`. **No definition dispatches while
  the version is 2.5**, so a half-copied journal is never read by a
  replay; a crash resumes from the cursor. The rebuild is skipped
  entirely when the table is absent or empty, and warns above 10 000
  retained rows naming `tasks.delete({ settledBefore })`.
- `cf_agents_task_mailbox` (PK `(run_id, key)`, `WITHOUT ROWID`, no
  secondary index — dedupe is an `ON CONFLICT DO NOTHING`),
  `cf_agents_task_asks` (PK `ask_id` = `<runId>#<nanoid>`, so an answer
  routes off the id alone), and `cf_agents_task_routes` (the root-side
  owner index, which exists because the wake mirror is _cancelled_ for an
  event-driven park and so cannot be the owner index).
- One new index: `cf_agents_task_runs_parent (parent_run_id)` — a
  write-once column, the same justification the `definition` index uses,
  and without it an abort cascade is a full-table scan on every cancel.

**The checkpoint column is not the step-vs-machine discriminator.** The
original plan said "`NULL` on every existing row, which is how a step run
is recognised". A machine run that has been accepted but has not yet
committed its first checkpoint is _also_ NULL — ambiguous exactly at the
acceptance/first-transition boundary, where a crash is most likely. The
**shape of the resolved definition** (`typeof def === "function"` vs an
object with `phases`) is the only reliable discriminator, and §1a already
uses it at registration. `checkpoint` is payload, not a type tag.

**A renamed or dropped definition must not terminally destroy in-flight
rows.** `#executeRun` (tasks.ts:1200–1207) currently constructs a
`MissingTaskDefinitionError` and calls `#failWithoutAttempt` when a
persisted name no longer resolves. Every migration that renames or drops
a name — PR 12's `MESSENGER_REPLY_TASK_DEFINITION`, PR 13's three harness
names, §5's fiber-vocabulary renames — would hit it, and the original
plan supplied a drain shim for only two of them. _RFC override of the
original "bounded park then fail":_ PR 7 makes such a run terminal
`failed` with `outcome: 'orphaned'`, **preserving the checkpoint,
journal, mailbox and asks even at `retain:false`**, costing no alarm, and
recoverable with an explicit `tasks.reopen(runId)` once the definition is
registered again. That is strictly more recoverable than a grace window
(a park that expires still loses the run), it is visible in `get()` and
`view()`, and it makes every later rename survivable without a per-name
shim. `@vN` name parsing plus `migrate(checkpoint, fromVersion, input)`
is the planned path; `orphaned` is the safety net for the unplanned one.

**Chat-recovery and chat-turn rows specifically.** These are the
highest-stakes rows in the transition because an in-flight one is a
half-finished chat turn a user is watching.

- `cf_agents_task_runs` rows under `__cf_internal_chat_recovery` are
  `retain: false` (recovery-task.ts:169–171), so **no terminal rows
  exist** — only live continuations, each one short. Rows under
  `__cf_internal_chat_turn` are likewise `retain: false` with runId
  `chat_<nonce>`.
- **The drain must not be a shim that ignores the journal.** The original
  plan proposed keeping the definition registered "as a shim whose `turn`
  hands its incident to the new machine and completes". An in-flight
  recovery run's durable state is not just the incident record — it is
  the journal: `createChatRecoveryTaskDefinition`
  (recovery-task.ts:185–202) writes a `backoff` sleep row and then a
  `continuation` `step.do` row whose state says whether the model handoff
  already fired. `#executeRun` resolves the _current_ handler for the
  persisted definition name (tasks.ts:1200–1207), so a shim replaces the
  old body wholesale: a run whose `continuation` step already completed
  would be handed to the new machine and re-run, **producing a second
  recovery turn for a user who already got one.** Correct drain: **keep
  the original step definition registered, unmodified, until its rows
  settle.** They are `retain:false` and short-lived, so one release is
  ample. If a handoff is wanted instead, the shim must read the journal
  (`continuation` completed → settle, do not re-dispatch) before handing
  off. "Hands its incident to the new machine and completes" does
  neither.
- The **incident records** `cf:chat-recovery:incident:<id>` and
  `cf:chat-recovery:progress` are the authoritative state and **must
  migrate**, lazily: the new machine's `initial` reads the legacy record
  if present, adopts it as the checkpoint, and deletes the key. One-shot,
  read-through, no batch migration — a DO with no in-flight incident pays
  nothing. (`initial` must be re-runnable, so anything non-deterministic
  it needs goes through `ctx.memo`, not through `initial` itself.)
- `cf:chat:recovering` and `cf:chat:last-terminal` are user-visible
  status flags, not machine state: **keep as-is**.
- `__cf_chat_turn_snapshot:<runId>` (turn-task.ts:56) and
  `__cf_messenger_recovery:<runId>` (think.ts:4950) become the checkpoint
  via the same lazy read-through in PRs 11 and 12, then the writers go.

**Legacy fiber tables: staged drop, not a single v12 step.** The ratchet
exists (`cf_agents:schema_version`, currently 11 at
`[main] index.ts:753`, DDL gated at :1563, tables at :1610/1623/1640), so
this is a clean migration — but it must be staged, because the readers do
not all die at once.

- `cf_agents_runs` — a row exists only while a fiber executes. After one
  release where the code scans but never inserts, any remaining row is
  unrecoverable anyway. **Drop at PR 15.**
- `cf_agents_facet_runs` — **the original plan's position here is
  self-contradictory and would throw.** It recommended dropping the table
  at v12 while "keep[ing] `cleanupPrefix`'s DELETE one more release so
  stale leases from the prior version still prune". A `DELETE FROM` a
  dropped table is a SQLite "no such table" error, not a no-op — and the
  table has six more unguarded raw-SQL readers than the one named:
  `dynamic-agents.ts:127` (SELECT scan), `:142` (DELETE), `:319` (INSERT
  OR REPLACE), `:338` (SELECT), `:358`, `:371` (DELETEs), `:1640` (DELETE
  in `unregisterRun`), plus `index.ts:4754` (COUNT). All are direct
  `this.#host.sql` / `this.sql` calls with no try/catch. **Resolution:
  the table survives PR 15; the drop is its own step (PR 16) one release
  later, after every reader is deleted.** The stated middle position
  breaks facet deletion on the first cleanup after migration.
- `cf_agents_fibers` — **the one real data-loss surface.** Terminal rows
  are _retained by design_: they are the idempotency receipt behind the
  webhook-dedupe recipe in `docs/agents/webhooks.md:426`.
  **Recommendation: document a reset, do not write a migration.** A
  retained receipt is an idempotency _cache_, not a record of truth;
  migrating it into `cf_agents_task_runs` would require synthesising a
  definition name and a journal for work that never ran on the engine.
  The deprecation changeset (PR 14) states plainly that retained terminal
  fiber receipts are dropped at the engine deletion and that a caller
  relying on cross-version dedupe must re-key onto
  `tasks.run({ idempotencyKey })` during the deprecation window.

**Think's tables** (PR 12): `cf_agent_tool_child_runs` holds live,
user-visible work → lazy read-through into the checkpoint, same pattern
as the incident record. `cf_think_action_ledger` is an idempotency cache
→ documented reset, with the note from §3.7 that a cross-turn memo
belongs in the committed checkpoint or in `ctx.memo` (journal
`turn = -1`) rather than in the turn-scoped journal.
`cf_think_action_pending_approvals` holds a human-blocking pause →
**must** read through into `ctx.ask` rows; dropping it silently strands
an approval. `cf_agent_tool_milestones` is presentation history → read
through for one release, then drop. `cf_think_submissions` is the open
one: it carries `request_id`, `stream_id`, `messages_applied_at`,
`error_message` and three purpose-built indexes
(`cf_think_submissions_status_created_idx`, `_request_status_idx`,
`_status_completed_idx`) that today's `TaskListOptions` cannot express —
it survives as a query projection unless §1a's widened `list()` lands
first. `agent-think/test/submission-status.test.ts:22` writes it directly
and is rewritten either way.

**The delete cascade is now a contract, and it is tested.** Every path
that removes a run — `retain:false` settle, `tasks.delete()`, the sealing
purge, facet subtree teardown — must remove, in one synchronous block:
journal rows, mailbox rows, ask rows (prefix `runId + '#'`), the route
row, the child mailbox rows this run wrote into a parent, and the run
row. `TaskStore.deleteRun` (store.ts:84, today two statements) grows to
six, and a test asserts zero orphan rows in all five tables after each of
the four paths. That test is also what keeps `memory-limit.test.ts:497`'s
sealing assertions honest.

---

## 7. Risks and open questions

Each carries a recommendation. A reviewer overriding one should say
which. Items the RFC has since settled say so and keep the reasoning, so
the record shows what was decided rather than what was dropped.

1. **`retries` meant two things.** `TasksOptions.retries` = step
   defaults; `TaskRunOptions.retries` = the interruption budget — same
   name, same object graph. → **Renamed run-level to `interruptions` and
   the error to `TaskInterruptionsExhaustedError`, inside #2274 before
   merge.** _Settled; the RFC uses the new names throughout, and the
   `docs/agents/tasks.md` half landed in the same commit (`f28ffc2f`) —
   nothing is owed, and PR 0's amendment (a) is struck._

2. **Deleting the `__cf` gate would expose internal definitions to
   `tasks.run()`.** A user could call
   `agent.tasks.run("__cf_internal_chat_turn", garbage)`. → _RFC
   override: the gate is **kept**._ With `register()` returning a handle
   and the two apertures deleted in favour of it, nothing forces the
   gate open, and public `run()` keeps refusing reserved names. The
   cost is that the **composition-registry** need is unanswered for the
   three example harnesses, which construct their capability separately
   from the `Tasks` instance and already cargo-cult the prefix; a public
   `define()` (PR 14a) is where that trade gets made, on its own, with
   the mitigation the original verdict proposed: definitions validate
   their input and fail the run, and the docs state that definition names
   are one shared namespace.

3. **Rename `TaskRunState` to the Workflows vocabulary?**
   (`pending→queued`, `completed→complete`, `failed→errored`,
   `cancelled→terminated`.) → **No.** These are persisted values behind a
   SQL `CHECK`; renaming costs a data migration on every object. Mirror
   Workflows names for _new_ concepts (`sendEvent`, `waitForEvent`,
   `pause`/`resume`/`terminate`) and ship the mapping table in the docs
   (RFC §9.5). Keeping the six also keeps the `result`/`error`/`reason`
   correlation a five-value set would destroy.

4. **Duplicate step names.** Workflows allows them and addresses
   occurrences by `count`; Tasks makes it fatal and tells users to
   hand-suffix loop steps. → **Keep it fatal**, now scoped to one turn.
   The only motivation for `(name, count)` keys is loops, and loops now
   have a first-class home: return the next state. This also closes
   `restart({from})` as a permanent non-goal, since `count` addressing is
   its prerequisite (RFC §13).

5. **`tasks.delete` is missing from the brief's enumerated surface.** →
   **Keep it, and widen it with `runId`.** A DO has no background GC and
   `retain` defaults to true; without the sweep, retained terminal rows
   grow without bound — and now they carry journal, mailbox and ask rows
   with them. The `runId` filter is separately required by Risk 17.

6. **Two names for "this run kept dying":** the memory-limit breaker's
   `TaskMemoryLimitSealed` (tasks.ts:643) and the interruption budget's
   exhaustion error. → **Make an OOM strike count as an interruption.**
   Then the budget fires first when one is set, and the seal is the
   unbounded-case backstop. #2274 already routes the sealed branch
   through `#failWithoutAttempt`; finish the wiring there, and stamp
   `outcome:'faulted'` while you are in it.

7. **Routed machinery: keep in Tasks, or lift to Lifecycle?** Both
   inventories said lift. → **Keep in Tasks for this cleanup.** It is not
   made unnecessary by the layering — it _grows_ four route messages plus
   an owner-index table (PR 9). Lifting a mechanism while it is gaining
   cases is the worst possible timing. De-duplicating the
   Scheduler/Queue/Tasks copies into `lifecycle.jobs` is a real and
   separate track, best started after PR 9 lands and the final shape is
   known.

8. **Does `stash()` survive the fiber engine?** It is public and
   documented, and `_withFiberStash` keeps it working for Tasks chat
   turns today. → **Deprecate it with `runFiber` (PR 14) and delete it in
   PR 15.** The returned checkpoint _is_ the state; a second ambient
   checkpoint writer is exactly the "second commit path" the RFC's
   invariant 5 forbids. Keep `_withFiberStash` alive only until PR 11
   lands.

9. **The published-surface accounting was three times too small.** →
   Three corrections, all raising the break count.
   (a) **Nine root fiber types, not two** (`src/index.ts:391–485`,
   `dist/index.d.ts:152–189`); the root entrypoint carries **no**
   `@experimental` note; `FiberStatus` is reachable from three of the
   others, so it cannot go independently. Rename with aliases in PR 14,
   delete in PR 15; the aliasing work is 4.5× the original budget.
   (b) **Eleven `agents/chat` Task exports** (`chat/index.ts:54–68`), on
   a first-class subpath (package.json:243–247), with **no `@internal`
   marker at all** on the turn-task block and a module-level one on
   `recovery-task.ts` that does not survive into `dist/chat/index.d.ts`.
   In-repo consumer through the public path:
   `packages/think/src/tests/agents/think-session.ts:49–55`. PRs 10 and
   11 are therefore **breaking and need changesets**; PR 6 deprecates
   them one release ahead.
   (c) **`MESSENGER_REPLY_FIBER_NAME` is published** from
   `@cloudflare/think`'s `./messengers` subpath
   (`messengers/index.ts:36`, package.json:80). PR 12's "Breaking:
   Think-internal tables" understated it.

10. **One journal or two?** → **One mechanism, two scopes — and the scope
    is not optional.** The original "one journal, run-scoped" verdict is
    unsafe under machine semantics for two independent reasons.
    (i) `DuplicateTaskStepError` is not a cross-turn guard: `#usedNames`
    is a `ReplayStep` instance field (replay.ts:239) and `ReplayStep` is
    constructed per attempt (tasks.ts:1327), so a name journaled in turn
    1 and reused in turn 5 does not throw — it takes `case "completed"`
    (replay.ts:310) and silently returns turn 1's result. Silent wrong
    answers, for exactly the loop shape the machine API exists to host.
    (ii) Take the other horn — unique names per turn — and the run
    accumulates rows with no GC (`store.ts:84`'s `deleteRun` is the only
    step-row DELETE) until `MAX_STEPS_PER_RUN = 10 000` (replay.ts:55,
    :292) fails it. That cap is precisely why pi rotates at 4 000 passes.
    **Resolution: the journal is keyed `(run_id, turn, name)` and the
    previous turn's rows are retired in the same transaction as the
    checkpoint write.** A step run is one turn, so nothing about it
    changes. _RFC refinement: this is a new table
    (`cf_agents_task_journal`) with a batched rebuild, not an `ALTER
TABLE` on `cf_agents_task_steps`, because the primary key changes._
    Cross-turn memoisation belongs in the checkpoint or in `ctx.memo` —
    write that into the `ctx.do` docs. _Still the item most likely to
    drift during PR 7; pin it in the engine PR's description._

11. **Agent installs Tasks unconditionally for every Agent**
    (`index.ts:1905`, `.use(this.tasks)` at :1985). → **Keep
    unconditional.** The concern in the inventories was "two always-on
    capabilities" once a second primitive existed; with one primitive
    that concern evaporates. Revisit only if install cost is measured,
    not on principle.

12. **`onError(error, run)` as a settle channel.** #2274 widened it to
    carry run identity, and the only production caller (Agent) ignores
    the new argument — it was pre-paying for the actor hosts. → **Keep it
    as observability; do not grow it.** `tasks.watch` is the settle
    channel and `ctx.join` is the in-run one. If `onError` grows a return
    value or a settle contract, we will have rebuilt the closure registry
    inside the capability.

13. **The `__DO_NOT_USE_WILL_BREAK__` apertures are in shipped typings**
    regardless of the `@internal` tag, and all three example harnesses
    use two of them. Cite the source, not `dist/`, which `.gitignore:92`
    ignores and whose line numbers no reader can reproduce:
    `runAttached` is `tasks/tasks.ts:672`, `enqueue` is `:694`,
    `cleanupRoutePrefix` is `:895` — all three present in the published
    `.d.ts`. →
    **Treat their removal as a published break** — which is now PR 4,
    the same PR that moves every in-repo caller — and survey external
    consumers, `flue` included, before PR 4 for these two and before
    PR 14 for the rest of the six-item list in §3.12. The rude name is
    not a licence; it is a warning nobody was required to read.

14. **`pause()`/`resume()` and the `paused`/`waitingForPause` states.** →
    _RFC override of the original "defer"._ Both ship: they are cheap in
    the wake model (suppress the push, do not re-arm) and they are the
    Workflows vocabulary, alongside `terminate()` as the forceful tier.
    `waitingForPause` is **not** adopted — our `pause()` does not
    interrupt a live transition, so a run reads `running` until it parks
    or settles and then `waiting` + `reason:"paused"`. The original
    argument ("the machine makes paused a definition-level state") is
    still true and still the better choice for a _domain_ pause; the
    capability verb is for the operator.

15. **PR ordering: the `enqueue` removal cannot precede the `__cf` gate
    removal.** → _Moot under the RFC._ The gate is kept, so the
    replacement for both apertures is `register(...).run(input, {
start })`, which accepts reserved names by construction. PR 3 lands
    the handle, PR 4 moves the call sites and deletes both apertures in
    the same diff — and no ordering inversion exists to trip over. The
    underlying fact
    remains true and worth keeping: public `run()` throws on any
    `__cf`-prefixed name (tasks.ts:317–320) and **every** production
    aperture caller passes one — six names: `__cf_pi_harness_lane@v1`,
    `__cf_codex_drive_v1`, `__cf_self_modifying_turn_v1`,
    `__cf_internal_chat_recovery`, `__cf_internal_messenger_reply`, and
    `__cf_internal_chat_turn` (`think.ts:2935`,
    `ai-chat/src/index.ts:4661`), the name passed at `think.ts:5078` and
    `ai-chat/src/index.ts:841`.

16. **PR ordering: `runAttached` cannot be deleted before messenger
    replies and the self-modifying harness migrate.** Live callers:
    `packages/think/src/think.ts:5013` (messenger reply), `:5078` and
    `packages/ai-chat/src/index.ts:841` (chat turn), and
    `examples/next/harnesses/self-modifying/src/self-modifying-harness.ts:394`.
    → _Dissolved, not deferred._ Repointing one of those at
    `register(name, def).run(input, { start: "attached" })` is a
    like-for-like edit that does not touch the definition it starts, so
    no consumer has to migrate first. **The deletion is PR 4, in the same
    diff as the moves**; the messenger (PR 12) and harness (PR 13)
    migrations then delete the calls themselves, not the aperture.
    _Two kinds of reference are not like-for-like, and PR 4 carries
    both:_ the four test subclasses that start a definition their
    **base** class registered (`ai-chat/tests/worker.ts:2549, 2565`;
    `think-session.ts:8185, 8220`), which need PR 3's protected
    accessor, and the `worker.ts:3374–3404` monkey-patch, which has to
    be repointed at the handle it patches.

17. **A settled machine address is permanently unusable.** _(Still open —
    and the one item this plan asks for that the RFC's §2.5 does not
    carry.)_ §1a promotes `runId` to "the address: get-or-create,
    `accepted:false` on join", and §3 addresses machines at fixed keys
    (`pi:lane:<lane>`, `self-modifying-turn:<turnId>`, the incident id,
    the messenger thread) while deleting today's `retain:false` + uuid
    ids. But `#accept` (tasks.ts:1105–1143) joins an existing row in
    **any** state, terminal included — there is no restart or replace
    branch anywhere in it — and `TaskDeleteOptions` (tasks.ts:220–224)
    exposes only `status`/`settledBefore`/`limit`, never a `runId`. So
    the first time a lane machine settles (cancel, deadline, exhausted
    interruptions, `faulted`, or a plain `complete`) the address returns
    `accepted:false, state:"failed"` forever and no public API can free
    it. The obvious escape — `retain:false` everywhere — contradicts the
    same section's claim that `tasks.get("pi:lane:<lane>")` answers
    liveness, since a settled `retain:false` run leaves no row at all;
    and `faulted`/`orphaned` override `retain:false` by design (RFC
    §6.6), so even that escape is incomplete. → **Add
    `TaskRunOptions.replace: "never" | "ifSettled"` (default `"never"` =
    today's behaviour) and `TaskDeleteOptions.runId`, both in PR 7.**
    Spell the restart rule out in the machine contract tests. _If the RFC
    declines `replace`, PR 13's pi port needs another answer before it
    can drop `retain:false` + uuid run ids, and the RFC's `reopen()` is
    not it — `reopen` un-orphans, it does not restart a completed run._

18. **The fiber recovery backoff is being removed before its replacement
    exists.** _(Still open — `interruptionBackoff` is not in the RFC's
    `TasksOptions`.)_ §5 retires `FIBER_RECOVERY_MAX_BACKOFF_MS` /
    `_recoveryNoProgressScans` on the grounds that the progress rules are
    strictly better. But #2274's interruption backoff and cap engage only
    when the _caller_ passed run-level `interruptions`: `#accept`
    persists `retry_policy = NULL` otherwise (tasks.ts:1068),
    `#runRetryPolicy` returns `null` (`:1457–1458`), and `#executeRun`'s
    whole backoff/exhaustion block is behind `if (policy)` (`:1247`). With no
    policy, an interrupted run is floored due-now by `#reconcile`
    (tasks.ts:1670–1673) and replays immediately, forever — #1707's hot
    loop. Progress Rule A _detects_ a no-progress transition; Rule B
    _detects_ a runaway loop; neither _contains_ a run that dies before
    it commits anything. → **PR 7 ships a default
    `TasksOptions.interruptionBackoff` that applies to un-policied runs,
    and PR 15 cannot merge before it.** Re-point
    `poison-row-backoff.test.ts` / `poison-row-aging.test.ts` at it.

19. **Deleting Think's tables destroys queries Tasks cannot serve, and
    committed state had no reader.** → **Half settled, half open.** The
    reader is settled: _RFC override — the checkpoint is **not** added to
    `TaskRunSnapshot` (renaming or overloading `state` would edit 41
    assertion sites); it is read from the new `tasks.view(runId)`, which
    also carries mailbox, asks, children, streams, `turn`, `progress` and
    `transitions`._ `tasks.view("pi:lane:<lane>")` is what answers "what
    phase is this lane in". Still open: `cf_think_submissions` carries
    `request_id`, `stream_id`, `messages_applied_at`, `error_message` and
    three purpose-built indexes (think.ts:10213–10240), while the
    replacement is `TaskListOptions` (`definition`/`status`/`limit`,
    `created_at DESC`, tasks.ts:211–215). "Submissions for request X",
    "oldest queued submission" and "has this submission applied its
    messages" are inexpressible after the delete. → **PR 7 widens
    `TaskListOptions` with metadata filters and ordering; PR 12 then
    either deletes the table or keeps a 4-column projection — decided
    against the shipped `list()`, not in advance.**

20. **PR 2's payoff claim was overstated.** Deleting the two
    `parentPath.length > 0` blocks does not make
    `_runFiberWithStashWrapper` dead in `packages/` — four call sites
    remain (`tests/agents/run-fiber.ts:440, 470, 505`;
    `ai-chat/src/tests/worker.ts:3362–3403`, which monkey-patches it and
    restores the original) — and the ~1 300-line deletion it promised to
    unblock is gated on rewriting those test agents, work scheduled in
    PR 15. The same block's `runAttached` patch
    (`worker.ts:3374–3404`) is **not** PR 15's: PR 4 deletes that method,
    so PR 4 repoints the patch. → **Keep PR 2 exactly where it is,
    for the reasons that survive (record correction + routed acceptance
    proof), and drop the "independent of the engine schedule" claim.**
    (The production gate count itself is right: `think.ts:4779` and
    `chat-sdk.ts:230, 238` are unrelated facet guards, not fiber
    fallbacks.)

21. **"Do not invent a machine-side `interrupted`" rested on evidence
    that does not exist.** The inventories deleted the twin on the
    grounds that "the machine's evidence is `attempt > 1` with unchanged
    state". `attempt` increments on **every** claim —
    `const attempt = row.attempt + 1` at tasks.ts:1269, on any
    `pending|waiting|running` row — including a clean wake from a sleep
    or a step-retry park; `types.ts:139–146` says exactly that, and
    :148–159 adds that "a first attempt, a sleep wake, and a step retry
    park all see `null`" for `interrupted`. Under machine semantics every
    transition boundary is a claim, so `attempt > 1` is true for every
    transition after the first and carries zero information. This matters
    _more_ on the machine API, not less: a phase body is unjournaled, so
    a machine re-entering after a lost isolate must know its side effects
    may be half-applied. → _Settled by `TaskContext extends TaskStep`:
    `ctx.interrupted` is `step.interrupted`, same shape, same
    `afterInterruption` gate, with the journal query scoped to the
    current turn (RFC §3.6)._

22. **Cancel-wins-over-result clobbers whatever the cancel transition
    returns.** `#runAttempt` re-reads `cancel_requested` _after_ the
    handler returns and settles `cancelled` unconditionally
    (tasks.ts:1338–1352) — deliberately, so a handler that swallowed
    `step.signal` cannot report success. If `onCancel` is invoked as its
    own transition, it runs _because_ cancel was requested, so that guard
    would fire on every one and throw away the returned state. →
    _Settled: the fence predicate carries `abort_mark IS NULL` on
    ordinary writes and `abort_mark IS NOT NULL` on the cancel
    transition's (RFC §5.2), which distinguishes the two cases at zero
    extra reads and also makes the mark a write barrier._ Name it
    explicitly in the engine PR's description; it is easy to lose.

23. **A renamed or dropped definition terminally fails in-flight rows.**
    `#executeRun` fails rather than parks when a persisted name no longer
    resolves (tasks.ts:1200–1207). Every rename in PRs 12–13 and §5 hits
    this, and the original plan supplied a drain shim for only the two
    chat definitions. → _RFC override: `outcome: 'orphaned'` with the
    checkpoint, journal, mailbox and asks preserved even at
    `retain:false`, no alarm, plus an explicit `tasks.reopen(runId)` —
    instead of a bounded park._ Strictly more recoverable (a park that
    expires still loses the run) and visible in `get()`/`view()`. See §6
    on why the chat shim itself must still not ignore the journal.

24. **The `cf_agents_facet_runs` drop as originally written would
    throw.** §6 recommended dropping it at v12 while keeping
    `cleanupPrefix`'s `DELETE` one release longer. A `DELETE FROM` a
    dropped table is a SQLite "no such table" error, not a no-op — and
    the table has eight unguarded raw-SQL readers, not one:
    `dynamic-agents.ts:127, 142, 319, 338, 358, 371, 1640` and
    `index.ts:4754`, all direct `sql` calls with no try/catch. → **Stage
    it: the table survives PR 15; PR 16 drops it one release later, after
    every reader is gone.** `cf_agents_runs` and `cf_agents_fibers` still
    go at PR 15.

25. **PR 7 commits the machine API before any consumer has exercised
    it.** → **Prototype the pi lane driver against PR 7's branch before
    PR 7 merges.** It is the purest machine, has no public API surface,
    and its pathologies are each a direct test of a design choice this
    revision changed: the 4 000-pass rotation tests the journal scope
    (Risk 10), the metadata liveness scan tests `view()` (Risk 19) _and_
    address reuse after settle (Risk 17), the two Lifecycle jobs test the
    wake port. Merging the engine without that feedback is the largest
    avoidable risk in the plan.

26. **The chat migrations (PRs 10, 11) are the only ones with
    user-visible behaviour at stake** — an in-flight turn's recovery. →
    Three mitigations, all mandatory: the e2e row-count probes that sum
    `cf_agents_runs + cf_agents_task_runs` must be rewritten to ask the
    engine (they will otherwise pass vacuously against a version that
    writes neither); the incident read-through (§6) must be covered by a
    version-N-writes / version-N+1-reads test, not just a unit test; and
    the drain must keep the original step definition registered until its
    rows settle rather than substituting a handoff shim that re-runs a
    completed `continuation` (§6).

---

## What changed from the scoping document this replaces

All 26 findings of the original scoping pass were verified against both
worktrees at the cited lines and are carried forward. What moved is only
what the RFC decided differently:

| Original verdict                                             | Now                                                                                     | Why                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register()` → public `define()`, `__cf` gate deleted (PR 3) | `register()` keeps its name, gains a handle, keeps the gate; `define()` becomes PR 14a  | RFC decision. The gate is still load-bearing because public `run()` must keep refusing reserved names — which is also why only the handle can replace the apertures; the composition-registry need is real and gets its own PR |
| `enqueue`/`runAttached` deleted in PRs 4 / 12                | handle in PR 3; call sites moved **and** both apertures deleted in PR 4                 | maintainer decision, 2026-09-16: no deprecated wrappers, and every in-repo caller migrates in the same PR as the deletion                                                                                                      |
| `step.idempotencyKey` deleted                                | kept, with the `turn`/`run` scope rule                                                  | RFC §3.4 — byte-identical keys on the compiled path are a migration requirement                                                                                                                                                |
| `ALTER TABLE cf_agents_task_steps ADD COLUMN turn`           | new `cf_agents_task_journal`, batched rebuild at schema 2.5, old table dropped          | the primary key changes, so SQLite cannot do it in place                                                                                                                                                                       |
| `machine_state` column, surfaced on `TaskRunSnapshot`        | `checkpoint` + `checkpoint_turn` columns, surfaced on the new `tasks.view()`            | RFC: `snapshot.state` keeps its meaning; renaming it would edit 41 assertion sites                                                                                                                                             |
| `MissingTaskDefinitionError` → park with a bounded grace     | `outcome: 'orphaned'` + preserved state + explicit `reopen()`                           | strictly more recoverable, and no per-name shim                                                                                                                                                                                |
| `run.interrupted` as a new twin                              | `ctx.interrupted`, inherited, because `TaskContext extends TaskStep`                    | one object, one member                                                                                                                                                                                                         |
| `TaskWaitReason` gains `"event"`                             | gains `mailbox`, `event`, `ask`, `child`, `paused`                                      | the machine parks five ways                                                                                                                                                                                                    |
| `pause`/`resume` deferred                                    | shipped, with `terminate` and `reopen`                                                  | Workflows vocabulary, cheap in the wake model                                                                                                                                                                                  |
| `tasks.ask` on the capability                                | no capability-level `ask`; a transition raises asks, an outside-in question is a `send` | an ask is a question the run asks, not one asked of it                                                                                                                                                                         |

Two items this plan still asks for that the RFC's normative API does not
carry, and which must be resolved in the engine PR:
**`TaskRunOptions.replace` / `TaskDeleteOptions.runId`** (Risk 17, without
which a fixed machine address is single-use) and
**`TasksOptions.interruptionBackoff`** (Risk 18, without which PR 15
removes the only containment for a poison run). A third, **widened
`TaskListOptions`** (Risk 19), is additive and blocks only PR 12.
