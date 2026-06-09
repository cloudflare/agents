---
"agents": patch
---

fix(experimental/memory): `createCompactFunction` now auto-calibrates whole-prompt token counters instead of degrading the tail budget to `minTailMessages`. A usage-style counter (e.g. `() => usage.inputTokens`, ignoring its arguments) is detected with an empty-message probe, called once over the full history, and the resulting model-scale ratio is applied to the built-in heuristic for the per-message tail walk — so `tailTokenBudget` is honored at the model's scale, the naive counter users naturally write just works, and async/remote counters cost O(1) calls per compaction instead of O(n). Message-scoped (tokenizer-style) counters are unchanged.
