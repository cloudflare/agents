---
"agents": minor
---

feat(experimental/memory): one consistent token accounting for compaction.

The Session now derives a single authoritative context size in model tokens — from the `compactAfter()` counter when configured, otherwise from model-reported usage on assistant message metadata (`metadata.usage` / `metadata.totalUsage`, e.g. set via the AI SDK's `messageMetadata`) — and uses that one number for both the fire decision and `createCompactFunction`'s boundary walk (via the new `CompactContext.contextTokens`), where it calibrates the built-in heuristic to the model's token scale.

This fixes #1593: on tool-heavy histories the heuristic under-counts, so `tailTokenBudget` silently degraded to `minTailMessages`. It also makes compaction zero-config when assistant messages carry usage metadata.

Semantics are now explicit, with no shape detection: `CompactOptions.tokenCounter` is strictly message-scoped (a tokenizer, called once per message); whole-prompt totals belong on `compactAfter()` or in usage metadata. `CompactContext.tokenCounter` was removed — the session counter is never called per-message anymore. New utils: `calculateContextTokens`, `getAssistantUsage`, `estimateContextTokensFromUsage`; `SessionMessage` gained `metadata`.
