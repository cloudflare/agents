---
"@cloudflare/ai-chat": patch
---

Fix stale agent reference in useAgentChat transport under React StrictMode

The `agentRef` was updated via `useEffect` (async, after render), but the `WebSocketChatTransport` is created in `useMemo` (sync, during render). When the agent reconnects or switches, `useMemo` would capture the old (closed) agent because the effect hadn't fired yet — causing `sendMessage` to send to a dead WebSocket. Fixed by updating `agentRef.current` synchronously during render, matching the pattern already used by other refs in the same hook.
