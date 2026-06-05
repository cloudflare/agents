---
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

fix(chat-recovery): don't seal a human-in-the-loop turn that is waiting on a pending client tool call

A turn parked on a pending CLIENT interaction — an `input-available` client-tool part (no server `execute`) or an `approval-requested` part, as detected by `hasPendingInteraction()` — is _waiting on the human_, not stuck. After a mid-turn Durable Object restart (e.g. a deploy), the in-memory pending-interaction promise is gone, so `waitUntilStable()` repeatedly times out until the client reconnects and replays the tool-result/approval. That replay drives a fresh continuation via the auto-continuation barrier independently of recovery — but the recovery loop was treating those timeouts as deploy churn:

- each stable-state timeout burned a recovery attempt, eventually sealing a perfectly healthy turn with `reason="stable_timeout"`, and
- the no-progress window (which never advances while no content is produced) could seal it with `reason="no_progress_timeout"` once it elapsed.

The net effect: an interrupted human-in-the-loop turn whose user simply took longer than the configured `noProgressTimeoutMs` / attempt budget to answer a tool prompt was terminalized with a "session interrupted" banner, even though nothing had actually failed.

While a client interaction is pending the turn is now **budget-free**:

- `_beginChatRecoveryIncident` suppresses the no-progress window, attempt cap, work budget, and `shouldKeepRecovering` predicate, and keeps the no-progress clock fresh so the turn gets a full window once the human finally answers.
- `_chatRecoveryContinue` / `_chatRecoveryRetry` **park** (mark the incident `skipped` with `reason="awaiting_client_interaction"`, resolving the live "recovering…" indicator) instead of rescheduling or exhausting — the client's eventual replay resumes the turn. A client that never returns is reclaimed by the incident TTL sweep and DO idle-eviction.

In `@cloudflare/think`, a `submitMessages`-backed turn additionally has its durable submission row **completed** at park time. The recovery loop is that row's sole completion driver after a restart, and the client's replay resumes the conversation as an independent auto-continuation that never touches the submission — so parking without completing would leave the row `running`, and the next restart's `_recoverSubmissionsOnStart` would sweep it to `error` (a false "session recovery error"). The park condition is a fully-materialized client tool call in the leaf, which is exactly the terminal state a non-interrupted submission reaches when its step emits a client tool call (the model does not block on client tools), so `completed` is the correct, consistent outcome.

SERVER-tool orphans are deliberately excluded (their `execute()` died with the isolate and nothing will resolve them), so they still recover normally via the transcript-repair pass.

Both `@cloudflare/think` and `@cloudflare/ai-chat` (which carries its own copy of the recovery engine) are fixed. In `@cloudflare/think` the client/server distinction already lived in `hasPendingInteraction()`. `@cloudflare/ai-chat`'s `hasPendingInteraction()` (used by `waitUntilStable`) does not distinguish client from server tools, so a new, narrower client-only predicate `hasPendingClientInteraction()` was added there and gates the exemption — leaving `waitUntilStable`'s existing behavior untouched so server-tool orphans keep reschedule/exhaust semantics.

The exemption depends on knowing the request's client tools. `@cloudflare/ai-chat` restores them in its constructor, so they are available when boot recovery evaluates budgets. `@cloudflare/think` restored them in `onStart()`, which the base `Agent` runs _after_ the boot-recovery path (`_handleInternalFiberRecovery` -> `_beginChatRecoveryIncident`) — so on a fresh wake the in-memory cache was still empty and a client-tool `input-available` orphan re-detected past the no-progress window was misread as "stuck" and wrongly sealed. `_beginChatRecoveryIncident` now re-hydrates `_lastClientTools` from the durable `think_config` store before evaluating the budget, closing that hibernation-ordering hole (`approval-requested` turns were never affected, since that branch does not depend on the client tool set).
