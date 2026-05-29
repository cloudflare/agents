---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
---

Add bounded, observable recovery foundations for durable chat turns and fibers.

- Add dedicated recovery observability channels/events for fibers, chat recovery, transcript repair, and agent-tool recovery.
- Bound internal framework fiber recovery hooks and parent agent-tool recovery scans so startup and recovery work cannot wedge indefinitely.
- Add shared chat recovery incident tracking with attempt counts, configurable `chatRecovery` defaults, and terminal exhaustion behavior for `AIChatAgent` and `Think`. Think recovery now exhausts after six failed attempts by default and sends a terminal error frame instead of spinning indefinitely.
- Keep the recovery attempt budget bounded even when an interrupted turn flips between `retry` and `continue` recovery kinds (the incident identity no longer includes the kind), guard a throwing `onExhausted` hook so the terminal UX is still delivered, mark incidents `failed` when the recovery dispatch throws, and reclaim incident records on success plus a TTL sweep for abandoned ones so durable storage does not grow without bound.
- Bound generic unmanaged fiber recovery with a configurable `fiberRecoveryMaxAgeMs` so a repeatedly-throwing `onFiberRecovered()` hook cannot re-trigger forever across restarts.
- Surface Think post-persist chat request failures through `onChatError(error, ctx)` and `chat:request:failed`.
- Repair incomplete Think tool-call transcripts before provider calls and allow `createCompactFunction()` to use a supplied token counter for tail budgeting.
