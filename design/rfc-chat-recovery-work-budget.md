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

## Follow-up: finite default `maxRecoveryWork` (#1825)

The `Infinity` default in "Finite default `maxRecoveryWork`" above was reversed
after production issue [#1825](https://github.com/cloudflare/agents/issues/1825).

An isolate that **exceeds its memory limit and is reset** mid-stream has usually
already streamed a little content, which bumps the durable progress counter. On
the next wake that reads as forward progress, **resetting both progress-keyed
bounds** (the no-progress window _and_ the attempt cap), and a fast crash loop
lands inside `CHAT_RECOVERY_ALARM_DEBOUNCE_MS` so the attempt counter is pinned
as well. With `maxRecoveryWork = Infinity` the only meter that still climbs
across the loop is disabled — recovery re-runs the turn (and its LLM calls)
forever.

So the first fix is to simply **turn the existing work meter on by default**
with a generous finite value (`DEFAULT_CHAT_RECOVERY_MAX_WORK = 1000`). This
bounds _every_ loop variant regardless of how the OOM surfaces — a crash that
credits progress is sealed by the work budget, one that credits none is sealed
by the no-progress window or attempt cap. It needs nothing from the dying
isolate, which makes it the right universal backstop.

The "magic number" objection in the rejected alternative still stands in spirit,
which is why the default is deliberately generous (work only accrues from the
first interruption until the turn completes; a normal interrupted turn never
approaches it) and why `Infinity` remains available for a turn that legitimately
produces a large amount of content under heavy interruption — paired with
`shouldKeepRecovering` for a precise, integrator-owned budget. The decision
trades the RFC's "never terminated by the framework on its own" purity for a
safe out-of-the-box default, on the evidence that an unbounded default is a
worse footgun in practice than a high-but-finite one.

## Follow-up: a tight OOM-specific retry budget (#1825)

The earlier note above called crash classification "infeasible" on the
assumption that an OOM is always an uncatchable hard kill. That was only partly
right. A memory-limit reset frequently surfaces **catchably**: the post-reset
isolate's first storage/SQL op rejects with `Durable Object's isolate exceeded
its memory limit and was reset.` (often `SqlError`-wrapped, original only in
`cause`). This is exactly the loop in #1825, where the give-up path itself logs
`[Think] failed to read recovery incident during give-up` — the OOM is _thrown_
from recovery bookkeeping, not a clean stream result. The hard-kill case (no
in-isolate code runs) still exists, but it is the minority — and the work budget
already covers it.

We deliberately do **not** route an OOM that surfaces as a _returned_ `error`
result (`continueLastTurn`'s own stream catch) through this budget. By the time
the turn returns that result it has already terminalized — sent the client a
`done:true, error:true` frame and fired `onError` — and its fiber completed, so
it is not looping. Re-driving it would be wasteful and could emit a second
terminal signal (`out_of_memory`) after the user already saw the error. Those
turns fall through to the normal `failed` terminalization, unchanged.

For the catchable majority, the work budget is a blunt instrument: it lets the
loop burn up to ~1000 units of model output before sealing. We can do far better
because the cause is **attributable**. So we add a second, tighter mechanism:

- A new predicate `isDurableObjectMemoryLimitReset(error)` in `agents/retries`
  (sibling to `isDurableObjectCodeUpdateReset` / `isPlatformTransientError`),
  matching through the `cause` chain and raw strings. It is **deliberately not**
  folded into the transient set: a supersede/connection-lost transient means
  "re-run on a healthy isolate and it succeeds" (defer-and-retry), whereas an
  OOM re-OOMs on re-run because the turn's footprint — not the platform — is the
  cause. Folding it in would _preserve the one-shot row and re-run the doomed
  work forever_, amplifying the very loop we are fixing.

- A durable per-incident `oomAttempts` counter and a `maxOomRetries` config
  (default `3`). When a recovery callback's `catch` observes a _thrown_ OOM, the
  shared engine's `recordOomAndDecide` bumps the counter and either reschedules a
  delayed, non-idempotent re-run (in case the OOM was a transient memory spike)
  while under budget, or returns `"exhausted"` so the caller terminalizes with
  `reason="out_of_memory"`. `evaluateChatRecoveryIncident` carries `oomAttempts`
  forward across begins and seals on the same threshold.

  **The begin path is the reliable terminator.** Recovery turns run inside
  `_runChatRecoveryFiber`, so even a hard-kill leaves an interrupted fiber that
  re-detects on the next wake and re-enters `beginIncident` →
  `evaluateChatRecoveryIncident` — _before_ the memory-heavy `continueLastTurn`,
  in the low-memory window where storage writes reliably succeed. The catch-path
  `recordOomAndDecide` does only tiny writes (bump the counter) under memory
  pressure; even if its eventual give-up write fails, it has already persisted
  the crossed `oomAttempts`, so the next begin seals cleanly. The catch path is
  thus a fast accelerator; the begin-path evaluate-seal (and the work-budget
  seal) are the guarantees.

Why a small budget rather than seal-on-first-OOM: a single OOM can be a genuine
transient (the 128 MB ceiling is shared with the global scope and noisy
neighbors), so one or two fresh-isolate retries can legitimately complete a turn
that was unlucky once — while still bounding a deterministic OOM at a tiny,
attributable cost. Crucially the OOM budget does **not** credit forward
progress: a crash that streams a few tokens before dying still counts, since
that "progress" is the very re-run that re-OOMs.

The two mechanisms compose: the OOM budget is the fast, attributable path for
catchable resets; `maxRecoveryWork` is a backstop for the hard-kill case where
nothing in the isolate runs to record the OOM. `Think` routes thrown OOMs through
its existing continuation `catch` (`_handleRecoveryCallbackError`, which
classifies OOM _before_ the transient check); `AIChatAgent` adds a narrow
OOM-only `catch` to its recovery callbacks that rethrows every non-OOM error to
preserve its existing (catch-free) semantics.

## Follow-up 2: the alarm-boundary circuit breaker (#1825, customer evidence)

A customer reported that even `maxRecoveryWork` did not stop the loop, and broke
it themselves by overriding `alarm()` to catch the memory-limit error and
`deleteAlarm()`. That evidence is decisive: **the in-DO budgets can be bypassed
entirely.** They only seal if their code runs and its writes land, and a severe
OOM defeats both preconditions:

- **It is thrown before the budget runs.** `alarm()` calls `super.alarm()`
  (onStart → state hydration → `_checkRunFibers`) _first_. If hydration OOMs
  there (the customer's `09:18:45` "can't even load its state"), no recovery
  evaluation executes at all.
- **The work budget can be starved.** `maxRecoveryWork` seals on a _progress_
  delta, and progress only climbs while the turn streams output. A turn whose
  bloat is the transcript OOMs during context assembly, before the first token —
  progress never moves, so the work budget never trips no matter how many loops.
- **The seal's own writes OOM.** The customer's `09:19:13`
  (`failed to read recovery incident during give-up`) shows even a tiny SQL read
  failing under memory pressure.

In all three, the error reaches `alarm()` and, unhandled, the platform
auto-retries the alarm with backoff — _forever_ — re-running the doomed, billable
turn (their `09:26:05` `error executing callback _chatRecoveryContinue after 3
attempts` is the in-process `tryN` exhaustion before the throw escapes).

The fix is a framework-level version of the customer's circuit breaker, made
safe and surgical. It works at the **outermost frame** for a specific reason: by
the time `alarm()`'s `catch` runs, `super.alarm()` / the continuation has fully
unwound, so GC has reclaimed the heavy transcript/prompt and the small
seal/purge writes can land where the mid-turn give-up read could not.

- `Agent.alarm()` wraps its body and intercepts ONLY
  `isDurableObjectMemoryLimitReset(error)` (everything else re-throws, unchanged).
- A durable strike counter tolerates `maxAlarmMemoryLimitStrikes` resets (default
  `3`); a memory-limit reset in a scheduled one-shot is now re-thrown (not
  swallowed) by `_executeScheduleCallback` so it _reaches_ the breaker — bounded
  deferral, the breaker being exactly what makes deferring a deterministic OOM
  safe.
- Under budget the breaker backs off the looping rows (the recovery callbacks and
  the exact executing row) so the retry is not a hot loop; at budget it calls the
  host's `_cf_sealMemoryLimitedRecovery()` (chat hosts seal every live incident
  as `out_of_memory` via the shared give-up spine) and surgically purges only the
  looping rows, leaving unrelated schedules intact.

The predicate is also broadened from the full `"...and was reset"` sentence to
the `"exceeded its memory limit"` fragment, because real #1825 logs carried
truncated/reworded surfacings; missing one means the breaker never engages, and a
false positive is fail-safe (bounded retry-then-seal).

**Honest residual.** None of this makes a DO whose _steady-state resident
footprint_ alone approaches 128 MB wakeable — if even boot hydration OOMs every
time, the breaker stops the platform retry storm and the bill, but the agent is
only usable again once the stored footprint shrinks (the #1710 windowed-hydration
/ media-eviction lever). The breaker bounds the blast radius; it does not shrink
the working set.
