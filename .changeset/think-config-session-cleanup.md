---
"@cloudflare/think": patch
---

Remove Think's unused internal `session_id` config scaffolding and move Think's private config into a dedicated `think_config` table.

Older builds wrote Think-owned config into Session's shared `assistant_config(session_id, key, value)` table even though Think never actually had top-level multi-session support and `_sessionId()` always returned the empty string. Think now stores its private config rows in `think_config(key, value)`, which better matches the shipped model of one Think Durable Object per conversation and avoids overloading Session's shared metadata table.

Existing Durable Objects are migrated automatically on startup: legacy Think-owned keys stored in `assistant_config` with `session_id = ''` are copied into `think_config` before config reads and writes continue.
