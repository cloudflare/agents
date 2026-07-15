# P13 notes — batch-port fibers+delegation files

## Scope
run-fiber.test.ts (54) · agent-tool-detached.test.ts (13) ·
agent-tool-replay.test.ts (5) · agent-tools-failure.test.ts (5)

## Key findings from research (before codex round 1)

- **Native fiber engine exists and closely mirrors packages/agents' fiber
  primitives**: `rebuild/src/domain/runtime/fibers/fibers.ts` implements
  `run`/`start`(managed)/`stash`/`inspect`/`inspectByKey`/`list`/`cancel`/
  `cancelByKey`/`resolve`/`deleteFibers`/`checkInterrupted`, wired onto
  `Agent` (rebuild/src/app/agent.ts:376-425) as public methods `runFiber`,
  `startFiber`, `stash`, `inspectFiber`, `inspectFiberByKey`, `listFibers`,
  `cancelFiber`, `cancelFiberByKey`, `resolveFiber`, `deleteFibers`, plus the
  overridable `onFiberRecovered` hook. run-fiber.test.ts is therefore MUCH
  more portable than the P13 brief's "expect a substantial quarry share"
  suggested — most of the 54 tests map directly onto this public surface.
  QUARRY only the true old-arch internals: raw SQL table access
  (`cf_agents_runs`/`cf_agents_fibers`), white-box private methods
  (`_checkRunFibers`, `_scheduleNextAlarm`, `_recoveryNoProgressScans`,
  `ctx.storage.getAlarm()`), and the MCP-wake-ordering test (Think/MCP
  specific, not bare fiber engine). Native `fibers.test.ts` (705 lines) +
  `agent.test.ts` (keepAlive ref-counting at line 365, fiber recovery at
  122/379) ALREADY cover backoff-doubling/capping, aged-row eviction,
  recoveryMaxAgeMs:0, deleteFibers default-preserves-interrupted, idempotency
  dedupe, waitForCompletion join, live-execution-excluded-from-orphan-scan —
  use these to justify "native <file>"/quarry calls for the "recovery
  follow-up alarm" describe block (5 tests) and most of "managed fibers".
- **`hostAgent<A extends Think>` requires the fixture to extend `Think`**,
  not bare `Agent` (rebuild/src/adapters/cloudflare/shell.ts:631) — even
  though the ORIGINAL TestRunFiberAgent extends packages/agents' bare
  `Agent`. Fixture must be `class ... extends Think { protected override
  getModel() {...}; @callable() runSimple(...) { return this.runFiber(...) }
  ... }` (same pattern as P9/P10 exemplars). `@callable()` from compat.js is
  how custom test RPC methods get exposed (see fixtures/sub-agent-agents.ts).
