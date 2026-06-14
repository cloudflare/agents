---
"agents": minor
---

Add first-class detached ("background") agent-tool runs with a durable
completion hook (cloudflare/agents#1752).

`runAgentTool(cls, { detached })` now dispatches a sub-agent **without blocking
the calling turn**, returning a `{ runId, agentType, status: "running" }` handle
immediately:

```ts
// Fire-and-forget — observe via agent-tool-event frames + onAgentToolFinish.
const { runId } = await this.runAgentTool(ImportAgent, {
  input,
  detached: true
});

// Or wire a durable, eviction-surviving completion callback (by METHOD NAME,
// like schedule()):
await this.runAgentTool(ImportAgent, {
  input,
  detached: { onFinish: "onImportDone", maxBudgetMs: 60 * 60 * 1000 }
});

async onImportDone(run: AgentToolRunInfo, result: AgentToolLifecycleResult) {
  // Branch on result.status: "completed" | "error" | "aborted" | "interrupted".
  // A budget give-up arrives as interrupted / reason "budget-exceeded".
}
```

Highlights:

- **Durable, exactly-once-on-the-happy-path completion.** A warm fast path
  (low-latency while the isolate is alive) plus a self-scheduling reconcile
  backbone (survives eviction / deploys) route through one guarded delivery
  funnel. Two independent ledger slots (finish / give-up) with a claim+lease
  mean a premature give-up can never dedupe a child's real late completion away.
- **No silent abandonment.** Detached runs are never sealed `interrupted` just
  because their dispatching turn ended (the normal state for a background run);
  the backbone owns them and re-arms on restart.
- **Bounded.** An absolute `maxBudgetMs` ceiling (default 24h, configurable via
  the `detachedMaxBudgetMs` static option) gives up — surfaced as `interrupted`
  with the new `budget-exceeded` reason — and tears the child down so an
  abandoned run cannot hold a concurrency slot forever.
- **`cancelAgentTool(runId)`** cancels a detached (or awaited) run by id through
  the same guarded path, so a wired `onFinish` still fires once with
  `status: "aborted"`.

A detached run deliberately does NOT inherit `options.signal` (it must outlive
the spawning turn); cancel it explicitly with `cancelAgentTool`.
