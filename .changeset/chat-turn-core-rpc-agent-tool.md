---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Agent-tool runs and `Think.chat()` now start, cancel and end through the shared chat turn core, and `AIChatAgent` and `Think` share one implementation of a child run (its table, `inspectAgentToolRun`, `getAgentToolChunks`, `tailAgentToolRun`, progress): a run or request cancelled while it waits in the queue never calls the model, a run's terminal status is written once, a cancel stops only that run's turn (also while chat recovery is re-running it), a chat reset ends a run as `error`, a `Think` run's stored chunks are readable while it runs, and `chat()` reports a chat cleared under it through `onError`.
