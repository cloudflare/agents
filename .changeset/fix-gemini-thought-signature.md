---
"@cloudflare/ai-chat": patch
---

Fix Gemini "missing thought_signature" error when using client-side tools with `addToolOutput`.

The server-side message builder (`applyChunkToParts`) was dropping `providerMetadata` from tool-input stream chunks instead of storing it as `callProviderMetadata` on tool UIMessage parts. When `convertToModelMessages` later read the persisted messages for the continuation call, `callProviderMetadata` was undefined, so Gemini never received its `thought_signature` back and rejected the request.

- Preserve `callProviderMetadata` (mapped from stream `providerMetadata`) on tool parts in `tool-input-start`, `tool-input-available`, and `tool-input-error` handlers — both create and update paths
- Preserve `providerExecuted` on tool parts (used by `convertToModelMessages` for provider-executed tools like Gemini code execution)
- Preserve `title` on tool parts (tool display name)
- Add `providerExecuted` to `StreamChunkData` type explicitly
- Add 13 regression tests covering all affected codepaths
