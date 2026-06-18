---
"@cloudflare/think": minor
---

`Think` now annotates and logs row-size compaction the same way
`@cloudflare/ai-chat` does.

When a persisted message exceeds the SQLite row-size limit and `Think` compacts
its tool outputs or truncates its text parts to fit, the resulting message now
carries `metadata.compactedToolOutputs` (the compacted tool-call IDs) and/or
`metadata.compactedTextParts` (the truncated text-part indices), and `Think`
emits a `console.warn` describing the compaction. The compaction itself is
unchanged — `Think` already used the shared shape-preserving `truncateToolOutput`
compactor — this only adds the previously ai-chat-only annotations/warnings so a
client can tell that a stored message was compacted. Both packages now share one
`enforceRowSizeLimit` implementation.
