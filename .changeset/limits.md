---
"agents": minor
---

Storage and message size limits.

- Agents now store up to 8 MB in one SQLite row (was 2 MB), as production allows. Event-log replay, Sessions search and `getAgentToolChunks` now page by size (16 MiB per frame or reply); a caller of `getAgentToolChunks` reads the rest by passing the last `afterSequence` until a call returns no chunks. Local development needs workerd 1.20260930 or later: `wrangler` 4.145.0+ and `@cloudflare/vitest-plugin` 1.9.1+; older local runtimes fail large writes with `SQLITE_TOOBIG`. See [Adding to an existing project](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/).
- `ROW_MAX_BYTES` is removed from `agents/chat` (use `ROW_VALUE_BYTES`), and `enforceRowSizeLimit` is deprecated.
- A callable whose result or stream chunk is over the WebSocket message limit (1 KiB under 32 MiB) answers with an error instead of leaving the call waiting (#2991, #3050).
- `setState` and SQL statements over SQLite's size limits throw a `SqlError` that names the limit (#3063).
