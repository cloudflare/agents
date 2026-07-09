---
"@cloudflare/codemode": patch
---

Echo the durable tool-call log on the proxy tool output. `ProxyToolOutput` now carries an optional `calls` field (the execution's `ToolLogEntry[]`) on completed, paused and error outcomes, so UIs can render an audit trail of every connector call and step — name, args, result, approval requirement and state — without a separate `executions()` round trip.
