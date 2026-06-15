---
"@cloudflare/codemode": patch
---

Fix the runtime tool description to say "Execute JavaScript" instead of "Execute TypeScript". The codemode sandbox executes JavaScript only; TypeScript types are generated for LLM context but are not executed.
