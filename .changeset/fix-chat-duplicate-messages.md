---
"@cloudflare/ai-chat": patch
---

Fix temporary duplicate assistant messages after tool calls (#1094)

- `CF_AGENT_MESSAGE_UPDATED` handler no longer appends when the message isn't found in client state, preventing the race condition between the transport stream and server broadcast that caused duplicate renders and React "duplicate key" warnings.
- `_resolveMessageForToolMerge` now reconciles message IDs by `toolCallId` regardless of tool state, preventing orphaned client-generated nanoid IDs from leaking into persistent storage.
