---
"agents": patch
---

De-duplicate the orphan-persist core shared by `@cloudflare/ai-chat` and
`@cloudflare/think` into `agents/chat`.

The genuinely-common skeleton of both hosts' `_persistOrphanedStream` — the
accumulate loop plus the `getMessage → updateMessage(merge) XOR appendMessage`
upsert — now lives once as the `@internal` `persistReconstructedOrphan` helper.
The deliberately host-specific bits stay in the callers: the buffer flush, the
fallback id, the `prepare` hook (Think strips internal parts and may skip;
ai-chat resolves the persist-target id), the `merge` hook (Think replaces;
ai-chat reconciles partials), and broadcast (Think after; ai-chat inside its
store's `persistMessages`).

Pure internal de-duplication with no observable behavior or API change: the new
symbol is `@internal` sibling-package support, not public API, and both hosts'
recovery suites pass unchanged. `@cloudflare/ai-chat` and `@cloudflare/think`
need no changeset for this extraction.
