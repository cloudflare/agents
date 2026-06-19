---
"@cloudflare/ai-chat": patch
---

`AIChatAgent` now delivers the terminal banner **before** persisting the durable
terminal record when chat recovery gives up, converging onto
`@cloudflare/think`'s broadcast-first ordering.

Previously `_exhaustChatRecovery` persisted the durable terminal record first
and broadcast the banner second. A terminal-record write can reject in the
deploy/storage window a give-up runs in (#1730); under persist-first the throw
propagated before the banner was sent, so the live banner was dropped on that
pass and only delivered on the healthy re-run (potentially a different isolate,
after the affected connections had gone). Broadcasting first makes the banner
resilient to a failing storage write: the throw still propagates and the whole
give-up re-runs on a healthy isolate, which persists the record idempotently and
re-delivers the banner (the documented at-least-once edge). Persisting first
gained no durability — the re-run persists either way — while losing this banner
resilience, so both chat hosts now terminalize broadcast-first.
