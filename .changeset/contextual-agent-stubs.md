---
"agents": minor
---

`getAgentByName()` now returns a contextual stub. Each method call carries the
calling Agent's identity (or `external` from a Worker) plus optional `context`
hints to the callee, where `getCurrentAgent().caller` exposes them, and opens
an `agents.rpc.call` span so cross-Agent hops are visible in traces. The stub
keeps its `DurableObjectStub<T>` type and native members (`id`, `name`,
`fetch`, `connect`). Pass `rpc: "native"` to receive the raw stub. Caller
context is untrusted metadata for correlation only, never authorization.
