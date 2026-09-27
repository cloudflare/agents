---
"@cloudflare/think": patch
"agents": patch
---

Fix messenger delivery and prompt-shaping issues found in review.

- Messengers keep the Chat SDK thread lock alive for the whole reply and keep queued messages for 30 minutes instead of 90 seconds, so a follow-up sent during a slow turn is answered after it rather than dropped or run concurrently. Messages still queued when the Durable Object restarts are drained after the interrupted reply is recovered.
- The typing indicator is re-sent every 4 seconds (`delivery.typingRefreshMs`) until the first text, a failing indicator no longer aborts the turn, and a reply with no visible text no longer posts a blank message before the apology.
- A burst whose earlier message mentions the bot is answered even when the adapter does not flag mentions, including in threads the bot has not subscribed to yet.
- Persisted messenger metadata no longer carries raw provider payloads or attachment bytes. Inline Chat SDK attachment `data` (Buffer, ArrayBuffer, typed array, Blob) is now mapped when there is no `fetchData`, and a full-span view's buffer is returned without a copy.
- A `messageMetadata` writer receives `continuation`, and a recovery continuation that extends the interrupted message no longer overwrites its start metadata (such as `createdAt`).
- Media eviction moves in `truncationStep` steps like read-time truncation, so it no longer rewrites the prompt prefix every turn. `truncationStep = Infinity` turns truncation off.
- The default model is resolved only when `beforeTurn` does not override it, and a `getGateway()` that returns a Promise fails with a clear error.
- `agents/chat-sdk`: `ChatSdkStateAdapter` takes `lockHeartbeat: true` to keep held locks alive until released. Older tool results in `truncateOlderMessages` replace inline images and file bytes with a marker, count inline text file items toward the budget, and match results to calls by message position when tool call ids repeat.
