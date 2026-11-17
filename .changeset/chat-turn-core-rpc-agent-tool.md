---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

`AIChatAgent` and `Think` share one implementation of an agent-tool child run, and `Think.chat()` runs through the turn core: a cancel stops only that run's turn and is recorded with its reason, a run whose reply is cut off stays `running` while chat recovery finishes it, a run's status is written once, `chat()` reports a chat cleared under it through `onError`, and `Think.startAgentToolRun` gains an optional `signal` (additive).
