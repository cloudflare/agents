---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat recovery after a restart or a dropped stream.

- Recovery work units (`maxRecoveryWork`, `ctx.work`) now count ten stored chunks each.
- Rate-limit, transient and overflow errors are recognised without `classifyChatError`, and recovery honours `Retry-After` (up to 60 s).
- An interrupted turn is skipped if the conversation moved on, else answered or continued once, and requests behind it run afterwards in order (#2922).
- Long conversations are no longer sealed with `work_budget_exceeded` (#3055).
- A stop during recovery always ends the request `aborted`, and the next message no longer waits out its backoff (#3027).
- A rebuilt reply no longer repeats parts, and a tool that only reported progress before a reset is reported interrupted (#2979).
