---
"@cloudflare/think": patch
---

A workflow prompt whose structured output is larger than a workflow event can hold (1 MiB) ends `error` with that reason, and `listSubmissions()` no longer reads every submission's result.
