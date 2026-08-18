---
"@cloudflare/think": patch
---

Preserve orphaned durable execution outcomes as framework-authored notes, then project them to user context for inference so provider transcript validation cannot reject their arbitrary position. Existing outcome notes receive the same projection without rewriting stored history.
