---
"agents": minor
"@cloudflare/think": minor
---

Add experimental Postgres-backed session, context, and search providers for external session storage via Hyperdrive-compatible `pg` clients.

Session APIs now consistently return promises so callers can use the same surface with local SQLite or external storage providers. Think's session integration has been updated for the async session API, including cache-aware handling for idempotent appends and compaction overlays.
