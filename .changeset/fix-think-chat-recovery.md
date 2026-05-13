---
"@cloudflare/think": minor
---

Wrap `Think.chat()` RPC turns in chat recovery fibers and persist their stream chunks so interrupted sub-agent turns can recover partial output. `ChatOptions.tools` has been removed from the TypeScript API; runtime `options.tools` values passed by legacy callers are ignored with a warning. Define durable tools on the child agent or use agent tools for orchestration.
