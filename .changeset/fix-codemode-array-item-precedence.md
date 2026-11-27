---
"@cloudflare/codemode": patch
---

Types generated from JSON Schema group unions correctly, and a `type` list such as `["array", "null"]` keeps its `items` and `properties`.
