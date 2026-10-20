---
"@cloudflare/codemode": patch
---

Release tool calls left pending when an execution settles, so unawaited calls no longer leak Dynamic Worker concurrency slots. See [Unawaited tool calls](https://github.com/cloudflare/agents/blob/main/docs/codemode/runtime.md#unawaited-tool-calls).
