---
"@cloudflare/think": minor
---

Add `messengerConcurrency` to choose the Chat SDK concurrency strategy for messenger replies (#2313). It defaults to the existing 600 ms `burst` strategy, exported as `DEFAULT_MESSENGER_CONCURRENCY`, and accepts any `ConcurrencyStrategy` or `ConcurrencyConfig`, such as `"queue"` or `{ strategy: "burst", debounceMs: 1500 }`.
