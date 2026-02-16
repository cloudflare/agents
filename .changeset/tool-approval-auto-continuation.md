---
"@cloudflare/ai-chat": patch
---

Add auto-continuation support for tool approval (`needsApproval`).

When a tool with `needsApproval: true` is approved via `CF_AGENT_TOOL_APPROVAL`, the server can now automatically continue the conversation (matching the existing `autoContinue` behavior of `CF_AGENT_TOOL_RESULT`). The client hook passes `autoContinue` with approval messages when `autoContinueAfterToolResult` is enabled. Also fixes silent data loss where `tool-output-available` events for tool calls in previous assistant messages were dropped during continuation streams by adding a cross-message fallback search in `_streamSSEReply`.
