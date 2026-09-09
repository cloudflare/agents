---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Move agent tools into a Lifecycle capability with a parent role and a child role.

**Existing code keeps compiling and running.** `runAgentTool`, `cancelAgentTool`, `hasAgentToolRun`, `clearAgentToolRuns`, `maxConcurrentAgentTools`, the `onAgentToolStart` / `onAgentToolFinish` / `onProgress` hooks, `agentTool()`, the `agent-tool-event` wire frames and `useAgentToolEvents()` are unchanged. `Agent` now installs the `AgentTools` capability as `this.agentTools` and forwards to it. `Think` and `AIChatAgent` install `AgentToolsChild` as `this.agentToolsChild`; their `startAgentToolRun` / `inspectAgentToolRun` / `tailAgentToolRun` / `getAgentToolChunks` / `cancelAgentToolRun` methods and the `formatAgentToolInput` / `getAgentToolOutput` / `getAgentToolSummary` / `formatDetachedCompletion` / `formatDetachedMilestone` hooks keep their signatures.

**What changed underneath**

- The detached reconcile backbone is one singleflight Lifecycle job instead of a self-scheduling `_cfDetachedReconcileTick` schedule. Anything that listed schedules to observe it should read `agentTools.pendingDetachedReconcile()`.
- `cf_agent_tool_runs` is owned by the capability under its own schema version. Existing tables converge in place; new tables omit the never-read `input_redacted` column.
- Child-run chunk attribution is an explicit `observeChunk` / `observeError` tap from the harness's frame sender instead of a `broadcast()` override that parsed every outgoing frame. `interceptAgentToolBroadcast` and `AgentToolBroadcastHooks` are removed from `agents/chat`.
- Think and AIChatAgent share one child implementation. `AIChatAgent`'s `cf_ai_chat_agent_tool_runs` and `cf_ai_chat_agent_tool_milestones` rows fold into `cf_agent_tool_child_runs` and `cf_agent_tool_milestones` on first wake and the legacy tables are dropped. A Think turn that was skipped before running is sealed as `error` with a clear message, as before.
- Any `Agent` subclass can become an agent-tool child by installing `AgentToolsChild` and binding `setAgentToolsChildHost`.
