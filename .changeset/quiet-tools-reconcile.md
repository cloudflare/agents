---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Keep assistant messages and tool outputs attached to the correct turn when a provider reuses a `toolCallId`; `resolveToolMergeId` is deprecated in favour of `reconcileMessages`. See [Chat agents](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md).
