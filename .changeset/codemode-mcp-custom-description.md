---
"@cloudflare/codemode": patch
---

Add optional `description` to `codeMcpServer`, matching the existing option on `createCodeTool`. Supports `{{types}}` and `{{example}}` placeholders; falls back to the built-in default when omitted.
