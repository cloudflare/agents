# Think — TODO

## Revisit

### WorkspaceLoopback `_agent` indirection

The current call chain for tool execution is:

```
Chat tool → WorkspaceLoopback → ThinkAgent.ws*() → Workspace facet
```

Each `ws*` method on ThinkAgent is a thin wrapper that calls `_ownedWorkspace(id).method()`. This exists because:

1. Facet stubs can't cross RPC boundaries (they're local DO references)
2. Only ThinkAgent can call `ctx.facets.get()` — the loopback is a WorkerEntrypoint, not the DO
3. The loopback itself is needed to create a separate RPC channel (avoids bidirectional streaming conflict)

**Question:** Is there a way to avoid the 10 `ws*` boilerplate methods on ThinkAgent? Possibilities:
- Can `ctx.facets.get()` work from inside a WorkerEntrypoint if it shares the same isolate?
- Could the Agents SDK expose a way to pass facet access tokens / handles across RPC?
- Could we use a single `wsCall(workspaceId, method, args)` dispatcher instead of 10 methods?
- Revisit once the facets API stabilizes — the experimental API may gain new capabilities

## Next up

- [ ] **Try it end-to-end** — use it for real with a workspace + AI model, fix whatever breaks
- [ ] **Model selection** — dropdown in thread header, store per-thread or global
- [ ] **Proposed changes layer** — staging area for agent writes, diff preview, merge/revert
- [ ] **Approval for dangerous tools** — `rm`, `bash` with destructive patterns
- [ ] **Persist tool call history** — compact log of what tools ran during each agent turn

## Later

- [ ] `executeCode` tool — run JS/TS in a sandboxed Worker
- [ ] Gatekeeper-style bindings — typed, auditable external service access
- [ ] `describeBinding` discovery — agent learns available tools at runtime
- [ ] Agent spawners — sub-agents for parallel task execution
- [ ] Hooks — push notifications from external services into threads
- [ ] Y.js for collaborative editing
