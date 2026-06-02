---
"@cloudflare/think": patch
---

Fix two chat-recovery failures that could leave a turn wedged at a half-finished assistant message after a deploy/eviction, with no terminal banner.

1. **Server-tool recovery deadlock.** When a server-side tool's `execute()` was interrupted by an eviction, the recovered turn's orphaned tool part was left at `input-available` — but no client `tool-result` will ever arrive for a server tool, so `waitUntilStable` could never converge. The recovery continuation burned its whole attempt budget on a wait that could not succeed. `waitUntilStable` now treats an `input-available` part as pending only when it is genuinely client-resolvable (a registered client tool whose result the SPA can replay, or an `approval-requested` part). A dead server-tool orphan no longer blocks stability, so recovery converges and the existing transcript-repair pass flips the orphan to an errored result and the model continues the turn.

2. **Silent seal on a thrown recovery callback.** A non-reset error thrown by `_chatRecoveryContinue` / `_chatRecoveryRetry` was re-thrown and then swallowed by the scheduler, which deleted the one-shot recovery alarm row — terminating the turn with no `onExhausted` event and no terminal banner. The recovery callbacks now terminalize a non-reset throw through the same exhaustion path (firing `onExhausted` with reason `recovery_error` and delivering the `terminalMessage`), while still re-throwing a genuine Durable Object code-update reset so the platform re-runs recovery on the fresh isolate. The terminal banner is also now broadcast before the bookkeeping storage writes in the exhaustion path, and those writes are best-effort, so a storage failure during give-up can no longer suppress the user-visible terminalization.
