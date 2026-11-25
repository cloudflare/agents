---
"agents": minor
---

Agents now store up to 8 MB in one SQLite row (was 2 MB), as production allows, so a large message or attachment takes fewer rows. Event-log replay, Sessions search and `getAgentToolChunks` now also page by size (16 MiB per frame or reply), so they stay within the 32 MiB WebSocket and RPC limits; a caller of `getAgentToolChunks` reads the rest by passing the last `afterSequence` until a call returns no chunks. Local development needs workerd 1.20260930 or later: `wrangler` 4.145.0+ and `@cloudflare/vitest-plugin` 1.9.1+; older local runtimes fail large writes with `SQLITE_TOOBIG`. See [Adding to an existing project](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/).
