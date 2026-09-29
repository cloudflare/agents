---
"@cloudflare/think": patch
---

`resolveModel()` now rejects a string model id that is neither a Workers AI id (`@cf/...` or `@hf/...`) nor a `<provider>/<model>` AI Gateway slug (for example `"gpt-5"`, `"@bad"`, or a bare `"@cf/"`) with an error naming both valid forms, instead of passing it to `env.AI.run()` and failing at inference time. `@hf/...` ids now get the same Workers AI chat settings (`sessionAffinity`) as `@cf/...` ids.
