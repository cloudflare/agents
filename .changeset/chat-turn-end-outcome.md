---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

`useAgentChat` gains `onTurnEnd`, called once for each chat request that ends with its `messageIds`, `outcome`, and error, so an application can settle exactly the optimistic sends a turn belongs to without reading raw WebSocket frames (#2280). It fires for this tab's requests, requests from other connections, and outcomes replayed on reconnect, and skips a request that recovery continues under a new one.

Terminal chat response frames now carry an `outcome` of `"completed"`, `"error"`, `"aborted"`, `"skipped"`, or `"recovering"` where the old `done`/`error` flags could not tell them apart. A skipped or cancelled request previously looked the same as a completed one. The `ChatTurnOutcome` and `ChatTurnEndEvent` types are exported.
