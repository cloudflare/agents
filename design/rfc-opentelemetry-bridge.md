# RFC: OpenTelemetry API on Workers tracing

Status: accepted (shipped as `experimental_registerOpenTelemetry`, undocumented)

## The problem

Libraries instrument themselves with the OpenTelemetry JS API
(`@opentelemetry/api`). The MCP TypeScript SDK v2 records a span per MCP
request by default (modelcontextprotocol/typescript-sdk#3115), and AI SDK v6
records spans under `experimental_telemetry`. On Workers nothing registers an
implementation of that API, so all of it is a no-op. Workers' own tracing
(`import { tracing } from "cloudflare:workers"`) is a different, smaller API.

Workers plans to register the OpenTelemetry API natively. Until then
users need a bridge, and the Agents SDK needs one for MCP servers and clients.

## The proposal

`experimental_registerOpenTelemetry()` in `agents/observability` registers a global OTel
context manager and tracer provider whose spans are native spans
(`src/observability/otel/`). One call, no options, no return value.

### How spans open

Native tracing has no manual parent wiring. A span's parent is whatever native
span is active in the async context when it opens, and a span is active only
inside the callback that opened it (`tracing.startActiveSpan(name, cb)`).

Every OTel span opens with `tracing.startActiveSpan`, and the bridge captures
`AsyncLocalStorage.snapshot()` inside the callback. The snapshot includes the
native active span: running a function inside it makes that span the active
parent again. Verified in workerd 2026-10 (`wrangler` 4.153).

- `startActiveSpan` runs the caller's function inside the native callback.
- `startSpan` returns from the native callback at once. The span is open
  (correct start time) and inactive, as OTel requires.
- `context.with(trace.setSpan(ctx, span), fn)` and `context.bind` run `fn`
  inside the span's snapshot when the span is not the active native span.
- A child whose parent is an inactive span the bridge opened is opened inside
  the parent's snapshot.

The MCP SDK uses exactly the `startSpan` then `context.with` pattern: the server
wraps the handler, and the client first wraps `propagation.inject` and then,
separately, the transport send.

### What is refused

A span opens only where its native parent is the span the caller asked for.
Otherwise the call returns a non-recording span that carries the requested
parent's span context (OTel's no-SDK behavior), so descendants are refused too:

- remote or foreign parents (`trace.setSpanContext`, `wrapSpanContext`)
- `root: true` and contexts without a span
- explicit `startTime`
- a parent span from another request (trace IDs differ)
- calls outside a request

Durable Object constructors and `blockConcurrencyWhile` callbacks are a special
case: `tracing.getActiveSpan()` returns `undefined` there, yet native spans
opened there still parent to the request. A span requested under the ambient
context in that state opens natively and the runtime picks the parent; at
module scope the runtime records nothing.

Kinds are accepted and not recorded. Creation links, later links, and events
other than exceptions are dropped. Array attributes are dropped, not
serialized. Unsupported features are reported once each through `diag`, with
no payloads.

### Registration

- Idempotent while registered; re-registers after a full `context.disable()`
  plus `trace.disable()`.
- When both a context manager and a tracer provider are already registered by
  someone else, it steps aside and does nothing.
- When only one is registered, or the global registry belongs to an
  incompatible `@opentelemetry/api` version, it throws.

`@opentelemetry/api` becomes a regular dependency of `agents` (it has no
dependencies of its own, and the MCP SDK and AI SDK already depend on it). The
bridge ships only from `agents/observability`; the main `agents` entry does not
load it (`src/node-tests/observability-bundle.test.ts`).

## The alternatives

**Open `startSpan` spans with `tracing.startSpan`.** A span opened that way can
never become active, so `context.with` changes only the OTel context and
children of the span are refused. That drops every MCP span: they are
`CLIENT`/`SERVER` spans created with `startSpan` and activated with
`context.with`.

**Open `startSpan` spans lazily, on the first `context.with`.** That nests the
MCP server correctly, but the MCP client's first `context.with` wraps only
`propagation.inject`, so the transport send (the second `context.with`) runs
outside the span. A span that is never activated also gets a zero-length
native span at `end()`. Opening eagerly and re-entering through a snapshot
fixes both, and lets an inactive span parent children.

The cost of snapshots: the re-entered callback sees the other
`AsyncLocalStorage` values from where the span started. Restoring happens only
when a span the bridge opened is made active from somewhere it is not already
the active native span (within the same trace), and in the MCP SDK the start
and activation happen in the same synchronous code. The export is experimental
and undocumented for now; user docs come with a stable name.

**Refuse non-`INTERNAL` kinds.** The bridge records the span without a kind
instead. A `span.kind` style attribute would be a made-up schema that
dashboards would come to depend on and that would duplicate the real field
once Workers has one. MCP spans carry their meaning in attributes
(`mcp.method.name`).

**Refuse spans created with links.** The bridge records the span and drops the
links. Links do not change parentage, so dropping them loses data but invents
nothing. The MCP server passes links only together with a remote parent, which
is refused anyway.

**Record explicit start times at "now".** Refused instead: it would report the
wrong duration.

**Serialize array attributes to JSON.** Dropped instead, matching the AI SDK
wrapper's existing policy.

**Throw on any competing registration.** The bridge steps aside when OTel is
fully registered, so that once Workers registers the OTel API natively the call
becomes a no-op without users changing code. It still throws on a
half-registered setup.

Status, renames, and span IDs map straight to the runtime's `setStatus`,
`updateName`, and `spanContext`; the runtime already applies OTel's status
rules (`OK` final, `UNSET` no effect, message only with `ERROR`). On runtimes
without them, the calls are dropped with a `diag` message. A native call that
throws is swallowed and reported through `diag`, as in `AgentTracer`.

## One path for Agents SDK spans

Today `AgentTracer` (`src/observability/tracing/`) writes native spans directly
for agent lifecycle spans, the AI SDK wrapper, Think, and the GenAI spans. Those
spans nest correctly with bridged OTel spans in both directions, because both
sit on native async context (covered by the `agent-spans` case of
`src/otel-tests`).

Moving them onto the OTel API is mostly mechanical: `AgentTracer` only needs a
`SpanRuntime` (`startActiveSpan(name, run)` with `isTraced`, `setAttribute`,
`end`), which a few lines can implement over any OTel `Tracer`. The switch is
not behavior-neutral, though (see the decision below):

- With no OTel registration, agent spans must keep recording natively. The
  runtime would use `trace.getTracer("agents")` when a provider is registered
  and the bridge's tracer (unregistered) otherwise.
- With a user's own OTel SDK registered, agent spans would move from Workers
  tracing to that SDK. That is the goal of "one mechanism", but it is a
  user-visible change.
- The bridge refuses spans under remote or inactive parents; native spans
  never are. Agent spans opened inside such a context would stop recording.

Once Workers registers the OTel API natively, the bridge steps aside and the
same code paths go to the native implementation.

## The decision

Ship the bridge as `experimental_registerOpenTelemetry()` in
`agents/observability`, opt-in and undocumented while it is a temporary
adapter. A bridge is partial by nature: `traceFlags` from `spanContext()` does
not reflect Workers sampling, and new roots, foreign parents, kind, links,
events, and array attributes cannot be represented.

Agents SDK spans stay on native Workers tracing. Moving them onto the bridge
was tried (#2753) and dropped: the trace data was identical (names, attributes,
nesting, verified against production), but it added the bridge's refusal
cases, a dependency on `getActiveSpan()`, and a global OTel registration for
every Agents user. The one gain, error status on failures, is a direct native
`setStatus()` call (#2763).
