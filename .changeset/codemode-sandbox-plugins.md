---
"@cloudflare/codemode": patch
---

Add `ToolProvider` interface for composing tools from multiple sources into a single codemode sandbox. `createCodeTool` now accepts a `ToolProvider[]` alongside raw tool sets. Each provider contributes tools under a named namespace (e.g. `state.*`, `mcp.*`) with the default being `codemode.*`. Providers with `positionalArgs: true` use natural function signatures (`state.readFile("/path")`) instead of single-object args. The old `executor.execute(code, fns)` signature is deprecated but still works with a warning.
