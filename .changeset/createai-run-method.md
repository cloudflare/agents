---
"agents": minor
---

`createAI` from `agents/models/ai-sdk` runs every model on `env.AI.run`: Workers AI ids, AI Gateway catalog ids (`ai("anthropic/claude-opus-4.8")`) and dynamic routes. Vendor model objects are no longer routed through AI Gateway's deprecated universal endpoint, so `ai(model)`, `ai.routed()` and `GatewayLanguageModel` are removed; pass the catalog id instead. See [docs/agents/models.md](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md#catalog-models).
