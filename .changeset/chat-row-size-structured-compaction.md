---
"@cloudflare/ai-chat": minor
---

`AIChatAgent` now compacts oversized tool outputs structurally instead of
replacing them with a flat summary string.

Previously, when a persisted assistant message exceeded the SQLite row-size
limit, `AIChatAgent` replaced each large tool output with a single english
summary string (`"This tool output was too large to persist… Preview: …"`),
discarding the original shape. It now uses the shared shape-preserving
`truncateToolOutput` compactor (the same one `@cloudflare/think` already used):
objects and arrays keep their structure, long strings are truncated in place
with a `... [truncated N chars]` marker, and only genuinely unrepresentable
nesting collapses to a marker object. This makes a compacted tool result far
easier for the model to keep reasoning about, and converges `AIChatAgent` and
`@cloudflare/think` onto one row-size compaction path. The
`metadata.compactedToolOutputs` / `metadata.compactedTextParts` annotations and
the compaction `console.warn`s are unchanged.
