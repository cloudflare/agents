---
"agents": patch
---

Trace every job the Lifecycle alarm loop runs. Each dispatch gets a `process {owner}` span that follows the OpenTelemetry messaging conventions (`messaging.system`, `messaging.destination.name`, `messaging.message.id`, `error.type`), and adds `cloudflare.agents.job.*` attributes for the function name, outcome, attempt count, retry budget, reschedule time and how late the job started. Spans the job creates, such as storage and model calls from a scheduled callback, nest under it. Each failed attempt is recorded as an exception event that carries only the error class name, and a job that runs out of retries gets an error span status on runtimes that support `Span.setStatus()`.
