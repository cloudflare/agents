---
"@cloudflare/ai-chat": patch
---

Fix `_sanitizeMessageForPersistence` stripping Anthropic `redacted_thinking` blocks. The sanitizer now strips OpenAI ephemeral metadata first, then filters out only reasoning parts that are truly empty (no text and no remaining `providerMetadata`). This preserves Anthropic's `redacted_thinking` blocks (stored as empty-text reasoning parts with `providerMetadata.anthropic.redactedData`) while still removing OpenAI placeholders. Fixes #978.
