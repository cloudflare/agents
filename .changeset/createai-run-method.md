---
"agents": patch
---

`createAI` from `agents/models/ai-sdk` takes AI Gateway catalog ids (`ai("anthropic/claude-opus-4.8")`) on `env.AI.run`, and sends a vendor's own model object (`ai(anthropic("claude-opus-4-8"))`) to AI Gateway's provider-native path instead of the deprecated Universal Endpoint. Adds the `byokAlias`, `zdr` and `vendorKey` options. See [docs/agents/models.md](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md#model-objects).
