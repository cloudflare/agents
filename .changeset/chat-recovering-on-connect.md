---
"@cloudflare/ai-chat": minor
---

`AIChatAgent` now replays the live "recovering…" status on connect (#1620).

Previously the `cf_agent_chat_recovering` frame was only broadcast live, so a
client that connected (or reconnected) while a durable turn was mid-recovery —
between a scheduled continuation and its first chunk — saw nothing and appeared
frozen until the turn resumed or failed. It now receives the recovering status
directly on connect (when no stream is active to resume), so `useAgentChat`'s
`isRecovering` reflects the in-progress recovery immediately. This converges
`AIChatAgent` onto `@cloudflare/think`'s behavior. The status is still cleared on
completion, exhaustion, or any terminal outcome, and stale records (older than
the recovering-flag TTL) are skipped so a recovery abandoned without a terminal
cannot show "recovering…" forever.
