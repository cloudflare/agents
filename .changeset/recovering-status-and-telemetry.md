---
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
"agents": minor
---

Surface a live "recovering…" status to chat clients during durable recovery (#1620)

When a durable chat turn is interrupted (a deploy/eviction, or a stream-stall
watchdog abort) and resumes, clients had no "in progress" signal — the turn
looked frozen until it completed or a terminal error was replayed. A new
`cf_agent_chat_recovering` protocol frame is now broadcast on recovery schedule
and cleared on every terminal outcome (completed/skipped/failed/exhausted), so
the indicator can't spin forever. In `@cloudflare/think` it's also persisted and
replayed on connect, so a client that joins mid-recovery learns the turn is
working. `useAgentChat` exposes a new `isRecovering` flag (distinct from
`isStreaming` — a recovering turn isn't producing tokens yet); most UIs render
`isStreaming || isRecovering` as "busy". Backward-compatible: clients that don't
understand the frame ignore it.

> Note: `@cloudflare/ai-chat` broadcasts the live signal but does not yet replay
> it on connect (it has no idle-connect hydration path; tracked in #1645).
> `@cloudflare/think` has both.

For recovery telemetry, subscribe to the `chat:recovery:*` observability events
and route them to your analytics sink.
