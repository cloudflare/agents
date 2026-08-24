# Durable Object lifecycle

`Lifecycle` is the composition root that turns a Cloudflare Durable Object into
an Agent. It owns runtime handlers, ordered capability phases, current Agent
context, and hibernating WebSocket connections.

The base `Agent` interface exported from `agents/lifecycle` extends Cloudflare's
`DurableObject`, requires the installed `Lifecycle`, and declares the optional
semantic hooks Lifecycle dispatches. The batteries-included `Agent` class
exported from `agents` is one implementation. It installs the same Lifecycle,
then adds state, RPC, scheduling, MCP, workflows, fibers, and sub-agents.

## Capability and user phases

Lifecycle runs startup in this order:

1. capability `onStart` hooks in registration order;
2. the Agent's `onStart` hook.

For an HTTP request, capability `onRequest` hooks run in registration order. The
first `Response` wins; otherwise the Agent's `onRequest` handles the request.
For an alarm, capability `onAlarm` hooks run in registration order before the
Agent's `onAlarm`.

Failures stop the phase and propagate. Failed startup remains retryable. Native
RPC methods explicitly call `lifecycle.start()` because native Durable Object
RPC bypasses Lifecycle handlers.

## Current Agent context

Lifecycle owns the AsyncLocalStorage used by `getCurrentAgent()`. The canonical
accessor is exported from `agents/lifecycle`; the root `agents` export is the
same function for compatibility.

Lifecycle establishes context around capability hooks and semantic Agent hooks:

- startup and alarm expose the Agent;
- HTTP requests expose the Agent and request;
- WebSocket connect exposes the Agent, connection, and upgrade request;
- WebSocket message, close, and error expose the Agent and connection.

`getConnectionTags(connection, { request })` remains argument-driven. Both
values are already explicit, and there is no demonstrated need for ambient
context in that hook. Lifecycle contains a local TODO to revisit this if shared
callback code develops a concrete requirement.

Context supports shared code whose Agent is selected only at invocation time.
It does not alter phase ordering: capability startup still precedes Agent
startup, and each capability restores only the state it owns. Context is not a
service locator; capabilities receive durable dependencies such as storage,
bindings, clocks, authentication, observability, and protocol adapters
explicitly at construction.

## Additional entry surfaces

The batteries-included Agent has entry surfaces beyond Lifecycle, including
native Durable Object RPC, WebSocket callables, email, schedules, fibers, chat
turns, and detached work. Its existing invocation wrappers continue to own
those surfaces. In particular, the automatic public-method wrapper is not made
redundant by Lifecycle because native Durable Object RPC does not pass through a
Lifecycle handler.

Tracing also remains in the batteries-included Agent's existing invocation
boundaries. Moving or consolidating tracing in Lifecycle is separate work.

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

- [Durable Object lifecycle composition](./rfc-durable-object-lifecycle.md)
