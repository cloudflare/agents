---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Allow Think agent-tool children to complete without emitting assistant text. Non-chat tool-step agents can now provide structured output through `getAgentToolOutput`, with summaries derived from assistant text, string output, structured output, or an empty string.

Fix `useAgentChat().isServerStreaming` cleanup when a resumed stream first enters the fallback observer path and later becomes transport-owned.
