---
"@cloudflare/codemode": patch
---

Add client-side tool calls to codemode via durable pause/resolve. A tool annotated with `resolution: "client"` pauses the run like an approval, but is never executed server-side: the host supplies its result with the new `resolve({ executionId, seq, result })` on the runtime handle (or the standalone `resolveCodemode`), and the run resumes with the code seeing the client's value. `ToolSetConnector` gains a `clientTools: "pause"` option that exposes execute-less AI SDK tools (client-side / provider-executed) as client-resolved tools instead of skipping them.
