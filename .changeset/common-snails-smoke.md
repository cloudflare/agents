---
"agents": patch
---

Report a WebSocket close before the terminal `done: true` frame as an interrupted chat turn instead of a completed one (#2013). `WebSocketChatTransport` now ends the `sendMessages`, resumed, and tool-continuation streams with an error chunk (`"WebSocket closed mid-stream"`), so `useAgentChat`/`useChat` enter the `error` state and call `onError` instead of presenting a truncated answer as finished. Chunks already received are still delivered ahead of the error, and when the socket reconnects and the stream resumes, the error clears as before. A close after `done`, or a tool-continuation close before the resume handshake, still ends the stream cleanly.
