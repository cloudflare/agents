---
"@cloudflare/think": patch
---

Require `ai@^7` (and `@ai-sdk/react@^4`). Think bundles `workers-ai-provider@4`, `@ai-sdk/openai@4` and `@ai-sdk/anthropic@4`, which produce `specificationVersion: "v4"` models that `ai@6` rejects with `UnsupportedModelVersionError`, so the `ai@^6` peer range never actually worked. If you are on `ai@6`, upgrade to `ai@7` before updating Think.
