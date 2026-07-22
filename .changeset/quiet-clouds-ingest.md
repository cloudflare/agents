---
"@cloudflare/think": minor
---

Add `ingest()` for host-owned transports driving Think agents over Workers RPC as a byte-streaming NDJSON contract, and allow policy-only non-messenger channels (omit `kind` — it is now optional and deprecated).

Deprecates the Think-owned transport surface — `getMessengers()`, `messengerChannel()`, and the `kind`/`ingress`/`capabilities`/`conversation`/`delivery` channel fields — in favour of user-owned hosts driving agents via `ingest()`; existing apps keep working unchanged.
