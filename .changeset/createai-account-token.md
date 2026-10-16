---
"agents": patch
---

`createAI` takes `{ accountId, apiToken }` in place of `binding`, to use a gateway in another account or to run outside a Worker. Model ids go to AI Gateway's REST API, and model objects to `gateway.ai.cloudflare.com`. See [the models docs](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md#account-id-and-api-token).
