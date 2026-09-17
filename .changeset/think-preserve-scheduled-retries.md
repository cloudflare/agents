---
"@cloudflare/think": patch
---

Preserve running durable submissions during startup when either a retry or continuation chat-recovery callback is still pending. This applies to both current Tasks recovery attempts and legacy scheduled callbacks, allowing interrupted empty streams to retry and complete after a restart instead of being marked as errors.

Keep recovery ownership until the successor chat turn is durably accepted, and bind the submission to that successor before handing off. Retain terminal stream evidence for running submissions so a restart between turn completion and ledger settlement records the completed or errored outcome without rerunning the turn or duplicating response callbacks. Scope the handoff signal to the successor turn so concurrent turns cannot claim it, including facet-hosted turns after their legacy successor fiber is durably created. Pin submission stream evidence until ledger settlement so unrelated turns cannot reclaim it, and release abandoned pins on startup. New recovery payloads carry stable submission identity; exact submission IDs take precedence over request-ID fallback, preventing collisions from recovering or terminalizing another submission.
