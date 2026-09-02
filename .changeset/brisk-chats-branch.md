---
"@cloudflare/think": minor
---

Replatform Think message, compaction, search, and media persistence onto `agents/sessions`, and its prompt context onto `agents/context`.

Context blocks are now declared by the new `configureContext()` hook and reached through `this.context`; `configureSession()` keeps compaction and search policy. `session.withContext()` and `withCachedPrompt()` are gone — a block declared without a provider is auto-wired to durable per-agent SQLite, and the frozen prompt is always persisted.

`hydrationByteBudget` now defaults to 32 MiB and charges each row its full stored size, continuation rows included, so the budget bounds isolate memory. `sessionAttachments` is gone: there is nothing to configure about how Sessions stores a message. Think no longer reads Sessions tables with raw SQL.