- **Two likely REAL bugs found in native fibers.ts (report loudly, do NOT
  fix — economy rules forbid rebuild changes):**
  1. `checkInterrupted()` calls `deps.onRecovered(ctx)` (and emits
     `fiber:recovery:detected`/`attempt`/`handled`) for EVERY orphaned run
     row, even when the row's managed ledger is already terminally settled
     (e.g. `aborted` with a stale lingering run row). It only guards against
     re-marking the ledger `interrupted` in that case
     (`!isSettled(ledger.status)`), not against firing the recovery hook
     itself. `resolve()` is a no-op for a non-`interrupted` ledger so the
     ledger status doesn't corrupt, but the app-level `onFiberRecovered`
     hook still fires spuriously for stale/already-terminal rows. Original
     test: "should not recover terminal managed fibers with stale run
     rows" expects `recovered.length === 0`; the native engine would push a
     spurious context. Maps to run-fiber.test.ts's managed-fibers block.
  2. `checkInterrupted()` only scans `RUN_PREFIX` rows
     (`store.list<RunRow>`) — a managed ledger row that exists WITHOUT an
     accompanying run row (e.g. a crash between writing the ledger and the
     run row) is never picked up by recovery at all. Two original tests
     ("should recover pending/running managed ledger rows without run
     rows") depend on ledger-only recovery, which the native engine can't
     do. Possible real gap or intentional divergence — flag, don't fix.
- **agentTool()/AgentToolRunService** (`rebuild/src/domain/delegation/
  runs.ts`) is the rebuild's OWN equivalent of packages/agents'
  `agent-tools.ts` `agentTool()` helper (which agent-tools-failure.test.ts
  imports from ORIGINAL `../agent-tools`/`../internal_context` — clean-room
  read-only, not portable to import directly). `RunStatus` = "running" |
  "completed" | "error" | "aborted" — **no "interrupted"**, confirming
  ISSUE-035. The rebuild's `agentTool().execute()` failure envelope is
  `{ error: { name, message } }`, NOT the original's `{ ok:false, status,
  retryable, error }` shape, and `startRun` always mints a fresh id
  (`ids.newId("run")`) — no toolCallId-derived stable runId (the #1630
  mechanism ISSUE-035 names explicitly). All 5 agent-tools-failure tests
  hang off this gap → missing-feature ISSUE-035, ported honestly-failing via
  a thin fixture built on the real `agentTool`/`createAgentToolRunService`
  (needs compat.js additions: export `agentTool`, `createAgentToolRunService`,
  types). Native `runs.test.ts` already unit-tests the domain service
  directly — don't duplicate, this port is specifically about the
  failure-envelope contract shape, which native tests don't assert (they
  don't need to, since the shape is intentional there).
- **agent-tool-replay.test.ts** (#1630): persists/replays `reason`/
  `childStillRunning` on interrupted rows. `AgentToolRun` has no such
  fields, no "interrupted" status → missing-feature ISSUE-035, same family.
- **agent-tool-detached.test.ts** (#1752): tests a two-slot claim+lease
  delivery ledger (give-up vs finish independent), no-progress give-up
  budget, escalating backbone cadence, terminal broadcast on cancel/give-up.
  This is a DIFFERENT subsystem than ISSUE-035 (live re-attach tail budget)
  — filed as **new ISSUE-037** (rebuild/ISSUES.md, added this session).
  None of the fixture's `*ForTest` RPC methods (`seedDetachedRunForTest`,
  `deliverFinishForTest`, `deliverGiveUpForTest`,
  `detachedReconcileTickForTest`, `detachedBackboneSchedulesForTest`, etc.)
  have ANY real rebuild mechanism to route through — inventing them in the
  fixture would test the fixture's own mock, not the rebuild (the exact
  "rigged pass" pattern P9's integrity note warns against). Plan: mark this
  file **blocked ISSUE-037** at the file level (13/13), no fixture attempt,
  UNLESS codex round 1 finds a partial honest seam worth trying for a subset
  (e.g. the "does not deliver through the ledger when cancelling an awaited
  run" test — that one might be portable against the real
  `cancelRun`/`waitForRun` path since it explicitly tests NON-detached
  behavior). Re-evaluate after codex's pass.

## Shared files to touch (additive only)
- `rebuild/test-workers/ported/fixtures/index.ts` — add barrel export line(s)
  for new fixture module(s).
- `rebuild/test-workers/ported/wrangler.jsonc` — add DO bindings +
  `new_sqlite_classes` migration entries for new fixture classes.
- `rebuild/test-workers/ported/env.d.ts` — add type imports + Env interface
  entries for new fixture classes.
- `rebuild/test-workers/ported/compat.ts` — add exports: `agentTool`,
  `createAgentToolRunService`, `AgentToolRunService`, `AgentToolRun`,
  `RunStatus` types from `../../src/domain/delegation/runs.js` (needed for
  agent-tools-failure.test.ts's fixture).

## Status — DONE

- [x] Research complete, ISSUE-037 filed.
- [x] Codex round 1 (author) — completed clean (log /tmp/codex-p13-r1.log,
      final message /tmp/codex-p13-r1-final.txt). No COVERAGE.md edits, no
      rebuild/src edits. Correctly used 48 actual `it(...)` in the checked-out
      run-fiber.test.ts (brief said 54 — stale estimate; verified via
      `grep -c '  it(' packages/agents/src/tests/run-fiber.test.ts`).
      Codex's own sandbox couldn't run vitest-pool-workers (EPERM on
      `listen 127.0.0.1`) or write outside its workspace root, so it could not
      self-verify or produce the JSON — I did both directly (see below).
- [x] Found + fixed ONE real defect from codex's round 1: the new fixture
      (`fixtures/p13-fibers-agents.ts`) exposed test-only methods via
      `@callable()` only, which registers into the INTERNAL callable dispatch
      registry (websocket rpc / `callables().dispatch()`), not as a directly
      RPC-callable method on the exported Durable Object class. Direct
      `stub.methodName(...)` calls (the pattern this port and the original
      fixture both use) need the method to exist on the exported class itself
      — see `installRpcMethods` in `agent-tools-agents.ts` for the precedent.
      Fixed by adding the same `installRpcMethods`/`rpcMethodNames` bridge to
      `p13-fibers-agents.ts` (list of ~44 method names, defined once on
      `TestRunFiberAgent.prototype`). This was a MECHANICAL fix, not a design
      change — no codex round 2 needed.
- [x] Verified: `npm run typecheck` from `rebuild/` clean (both tsc passes).
      Ran the 4 files directly via
      `npx vitest run --config vitest.ported.config.ts <4 files>
      --reporter=json --outputFile=/Users/cjols/.claude/jobs/815a38dc/tmp/p13-batch.json`
      with `dangerouslyDisableSandbox: true` (needed for workerd's local
      listen). Final: 71 total (48+13+5+5) — 36 pass / 11 fail on the board,
      24 not-yet-portable (skipped with per-test triage comments citing
      ISSUE-035/036/037 or native citations). Spot-checked every failing
      assertion by hand-tracing the real `fibers.ts`/`runs.ts` code paths —
      all are genuine, non-rigged reds (see final report to orchestrator for
      the full table + the confirmed REAL bug in `checkInterrupted()`).
- [x] Committed on port/fibers-batch-p13 (see commit hash in final report).
