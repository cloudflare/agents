Status: accepted

# Lifecycle capability execution boundary

## Problem

`Lifecycle` owns ordered capability startup, request interception, and alarm
handling. `Agent` also owns invocation context, tracing, startup error policy,
and persisted facet identity.

Installing `MCPClientManager` directly exposed a mismatch: capability hooks ran
outside Agent's invocation context and before facet identity was hydrated. A
private Agent adapter preserved behavior by manually calling the manager's
lifecycle hooks, but duplicated Lifecycle dispatch and could drift when a
capability gained another phase.

## Proposal

Allow a host to supply one optional capability execution boundary when it
constructs `Lifecycle`:

```ts
Lifecycle.install(this, {
  runCapabilityPhase: (context, operation) =>
    runInHostContext(context, operation)
});
```

Lifecycle continues to own phase ordering and first-response request semantics.
The boundary receives phase-specific context and the complete operation for one
phase. It does not receive or expose the host.

Agent uses the start boundary to establish invocation context and hydrate its
persisted facet identity before capability startup. It uses the request boundary
to expose the current request. MCP can then be installed directly as the public
capability object.

Runtime dependencies remain explicit capability inputs. In particular,
`MCPClientManager` receives `env` when it must reconstruct persisted RPC
connections from binding names; Lifecycle does not pass its host or `Env` to
capabilities.

## Alternatives

### Keep an Agent-specific MCP adapter

This preserves behavior but duplicates capability dispatch and couples the
adapter to MCP's current set of hooks.

### Pass the Lifecycle host to every capability

This recreates the broad implicit host contract: every capability could inspect
all Agent and runtime state.

### Pass `getCurrentAgent` to Lifecycle

`getCurrentAgent` only reads invocation context. It cannot establish the context
that capability hooks require.

### Add middleware-style `next()` dispatch

This adds alternate ordering and interception policy that Lifecycle does not
need. The execution boundary surrounds one lifecycle-owned phase and cannot
reorder individual capabilities.

## Decision

Add the optional capability execution boundary. Keep capability dependencies
explicit, install `MCPClientManager` directly, and remove the private Agent MCP
lifecycle adapter.
