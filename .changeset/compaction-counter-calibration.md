---
"agents": minor
---

feat(experimental/memory): one consistent token accounting for compaction.

The Session now derives a single authoritative context size in model tokens — from the `compactAfter()` counter when configured, otherwise from model-reported usage on assistant message metadata (`metadata.usage` / `metadata.totalUsage`, e.g. set via the AI SDK's `messageMetadata`) — and uses that one number for both the fire decision and `createCompactFunction`'s boundary walk (via the new `CompactContext.contextTokens`), where it calibrates the built-in heuristic to the model's token scale.

This fixes #1593: on tool-heavy histories the heuristic under-counts, so `tailTokenBudget` silently degraded to `minTailMessages`. It also makes compaction zero-config when assistant messages carry usage metadata.

The boundary walk no longer accepts a user counter at all: `CompactOptions.tokenCounter`, the `CompactTokenCounter` type, and `CompactContext.tokenCounter` are removed (the per-message counter was the #1593 footgun — a whole-prompt counter passed there silently degraded the budget to `minTailMessages`). Whole-prompt totals belong on `compactAfter()` or in usage metadata. New utils: `calculateContextTokens`, `getAssistantUsage`, `estimateContextTokensFromUsage`; `SessionMessage` gained `metadata`.
