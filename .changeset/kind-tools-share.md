---
"agents": minor
"@cloudflare/ai-chat": patch
---

Accept AI SDK flexible schemas in `agentTool`, including Valibot adapters, while preserving schema-driven input inference and structured output validation. Zod is no longer a peer requirement of `@cloudflare/ai-chat`.

Existing custom schemas that no longer type-check as AI SDK `FlexibleSchema` must use the schema library's AI SDK adapter or wrap raw JSON Schema with `jsonSchema()`. Validation-only Standard Schema implementations are insufficient because tool inputs must expose JSON Schema to the model.
