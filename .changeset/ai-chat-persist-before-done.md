---
"@cloudflare/ai-chat": patch
---

Send the terminal `done` frame after the assistant message is persisted and broadcast.

`useAgentChat` switches to ready on `done`, but `AIChatAgent` sent it before saving the reply and broadcasting `cf_agent_chat_messages`. On programmatic turns (`saveMessages()`, scheduled work, continuations) and in other open tabs, a message the user sent right after the reply finished could be replaced by the late transcript. The terminal frame is now sent after the transcript broadcast, and becomes an error frame if persisting the reply fails.
