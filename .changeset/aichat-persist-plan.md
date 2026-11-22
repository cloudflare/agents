---
"@cloudflare/ai-chat": patch
---

`AIChatAgent.persistMessages` computes what to write, what a regenerate deletes and what retention trims in `transcript.ts`, with no change in behaviour.
