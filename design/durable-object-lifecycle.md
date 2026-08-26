# Durable Object lifecycle

`Lifecycle` composes runtime behavior into a Cloudflare Durable Object. It owns
runtime handlers, ordered capability phases, host-hook context, identity, and
hibernating WebSocket connections. A host continues to extend Cloudflare's
`DurableObject`; it does not become the `Agent` class exported from `agents`.

`agents/lifecycle` exports `LifecycleObject`, an interface for a
`DurableObject` with an installed `Lifecycle` and the optional semantic hooks
Lifecycle dispatches. The interface names the host contract without introducing
another base class.

The batteries-included `Agent` class installs the same Lifecycle, then adds
state, RPC, scheduling, MCP, workflows, fibers, and sub-agents.

## Capability and host phases

Lifecycle runs startup in this order:

1. capability `onStart` hooks in registration order;
2. the host's `onStart` hook.

For an HTTP request, capability `onRequest` hooks run in registration order. The
first `Response` wins; otherwise the host's `onRequest` handles the request. For
an alarm, capability `onAlarm` hooks run in registration order before the
host's `onAlarm`.

Failures stop the phase and propagate. Failed startup remains retryable. Native
RPC methods explicitly call `lifecycle.start()` because native Durable Object
RPC bypasses Lifecycle handlers.

## Alarm ownership and scheduling

Lifecycle owns the one physical Durable Object alarm. A capability can return
its next requested epoch time from `getNextAlarm()` and request recalculation
through `this.lifecycle.alarms.rearm()`. Lifecycle serializes
recalculation, chooses the earliest contribution, runs every capability's
`onAlarm()` followed by the host's `onAlarm()`, then recalculates once more.

Capabilities own their durable work. Scheduler stores named callback rows in
its table; a future Fiber capability can store resumable jobs in its own table;
an MCP capability can store reconnect state in its own table. They coordinate
only through Lifecycle's alarm contract and do not depend on Scheduler.

A host can also implement `getNextAlarm()` for work not yet extracted into a
capability. Exclusive contributions replace ordinary wake-time candidates,
which supports teardown without teaching other capabilities about destroy
semantics; they do not alter alarm hook order. Agent currently uses the host
contribution for deferred destruction, keep-alive, fiber recovery, and facet-run
checks. These can move into separate capabilities without changing Scheduler or
alarm selection.

`Scheduler` is a plain Lifecycle primitive. Its `onStart` hook owns schedule
schema migration, `onAlarm` owns due-row processing, and `getNextAlarm`
contributes its earliest runnable row or hung-interval recheck. Agent constructs
the same Scheduler exposed at `Agent.this.scheduler`; existing Agent scheduling
methods remain compatibility delegators.

Capabilities extending `LifecycleCapability` receive storage, readiness,
startup state, alarm coordination, host-callback dispatch, events, and generic
capability routing. A capability constructed for a specific host declares it,
and `Lifecycle.use()` verifies the identity at install time — compile-time
host typing and the runtime dispatch target cannot diverge. That service surface is the whole contract: Scheduler
consumes only standard services plus its own policy options, and a future
capability composes the same way with no host adapter. Lifecycle routes an
envelope to the matching capability ID at the destination. Agent supplies an
internal facet transport through one generic RPC aperture, so Scheduler routes
owner-scoped CRUD and callbacks without facet-specific methods or an Agent
adapter. Existing facet rows stay in the root Scheduler table.

Host adaptation happens only at a composition root, through three internal
apertures: the capability event sink, the routed-capability transport, and the
host-callback invoker. Agent uses them to route events into its observability
interface, carry envelopes between facets, and wrap capability-invoked user
callbacks in its tracing invocation boundary. A plain Lifecycle Object uses
the defaults and configures nothing.

Capabilities publish best-effort telemetry through
`this.lifecycle.events.emit()`. Lifecycle sends plain Lifecycle Object events to
the existing diagnostics channels. Agent adapts the terminal sink to its
existing observability implementation. The bus is not durable; a capability
that requires guaranteed delivery owns an outbox.

