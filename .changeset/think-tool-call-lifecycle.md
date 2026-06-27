---
"@cloudflare/think": minor
---

Improve Think's tool-call lifecycle hooks (follow-ups from #1343):

- **Preserve preliminary streaming through `beforeToolCall`.** Tools whose `execute` is an async generator (`async function* execute(...)`) now stream their preliminary tool-results to the model even though Think wraps `execute` to consult `beforeToolCall` first. Non-streaming tools keep a scalar wrapper, so they never emit a synthetic `preliminary` chunk. The non-canonical `async () => makeIterator()` form (a `Promise<AsyncIterable>`) still collapses to its last yielded value, matching the raw AI SDK.
- **Per-tool typing on the lifecycle contexts.** When an explicit `TOOLS` generic is passed, narrowing on `ctx.toolName` now narrows `ctx.input` on `beforeToolCall` and — new — `ctx.output` on `afterToolCall`'s success branch to that tool's inferred output type. Dynamic tools stay `unknown`. Behavior with the default `ToolSet` is unchanged.
