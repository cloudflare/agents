Status: accepted

# Cold native RPC initialization

## Problem

Native Durable Object RPC dispatches straight onto the instance. The lifecycle
starts from the five handlers it installs — `fetch`, `alarm`,
`webSocketMessage`, `webSocketClose`, `webSocketError` — and from an explicit
`lifecycle.start()`. An RPC method is none of those, so `onStart` never runs
when the RPC is the call that wakes a cold instance. For an agent that idles
between messages, that is the normal case.

[#1990](https://github.com/cloudflare/agents/issues/1990) reports two symptoms.
Against `e87ad62b`, an empty `class ColdAgent extends Think {}` and a single
`stub.saveMessages([message])` reproduces the first verbatim:

```
TypeError: Cannot read properties of undefined (reading 'appendMessage')
```

`Think.session` is declared `session!: Session` with no initializer and is
assigned during startup, so a cold RPC reaches it as `undefined`.

The second symptom is quieter and worse. Seeding durable storage, evicting, then
reading over RPC a field that startup hydrates returns the wrong answer with no
error:

```
cold read after eviction => undefined     // "IMPORTANT" is durably stored
```

`getMessages()` returns `[]` for a conversation that has one, and
`getMcpServers()` reports every registered server as `not-connected`. A caller
cannot distinguish those from a genuinely empty result.

`Agent` already treats initialization as an entry-point responsibility. It calls
`__unsafe_ensureInitialized()` from `_cf_invokeAgentPath`, `_cf_initAsFacet`,
`_cf_scheduleDestroy` and the three `_workflow_*` methods. All six are
framework-internal. The surface users actually dial is the gap.

## Proposal

Widen the prototype wrapping `Agent` already performs.

The constructor calls `_autoWrapCustomMethods()`, which walks the prototype
chain and replaces methods with a wrapper that establishes `getCurrentAgent()`
context. Until now it excluded everything on `Agent.prototype`, so it only ever
wrapped user-defined methods. Removing that exclusion brings the framework's own
public API into scope, and the wrapper gains one branch:

```ts
if (this._rpcInitializationState !== "pending") {
  return method.apply(this, args);
}
return this.__unsafe_ensureInitialized().then(() => method.apply(this, args));
```

A four-state field tracks the boundary. The constructor arms `"pending"` in a
microtask under `blockConcurrencyWhile`, so a subclass calling its own methods
during construction stays synchronous and no external event can arrive in the
window. `onStart` sets `"starting"` then `"started"`, restoring the previous
value on failure so startup can be retried. The `"starting"` state is what stops
startup's own calls into public methods from recursing.

Only a constructed-but-unstarted instance defers. A warm call is unchanged.

The exclusion boundary is the framework's runtime surface: platform methods
derived from `DurableObject.prototype`, lifecycle callbacks derived from the
`LifecycleHostCallback` union and checked with `satisfies`, then runtime entry
points, lifecycle accessors, connection policy hooks, state hooks, `destroy()`,
and anything underscore-prefixed.

## Alternatives

**Document `await this.lifecycle.start()` and require callers to add it.** This
is what `design/rfc-durable-object-lifecycle.md` prescribes, and it works — a
user method with the line initializes correctly. It does not reach the reported
bug. The MRE is an empty subclass calling a framework method on the stub; there
is no user code in the path. The only workaround is overriding framework methods
purely to inject the line, repeated for every method ever called over RPC, on
signatures the subclass does not own. The issue asks specifically for no
per-method boilerplate.

**Call `lifecycle.start()` explicitly from every public method.** `Agent` has 82
public methods and `Think` has 60. Of those, 30 and 19 respectively are
synchronous, and around 40 would have to become async to accommodate an `await`.
That breaks every subclass overriding `getModel()` or `getTools()`. It is also
opt-in: a public method added later silently misses the call, and the bug
returns for that method alone. Wrapping fails closed — a name must be added to
the exclusion list to break it.

Most of that surface would not benefit either way. `_ensureSchema()` runs in the
constructor, so SQL-backed reads are already correct cold; seeding a
`cf_agents_schedules` row, evicting, then calling `getSchedules()` over RPC
returns the right answer on a fully uninitialized instance. The methods that
need startup are the ones reading in-memory state it hydrates. That set is
defined by implementation detail rather than by signature, so a curated list
would drift as implementations move.

**Wrap only `Agent.prototype` and `Think.prototype`, not user subclasses.** This
fixes the MRE and every silent case while leaving user prototypes untouched. It
reintroduces the footgun for a user method that calls a framework method, which
is the shape most likely to be written.

## Decision

Widen the existing wrapping.

The cost is real and worth stating. For a representative Think subclass the
wrapper covers 229 methods, of which 84 are user-defined and 145 are framework
methods — roughly a 2.7× widening. On the cold path a declared-synchronous
method returns a Promise while TypeScript still shows the synchronous signature.
That is a type-level inaccuracy, harmless over RPC where every call is awaited,
and confined to the one path where the alternative is a wrong answer.

Wrapping was not reintroduced by this change. `_autoWrapCustomMethods` predates
the lifecycle vendoring and survived it; [#2133](https://github.com/cloudflare/agents/pull/2133)
adjusted a single line of it for the removed base class and left the mechanism
alone. `Lifecycle.installHandlers()` performs the same kind of installation onto
its host, instance-level and guarded, which is why the factory is named
`install`.

The alternative that avoids reflection over our own surface costs about 40
breaking signature changes. Preserving those signatures is what buys the
wrapping.

## History

- [rfc-durable-object-lifecycle.md](./rfc-durable-object-lifecycle.md) — vendored
  the lifecycle and established `lifecycle.start()` as the explicit RPC contract
  this record extends.
