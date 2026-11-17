---
"@cloudflare/codemode": patch
---

`DynamicWorkerExecutor` now reports an error when sandbox code throws a non-Error value (string, object, `null`, `undefined`) instead of returning `error: undefined` or rejecting.
