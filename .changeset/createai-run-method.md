---
"agents": patch
---

`createAI` stops using AI Gateway's deprecated Universal Endpoint. In `agents/models/ai-sdk`, AI Gateway catalog ids (`ai("anthropic/claude-opus-4.8")`) run on `env.AI.run` and a vendor's own model object (`ai(anthropic("claude-opus-4-8"))`) goes to the provider-native path; `agents/models/pi-ai` runs its catalog models on `env.AI.run` in their native format and other model objects on the provider-native path. Adds the `byokAlias`, `zdr` and `vendorKey` options. See [docs/agents/models.md](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md#model-objects).
