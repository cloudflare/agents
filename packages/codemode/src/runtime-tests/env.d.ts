/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Makes the `cloudflare:test` module (evictDurableObject, evictAllDurableObjects,
// etc.) resolvable to TypeScript for the runtime-tests project. Mirrors
// packages/agents/src/tests/env.d.ts. The runtime tests run under their own
// wrangler config (vitest.runtime.config.ts), so this lives alongside them.
