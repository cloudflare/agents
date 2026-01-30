---
"agents": patch
---

docs: add OpenAI provider options documentation to scheduleSchema

When using `scheduleSchema` with OpenAI models via the AI SDK, users must now pass `providerOptions: { openai: { strictJsonSchema: false } }` to `generateObject`. This is documented in the JSDoc for `scheduleSchema`.

This is required because `@ai-sdk/openai` now defaults `strictJsonSchema` to `true`, which requires all schema properties to be in the `required` array. The `scheduleSchema` uses optional fields which are not compatible with this strict mode.
