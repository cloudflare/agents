---
"@cloudflare/think": minor
---

Replatform Think message, compaction, search, and media persistence onto `agents/sessions`, and its prompt context onto `agents/context`.

Context blocks are now declared by the new `configureContext()` hook and reached through `this.context`; `configureSession()` keeps compaction and search policy. `session.withContext()` and `withCachedPrompt()` are gone — a block declared without a provider is auto-wired to durable per-agent SQLite, and the frozen prompt is always persisted.

`hydrationByteBudget` now defaults to 32 MiB and counts the attachment bytes a row re-inflates, so the budget bounds isolate memory instead of stored bytes. The per-tool-result durable scan reads pointers rather than inflating every attachment on the path. `mediaEviction` still disables the aged-row pass with `false`, but payload bytes are always preserved now, so `externalizeToWorkspace` no longer has an effect. Think no longer reads Sessions tables with raw SQL.
