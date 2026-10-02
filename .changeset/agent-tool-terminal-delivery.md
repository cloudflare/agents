---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Add `eventDelivery: "terminal"` to `runAgentTool` to forward only lifecycle, progress, and milestone events for a run. See [Agent tools](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md).
