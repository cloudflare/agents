---
"@cloudflare/ai-chat": patch
---

Heal a malformed `tool_use.input` when loading persisted messages.

`AIChatAgent` delegates `convertToModelMessages` to your `onChatMessage`, so it has no framework-side pre-send pass to repair a transcript. A session that persisted a non-object tool `input` — `null`, `undefined`, `""`, an array, or a raw string — before the write-side guard shipped would therefore keep 400ing with `tool_use.input: Input should be an object` on every turn, wedged across reconnects/redeploys/evictions.

`autoTransformMessage` (run on every load) now normalizes malformed tool inputs to `{}` (parsing stringified-JSON objects, and leaving healthy object inputs untouched), so existing wedged sessions self-heal on their next load without per-DO storage surgery. Healthy messages are returned by reference, so the persistence cache stays a no-op for them.
