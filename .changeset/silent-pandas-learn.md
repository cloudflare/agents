---
"@cloudflare/codemode": patch
---

Remove the echoed source `code` field from codemode tool results. Successful sandbox executions now return only the execution `result` and any captured `logs`.
