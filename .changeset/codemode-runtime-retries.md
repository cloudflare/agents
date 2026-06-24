---
"@cloudflare/codemode": patch
---

Add durable execution retries to `runtime.tool()`. Connectors can throw `RetryableError` with an optional delay; by default the runtime makes three total attempts, honors that delay or uses bounded exponential backoff, and can be customized or disabled with `retry`. Failed passes restart under the same execution id, replaying applied calls from the log and re-executing only the failure boundary. Dynamic-worker timeouts are surfaced as structured failures but are not retried by default, so applications can conservatively decide which executions are safe to retry. Attempt fencing prevents calls or results from a superseded timed-out sandbox from mutating the replay log, and connector execute contexts receive a pass-scoped `AbortSignal` for cooperatively cancelling old work before the runtime moves on.
