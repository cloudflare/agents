---
"@cloudflare/think": patch
---

`Think` keeps the `onChatResponse` call a reset interrupted in the `Outbox` and fires it on the next start, retrying if the bookkeeping before the hook fails. Owed hooks stored by earlier releases move into it on start.
