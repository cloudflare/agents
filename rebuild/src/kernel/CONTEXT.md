# Kernel

Pure primitives the whole system builds on: no I/O, no state, no ports, no domain
knowledge. See the [context map](../../CONTEXT-MAP.md) for how this relates to the
other contexts.

## Language

**IdSource**:
An injectable source of unique, URL-safe, prefix-delimited ids (e.g. `req_…`).
Deterministic implementations are injected in tests.
_Avoid_: uuid generator, id factory

**Stable hash**:
A deterministic short fingerprint of any JSON-serializable value, identical across
processes and regardless of key order. The basis for idempotency.
_Avoid_: content hash, fingerprint, checksum

**Canonical JSON**:
A serialization with sorted keys that produces stable output; the input to a
stable hash.

**AgentError**:
The root of the error taxonomy — an error carrying a string `code`. Thrown for
programmer/protocol faults.
_Avoid_: bare Error

**ErrorValue**:
A failure carried as a *value* (`{ name, message }`) through tool and action
results, rather than thrown. Lets a turn continue instead of crashing.
_Avoid_: tool result error, error object

**EventBus**:
A synchronous pub/sub bus that emits observability events. The one sanctioned way
domain code announces what happened.
_Avoid_: diagnostics channel, emitter, logger

**Observability event**:
A structured record `{ type, agent, name, payload, timestamp }` published on the
EventBus, where `agent` is the class name and `name` the instance name.

**Observability channel**:
A category (e.g. `state`, `rpc`, `message`, `fiber`, `schedule`) that an event
`type` prefix maps to; unknown types fall to `misc`.
_Avoid_: "channel" unqualified — a **Channel** in the Channels/Surfaces context is
a completely different thing (a surface a turn arrives on).
