---
"agents": minor
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Add `session.mirror()`, which keeps an in-memory transcript in step with one session's change feed. `AIChatAgent` and `Think` now share it instead of each carrying its own copy of the reduction; `Think` keeps its branch, compaction, and prompt-refresh handling through the `intercept` and `onApplied` hooks.
