---
"@cloudflare/think": minor
---

Add `addMessages()` for writing to the transcript without starting a model turn.

`addMessages(messages, options?)` appends (or upserts, via `{ mode: "upsert" }`) into the Session tree without running inference or entering the turn queue, so it is safe to call from inside a tool `execute`. Array entries are appended linearly into one path; appends are idempotent by message id; `parentId` controls the attach point (latest committed leaf by default, `null` for root, and an unknown id fails fast). This is distinct from `saveMessages()` (which runs a turn) and from `AIChatAgent`'s `persistMessages()` (which replaces/reconciles a flat array). Fixes the Think docs that previously pointed to a nonexistent `persistMessages()` on Think.
