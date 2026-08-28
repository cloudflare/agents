# Capability test fixtures

Harness Durable Objects for testing Lifecycle capabilities — the lower-level
sibling of `../agents/` (which holds Agent-level fixture classes). One file
per capability, all registered in the shared workers project
(`../worker.ts` + `../wrangler.jsonc`), all driving real Durable Objects.

- `harness.ts` — the generic tier's bare `CapabilityHarnessObject`. Its
  driver, `withCapabilityHarness()` (in `../shared/capability-harness.ts`),
  binds per-test-constructed capabilities to a real `Lifecycle` over real
  SQLite storage — a new capability gets isolation tests with zero new
  wiring.
- `lifecycle.ts` — fixtures for the Lifecycle core itself:
  `PlainLifecycleObject` (probe capabilities for phases, alarms, context,
  routing, events, WebSockets) and `RetryableStartObject` (startup-failure
  retry).
- `scheduler.ts` — `SchedulerHarnessObject` (Scheduler with registered
  callbacks, driven through real platform alarms), `SchedulerStartupWarnObject`,
  `ScheduledLifecycleObject` (Scheduler through full Lifecycle + eviction),
  and `backdateScheduleRow()`.
- `tasks.ts` — `TaskHarnessObject` (Tasks standalone; the Scheduler pairing for
  alarm coexistence lives in `TaskSchedulerCoexistObject`), with definitions
  whose instance counters separate real step
  execution from journal hits, `TaskBatchHarnessObject` (alarm batch
  bound), and the `seedTaskRun()` / `seedTaskStep()` /
  `backdateTaskWake()` helpers that fabricate interrupted or due runs.
- `streams.ts` — `StreamHarnessObject` (Streams as the only capability) and
  `TaskStreamComposeObject` (the checkpointed-cursor contract with Tasks,
  including recovery from stream evidence).
- `mcp-client.ts` — `PlainMcpClientObject` (manager as an installed
  capability); its driver `withMcpHarness()` (in `../shared/mcp-harness.ts`)
  creates per-test managers over shared real storage, simulating hibernation
  wake-ups.

Files here are part of the shared test worker's module graph, so they must
stay loadable outside the vitest pool (the React project boots the worker
under `wrangler dev`): never import `cloudflare:test` from this directory.
Drivers that need it live in `../shared/` instead — `withCapabilityHarness()`,
`withMcpHarness()`, and `captureDiagnosticsEvents()` (observes a capability's
events on the real `agents:*` channels). `console-capture.ts` lives here
because it is worker-safe and fixtures import it.

## Where the tests live

Tests mirror source modules (`src/<module>` ↔ `src/tests/<module>`):

- `../lifecycle/*.test.ts` — Lifecycle core, one file per functionality
  (runtime handlers, startup, alarm arbitration, capability events, routing,
  host context, WebSockets, identity, disposal).
- `../schedules/capability.test.ts` and `../schedules/timing.test.ts` — the
  Scheduler capability contract and its pure timing rules.
- `../streams/capability.test.ts` — the Streams capability contract and its
  Tasks composition.
- `../tasks/capability.test.ts` — the Tasks capability contract: replay
  memoization, interruption reclaim, durable sleeps, cancellation, and alarm
  coexistence.
- `../mcp/client-capability.test.ts` — the MCP client manager as an installed
  capability; the manager suites in `../mcp/` drive `withMcpHarness`.
- Agent-surface suites stay top-level (`../schedule.test.ts`,
  `../alarms.test.ts`, …).

## Adding a capability

Write pure domain rules as dependency-free modules and unit test them
directly (e.g. `../schedules/timing.test.ts`). Test the capability
itself with `withCapabilityHarness` — no new wiring needed. Add a dedicated
harness object here only when tests need real alarms or runtime handlers;
export it from `../worker.ts` and register it in `../wrangler.jsonc`. Do not
bind fake `LifecycleServices`; real objects are cheap in the Workers pool and
fakes drift from Lifecycle semantics.
