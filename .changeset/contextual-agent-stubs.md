---
"agents": minor
---

Add opt-in contextual RPC between Agents and Lifecycle Objects. Pass
`{ rpc: "contextual" }` to `getAgentByName()`, `dynamicAgents.get()`,
`subAgent()`, `parentAgent()`, or `getSubAgentByName()` and every method call
on the returned stub carries the caller's identity (class, Durable Object id,
instance name, or `external` from a Worker) plus optional `context` hints to
the callee, where `getCurrentAgent().caller` exposes them, and opens an
`agents.rpc.call` span. Bridged facet calls thread the original caller through
every hop. `getAgentByName()` now accepts any Lifecycle Object, not only
Agents: `Lifecycle.install` defines the entry points this relies on
(`_cf_invoke`, `_cf_rpcIdentity`, `__unsafe_ensureInitialized`) on the host
class prototype once, leaving any the class already declares untouched.

The default stays the raw Durable Object stub. A contextual stub is a Proxy
rather than a runtime `Fetcher`; `nativeAgentStub()` unwraps it for runtime
APIs and RPC arguments. Caller context is untrusted metadata for correlation
only, never authorization.
