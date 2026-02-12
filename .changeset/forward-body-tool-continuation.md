---
"@cloudflare/ai-chat": patch
---

Forward custom body fields to onChatMessage during tool continuation calls. Previously, `options.body` was only available on the initial `CF_AGENT_USE_CHAT_REQUEST` path and was `undefined` during auto-continue after client tool results. The body is now persisted from the most recent chat request and automatically passed through on tool continuations, matching the existing behavior for `clientTools`.
