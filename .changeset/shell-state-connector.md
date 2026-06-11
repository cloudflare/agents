---
"@cloudflare/shell": minor
---

Add `StateConnector` — the `state.*` filesystem API as a codemode connector.

`stateConnector(ctx, backend)` (or `new StateConnector(ctx, backend)`) exposes every `StateBackend` method (`readFile`, `writeFile`, `editFile`, `ls`, `find`, `grep`, `readJson`, `mergeJson`, …) as connector tools for `@cloudflare/codemode`'s durable runtime. Tools take a single object argument (`state.writeFile({ path, content })`), which the connector maps to the backend's positional parameters; pure reads are marked `replay: "reexecute"` so large file contents are never stored in the durable log. The legacy provider path (`createStateToolProvider`/`stateTools`) is unchanged and also accepts object-style arguments now, and the `state.*` type declarations and system prompt were updated to the object-argument convention.
