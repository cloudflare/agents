---
"@cloudflare/think": minor
---

Add `getPruneOptions()` method to `Think`, making the AI SDK's `pruneMessages` step configurable. Default behavior is unchanged (`{ toolCalls: "before-last-2-messages" }`); subclasses can override to relax pruning for client-side tools or return `null` to skip the prune step entirely. Fixes #1455 for agents that rely on multi-turn client-side tool flows where earlier tool results were silently dropped before reaching the model.
