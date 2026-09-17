---
"agents": minor
---

Add durable terminal-row retention to `ResumableStream`. Pass `retain: true` at cutover, error settlement, or pending completion to keep evidence across unrelated stream starts and reclamation. `listRetained()` exposes pinned stream identities for consumer reconciliation, and idempotent `release(streamId)` makes settled evidence reclaimable again. Existing `discard: false` streams remain unretained and reclaimable on the next start.
