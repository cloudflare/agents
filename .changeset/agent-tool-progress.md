---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Add progress signalling and durable milestones for agent-tool sub-agents
(cloudflare/agents#1758, rfc-detached-agent-tools §progress, phases 4a + 4b).

A sub-agent running as an agent tool (awaited or detached/background) can now
report mid-run progress:

```ts
// Inside the child sub-agent (e.g. from a tool's execute):
await this.reportProgress({
  fraction: 0.6,
  phase: "deploying",
  message: "Generating menu page…"
});
```

These signals ride the child's own turn stream as a transient
`data-agent-progress` part, so they re-broadcast to the parent's connected
clients and surface on `AgentToolRunState.progress` via `useAgentToolEvents` — a
background-runs tray can render a live bar / phase / status line without drilling
in. Highlights:

- **`reportProgress({ fraction?, message?, phase?, data? }, { persist? })`** on
  chat agents (`@cloudflare/think`, `AIChatAgent`); a no-op with a dev warning on
  the base `Agent` and when called outside an active agent-tool run. The framework
  resolves the run id from the active turn — no threading required. Bursts are
  coalesced (latest-wins; a `fraction >= 1` "done" frame always flushes). `data`
  is live-only unless `{ persist: true }`.
- **`onProgress(run, progress)`** parent hook, fired best-effort from the tail
  for both awaited and detached runs.
- **Latest-snapshot persistence + recovery inspect.** The child stores a
  `progress_json` + `last_signal_at` on its run row and surfaces it through
  `inspectAgentToolRun().progress`, so a rehydrated parent reconstructs progress
  after eviction.
- **Resetting no-progress budget for detached runs.** Once a detached child has
  reported at least one signal, the backbone gives up if it then goes silent for
  `detachedNoProgressBudgetMs` (default 1h; per-run override via
  `detached: { noProgressBudgetMs }`), surfaced as `interrupted` with the
  `no-progress` reason. A child that never reports is bounded only by the absolute
  `detachedMaxBudgetMs` ceiling — we never give up on a run merely for being slow.

## Durable milestones (phase 4b)

Naming a `milestone` promotes a signal from the ephemeral tier to a **durable**
one — there is still only one emit method:

```ts
// Inside the child sub-agent:
await this.reportProgress({
  milestone: "sources-gathered",
  data: { sources: 2 }
});
```

- **Persisted + replayable.** Each milestone is one row on the child
  (`cf_agent_tool_milestones` / `cf_ai_chat_agent_tool_milestones`) with a
  monotonic per-run `sequence`. It rides the stream as a **persisted**
  `data-agent-milestone` part (vs. transient progress), so drill-in replay and a
  rehydrated parent both see it. Surfaced via `inspectAgentToolRun().milestones`
  and `AgentToolRunState.milestones` (deduped by `sequence`).
- **`onProgress` fires for milestones too** — the snapshot carries
  `progress.milestone`, so a consumer can branch on milestone vs. ephemeral.
- **`detached: { onMilestones }` chat convenience** (`@cloudflare/think` and
  `AIChatAgent`). When a configured milestone lands, the chat agent surfaces an
  idempotent synthetic chat message (keyed/idempotent per `(runId, name)`)
  _before_ the run finishes. Delivered from both the warm tail and the cold
  backbone reconcile; the deterministic id collapses them to at-most-once. Two
  modes (the `string[]` shorthand defaults to `"narrate"`):
  - `"narrate"` (default) — a synthetic **assistant** message injected directly
    (no inference): a cheap, honest status line that does not trigger a turn.
  - `"react"` — a **user-role** turn so the model responds to the milestone
    (steer, start dependent work). Costs a model turn.

  ```ts
  detached: { onMilestones: ["preview-ready"] } // narrate (default)
  detached: { onMilestones: { names: ["needs-approval"], mode: "react" } }
  ```

  Override the wording via `formatDetachedMilestone(run, milestone)`. These
  synthetic messages carry `metadata.source` so clients can render them as an
  agent **event** rather than a human turn (the example does this).

The awaitable join point (`awaitAgentToolMilestone`, phase 4c) is intentionally
not included here — it is gated behind a design addendum.
