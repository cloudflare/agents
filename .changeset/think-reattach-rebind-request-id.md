---
"@cloudflare/think": patch
---

Fix: a recovered agent-tool **child** turn now re-binds its run row to the
recovery turn's request id, so a healthy long-running child is no longer
abandoned as `interrupted` after a deploy.

When a facet running as an agent-tool child was interrupted mid-run (e.g. a
deploy evicted it), its recovery continuation (`continueLastTurn` /
`_retryLastUserTurn`) minted a fresh request id but left
`cf_agent_tool_child_runs.request_id` pointing at the pre-eviction turn. Frame
attribution (`_agentToolRunForRequest`) then failed, so the recovered turn's
broadcast frames never reached the parent's re-attach tail; the parent saw no
forward progress and sealed a still-advancing child `interrupted` once its
no-progress budget elapsed. The recovery paths now re-bind the child-run row
(and the in-memory attribution map) to the current turn's request id, keeping
frames flowing across recovery so the parent re-attaches and follows the child
to its real terminal.
