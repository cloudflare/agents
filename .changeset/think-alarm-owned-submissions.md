---
"@cloudflare/think": patch
---

Run durable submissions only from their awaited scheduled drain, preventing model work and tracing spans from outliving the short submission-acceptance invocation.
