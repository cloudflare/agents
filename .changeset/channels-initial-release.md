---
"@cloudflare/channels": minor
---

Add `@cloudflare/channels`, a durable turn engine for stateful agents on
Cloudflare Workers.

The engine provides a SQLite-backed turn ledger, append-only output journal,
per-conversation execution ordering, deduplication, cancellation, durable human
interaction pauses, stale-writer protection, retention alarms, and recovery
across Durable Object restarts. Transport routing, platform projection,
transcript hydration, and provider-specific connectors are deliberately left to
modules built on top of the engine.
