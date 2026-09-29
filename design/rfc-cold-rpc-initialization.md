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
An empty `class ColdAgent extends Think {}` and a single
`stub.saveMessages([message])` reproduces the first:

```
TypeError: Cannot read properties of undefined (reading 'appendMessage')
```

`Think.session` is declared `session!: Session` with no initializer and is
assigned during startup, so a cold RPC reaches it as `undefined`.

The second symptom is quieter and worse: a read of state that startup hydrates
returns the wrong answer with no error. `getMessages()` returns `[]` for a
conversation that has one, and a caller cannot distinguish that from a genuinely
empty result.

`Agent` already treats initialization as an entry-point responsibility for its
framework-internal `_cf_*` and `_workflow_*` RPCs, which call
`__unsafe_ensureInitialized()`. The surface users actually dial is the gap.

## Proposal

Start the lifecycle from the wrapper `Agent` already installs around subclass
methods.

The constructor calls `_autoWrapCustomMethods()` once per class. It walks the
prototype chain below `Agent.prototype` and replaces each public method with
`withAgentContext`, which establishes `getCurrentAgent()` context for calls that
arrive outside a lifecycle hook — native RPC being the main one. For `async`
methods the wrapper gains one branch:

```ts
if (getCurrentAgent().agent !== this && !this.lifecycle.isStarted()) {
  await this.lifecycle.start();
}
```

- **The lifecycle owns the state.** `Lifecycle.isStarted()` exposes the
  lifecycle's own status; there is no second state machine on `Agent`.
- **Calls from inside this Agent never start it.** `onStart`, lifecycle hooks
  and wrapped methods all run with this Agent as the current agent, so startup
  calling its own public methods does not recurse. `lifecycle.start()` also
  returns immediately while startup is running: startup holds the input gate, so
  such a call can only come from startup itself (for example a capability
  calling a host method).
- **Synchronous methods stay synchronous.** Only functions that are `async` get
  the startup branch. A sync method keeps its return type on every path,
  including the one that wakes the instance, and a subclass constructor or field
  initializer calling its own sync helpers is unaffected.
- **Base `Agent` methods stay unwrapped.** Methods on `Agent.prototype` —
  connection policy hooks, `destroy()`, `getMcpServers()` and the rest — are not
  wrapped, so their signatures and the framework's synchronous decisions inside
  entry points are unchanged, and a cold alarm can still finish deleting a
  condemned Agent without startup recreating state.

Think's public API (`saveMessages`, `getMessages`, `addMessages`, `chat`,
`runTurn`, …) lives on `Think.prototype`, below `Agent.prototype`, so it is
covered. Think's underscore-prefixed host bridge methods and the dynamic agent
path RPCs are skipped by wrapping and call `__unsafe_ensureInitialized()`
directly.

Method discovery treats the nearest descriptor for a name as authoritative, so a
subclass getter shadowing an inherited method is not replaced. It no longer stops
at a fixed depth, and it does not re-wrap a function that is already a wrapper.

## Costs

- A non-`async` method that returns a Promise, or a synchronous method that
  reads state `onStart` hydrates, is not started by the wrapper. Declare it
  `async` or call `await this.lifecycle.start()` in it.
- Methods on `Agent.prototype` called over native RPC on a cold instance still
  run before startup. SQL-backed reads are correct cold because `_ensureSchema()`
  runs in the constructor; in-memory state such as live MCP connections is not.
- Startup resolves the object's name. An Agent addressed with `newUniqueId()` or
  `idFromString()` without a migrated legacy name now fails its first `async`
  subclass RPC with the lifecycle's addressing error instead of serving the call
  against uninitialized state. This ships as a minor release.

## Alternatives

**Document `await this.lifecycle.start()` and require callers to add it.** This
is what `design/rfc-durable-object-lifecycle.md` prescribes. It does not reach
the reported bug: the repro is an empty subclass calling a framework method on
the stub, so there is no user code in the path.

**Call `lifecycle.start()` explicitly from every public method.** Around 40
synchronous methods on `Agent` and `Think` would have to become async, breaking
every subclass overriding `getModel()` or `getTools()`, and a public method
added later silently misses the call.

**Wrap `Agent.prototype` too, with a hand-kept exclusion list.** An earlier
revision of this change did this, with a four-state field armed from a
constructor microtask. It made synchronous methods return a Promise on the cold
path while TypeScript still showed the synchronous signature, and every new
runtime hook had to be added to the exclusion list. The current design reaches
the same Think surface without either cost.

## History

- [rfc-durable-object-lifecycle.md](./rfc-durable-object-lifecycle.md) — vendored
  the lifecycle and established `lifecycle.start()` as the explicit RPC contract
  this record extends.
