---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Stored chat messages and tool calls.

- Before each turn, tool calls and approvals left pending in earlier replies are failed (`chat:transcript:repaired` reports it), and `continueLastTurn()` returns `"awaiting-client"` while a reply waits on a client. See [Client-side tools](https://github.com/cloudflare/agents/blob/main/docs/agents/client-tools-continuation.md#when-the-user-moves-on-without-answering).
- A streaming tool's final output now clears `preliminary`, so the call and its result are no longer dropped from later turns (#3143).
- Overlapping text and reasoning parts no longer mix, and a streamed file keeps its `filename` (#3145).
- Stored parts keep `providerMetadata` and `toolMetadata` (#3143).
- A repeated tool result is a no-op, and an approval given before a tool's final input keeps that input (#2981).
- `AIChatAgent` retention (`maxPersistedMessages`) no longer reads the whole transcript on every persist.
