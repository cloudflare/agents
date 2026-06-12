---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Defer one-shot scheduled callbacks (and chat-recovery give-ups) on platform transients instead of consuming them mid-deploy (#1730).

A mid-execution Durable Object code-update reset surfaces storage failures in two shapes: the verbatim reset/supersede messages (already deferred) and `SqlError: SQL query failed: Network connection lost.` — a wrapper that drops the CF `retryable` flag and dodges the reset matcher. The second shape burned the in-process retry budget inside the same few-seconds reset window (which outlasts the retry schedule by design) and then consumed the one-shot row on exhaustion, freezing the turn for minutes until incident re-detection — in the reported production capture, storage was healthy again 15 ms after the final attempt.

- **`agents`** — new cause-aware `isPlatformTransientError` classifier (exported, alongside `isDurableObjectCodeUpdateReset`): reset/supersede messages, `retryable`-flagged platform errors (excluding overloaded), and "Network connection lost.", looked up through wrapper `cause` chains. `_executeScheduleCallback` keeps in-process retries for connection-lost transients (a genuine blip heals fast) but on exhaustion of a one-shot row it now re-throws instead of swallowing, so the row survives and the alarm re-runs it in the healthy window that follows. Genuine application errors are still abandoned after `maxAttempts` exactly as before.
- **`@cloudflare/think`** — `_handleRecoveryCallbackError` now defers (re-throws) on any platform transient instead of terminalizing through a give-up whose own seal needs the storage that is down; the bookkeeping write on the defer path is best-effort. The defer path no longer marks the recovered submission `error` (which made the deferred re-run skip with `submission_not_running` — a self-defeating defer); it stays `running` for the re-run to pick up. The give-up now seals the incident `exhausted` only after the terminal writes succeed, so a transient mid-seal defers the whole give-up for an idempotent re-run instead of half-sealing.
- **`@cloudflare/ai-chat`** — same give-up seal ordering: the incident is sealed only after `_exhaustChatRecovery` (incl. the durable terminal record) succeeds, so a transient mid-seal preserves the one-shot row and the give-up re-runs in full on a healthy isolate.
