---
"agents": patch
---

Enforce the `tool_use.input` invariant at the chat write boundary.

A streamed tool call that finishes with no `input_json_delta` events (the model called the tool with no args), or whose input surfaces as a stringified JSON blob, could persist a non-object `input` — `null`, `undefined`, `""`, an array, or a raw string. The Anthropic Messages API requires `tool_use.input` to be a JSON object and rejects every subsequent turn with `tool_use.input: Input should be an object` (verified against the live API: `{}` → 200, but `""`, `[]`, and `[{...}]` all → 400). Because the bad shape lives in durable storage, the session is wedged across reconnects, redeploys, and DO evictions.

`applyChunkToParts` (the shared accumulator used by `@cloudflare/ai-chat` and `@cloudflare/think`) now normalizes the finalized tool `input` on `tool-input-available` / `tool-input-error`: a plain object passes through untouched, a stringified-JSON object is parsed, and everything else (`null`/`undefined`/`""`/arrays/primitives/unparseable strings) collapses to `{}`. A new `normalizeToolInput` helper is exported from `agents/chat` so read-side transcript repair can enforce the same invariant.
