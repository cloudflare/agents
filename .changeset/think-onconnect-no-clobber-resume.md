---
"@cloudflare/think": patch
---

Fix stream resumption on page refresh: do not broadcast `cf_agent_chat_messages` from Think's `onConnect` while a resumable stream is in flight.

Previously, Think unconditionally sent a `cf_agent_chat_messages` frame on every new WebSocket connection. When a client refreshed during an active chat turn, that broadcast arrived in the same connect sequence as `cf_agent_stream_resuming` and overwrote the in-progress assistant message the client was about to rebuild from the resumed stream. The assistant reply would stay hidden until the server finished the turn and re-broadcast the persisted history.

Now Think only broadcasts `cf_agent_chat_messages` on connect when there is no active resumable stream. During an active stream the resume flow is the authoritative source of state: `STREAM_RESUMING` triggers replay of buffered chunks, and the final state broadcast happens when the turn completes. This matches the behavior that `AIChatAgent` already had.

Marked the internal `_resumableStream` field as `protected` (previously `private`) so framework subclasses and focused tests can coordinate around the resume lifecycle.
