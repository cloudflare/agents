# Durable Object lifecycle

`Lifecycle` owns Durable Object runtime handlers, ordered capability phases,
and hibernating WebSocket connections. A host extends the platform
`DurableObject`, installs one lifecycle, and composes capability objects with
`use()`.

## Capability phases

Lifecycle runs capability hooks in registration order:

1. capability startup;
2. host `onStart`;
3. capability request interception, where the first `Response` wins;
4. host `onRequest`;
5. capability alarm work;
6. host `onAlarm`.

Failed startup remains retryable. Native RPC methods explicitly call
`lifecycle.start()` because RPC bypasses `fetch`.

## Host execution policy

A host may provide `runCapabilityPhase` when it needs all capability work to run
inside host-owned invocation context, tracing, or error policy. Lifecycle passes
one complete phase operation to this boundary and retains ordering and request
interception policy.

The boundary receives only phase-specific context. Lifecycle does not expose its
host or pass `Env` implicitly. Capabilities receive runtime dependencies such as
storage and bindings explicitly at construction.

Agent uses this seam to establish `getCurrentAgent()` context and restore facet
identity before capability startup. This lets it install the same
`MCPClientManager` object as a plain Durable Object. MCP receives Agent's `env`
explicitly to reconstruct persisted RPC bindings.

## History

- [Durable Object lifecycle composition](./rfc-durable-object-lifecycle.md)
- [Lifecycle capability execution boundary](./rfc-lifecycle-capability-execution-boundary.md)
