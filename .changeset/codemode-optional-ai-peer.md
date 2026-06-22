---
"@cloudflare/codemode": patch
---

Remove the root entry's runtime dependency on the optional `ai` and `zod` peers. Executor and runtime imports now bundle without either framework package installed.
