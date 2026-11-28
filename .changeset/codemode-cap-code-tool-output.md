---
"@cloudflare/codemode": patch
---

`createCodeTool` (and the browser and TanStack AI variants) now cap the `result` and `logs` they return to the model, and the console output in a failure message, using `truncateResult`'s `--- TRUNCATED ---` marker (#3495).
