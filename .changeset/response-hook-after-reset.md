---
"agents": patch
"@cloudflare/think": patch
---

Fire `onChatResponse` for a turn whose assistant message was persisted right before a Durable Object reset. Think records that the hook is owed before persisting, and on wake fires it with the stored message and the new `ChatResponseResult.recovered: true` instead of re-running the finished turn through chat recovery (#2266). Messenger replies now checkpoint their terminal stage before posting the interrupted or error reply, so a reset can no longer make recovery post the apology twice (#1842).
