Status: accepted

# RFC: Decouple chat-recovery duration from the runaway-loop guard

## The problem

Durable chat recovery (`AIChatAgent` in `@cloudflare/ai-chat`, mirrored in
`@cloudflare/think`) bounds an in-progress recovery incident with three limits,
computed in `_beginChatRecoveryIncident`:

- **No-progress window** (`CHAT_RECOVERY_NO_PROGRESS_WINDOW_MS`, 5 min) — keyed
  to `lastProgressAt`, **resets on forward progress**. Catches a stuck turn.
- **Attempt cap** (`maxAttempts`, default 10) — **resets on forward progress**.
  Catches a tight no-progress alarm loop.
- **Absolute incident-age ceiling** (`CHAT_RECOVERY_MAX_WINDOW_MS`, 15 min) —
  keyed to `firstSeenAt`, **never resets**.

A long agentic turn that makes genuine forward progress on every recovery but
takes more than 15 minutes of wall-clock to finish (because it is repeatedly
interrupted by a dense deploy window) is sealed with
`reason="max_recovery_window_exceeded"`, discarding completed work and forcing a
re-prompt. A customer hit this in production: ~99 model generations, ~3 deploys
in ~95 minutes, sealed at exactly 901,929 ms (≈ the 15-min ceiling) while still
healthy (`attempt=1`, meaning the no-progress window and attempt cap had just
reset on progress — only the non-resetting ceiling could fire).

The ceiling is overloaded: it does duty as both a _recovery-duration bound_ and
a _runaway-loop guard_. Those jobs want different instruments. The no-progress
window already catches stuck turns; the only thing the absolute ceiling uniquely
catches is a loop that **keeps emitting content but never converges** — and that
is a **bounded-work** condition, not a duration. A healthy long turn and a
runaway loop are distinguished by _work done_, not by _elapsed time_.

## The proposal

Decouple the two jobs.

1. **Remove the non-resetting wall-clock ceiling.** Recovery duration is no
   longer bounded for a progressing turn. A turn making genuine forward progress
   survives unbounded deploy churn. Stuck turns are still sealed by the
   no-progress window; tight no-progress alarm loops by the attempt cap.

2. **Add a work budget** as the runaway-loop guard. Reuse the existing durable,
   monotonic, reconnect-immune progress counter (`CHAT_RECOVERY_PROGRESS_KEY`,
   bumped once per produced content/tool unit — not per token) as a **work
   meter**. Record the counter value at incident open (`workBaseline`) and seal
   when `work = progress - workBaseline` exceeds `maxRecoveryWork`
   (`reason="work_budget_exceeded"`).

3. **Add a caller predicate hook** `shouldKeepRecovering(ctx)`, invoked per
   recovery attempt from the second onward (only when no hard bound has already
   sealed the incident). Returning `false` seals with
   `reason="recovery_aborted"`. This is where integrators express token / cost /
   semantic-step budgets the SDK should not hardcode. A throwing predicate is
   logged and treated as "keep recovering" so a buggy hook cannot wedge a turn.

4. **Expose the no-progress timeout** as `noProgressTimeoutMs` (default 5 min,
   resets on progress). With the wall-clock ceiling gone it is the primary
   stuck-turn bound, and it was the only recovery limit still hardcoded;
   exposing it keeps the config surface consistent (`maxAttempts`,
   `stableTimeoutMs`, `maxRecoveryWork` are all configurable). Safe to expose
   because it resets on progress, so it only bites genuinely idle turns.

The new knobs live on `ChatRecoveryConfig`:

```ts
maxRecoveryWork?: number; // default Infinity
noProgressTimeoutMs?: number; // default 300_000 (5 min)
shouldKeepRecovering?(ctx: ChatRecoveryProgressContext): boolean | Promise<boolean>;
```

### Naming

The predicate is `shouldKeepRecovering`, not `shouldContinue`: `continue` is
already overloaded in this API (`ChatRecoveryOptions.continue` and
`continueLastTurn()`), so `shouldContinue` read as "should I call
`continueLastTurn`?" rather than "should the recovery loop keep going?". The
work cap stays `maxRecoveryWork`/`ctx.work` — "work" honestly conveys "units of
progress" and the config/context pair is self-documenting.

### Default behavior

`maxRecoveryWork` defaults to **`Infinity`** — the SDK ships the _mechanism_ but
imposes **no** implicit work cap. By default the only remaining bounds are the
no-progress window and the attempt cap (both reset on progress). This is a
deliberate decision (see "Decision"): a progressing turn is never terminated by
the framework on its own; integrators that need a runaway backstop set
`maxRecoveryWork` or `shouldKeepRecovering`. Note `maxSteps` is **not** a substitute —
it bounds a single continuation and resets on each recovery, so it does not
bound cumulative recovery work (the gap the work budget exists to fill).

`max_recovery_window_exceeded` is no longer emitted. It is retained in the
documented `reason` union (an open string) for back-compat with persisted
incidents.

## The alternatives

- **B — expose `maxRecoveryWindowMs` + `recoveryWindowResetsOnProgress`.** A
  minimal unblock that keeps the wall-clock instrument but makes it tunable /
  progress-resetting. Rejected as the end state: a progress-resetting wall-clock
  cap is just a slower no-progress window, and a non-resetting one keeps the
  false-positive footgun. Useful only as an interim; we went straight to A.

- **C — sliding window.** Each progress event pushes the ceiling out, capped at
  a larger hard maximum. Rejected: same false-positive class as today, only
  later; still bounds a progressing turn by duration.

- **Finite default `maxRecoveryWork`.** Preserves an implicit backstop for
  existing users. Rejected: requires inventing a magic work number, which is the
  same class of fragile proxy that caused the original bug. We prefer an
  explicit `Infinity` default and let integrators opt into a cap they understand.

- **Per-token work meter.** Rejected: the existing counter is per-content-unit
  (text/reasoning-start, settled tool input/output), durable and reconnect-
  immune. It is already the right granularity for "work done" and free to reuse.

## The decision

Accepted. Ship A in both `@cloudflare/ai-chat` and `@cloudflare/think` (the two
copies of the recovery engine), with `maxRecoveryWork` defaulting to `Infinity`.

Invariant:

> A turn making genuine forward progress survives unbounded deploy churn — no
> matter how long it runs or how many recoveries occur — and is terminated only
> by (a) a no-progress timeout (stuck), (b) the attempt cap (no-progress alarm
> loop), (c) a work-budget violation (runaway), or (d) a caller predicate.
