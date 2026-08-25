# Capability test fixtures

Harness Durable Objects for testing Lifecycle capabilities — the lower-level
sibling of `../agents/` (which holds Agent-level fixture classes). One file
per capability, all registered in the shared workers project
(`../worker.ts` + `../wrangler.jsonc`), all driving real Durable Objects.

- `harness.ts` — the generic tier: a bare `CapabilityHarnessObject` plus
  `withCapabilityHarness()`, which binds per-test-constructed capabilities to
  a real `Lifecycle` over real SQLite storage. A new capability gets
  isolation tests from this with zero new wiring.
- `lifecycle.ts` — fixtures for the Lifecycle core itself:
  `PlainLifecycleObject` (probe capabilities for phases, alarms, context,
  routing, events, WebSockets) and `RetryableStartObject` (startup-failure
  retry).
- `scheduler.ts` — `SchedulerHarnessObject` (Scheduler installed with runtime
  handlers, driven through real platform alarms), `SchedulerStartupWarnObject`,
  `ScheduledLifecycleObject` (Scheduler through full Lifecycle + eviction),
  and `backdateScheduleRow()`.
- `mcp-client.ts` — `PlainMcpClientObject` (manager as an installed
  capability) and `withMcpHarness()` (per-test managers over shared real
  storage, simulating hibernation wake-ups).

Shared drivers live in `../shared/`: `captureDiagnosticsEvents()` observes a
capability's events on the real `agents:*` channels; `captureConsoleWarnings()`
asserts warning behavior through its output.

## Where the tests live

Tests mirror source modules (`src/<module>` ↔ `src/tests/<module>`):

- `../lifecycle/*.test.ts` — Lifecycle core, one file per functionality
  (runtime handlers, startup, alarm arbitration, capability events, routing,
  host context, WebSockets, identity, disposal).
- `../schedules/capability.test.ts` and `../schedules/timing.test.ts` — the
  Scheduler capability contract and its pure timing rules.
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
