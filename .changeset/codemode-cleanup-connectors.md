---
"@cloudflare/codemode": patch
---

Cleanup connector imports so connector modules are imported normally and the Vite plugin only auto-exports the CodemodeRuntime facet class. Codemode now fails loudly when the runtime facet class is not exported from the Worker entry.
