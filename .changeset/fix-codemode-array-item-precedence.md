---
"@cloudflare/codemode": patch
---

Types generated from JSON Schema group unions correctly (`Array<string | null>`, not `string | null[]`), and a `type` list such as `["array", "null"]` keeps its `items` and `properties`.
