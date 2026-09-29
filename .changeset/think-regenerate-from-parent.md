---
"@cloudflare/think": patch
---

Fix regenerate behaving like continue (#2028). A regenerated response was already saved as a new branch beside the one it replaces, but the model prompt was built from the latest branch, so it still contained the old response and the model continued it. The prompt for a regeneration now stops at the user message being answered, so neither the replaced response nor anything after it reaches the model. A regeneration interrupted before its first chunk is retried as a regeneration too (a new branch from the same user message), including across durable recovery.
