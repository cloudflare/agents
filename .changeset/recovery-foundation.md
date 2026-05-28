---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
---

Add bounded, observable recovery foundations for durable chat turns and fibers.

- Add dedicated recovery observability channels/events for fibers, chat recovery, transcript repair, and agent-tool recovery.
- Bound internal framework fiber recovery hooks and parent agent-tool recovery scans so startup and recovery work cannot wedge indefinitely.
- Add shared chat recovery incident tracking with attempt counts, configurable `chatRecovery` defaults, and terminal exhaustion behavior for `AIChatAgent` and `Think`. Think recovery now exhausts after six failed attempts by default and sends a terminal error frame instead of spinning indefinitely.
- Surface Think post-persist chat request failures through `onChatError(error, ctx)` and `chat:request:failed`.
- Repair incomplete Think tool-call transcripts before provider calls and allow `createCompactFunction()` to use a supplied token counter for tail budgeting.
