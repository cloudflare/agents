---
"@cloudflare/think": patch
---

Send the terminal `done` frame after the persisted transcript, not before it. `useAgentChat` switches to `ready` on `done`, and the transcript broadcast (`cf_agent_chat_messages`) used to arrive afterwards. If the user sent a message right away, that later snapshot would replace the client's messages and briefly drop the new one. Think now persists the assistant message and broadcasts the transcript first, on WebSocket turns, `chat()` RPC turns, and mid-stream failures. If persisting the message fails, the terminal frame now reports the error instead of a clean `done`.
