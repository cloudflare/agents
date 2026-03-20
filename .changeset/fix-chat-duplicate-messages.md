---
"@cloudflare/ai-chat": patch
---

fix(ai-chat): prevent duplicate messages after tool calls and orphaned client IDs

- CF_AGENT_MESSAGE_UPDATED handler no longer appends when message not found in client state, fixing race between transport stream and server broadcast
- _resolveMessageForToolMerge reconciles IDs by toolCallId regardless of tool state, preventing client nanoid IDs from leaking into persistent storage
