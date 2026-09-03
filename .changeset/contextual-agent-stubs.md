---
"agents": minor
---

`getAgentByName()` now returns a contextual stub and accepts any Lifecycle
Object, not only Agents. Each method call carries the caller's identity (class,
Durable Object id, instance name, or `external` from a Worker) plus optional
`context` hints to the callee, where `getCurrentAgent().caller` exposes them,
and opens an `agents.rpc.call` span so cross-object hops are visible in traces.
`Lifecycle.install` defines the entry points this relies on (`_cf_invoke`,
`_cf_rpcIdentity`, `__unsafe_ensureInitialized`) on the host class prototype
once, leaving any the class already declares untouched. Dynamic-agent stubs
from `dynamicAgents.get()`, `subAgent()`, `parentAgent()` (both branches), and
`getSubAgentByName()` carry the caller too, threaded through the facet bridge
hops so the final object sees the original caller. The stub
keeps its `DurableObjectStub<T>` type and native members (`id`, `name`,
`fetch`, `connect`). Pass `rpc: "native"` to receive the raw stub. Caller
context is untrusted metadata for correlation only, never authorization.
