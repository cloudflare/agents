# Alarm coordination

A Durable Object has one physical alarm timestamp. Lifecycle owns that platform
resource so capabilities do not overwrite one another's wake-ups.

## Domain model

- **Physical alarm** — the single timestamp stored by the Durable Object runtime.
  Only Lifecycle reads or writes it.
- **Alarm contribution** — a capability's requested next wake time. It is a
  projection of capability-owned durable state, not the work itself.
- **Alarm work** — durable records and processing owned by one capability. Each
  capability keeps its own schema, retry policy, and recovery semantics.
- **Scheduler** — the capability for persistent named callbacks. It is one alarm
  contributor, not the general alarm service.
- **Fibers** — the capability for durable replayable execution. Every
  non-terminal run carries an authoritative `next_at` deadline (acceptance,
  sleeps, retries, and claim backstops all write it), and the capability
  contributes the minimum as one more ordinary contribution.
- **Host contribution** — temporary support for host work that has not yet been
  extracted into a capability.

## How it works

A capability that needs future work implements `getNextAlarm()` and `onAlarm()`.
When it changes durable state, it calls `this.lifecycle.alarms.rearm()` through
the standard service surface supplied by `LifecycleCapability`.

Lifecycle serializes recalculation, reads every capability contribution plus the
host contribution, and sets the physical alarm to the earliest requested time.
An exclusive contribution replaces ordinary wake-time candidates while it
exists; it does not change hook order.

When the platform alarm fires, Lifecycle:

1. starts capabilities and the host if necessary;
2. runs capability `onAlarm()` hooks in registration order;
3. runs host `onAlarm()`;
4. recalculates and rearms the physical alarm.

A failed alarm hook stops the phase and leaves platform retry semantics intact.
Rearm requests made during startup are coalesced and applied after startup, so a
capability can create work in `onStart()` without deadlocking initialization.

## Capability independence

Alarm coordination does not create capability dependencies. Scheduler stores
named callback rows in `cf_agents_schedules`. A future Fiber capability should
store resumable jobs in its own tables and contribute the next recovery wake. An
MCP capability can do the same for reconnect state. Neither needs to insert a
Scheduler row or call Scheduler APIs.

A direct capability dependency remains valid when the domain itself requires
one. Sharing the physical alarm is not such a dependency.

## Agent integration

Agent installs the public Scheduler primitive with policy options only —
retry defaults, hung-interval timeout, and an error observer — plus a
composition-root callback resolver for its historical name-based scheduling
methods. Everything else Scheduler needs (storage, rearm, teardown state,
startup state, the host invocation boundary) arrives through the standard
capability services, so there is no Agent-specific Scheduler adapter. Lifecycle's generic routing surface carries
owner-scoped Scheduler messages to the root and dispatches due callbacks to
facets through one internal Agent transport aperture. Existing facet schedule
rows remain in the root Scheduler table; no data migration or
Scheduler-specific Agent RPC methods are required.

Scheduler publishes telemetry through Lifecycle's event bus. Plain Lifecycle
Objects use the existing diagnostics-channel sink; Agent adapts the same bus to
its existing observability implementation at its composition root.

Agent's host contribution currently covers deferred destruction, keep-alive,
fiber recovery, facet-run checks, and Think's transitional workflow-notification
wake. Those concerns can become capabilities independently without changing the
alarm contract or Scheduler.

## Tradeoffs

Every recalculation queries each contributor, so `getNextAlarm()` should be a
small indexed read with no network I/O. In return, capabilities retain clear
storage ownership and cannot silently clobber each other's alarms.
