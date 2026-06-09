---
"agents": minor
---

feat(experimental/memory): usage-metadata token accounting and foolproof token counters for compaction.

- **Zero-config accounting**: when assistant messages carry model-reported usage in their metadata (`metadata.usage` / `metadata.totalUsage`, e.g. the AI SDK's `messageMetadata`), the Session now uses it automatically — both for the `compactAfter` fire decision (last reported usage + heuristic for newer messages) and for `createCompactFunction`'s boundary walk (the usage total calibrates the built-in heuristic to the model's token scale via `CompactContext.contextTokens`). No `tokenCounter` needed. New utils: `calculateContextTokens`, `getAssistantUsage`, `estimateContextTokensFromUsage`.
- **Explicit counter scope**: new `CompactOptions.countTokens` for strictly message-scoped counters (tokenizers) — used directly by the per-message tail walk, no detection. Wins over `tokenCounter` when both are set.
- **Foolproof `tokenCounter`**: the ambiguous counter is now classified with a two-point probe (does it respond to its input?) instead of an absolute threshold. Usage-style counters (`() => usage.inputTokens`) calibrate the heuristic — `tailTokenBudget` is honored at the model's scale instead of degrading to `minTailMessages`, with O(1) counter calls per compaction. Message-scoped counters with fixed per-call overhead (chat-template priming, baked-in system prompts) keep their per-message accuracy with the overhead subtracted. Any probe failure falls back to the previous behavior.
