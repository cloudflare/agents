---
"@cloudflare/codemode": patch
---

Remove `zod-to-ts` dependency to reduce bundle size. Zod schemas are now converted to TypeScript strings via JSON Schema using the existing `jsonSchemaToTypeString()` function and AI SDK's `asSchema()`.
