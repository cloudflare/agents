---
"agents": patch
"@cloudflare/ai-chat": patch
---

Fix several chat turn-settlement edge cases in the wire protocol and `useAgentChat`:

- Replayed terminals now carry the stream's `outcome` (`aborted` for orphaned or aborted streams, `recovering` when stall recovery is scheduled), and the outcome survives the stream row being cleaned up.
- A resume ACK that lands while the response is still being persisted replays the held stream instead of sending an early bare done.
- The "No response" done is sent to every connection, including the one that sent the message.
- Observers settle on a `done` for a request other than the one they are watching, and a `recovering` done no longer clears `isRecovering`.
- `onToolCall` stays held after a `recovering` close, and with `resume: false` a held `onToolCall` is released on reconnect.
- `onTurnEnd` fires after `status` settles for the tab's own requests, so it can call `sendMessage`.
- Live chunks no longer merge into a message once divergence is detected.
- Remembered turn errors are capped and cleared by `clearHistory`.
