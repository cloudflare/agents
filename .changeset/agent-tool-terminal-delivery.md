---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Add `eventDelivery: "terminal"` to `runAgentTool`. The parent then forwards only lifecycle, progress, and milestone events for the run (live and on replay), and the child stops broadcasting its own stream chunks. Results, summaries, and structured output are unchanged. Detached runs reject the option.

Replaying agent-tool runs to a new connection now includes the child's persisted milestones, and `useAgentToolEvents` no longer drops a replayed lifecycle event whose sequence matches an earlier live progress frame.
