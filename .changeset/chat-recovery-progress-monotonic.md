---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Fix chat recovery prematurely exhausting its retry budget under compaction
(#1628). The deploy-churn forward-progress signal — which resets the recovery
budget when an interrupted turn is actually advancing — was recomputed from the
live transcript by counting assistant messages. Compaction collapses older
assistant messages into a summary, lowering that count, so a turn that had
genuinely advanced could read as "no progress" between recovery attempts and
exhaust at `maxAttempts`, sealing a healthy turn. Progress is now tracked by a
durable, monotonic counter incremented when `_persistOrphanedStream` materializes
a non-empty partial (the exact event the message count was proxying for), so
compaction can never lower it. A turn that genuinely fails to advance still
exhausts at the cap, and the 15-minute wall-clock ceiling is unchanged.
