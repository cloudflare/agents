Status: accepted

# Durable Object component lifecycle

## The problem

`Agent` currently owns the integration code for every durable capability. MCP
connection restoration, OAuth callbacks, tool contribution, protocol updates,
observability, and cleanup are spread across the base class. Scheduling and
managed fibers have similar coupling.

The first MCP extraction in
[#1895](https://github.com/cloudflare/agents/pull/1895) introduced an internal
`AgentLifecycle`, but the client manager still discovered a large, implicit
Agent host through a `WeakMap`. This made the manager harder to construct and
prevented a plain Durable Object from using it. It also put the Agent-specific
`onTurn` phase in the same abstraction as Durable Object startup and request
handling.

Agents already inherits its Durable Object and WebSocket lifecycle from
PartyServer. Keeping that substrate in a separately released repository makes
it difficult to establish one lifecycle boundary shared by `Agent` and
standalone Durable Objects.

## The proposal

### Vendor the Durable Object substrate

Vendor PartyServer as the `packages/partyserver` workspace package and re-export
it from `agents/lifecycle`. Keeping the existing package name preserves the
nominal `Server` identity used by PartyServer helpers and existing consumers.
The initial source comes from
[`cloudflare/partykit@f0a2e97d`](https://github.com/cloudflare/partykit/commit/f0a2e97d233f24545b2648aec2ed6a191e11074e),
which contains `partyserver@0.5.10`. Preserve its ISC license, routing helpers,
`Server` callbacks, connection behavior, and public type shapes.

`Agent` extends this vendored `Server`. Existing exports from `agents` keep
their names and behavior. The new subpath is additive.

### Compose durable components explicitly

`DurableObjectLifecycle` runs an ordered collection of
`DurableObjectLifecycleComponent` values. A component may participate in these
initial phases:

- `onStart`: durable initialization and recovery;
- `onRequest`: optional HTTP request interception;
- `onAlarm`: work triggered by the host's physical alarm;
- `onDispose`: explicit resource cleanup before host deletion.

The lifecycle applies one policy per phase:

- startup and alarm hooks run sequentially in component order;
- request handling stops at the first component response;
- disposal runs every component in reverse order and reports all failures;
- a startup, request, or alarm failure stops that phase and propagates.

The component collection is resolved lazily and then fixed for the lifetime of
the in-memory Durable Object. This lets derived class fields replace defaults
after `super()` while ensuring that the component started is also the component
disposed.

The vendored `Server` drives these phases around its existing user hooks.
Standalone classes that extend the native `DurableObject` can instead construct
and delegate to `DurableObjectLifecycle` directly.

Components receive only phase-specific context. Storage, environment bindings,
protocol publication, observability, authentication, and other capabilities
are explicit constructor dependencies supplied by the composition root. A
component does not receive the whole `Agent` and does not discover a hidden
host adapter.

### Keep higher-level capabilities separate

An AI turn is not a Durable Object lifecycle phase. MCP tool contribution will
be an explicit Agent-level capability layered on top of the durable component,
not an `onTurn` method on the generic lifecycle.

The lifecycle dispatches alarms but does not schedule or arbitrate the single
physical Durable Object alarm. The host retains alarm ownership. A later
scheduler or fiber extraction can contribute due work while one host-level
arbiter chooses the next alarm timestamp.

`onDispose` is explicit. The Workers runtime does not provide an eviction or
destructor callback, so the API must not imply that cleanup runs on ordinary
isolate eviction.

Native Durable Object RPC also bypasses `fetch()`. Lifecycle-aware components
must either expose self-initializing operations or be hosted by a base class
that guards RPC entry points; request lifecycle alone cannot intercept
arbitrary RPC methods.

### Simplify names without breaking old objects

For named addressing, `ctx.id.name` is the source of truth. Cloudflare has
provided it for `idFromName()` and `getByName()` since 2026-03-15, including
alarm wakeups. Vendoring therefore removes the redundant write that copied each
native name into `__ps_name`.

Compatibility fallbacks remain for now:

- read existing `__ps_name` records;
- retain the `setName(name, props)` wire method and raw-ID bootstrap behavior;
- retain the deprecated `x-partykit-room` header fallback;
- preserve Agent facet logical names and path-v2 routed identities.

Those paths cover old alarm records, mixed-version deployments, and callers
using `newUniqueId()` or `idFromString()`. Removing them requires an explicit
major-version migration, not this refactor.

## Alternatives

### Keep PartyServer external and add lifecycle upstream

This preserves package ownership but keeps the Agents architecture dependent on
a second repository and release train. The lifecycle is being introduced to
extract Agent capabilities, so Agents needs to own and test the composition
boundary.

### Keep an internal Agent-only runner

This is the shape used by #1895. It reduces code in `Agent`, but it cannot host
the same component in another Durable Object and encourages broad Agent host
interfaces.

### Give every component every PartyServer and Agent hook

A universal hook bag would include WebSocket events, AI turns, state protocol,
and other unrelated concerns. It makes the abstraction broad before a concrete
component needs those phases. New phase-specific interfaces can be added when a
second implementation proves the need.

### Use middleware with `next()` for every phase

Middleware is flexible but gives each component responsibility for continuing
the chain and makes teardown/error policy implicit. Ordered hooks with a fixed
policy have lower caller burden for durable capabilities.

### Start user lifecycle code in the base constructor

Derived fields are not initialized while `super()` runs, and user startup can
exceed the runtime limits of constructor-time `blockConcurrencyWhile()`. Lazy
startup at an actual entry point preserves current Server semantics.

## The decision

Agents owns the vendored `partyserver` workspace package and re-exports it from
`agents/lifecycle`. A small Durable Object component lifecycle handles only
startup, HTTP interception, alarm dispatch, and explicit disposal. Components
use explicit dependencies, while Agent-specific turn and protocol integration
remain separate adapters. Existing Agent and PartyServer-compatible behavior is
preserved during the refactor.
