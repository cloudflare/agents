---
"@cloudflare/ai-chat": minor
---

Change `autoContinueAfterToolResult` default from `false` to `true`.

Client-side tool results and tool approvals now automatically trigger a server continuation by default, matching the behavior of server-executed tools (which auto-continue via `streamText`'s multi-step). This eliminates the most common setup friction with client tools — the LLM now responds after receiving tool results without requiring explicit opt-in.

To restore the previous behavior, set `autoContinueAfterToolResult: false` in `useAgentChat`.
