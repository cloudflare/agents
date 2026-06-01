---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
"agents": patch
---

Count a sub-agent's progress as the orchestrating parent's recovery progress

A parent turn whose work is "run a sub-agent and await its result" produced no
recoverable content of its own, so under deploy churn the **parent's** own
chat-recovery no-progress window could exhaust while the child was still
healthily streaming — abandoning the turn as `interrupted` and collecting an
interrupted result even though the child went on to complete. (Reproduced by
the `examples/deploy-churn --mode subagent` harness: the parent exhausted at
`attempt 6/6` with `progress: 1` while the child self-healed all 30 steps.)

Forwarding a child's stream to the parent's connections is now treated as
genuine forward progress for the parent's recovery budget: `Think` and
`AIChatAgent` advance their durable recovery-progress marker (throttled) each
time `_forwardAgentToolStream` forwards child output, so a parent that keeps
re-attaching to and streaming a live child survives churn indefinitely. The
credit is only granted when the child actually produces output — a silent or
hung child still lets the parent exhaust on its own no-progress timer, so a
stuck sub-agent can never pin a parent's recovery open forever.

This completes the sub-agent recovery story started by the stable-runId +
bounded re-attach fix (#1630): the child self-heals and the parent both
re-attaches to it _and_ keeps its own recovery alive while doing so.
