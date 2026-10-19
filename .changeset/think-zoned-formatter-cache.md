---
"@cloudflare/think": patch
---

Reuse one `Intl.DateTimeFormat` per timezone when computing wall-clock scheduled task occurrences, cutting the CPU cost of each occurrence substantially. See [#2583](https://github.com/cloudflare/agents/issues/2583); thanks @Bowiemb.
