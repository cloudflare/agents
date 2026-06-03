---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Fix: a deploy that interrupts an in-flight `runAgentTool` child no longer abandons the still-running child as `interrupted`.

Parent recovery re-attaches to a still-running child and tails it to its real terminal. Previously that re-attach used a flat 120s wall-clock budget that was **not** reset by the child's forward progress, so a healthy child whose recovery legitimately ran longer than the budget was sealed `interrupted` (and its already-completed work re-run from scratch), even while it was actively streaming.

The re-attach budget is now **progress-keyed**: it bounds how long the parent waits with _no_ forward progress from the child (resetting on every forwarded chunk), and is hard-bounded by the child's own recovery ceiling so a genuinely hung child still seals `interrupted` and can never block recovery forever. The parent re-arms (opens a fresh tail) **only when the child's stream closes cleanly while it is still advancing** — i.e. a re-evicted-but-progressing child. A full no-progress window (the child went silent) seals `no-progress` immediately even if the child streamed earlier in that window; it no longer grants a bonus window. This is both the honest stall signal and what keeps at most one pending tail reader alive per re-attach (no per-cycle reader accumulation).

`@cloudflare/think` and `@cloudflare/ai-chat` additionally finalize a child facet's own agent-tool run row as soon as its recovered turn settles — regardless of whether recovery took the continue path (`_chatRecoveryContinue`) or the pre-stream retry path (`_chatRecoveryRetry`) — so a re-attached parent collects the terminal result immediately instead of waiting out a full no-progress window after the child has already finished.

This release also adds:

- **Typed interrupted cause.** `RunAgentToolResult`, the `agentTool()` `AgentToolFailure` envelope, the `onAgentToolFinish` lifecycle result, and the `agent-tool-event` wire event (kind `"interrupted"`) now carry a machine-readable `reason` (`AgentToolInterruptedReason`: `"no-progress" | "window-exceeded" | "not-tailable" | "inspect-timeout" | "inspect-failed" | "recovery-deadline"`) and a `childStillRunning` boolean on `interrupted` results, so callers (and UIs) can branch on _why_ a run was abandoned (and whether the child is still running) instead of pattern-matching the human-readable `error` prose. `retryable` stays coarse (always `true` for `interrupted`); refine with `reason` / `childStillRunning`.
- **Configurable re-attach budgets.** Two new public `AgentStaticOptions` — `agentToolReattachNoProgressTimeoutMs` (default 120000) and `agentToolReattachMaxWindowMs` (default 900000) — let an Agent tune the no-progress budget and the hard ceiling.
- **Give-up teardown (ceiling only).** When the parent gives up at the hard `window-exceeded` ceiling — where the child has had its full recovery window and is truly exhausted — it now cancels the child (`childStillRunning: false`) so it stops consuming a fiber / keep-alive. `no-progress` give-ups stay **soft** (`childStillRunning: true`): the child is left running so a re-issue can still re-attach and repair it if it self-heals, preserving the repair-on-re-issue path. In both `@cloudflare/think` and `@cloudflare/ai-chat`, `cancelAgentToolRun` also aborts an in-flight chat-recovery turn (not just the original in-isolate run) and releases live tails — Think sweeps its `_submissionAbortControllers`, ai-chat its request `AbortRegistry` (`abortAllRequests`) — so a torn-down child stops grinding instead of finishing an orphaned recovered turn.
