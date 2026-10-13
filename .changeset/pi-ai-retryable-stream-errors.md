---
"agents": patch
---

`createAI` for pi-ai (`agents/models/pi-ai`) reports a cut-off or idle model stream with wording pi's retry policy treats as transient, so pi-durable retries the request instead of failing the run. See [docs/agents/models.md](https://github.com/cloudflare/agents/blob/main/docs/agents/models.md).
