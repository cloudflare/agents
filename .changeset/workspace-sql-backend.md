---
"@cloudflare/shell": minor
---

Replace tagged-template SQL host interface with a plain `SqlBackend` interface. Workspace now accepts `SqlStorage`, `D1Database`, or any custom `{ query, run }` backend via a single options object. This makes Workspace usable from any Durable Object or D1 database, not just Agents.
