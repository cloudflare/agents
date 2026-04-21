---
"agents": minor
---

External addressability for sub-agents.

Clients can now reach a facet (a child DO created by `Agent#subAgent()`) directly via a nested URL:

    /agents/{parent-class}/{parent-name}/sub/{child-class}/{child-name}[/...]

New public APIs (all `@experimental`):

- `routeSubAgentRequest(req, parent, options?)` — sub-agent analog of `routeAgentRequest`. For custom-routing setups where the outer URL doesn't match the default `/agents/...` shape.
- `getSubAgentByName(parent, Cls, name)` — sub-agent analog of `getAgentByName`. Returns a typed Proxy that round-trips typed RPC calls through the parent. RPC-only (no `.fetch()`); use `routeSubAgentRequest` for external HTTP/WS.
- `parseSubAgentPath(url, options?)` — public URL parser used internally by the routers.
- `DEFAULT_SUB_PREFIX` — the `"sub"` separator constant.

New public on `Agent`:

- `onBeforeSubAgent(req, { class, name })` — overridable middleware hook, mirrors `onBeforeConnect` / `onBeforeRequest`. Returns `Request | Response | void` for short-circuit responses, request mutation, or passthrough. Default: void.
- `parentPath` / `selfPath` — root-first ancestor chains, populated at facet init time. Inductive across recursive nesting.
- `hasSubAgent(className, name)` / `listSubAgents(className?)` — parent-side introspection backed by an auto-maintained SQLite registry written by `subAgent()` / `deleteSubAgent()`.

New public on `useAgent` (React):

- `sub?: Array<{ agent, name }>` — flat root-first chain addressing a descendant facet. The hook's `.agent` / `.name` report the leaf identity; `.path` exposes the full chain.
- `subPrefix?: string` — matches the server's `subPrefix` (defaults to `"sub"`).

Breaking changes: none. `routeAgentRequest` behavior is unchanged when URLs don't contain `/sub/`. `onBeforeSubAgent` defaults to permissive (forward unchanged). `useAgent` without `sub` is unchanged. `subAgent()` / `deleteSubAgent()` gain registry side effects but preserve return types and failure modes. The `_cf_initAsFacet` signature gained an optional `parentPath` parameter.

See `design/rfc-sub-agent-routing.md` for the full rationale, design decisions, and edge cases. The spike at `packages/agents/src/tests/spike-sub-agent-routing.test.ts` documents the three candidate approaches considered for cross-DO stub passthrough and why the per-call bridge won.
