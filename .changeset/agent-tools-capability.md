---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Move agent tools into a Lifecycle capability with a parent role and a child role.

**Existing code keeps compiling and running.** `runAgentTool`, `cancelAgentTool`, `hasAgentToolRun`, `clearAgentToolRuns`, `maxConcurrentAgentTools`, the `onAgentToolStart` / `onAgentToolFinish` / `onProgress` hooks, `agentTool()`, the `agent-tool-event` wire frames and `useAgentToolEvents()` are unchanged. `Agent` now installs the `AgentTools` capability as `this.agentTools` and forwards to it. `Think` and `AIChatAgent` install `AgentToolsChild` as `this.agentToolsChild`; their `startAgentToolRun` / `inspectAgentToolRun` / `tailAgentToolRun` / `getAgentToolChunks` / `cancelAgentToolRun` methods and the `formatAgentToolInput` / `getAgentToolOutput` / `getAgentToolSummary` / `formatDetachedCompletion` / `formatDetachedMilestone` hooks keep their signatures.

**New policy options**

- `agentToolReplayOnConnect: { maxRuns, maxChunksPerRun }` (static option;
  `replayOnConnect` on `AgentToolsOptions`) bounds what one reconnecting client
  is replayed: the newest N runs, and the last N stored chunks of each. Dropped
  chunks still advance the frame sequence, so retained frames keep the sequence
  numbers an uncapped replay would use and `useAgentToolEvents()` dedupes as
  before. Both default to `Infinity` (today's behaviour); retention is unchanged.
- `maxConcurrentDetachedAgentTools` (live `Agent` field; `maxConcurrentDetached`
  on `AgentToolsOptions`) caps non-terminal DETACHED runs separately, inside the
  `maxConcurrentAgentTools` total. Default `Infinity`. A detached dispatch over
  the cap fails exactly like the total cap does — synchronous `error` result and
  row, `started` + `error` events, no child spawned.

**What changed underneath**

- The detached reconcile backbone is one singleflight Lifecycle job instead of a self-scheduling `_cfDetachedReconcileTick` schedule. Anything that listed schedules to observe it should read `agentTools.pendingDetachedReconcile()`.
- `cf_agent_tool_runs` is owned by the capability under its own schema version. Existing tables converge in place; new tables omit the never-read `input_redacted` column.
- Child-run chunk attribution is an explicit `observeChunk` / `observeError` tap from the harness's frame sender instead of a `broadcast()` override that parsed every outgoing frame. `interceptAgentToolBroadcast` and `AgentToolBroadcastHooks` are removed from `agents/chat`.
- Think and AIChatAgent share one child implementation. `AIChatAgent`'s `cf_ai_chat_agent_tool_runs` and `cf_ai_chat_agent_tool_milestones` rows fold into `cf_agent_tool_child_runs` and `cf_agent_tool_milestones` on first wake and the legacy tables are dropped. A Think turn that was skipped before running is sealed as `error` with a clear message, as before.
- Any `Agent` subclass can become an agent-tool child by installing `AgentToolsChild` and binding `setAgentToolsChildHost`.
- `AgentTools` exposes only its operations: `run`, `cancel`, `has`, `clear`, `replayToConnection`, `recoveryRunIds`, `scheduleStartupRecovery`, `reconcile`, `hasOutstandingDetachedRuns`, `pendingDetachedReconcile`, `armDetachedBackbone`, `reconcileTick`. The storage and streaming internals (`readRun`, `resultFromRow`, `updateTerminal`, `deliverDetachedTerminal`, `reattachToTerminal`, `forwardStream`, `broadcastStoredChunksFromAdapter`, `runDeferredFinishHooks`) are private; deferred finish hooks are drained inside `scheduleStartupRecovery`, their only caller. `getAgentToolsHost` is exported alongside `setAgentToolsHost` so a host can re-install a wrapped port.
- A milestone reached while the parent is tailing a detached child live is now delivered on the warm path instead of waiting for a reconcile tick (the run row read while forwarding did not project the run's milestone configuration).
- A child run that ends in `error`, `aborted` or `skipped` no longer calls the harness's `getAgentToolOutput` / `getAgentToolSummary` hooks, so overrides with completion side effects only run for a completed turn. Such a row carries no summary, matching what the parent already surfaced for a non-completed inspection.
- `AIChatAgent` deployments whose legacy `cf_ai_chat_agent_tool_runs` table predates the progress columns now fold in correctly instead of throwing during startup.
