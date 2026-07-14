# State container is transport-free (it does not know connections)

**Status: implemented.** `StateSource` is `{ kind: "server" } | { kind: "client" }`;
the Agent supplies the client's `sourceId` on the published `state:changed` event,
and the websocket-chat adapter owns exclusion + readonly rejection.

The `StateContainer` keeps only **coarse provenance** — `{ kind: "server" | "client" }` —
and never a connection identity. It exposes "the value changed"; it does not
broadcast to, or exclude, specific connections. Origin echo-suppression, readonly
rejection, and the `cf_agent_state` / `cf_agent_state_error` framing live in the
**websocket-chat transport adapter** instead. This deliberately deviates from audit
doc 04's proposed interface, which threaded a `connectionId` through `StateSource`
and had the container compute `broadcast(state, excludeConnectionId)`.

## Why

The *only* reason the container ever needed a `connectionId` was to avoid echoing
a change back to the client that already applied it optimistically. That is a
transport-layer optimization, and "which connection sent this" is transport-layer
knowledge — the transport is the only party that knows it. Pulling it out of the
domain type means `State` references no transport concept at all: it becomes a
plain durable, observable JSON cell, the same *kind* of thing as the scheduler or
the task queue, and it sits cleanly inside **Durable Runtime**. The Web Client
Protocol context simply subscribes to state changes and mirrors them, excluding
the originating connection using its own knowledge.

## Consequences

- **Provenance-based authorization splits by owner.** Invariant validation ("this
  value must always be well-formed") stays in `State` and needs at most the coarse
  `server`/`client` tag. Connection-specific authorization (readonly connections,
  "clients may not touch field X") lives with the initiator — the websocket-chat
  adapter — which is where connection identity is known.
- **Guard against regression.** A future reader comparing against the original
  Agent (or audit doc 04) will expect `setState(next, source)` with a
  `connectionId` and a `broadcast` that excludes it. Reintroducing `connectionId`
  into `State` would re-leak a transport concept into the domain and should be
  rejected.
