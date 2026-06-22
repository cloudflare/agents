---
"@cloudflare/ai-chat": patch
---

Fix: a recovered agent-tool **child** turn now re-binds its run row to the
recovery turn's request id (parity with `@cloudflare/think`).

When an `AIChatAgent` facet running as an agent-tool child was interrupted
mid-run, its recovery continuation (`continueLastTurn` / `_retryLastUserTurn`)
minted a fresh request id but left `cf_ai_chat_agent_tool_runs.request_id`
pointing at the pre-eviction turn, breaking frame attribution. A long-running
recovered child then forwarded nothing to the parent's re-attach tail and could
be abandoned as `interrupted` once the no-progress budget elapsed. The recovery
paths now re-bind the child-run row (and the in-memory attribution map) so frames
keep flowing across recovery.
