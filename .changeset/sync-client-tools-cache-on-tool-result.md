---
"@cloudflare/ai-chat": patch
---

Sync `_lastClientTools` cache and SQLite when client tools arrive via `CF_AGENT_TOOL_RESULT`, and align the wire type with `ClientToolSchema` (`JSONSchema7` instead of `Record<string, unknown>`)
