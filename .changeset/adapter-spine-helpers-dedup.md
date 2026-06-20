---
"agents": patch
---

De-duplicate three adapter-spine helpers shared by `@cloudflare/ai-chat` and
`@cloudflare/think` into `agents/chat`.

Three fragments that were duplicated byte-for-byte across both hosts now live
once as shared, `@internal` primitives:

- `async-helpers.ts` — the `TIMED_OUT` sentinel, `awaitWithDeadline` (a
  deadline-bounded promise race that always clears its timer), and
  `drainInteractionApplies` (the substrate-free interaction-apply completeness
  drain, parameterized by `hasPending` / `getTail`).
- `classifyAgentToolChildRecovery(storage)` (in `recovery-incident.ts`) — the
  parent's agent-tool reattach incident scan, with `in-progress > failed > none`
  precedence so a parent never gives up on a still-recovering child.
- `interceptAgentToolBroadcast(msg, hooks)` (in `agent-tools.ts`) — the #1575
  outgoing-frame snoop that forwards an agent-tool child's streamed progress to
  its live tailers (or captures its error), parameterized by an
  `AgentToolBroadcastHooks` substrate (the per-run forwarder / live-sequence /
  last-error maps, the host's response-frame type, and the host run-lookup).

Both hosts delegate through their existing private method names and
`broadcast()` overrides (which still call `super.broadcast`), so every call site
is untouched. This is a pure internal de-duplication with no observable behavior
or API change: the new symbols are `@internal` sibling-package support, not
public API, and both hosts' existing test suites pass unchanged.
`@cloudflare/ai-chat` and `@cloudflare/think` need no changeset for this
extraction.
