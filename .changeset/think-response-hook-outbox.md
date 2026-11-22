---
"@cloudflare/think": patch
---

`Think` fires the `onChatResponse` a reset interrupted on the next start and retries it if the bookkeeping before the hook fails. Two `onChatResponse` calls that overlap both run; only a turn started from inside `onChatResponse` skips its own hook.
