---
"agents": patch
---

`createAI` no longer uses AI Gateway's deprecated Universal Endpoint. Model ids, now including catalog ids like `anthropic/claude-opus-4.8`, run on `env.AI.run`; model objects go to the provider-native path. Adds `byokAlias`, fixes pi-ai catalog models and dynamic routes, and lets `agents/models/opencode` take catalog ids. See [the models docs](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md).
