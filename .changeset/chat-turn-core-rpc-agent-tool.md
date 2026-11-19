---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` share one implementation of an agent-tool child run, and `Think.chat()` runs through the turn core: a cancel stops only that run's turn and is recorded with its reason, a run whose reply is cut off stays `running` while chat recovery finishes it and ends `aborted` when its request is stopped meanwhile, a run's status is written once, `chat()` reports a chat cleared under it through `onError`, a stopped turn ends `aborted` whatever reason the abort carried, `abortRequest` and a caller's `signal` also cancel a scheduled recovery of the request, `runAgentTool` waits for a child whose isolate reset mid-run and returns the run's own status, and `Think.startAgentToolRun` gains an optional `signal` (additive). See [Agent tools](https://developers.cloudflare.com/agents/api-reference/agent-tools/).
