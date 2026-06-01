---
"agents": minor
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Re-attach to a still-running sub-agent (`agentTool()`) run on parent recovery instead of abandoning and re-running it (#1630).

When a parent agent was interrupted (deploy / Durable Object eviction) while a child `agentTool()` run was still in flight, recovery marked the run `interrupted` within a ~5s window and the parent re-issued the task — re-running the child's already-completed work. For long-running children under continuous deploys this surfaced to users as "the agent went all the way back and lost the files it already wrote."

Three changes fix this:

- **Stable child runId.** `agentTool()` now derives the child `runId` from the (recovery-preserved) tool call id (`agent-tool:<toolCallId>`) instead of minting a fresh `nanoid` per call. A turn re-run by chat recovery now resolves to the **same** idempotent child facet rather than spawning a brand-new one, so completed child work is never re-run.
- **Bounded re-attach.** A duplicate non-terminal `runId` (in `runAgentTool`) and a still-running child during startup reconciliation now **tail the live child to its real terminal result** and collect it, instead of immediately sealing `interrupted`. Re-attach is bounded by a generous wall-clock budget (`DEFAULT_AGENT_TOOL_REATTACH_TIMEOUT_MS`, 120s, internal): a child that keeps advancing toward terminal within the window is collected; a genuinely hung child still seals `interrupted` so recovery can never block forever.
- **Durable child-run reconcile.** A child facet self-heals its interrupted turn via its own `chatRecovery`, but that recovery path never wrote the child's agent-tool run row — so after a real eviction the row stranded `running` (think) / was force-errored (ai-chat) and the parent could never collect the recovered result. Both `@cloudflare/think` and `@cloudflare/ai-chat` now reconcile a stale child-run row from the durable transcript on inspect: while recovery is still resolving the row stays `running`; once it settles, a completed assistant response surfaces as `completed` (so the parent collects the real result) and an empty/failed recovery as `error`. This keeps the child's own (working) recovery path untouched.

No new public configuration. Adds an internal `agent_tool:recovery:reattach` observability event. `@cloudflare/think` and `@cloudflare/ai-chat` child tails are now read-only on consumer detach (a parent's re-attach budget expiring never cancels the still-running child).
