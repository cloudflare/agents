---
"@cloudflare/think": patch
---

`resolveModel()` rejects malformed model ids up front, and `@hf/...` ids get the same Workers AI settings as `@cf/...`. See [Think](https://github.com/cloudflare/agents/blob/main/docs/think/index.md).
