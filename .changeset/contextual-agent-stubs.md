---
"agents": minor
---

Stubs from `getAgentByName()`, `dynamicAgents.get()`, `subAgent()`,
`parentAgent()`, and `getSubAgentByName()` now carry caller context. Every
method call delivers the caller's identity (class, Durable Object id, instance
name, or `external` from a Worker) plus optional `context` hints to the
callee, where `getCurrentAgent().caller` exposes them, and opens an
`agents.rpc.call` span. Bridged facet calls report the facet that called, not
the root that relayed it. `getAgentByName()` also accepts any Lifecycle Object,
not only Agents: `Lifecycle.install` defines the entry points this relies on
(`_cf_invoke`, `_cf_rpcIdentity`, `__unsafe_ensureInitialized`) on the host
class prototype once, leaving any the class already declares untouched.

The returned stub is a Proxy over the native stub, not a runtime `Fetcher`,
so it cannot be passed to a runtime API that takes a stub or sent as an RPC
argument. New `getStubByName()` returns the raw stub with the same startup
guarantee for those cases. Caller context is untrusted metadata for
correlation only, never authorization.
