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

- [Durable Object lifecycle composition](./rfc-durable-object-lifecycle.md)
