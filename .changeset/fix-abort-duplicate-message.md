---
"@cloudflare/ai-chat": patch
---

fix: abort/stop no longer creates duplicate split messages (issue #1100)

When a user clicked stop during an active stream, the assistant message was split into two separate messages. This happened because `onAbort` in the transport immediately removed the `requestId` from `activeRequestIds`, causing `onAgentMessage` to treat in-flight server chunks as a new broadcast.

- `WebSocketChatTransport`: `onAbort` now keeps the `requestId` in `activeRequestIds` so in-flight server chunks are correctly skipped by the dedup guard
- `useAgentChat`: `onAgentMessage` now cleans up the kept ID when receiving `done: true`, preventing a minor memory leak
