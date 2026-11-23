---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

An agent-tool run whose child's turn was cut off now waits for the child's chat recovery instead of ending `error` when the parent checks it before that recovery has started.
