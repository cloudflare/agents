---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Terminal chat response frames (`done` or `error`) now carry `messageIds`, the ids of the user messages the originating request ended with. This covers completion, pre-stream and stream errors, skipped and cancelled requests, and terminals replayed on reconnect (the ids are stored with the stream and the durable terminal record), so a client can settle exactly the optimistic sends a terminal belongs to. Recovered turns keep the ids too, including a turn interrupted before its stream started (they are stored in the chat fiber snapshot as `originMessageIds`). Recovered turns keep the ids too, including a turn interrupted before its stream started (they are stored in the chat fiber snapshot as `originMessageIds`).
