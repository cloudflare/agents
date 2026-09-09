---
"@cloudflare/codemode": patch
---

Truncate structured results structurally instead of slicing their JSON.

`truncateResult` (the default `transformResult` in Think's execute tool and the browser tools) and the `codeMcpServer` / `openApiMcpServer` response path used to pretty-print an oversized object and cut it at a character count, leaving the model with half a JSON document. Oversized values are now shrunk in place, largest values first: strings are clipped with a `--- TRUNCATED --- <n> chars` suffix, arrays keep their leading items and end with a `--- TRUNCATED --- <n> more items` element, and an object only loses entries (largest first, named in a `"--- TRUNCATED ---"` entry) when its values cannot share the budget. The output is always valid JSON of the original shape and small values pass through untouched.

The Code Mode tool now carries a `toModelOutput` that projects `calls` out of what the model sees and bounds the sandbox `logs` the same way a result is bounded. The durable call log — every connector call's args and result — stays on the persisted tool part for UIs and audit, but no longer rides into the model's context uncapped alongside the transformed `result`. The projection never throws: a BigInt or cyclic value is rendered rather than failing a completed run at model assembly.

The MCP servers apply the response budget to the text they emit, pretty-printing only while that still fits.

Fixes #2009, #2143 and #2182.
