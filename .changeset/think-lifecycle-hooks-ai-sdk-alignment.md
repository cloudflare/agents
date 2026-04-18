---
"@cloudflare/think": minor
---

Align Think lifecycle hooks with the AI SDK and fix latent bugs around tool-call hooks and extension dispatch.

**Lifecycle hook context types are now derived from the AI SDK** (resolves [#1339](https://github.com/cloudflare/agents/issues/1339)). `StepContext`, `ChunkContext`, `ToolCallContext`, and `ToolCallResultContext` are derived from `StepResult`, `TextStreamPart`, and `TypedToolCall` so users get full typed access to `reasoning`, `sources`, `files`, `providerMetadata` (where Anthropic cache tokens live), `request`/`response`, etc., instead of `unknown`. The relevant AI SDK types are re-exported from `@cloudflare/think`.

**`beforeToolCall` / `afterToolCall` now fire with correct timing.** `beforeToolCall` runs **before** the tool's `execute` (Think wraps every tool's `execute`), and `afterToolCall` runs **after** with `durationMs` and a discriminated `success`/`output`/`error` outcome (backed by `experimental_onToolCallFinish`).

**`ToolCallDecision` is now functional.** Returning `{ action: "block", reason }`, `{ action: "substitute", output }`, or `{ action: "allow", input }` from `beforeToolCall` actually intercepts execution.

**Extension hook dispatch.** `ExtensionManifest.hooks` claimed support for `beforeToolCall`/`afterToolCall`/`onStepFinish`/`onChunk` but Think only ever dispatched `beforeTurn`. All five hooks now dispatch to subscribed extensions with JSON-safe snapshots. Extension hook handlers also receive `(snapshot, host)` (symmetric with tool `execute`); previously only tool executes got the host bridge.

**Breaking renames** (per AI SDK conventions): `ToolCallContext.args` → `input`, `ToolCallResultContext.args` → `input`, `ToolCallResultContext.result` → `output`. `afterToolCall` is now a discriminated union — read `output` only when `ctx.success === true`, and `error` when `ctx.success === false`. Equivalent renames on `ToolCallDecision`.

See [docs/think/lifecycle-hooks.md](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md) for the full hook reference.
