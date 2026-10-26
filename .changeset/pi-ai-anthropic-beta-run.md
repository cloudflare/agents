---
"agents": patch
---

`createAI` from `agents/models/pi-ai` now sends pi-ai's `betas` as the `anthropic-beta` header for catalog Claude models on `/run`, as it already did on the provider-native path. See [#2714](https://github.com/cloudflare/agents/issues/2714).