Alarm contribution, capability hooks, and capability-event delivery run outside
ambient host context.
Scheduled methods are user callbacks, so Scheduler invokes them in Lifecycle
Object or Agent context as appropriate.

## Testing capabilities

Capabilities are testable at every layer without module mocks or fake
services. Harness Durable Objects live one-per-capability in `tests/capabilities/`, with
their pool-only drivers in `tests/shared/` (see `tests/capabilities/AGENTS.md`), so every capability follows the same pattern:

1. **Pure domain logic** (timing parsers, selection rules) lives in
   dependency-free modules and is unit tested directly, e.g.
   `tests/schedules/timing.test.ts`.
2. **The capability in isolation, on a real Durable Object** —
   `withCapabilityHarness()` binds per-test-constructed capabilities to a
   real Lifecycle over real SQLite storage inside a bare harness object
   (the MCP client suites), while a capability whose tests need real
   platform dispatch gets a dedicated harness object with runtime handlers
   installed — `SchedulerHarnessObject` driven through real alarms in
   `tests/schedules/capability.test.ts`. The Workers vitest pool
   makes real objects cheap, so there is no fake-services seam to keep in
   sync with Lifecycle semantics.
3. **Lifecycle integration** proves cross-capability behavior: alarm
   arbitration across contributors, phase order, context boundaries, and
   eviction recovery — the per-functionality files in `tests/lifecycle/`.
4. **Host surface** tests exercise the capability through the complete
   `Agent` class and its public API — `tests/schedule.test.ts`, the MCP
   agent suites, and the think/ai-chat packages.

A new capability should arrive with layers 2 and 3; layer 1 applies when it
owns non-trivial pure rules.

## Host context

Lifecycle owns the AsyncLocalStorage read by `getCurrentAgent()`. The accessor
is exported from `agents/lifecycle`; the root `agents` export is the same
function for `Agent` compatibility.

Lifecycle establishes context only around semantic host hooks:

- startup and alarm expose the host;
- HTTP requests expose the host and request;
- WebSocket connect exposes the host, connection, and upgrade request;
- WebSocket message, close, and error expose the host and connection.

`getConnectionTags(connection, { request })` remains argument-driven because
both values are already explicit.

Capability hooks deliberately run outside the host context. Capabilities use
their own `this`, phase arguments, and explicit dependencies. Lifecycle exits
any inherited current-Agent context before invoking capability startup,
request, or alarm hooks, so behavior does not depend on the entrypoint that
triggered the phase.

User callbacks are the exception: when a capability invokes a named host
method through `this.lifecycle.callbacks.invoke()`, Lifecycle establishes the
host invocation context around that call. This is the one boundary a host
composition root may wrap — Agent substitutes its tracing invocation scope —
so every capability that dispatches user callbacks inherits the host's
invocation semantics without capability-specific hooks.

## Agent entry surfaces

The `Agent` class has entry surfaces beyond Lifecycle, including native Durable
Object RPC, WebSocket callables, email, schedules, fibers, chat turns, and
detached work. Its existing invocation wrappers continue to own those surfaces.
In particular, the automatic public-method wrapper is not made redundant by
Lifecycle because native Durable Object RPC does not pass through a Lifecycle
handler.

Tracing remains in Agent's existing invocation boundaries. Moving or
consolidating tracing in Lifecycle is separate work.

## WebSockets

Lifecycle WebSockets always use Cloudflare's Hibernation API. It accepts sockets
with `DurableObjectState.acceptWebSocket`, stores connection metadata in
attachments, and reconstructs `Connection` objects after hibernation.

There is no in-memory WebSocket mode.

## Identity

For supported named objects, `ctx.id.name` is authoritative. Lifecycle exposes
it as `lifecycle.name` and reads the historical `__ps_name` storage key only as
a migration fallback. It never writes a duplicate name.

## History

- [Alarm coordination](./alarm-coordination.md)
- [Durable Object lifecycle composition](./rfc-durable-object-lifecycle.md)
