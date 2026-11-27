---
"agents": minor
---

Storage limits and `agents/streams`.

- Agents now store up to 8 MB in one SQLite row (was 2 MB), as production allows. Event-log replay, Sessions search and `getAgentToolChunks` now page by size (16 MiB per frame or reply); a caller of `getAgentToolChunks` reads the rest by passing the last `afterSequence` until a call returns no chunks. Local development needs workerd 1.20260930 or later: `wrangler` 4.145.0+ and `@cloudflare/vitest-plugin` 1.9.1+; older local runtimes fail large writes with `SQLITE_TOOBIG`. See [Adding to an existing project](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/).
- `ROW_MAX_BYTES` and `enforceRowSizeLimit` are removed from `agents/chat` (use `ROW_VALUE_BYTES`).
- An oversized callable result or chat message list fails with an error instead of being dropped, and oversized state or SQL throws a `SqlError` naming the limit (#2991, #3050, #3063).
- `agents/streams` takes an optional `name` (experimental) and validates its arguments (#3062).
