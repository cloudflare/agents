---
"@cloudflare/think": patch
---

think: add `beforeStep` lifecycle hook and `output` passthrough on `TurnConfig`.

- **`beforeStep(ctx)`** — new lifecycle hook called before each AI SDK step in the agentic loop, wired to `streamText({ prepareStep })`. Receives a `PrepareStepContext` (the AI SDK's `PrepareStepFunction` parameter — `steps`, `stepNumber`, `model`, `messages`, `experimental_context`) and may return a `StepConfig` (`PrepareStepResult`) to override `model`, `toolChoice`, `activeTools`, `system`, `messages`, `experimental_context`, or `providerOptions` for the current step. Use `beforeTurn` for turn-wide assembly and `beforeStep` when the decision depends on the step number or previous step results. Resolves [#1363](https://github.com/cloudflare/agents/issues/1363).
- **`TurnConfig.output`** — new optional field on `TurnConfig` forwarded to `streamText`. Accepts the AI SDK's structured-output spec (e.g. `Output.object({ schema })`, `Output.text()`) so a single agent can keep tools enabled on intermediate turns and return schema-validated structured output on a designated turn — without losing tools at model construction. Combine with `activeTools: []` for providers that strip tools when `responseFormat: "json"` is active (e.g. `workers-ai-provider`). Resolves [#1383](https://github.com/cloudflare/agents/issues/1383).
- New re-exports from `@cloudflare/think`: `PrepareStepFunction`, `PrepareStepResult`, `PrepareStepContext`, `StepConfig`.

`beforeStep` is available to subclasses; it is not dispatched to extensions (the AI SDK `prepareStep` boundary surfaces non-serializable inputs like `LanguageModel` instances). The AI SDK does not expose `output` or `maxSteps` per step — set those at the turn level via `TurnConfig`. All other extension hook subscriptions are unchanged.
