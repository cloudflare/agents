---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Recovery give-up now resolves the orphaned stream by newest metadata row.

The stable-timeout/error give-up path that terminalizes an exhausted recovery
turn previously resolved the turn's orphaned stream id with an in-memory
first-match scan over all stream metadata, while the wake (restart) path already
used the newest durable row keyed by the recovery-root request id. These two
lookups are now a single seam, so both paths surface the same partial — the
newest stream the turn produced — when a request id spans more than one
recovery attempt. Single-attempt turns (one stream row per request id) are
unaffected.
