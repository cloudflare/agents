# Durable Runtime

Generic, stateful durable-object capabilities — not chat- or even agent-specific.
Durable behavior built on the KV + alarm ports: scheduling, durable execution
(fibers), the task queue, observable state, and the RPC registry. See the
[context map](../../../CONTEXT-MAP.md).

## Scheduling

**Scheduler**:
The alarm multiplexer that persists many logical schedules and keeps the single
Durable Object alarm set to the earliest pending one.
_Avoid_: alarm multiplexer (describe it, don't rename)

**Schedule**:
A persisted logical timer: `{ id, callback, payload, spec, nextRunAt }`.
_Avoid_: schedule row

**ScheduleSpec**:
The kind + timing of a schedule: `once` (a time), `interval` (every N seconds), or
`cron` (expression).

**Schedule DSL**:
The human-friendly schedule language (e.g. `"every day at 08:00 in Europe/London"`)
parsed into a ParsedSchedule (`interval` or `wall-clock`).
_Avoid_: Think DSL

**No-backfill**:
The rule that a late-firing alarm runs the intended occurrence once and arms the
next *future* one — missed occurrences are never backfilled.

**Internal callback**:
A callback namespaced `$internal:<name>` (keep-alive heartbeat, housekeeping,
declared tasks) hidden from user-facing schedule listings.

**KeepAlive**:
A ref-counted heartbeat that keeps the alarm armed (via an internal interval) while
at least one ref is held, preventing idle eviction.
_Avoid_: heartbeat (loosely)

## Fibers (durable execution)

**Fiber**:
A named async closure executed now and registered durably *before* it runs, so a
mid-run eviction leaves a recoverable row.

**Run row**:
The transient durable row inserted before a closure runs and deleted/settled after.
_Avoid_: confusing with a Delegation *agent-tool run*.

**Stash / snapshot**:
`stash` is the synchronous full-replacement checkpoint; the snapshot is the persisted
value handed to recovery. The closure itself is never persisted.

**Managed fiber**:
A fiber started with a retained ledger row + idempotency key; a duplicate `start`
returns the retained status (`accepted: false`) instead of re-running.
_Avoid_: plain fiber = the transient `run` variant whose row is deleted on completion.

**Interrupted**:
The status of a fiber whose process died mid-run (an orphaned run row), surfaced to
the recovery hook.

**Recovery scan**:
`checkInterrupted` — the startup/housekeeping pass that finds orphaned run rows and
drives them through the `onRecovered` hook.
_Avoid_: recovery (unqualified) — Reliability and Delegation have their own.

## Task queue

**TaskQueue**:
A durable FIFO of named-callback tasks that execute strictly in insertion order, one
in flight at a time (single-flight).

**QueueItem**:
A persisted queue row: `{ id, callback, payload, createdAt, attempts }`.

**Flush**:
Draining pending rows now (on startup and after enqueue); a flush while one is
running is a no-op join.

## State

**StateContainer**:
A durable, observable JSON cell with lazy load, validation, and change notification.
Transport-free by design (ADR-0001).

**StateSource**:
The coarse provenance of a change: `{ kind: "server" }` or `{ kind: "client" }` —
never a connection identity (ADR-0001).
_Avoid_: the Agent's `StateOrigin` carries a `sourceId`; the container's StateSource
does not.

## RPC

**Callable**:
A method opted into RPC over a connection, via the `@callable` decorator or explicit
registration.

**CallableRegistry**:
The registry that holds callables and dispatches RpcRequests to responses (including
streaming).
_Avoid_: the request/response *framing* over a connection is a transport-adapter
concern, not this registry's.
