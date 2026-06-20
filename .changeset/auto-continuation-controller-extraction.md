---
"agents": patch
---

Extract the shared auto-continuation barrier into an `AutoContinuationController`
primitive in `agents/chat`.

The event-driven auto-continuation barrier (the tool-result → auto-continue flow,
#1649 / #1650) was duplicated, line-for-line, across `@cloudflare/ai-chat`
(`AIChatAgent`) and `@cloudflare/think` (`Think`) — the coalesce timer, the
double-fire guard, the create/update/defer scheduling branch, and the
completeness-gated drain orchestration. It now lives once as
`AutoContinuationController`, parameterized over a small `AutoContinuationHost`
interface (the stream-active signal, the incomplete-batch / pending-interaction
predicates, the apply-drain primitive, and each host's continuation-turn
pipeline). Both hosts delegate to it through thin wrappers, so every call site is
untouched.

This is a pure internal de-duplication with no observable behavior or API change:
the new symbols are `@internal` sibling-package support, not public API, and both
hosts' existing test suites pass unchanged. `@cloudflare/ai-chat` and
`@cloudflare/think` need no changeset for this extraction.
