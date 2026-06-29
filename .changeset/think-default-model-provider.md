---
"@cloudflare/think": minor
---

`getModel()` now accepts a model id string, resolved through a built-in `workers-ai-provider` instance — no separate provider package to install, import, or wire up for the common case.

Think now depends on `workers-ai-provider` (plus the `@ai-sdk/openai` and `@ai-sdk/anthropic` wire-format plugins) directly. When `getModel()` returns a string, Think resolves it off your `AI` binding:

- A `@cf/...` id hits Workers AI directly (with `sessionAffinity` wired in automatically for prefix-cache hits).
- Any other `"<provider>/<model>"` slug — e.g. `"openai/gpt-5.5"`, `"anthropic/claude-sonnet-4-5"`, `"google/gemini-2.5-pro"`, `"xai/grok-4"`, `"groq/..."` — is routed through AI Gateway.

```typescript
export class MyAgent extends Think<Env> {
  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code"; // or "openai/gpt-5.5"
  }
}
```

Returning a fully-constructed AI SDK `LanguageModel` from `getModel()` still works unchanged for any other provider or for full control over provider/gateway options. A new `getAIBinding()` override (default `this.env.AI`) controls which binding the string resolver uses.

Because `getModel()` may now return a bare string, a new public `resolveModel(model?)` method (defaults to resolving `getModel()`) returns a concrete `LanguageModel`. Use it for side inference calls — e.g. summarization/compaction `generateText` — instead of passing `getModel()` straight to the AI SDK.

The per-turn override `TurnConfig.model` (returned from `beforeTurn`) also accepts a `ThinkModel` now, so you can switch models for a turn with a plain string (e.g. a cheaper model for continuations). The per-step override `StepConfig.model` (returned from `beforeStep`) accepts a `ThinkModel` too — Think resolves a string back into a `LanguageModel` before handing the step to the AI SDK.

`getModel()` is typed to return `ThinkModel` (a newly exported alias for `LanguageModel | ThinkModelId`). `ThinkModelId` (also exported) gives editor autocomplete for the Workers AI text-generation catalog (`@cf/...`, derived from the installed `@cloudflare/workers-types`) while still accepting any string — gateway catalog slugs like `"openai/gpt-5.5"` are validated at runtime, since the catalog lives server-side and is not knowable from types.
