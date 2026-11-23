# Fibers

**Internal.** Not a public API. Nothing new from the slim-hosts work is exposed to apps until it has shipped inside `Think` and `AIChatAgent` for a release and is shown correct ([rfc-slim-hosts.md](./rfc-slim-hosts.md#exposure)).

A fiber is a closure that runs once, checkpoints with `stash()`, and hands an interruption to a recovery hook. `Agent.runFiber()`, `startFiber()`, `stash()`, `inspectFiber()`, `listFibers()`, `cancelFiber()`, `resolveFiber()`, `deleteFibers()` and the `onFiberRecovered()` hook are the public API and keep their signatures.

**A fiber is a one-step [Task](./tasks.md) run.** There is no Fibers engine, table or recovery scan. `packages/agents/src/fiber-runs.ts` is a plain module with no storage of its own: two framework definitions, the functions behind Agent's fiber methods, and the one-way import of rows from older releases.

## How it works

- `runFiber(name, fn)` is a `__cf_fiber` run: `input = { name }`, `retain: false`, `start: "now"`, and the closure as its `local`. Attempt 1 runs the closure; its result or throw goes back to the caller from memory, never stored. The run is deleted when it finishes.
- `startFiber(name, fn, options)` is a `__cf_managed_fiber` run: `fiberId` is the run id, `idempotencyKey` and `metadata` are the run's, and the definition keeps its checkpoint after settling (`keepCheckpoint`), so `inspectFiber()` shows the last snapshot until `deleteFibers()`.
- `stash(data)` writes the checkpoint entry `snapshot`: a synchronous SQLite write fenced on the attempt. `this.stash()` finds the current fiber through an AsyncLocalStorage (`withFiberStash`), which the chat hosts also enter for their turns.
- The claim lasts `keepAliveIntervalMs` (`claimMs`), and its wake renews it while the closure runs: that wake is the object's keep-alive, as the old fiber heartbeat was. A running fiber holds no `keepAlive()` ref.
- A later attempt has no closure (`step.local` is undefined after a reset). It calls the host's recovery: `_handleInternalFiberRecovery` first (chat hosts' legacy turn fibers), then `onFiberRecovered`, with the last snapshot.
- At startup, before `onStart`, the Agent imports older rows, then runs the due fiber runs (`tasks.runDue`), bounded by `fiberRecoveryScanDeadlineMs`. What the deadline leaves runs from its own wake (`fiber:recovery:skipped`, reason `scan_deadline_exceeded`).

### Recovery rules (from the Fibers capability, kept)

- **Commit before the hook.** The attempt is counted in the checkpoint (`crashes`) and committed with `storage.sync()` before the hook runs. A hook that ends the isolate before its first I/O would otherwise roll the count back, and every start would run it again (RUNTIME-FACTS).
- **Crash budget.** The count is taken back when the hook returns or throws. A plain fiber whose hook never returned three times ends `aborted` without the hook (`fiber:recovery:skipped`, `recovery_crashed`). A managed fiber's recovery runs at most once; after one crash it is parked `interrupted`. Only a chat host's legacy turn fibers (`${CHAT_FIBER_NAME}:<id>`) are exempt: their engine keeps its own budget.
- **A throwing hook.** A plain fiber is retried after `keepAliveIntervalMs * 2^n` (capped at 5 min) through a durable sleep of its own run, until it is older than `fiberRecoveryMaxAgeMs` (`max_age_exceeded`). Each fiber backs off on its own. A managed fiber ends `error`.
- **Recovery results.** A managed fiber's hook may return a `FiberRecoveryResult`: `completed` (snapshot and metadata applied), `error`, `aborted`, or `interrupted`. Nothing returned leaves it `interrupted`: the run is parked (`TaskSettlement.park`) until `resolveFiber()` settles it once from outside (`tasks.settle(runId, outcome, { checkpoint })`), the shape approvals use too.
- **Settled but not cleaned up (#2305).** Finishing is one write; when deleting a finished `retain: false` run fails, it is completed in place, so a finished body is never recovered.
- **Starting fails.** If the run's first wake cannot be written, the caller gets the throw and the run is cancelled, so no recovery runs a closure whose caller was told it failed.

### Statuses

| Fiber status  | Task run                                |
| ------------- | --------------------------------------- |
| `pending`     | `pending` (as returned by `startFiber`) |
| `running`     | `running`                               |
| `completed`   | `completed`                             |
| `error`       | `error`                                 |
| `aborted`     | `aborted`                               |
| `interrupted` | `pending` with wait reason `park`       |

`cancelFiber()` is `tasks.cancel()`: the run is `aborted` at once and the closure's signal aborts. `deleteFibers()` deletes settled managed runs, oldest settled first; an `interrupted` one is settled `aborted` first.

### Durable and in memory

| Durable (SQLite)                                                | In memory (lost on eviction)                   |
| --------------------------------------------------------------- | ---------------------------------------------- |
| the run row, its checkpoint (`snapshot`, `crashes`, `failures`) | the closure and its result (the run's `local`) |
| the run's wake job                                              | the attempt's abort controller (Tasks)         |

Memory: one `local` per fiber started in this isolate, dropped when its attempt ends (Tasks' `#locals`). Nothing else.

### Facets

A fiber in a facet is a Task run in the facet's storage; its wake reaches the root as every facet job does. A root from a release before this kept `cf_agents_facet_runs`; startup moves each facet in it onto the facet wake, due now, and drops the table. The facet's own start carries its rows forward.

### Rows from older releases

`importLegacyFibers` runs at startup, once (it finds the old tables in one schema read and drops them):

- a `cf_agents_runs` row with no `completed_at` becomes an interrupted `__cf_fiber` run (`snapshot` → checkpoint, `recovery_crashes` → `crashes`); its next attempt is its recovery. One with `completed_at` settled and is dropped (#2305).
- a `cf_agents_fibers` row becomes a `__cf_managed_fiber` run with its id, key, metadata, status, error and timestamps. `pending`/`running` ones come back interrupted (their run row, if any, merged into them); `interrupted` ones stay parked without running the hook again.
