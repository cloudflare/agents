---
"@cloudflare/codemode": patch
---

DynamicWorkerExecutor now normalizes code and sanitizes tool names internally. Users no longer need to call `normalizeCode()` or `sanitizeToolName()` before passing code/fns to `execute()`.
