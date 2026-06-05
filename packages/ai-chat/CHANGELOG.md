# @cloudflare/ai-chat

## 0.8.3

### Patch Changes

- [#1686](https://github.com/cloudflare/agents/pull/1686) [`1e49880`](https://github.com/cloudflare/agents/commit/1e498803fe26970aa264678d5ae3a2c96dd28258) Thanks [@threepointone](https://github.com/threepointone)! - Batch and pack chat-persistence SQLite writes to reduce rows written and round-trips.
  - `agents`: `ResumableStream` now **packs** each buffered group of stream chunks into a single SQLite row (a JSON array of chunk bodies) instead of writing one row per chunk. Single-chunk and large-chunk segments are stored unwrapped, and a per-segment byte cap keeps rows within the 2 MB SQLite row limit. This cuts chunk rows written / stored / scanned-on-replay by up to ~10×. Reads (replay, orphan reconstruction, `getStreamChunks`) transparently unpack both packed segments and legacy per-chunk rows, so existing stored data keeps working. Adds shared `buildInClauseStrings` and `MAX_BOUND_PARAMS` helpers exported from `agents/chat`.
  - `@cloudflare/ai-chat`: message cleanup (stale-row pruning and `maxPersistedMessages` enforcement) previously issued one `DELETE` per row in a loop; it now deletes rows in batched `DELETE ... WHERE id IN (...)` queries (capped at 100 bound parameters per query).
  - `@cloudflare/think`: `deleteSubmissions()` cleanup previously issued one `DELETE` per terminal submission (up to 500 per call); it now deletes rows in batched `DELETE ... WHERE submission_id IN (...)` queries.
  - `@cloudflare/ai-chat` & `@cloudflare/think`: chat-recovery incident TTL sweep previously deleted each stale incident with a separate awaited `storage.delete(key)` (which also defeats Durable Object write-coalescing); it now deletes incidents in batched `storage.delete(keys)` calls (up to 128 keys per call).

## 0.8.2

### Patch Changes

- [#1684](https://github.com/cloudflare/agents/pull/1684) [`ab6dd95`](https://github.com/cloudflare/agents/commit/ab6dd95b791a60fe5a5806852e05d4eeffecf9fd) Thanks [@threepointone](https://github.com/threepointone)! - warn when `chatRecovery` is configured in `onStart()` (applied too late for wake recovery)

  On every Durable Object wake the SDK evaluates chat-recovery budgets — and may seal an interrupted turn, firing `onExhausted` — **before** the user's `onStart()` runs (`_checkRunFibers()` is ordered ahead of `onStart()`). A `chatRecovery` config produced inside `onStart()` is therefore read as the built-in defaults at the moment recovery decides, so a configured `maxRecoveryWork` / `shouldKeepRecovering` / `onExhausted` silently never applies to the recovery that matters.

  This is now documented on `ChatRecoveryConfig` and the `chatRecovery` fields of `Think` / `AIChatAgent`, and the SDK logs a one-time warning if it detects `chatRecovery` being reassigned during `onStart()`. The warning fires both for a custom config object and for `chatRecovery = true` (enabling recovery / its defaults too late); assigning `false` (disabling) in `onStart()` is intentionally not warned, since recovery already ran with the pre-`onStart()` value and disabling it afterward is a benign no-op for that wake. The fix is to assign `chatRecovery` as a class field or in the constructor.

- [#1684](https://github.com/cloudflare/agents/pull/1684) [`ab6dd95`](https://github.com/cloudflare/agents/commit/ab6dd95b791a60fe5a5806852e05d4eeffecf9fd) Thanks [@threepointone](https://github.com/threepointone)! - fix(chat-recovery): don't seal a human-in-the-loop turn that is waiting on a pending client tool call

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

- [#1672](https://github.com/cloudflare/agents/pull/1672) [`f96a2ba`](https://github.com/cloudflare/agents/commit/f96a2bab7a668465b0e68c7f70b4b1b93ae53296) Thanks [@threepointone](https://github.com/threepointone)! - fix(chat-recovery): a turn making forward progress now survives unbounded deploy churn; add a work budget + `shouldKeepRecovering` runaway guard

  Durable chat recovery used to bound a single incident with a non-resetting 15-minute wall-clock ceiling (`CHAT_RECOVERY_MAX_WINDOW_MS`). That ceiling was overloaded — it served as both a recovery-duration bound and a runaway-loop guard — and it terminated _healthy, actively-progressing_ turns that simply took longer than 15 minutes of wall-clock to finish while being repeatedly interrupted by a dense deploy window, sealing them with `reason="max_recovery_window_exceeded"` and discarding completed work.

  The two jobs are now decoupled (see `design/rfc-chat-recovery-work-budget.md`):
  - **Duration is no longer a bound for a progressing turn.** The non-resetting wall-clock ceiling is removed. A turn that keeps producing content survives unbounded deploy churn. Stuck turns are still sealed by the no-progress window (5 min, resets on progress); tight no-progress alarm loops by the attempt cap.
  - **New runaway-loop guard, keyed to work, not time.** The existing durable, monotonic, reconnect-immune progress counter is reused as a work meter. `chatRecovery.maxRecoveryWork` caps the produced content/tool units since an incident opened; exceeding it seals with `reason="work_budget_exceeded"`. **Defaults to `Infinity`** — the SDK ships the mechanism but imposes no implicit cap, so it never terminates a progressing turn on its own.
  - **New caller predicate.** `chatRecovery.shouldKeepRecovering(ctx)` is consulted per recovery attempt from the second onward (only when no hard bound has already sealed the incident); returning `false` seals with `reason="recovery_aborted"`. This is where integrators express token/cost/step budgets the SDK should not hardcode. A throwing predicate is logged and treated as "keep recovering".
  - **The no-progress timeout is now configurable.** `chatRecovery.noProgressTimeoutMs` (default 5 min, resets on progress) is the primary stuck-turn bound, now overridable per agent instead of a hardcoded constant.

  New public types from `agents/chat`: `ChatRecoveryProgressContext`. New `ChatRecoveryConfig` fields: `maxRecoveryWork`, `shouldKeepRecovering`, `noProgressTimeoutMs`. `ChatRecoveryExhaustedContext.reason` gains `work_budget_exceeded` and `recovery_aborted`; `max_recovery_window_exceeded` is retained as an open-string value but is no longer emitted.

  Both `@cloudflare/ai-chat` and `@cloudflare/think` (which carries its own copy of the recovery engine) are updated identically. Defaults are unchanged except that a progressing turn is no longer terminated by wall-clock age.

- [#1670](https://github.com/cloudflare/agents/pull/1670) [`5d64940`](https://github.com/cloudflare/agents/commit/5d64940c2115822ef5ba4c8b35bfe5c2632ce11d) Thanks [@threepointone](https://github.com/threepointone)! - Fix: a deploy that interrupts an in-flight `runAgentTool` child no longer abandons the still-running child as `interrupted`.

  Parent recovery re-attaches to a still-running child and tails it to its real terminal. Previously that re-attach used a flat 120s wall-clock budget that was **not** reset by the child's forward progress, so a healthy child whose recovery legitimately ran longer than the budget was sealed `interrupted` (and its already-completed work re-run from scratch), even while it was actively streaming.

  The re-attach budget is now **progress-keyed**: it bounds how long the parent waits with _no_ forward progress from the child (resetting on every forwarded chunk), so a genuinely hung/silent child still seals `interrupted` after one no-progress window and can never block recovery forever, while a healthy child that keeps streaming is followed through to terminal. The parent re-arms (opens a fresh tail) **only when the child's stream closes cleanly while it is still advancing** — i.e. a re-evicted-but-progressing child. A full no-progress window (the child went silent) seals `no-progress` immediately even if the child streamed earlier in that window; it no longer grants a bonus window. This is both the honest stall signal and what keeps at most one pending tail reader alive per re-attach (no per-cycle reader accumulation).

  `@cloudflare/think` and `@cloudflare/ai-chat` additionally finalize a child facet's own agent-tool run row as soon as its recovered turn settles — regardless of whether recovery took the continue path (`_chatRecoveryContinue`) or the pre-stream retry path (`_chatRecoveryRetry`) — so a re-attached parent collects the terminal result immediately instead of waiting out a full no-progress window after the child has already finished.

  This release also adds:
  - **Typed interrupted cause.** `RunAgentToolResult`, the `agentTool()` `AgentToolFailure` envelope, the `onAgentToolFinish` lifecycle result, and the `agent-tool-event` wire event (kind `"interrupted"`) now carry a machine-readable `reason` (`AgentToolInterruptedReason`: `"no-progress" | "window-exceeded" | "not-tailable" | "inspect-timeout" | "inspect-failed" | "recovery-deadline"`) and a `childStillRunning` boolean on `interrupted` results, so callers (and UIs) can branch on _why_ a run was abandoned (and whether the child is still running) instead of pattern-matching the human-readable `error` prose. `retryable` stays coarse (always `true` for `interrupted`); refine with `reason` / `childStillRunning`. These fields are **persisted** (schema bump), so they survive a reconnect replay — a client that reconnects after an interrupt reconstructs the same `reason` / `childStillRunning` a live client saw, rather than `undefined`. The persisted cause is cleared when a soft `interrupted` row is later repaired to `completed`/`error`.
  - **Configurable re-attach budgets.** Two new public `AgentStaticOptions` — `agentToolReattachNoProgressTimeoutMs` (default 120000, the progress-keyed no-progress budget) and `agentToolReattachMaxWindowMs` (default **`Infinity`** — no implicit wall-clock cap) — let an Agent tune re-attach. The hard ceiling defaults to uncapped to mirror chat-recovery's `maxRecoveryWork: Infinity`: a re-attached parent follows a healthy, still-advancing child for as long as it makes progress — exactly as it would on the live (never-evicted) path — so it never abandons a long-running-but-healthy child that simply outlasts a fixed wall clock under deploy churn. A hung/silent child is bounded by the no-progress budget; a content-runaway is bounded uniformly (live and recovery) by the child's own `maxRecoveryWork` / `shouldKeepRecovering`. Integrators that want a hard wall-clock cap (and the `window-exceeded` child teardown it triggers) can set `agentToolReattachMaxWindowMs` to a finite value. Symmetrically, setting `agentToolReattachNoProgressTimeoutMs` to `Infinity` now means **"never seal on no-progress"** (a silent-but-alive child is followed until its stream closes or the hard ceiling fires) instead of silently skipping the wait — `0` remains the "don't wait, collect only an already-terminal child" sentinel.
  - **Give-up teardown (ceiling only).** When the parent gives up at the hard `window-exceeded` ceiling — where the child has had its full recovery window and is truly exhausted — it now cancels the child (`childStillRunning: false`) so it stops consuming a fiber / keep-alive. `no-progress` give-ups stay **soft** (`childStillRunning: true`): the child is left running so a re-issue can still re-attach and repair it if it self-heals, preserving the repair-on-re-issue path. In both `@cloudflare/think` and `@cloudflare/ai-chat`, `cancelAgentToolRun` also aborts an in-flight chat-recovery turn (not just the original in-isolate run) and releases live tails — Think sweeps its `_submissionAbortControllers`, ai-chat its request `AbortRegistry` (`abortAllRequests`) — so a torn-down child stops grinding instead of finishing an orphaned recovered turn.

## 0.8.1

### Patch Changes

- [#1661](https://github.com/cloudflare/agents/pull/1661) [`41315b6`](https://github.com/cloudflare/agents/commit/41315b602c4d68dbd5cad99cc949fbf13e256c51) Thanks [@threepointone](https://github.com/threepointone)! - Heal a malformed `tool_use.input` when loading persisted messages.

  `AIChatAgent` delegates `convertToModelMessages` to your `onChatMessage`, so it has no framework-side pre-send pass to repair a transcript. A session that persisted a non-object tool `input` — `null`, `undefined`, `""`, an array, or a raw string — before the write-side guard shipped would therefore keep 400ing with `tool_use.input: Input should be an object` on every turn, wedged across reconnects/redeploys/evictions.

  `autoTransformMessage` (run on every load) now normalizes malformed tool inputs to `{}` (parsing stringified-JSON objects, and leaving healthy object inputs untouched), so existing wedged sessions self-heal on their next load without per-DO storage surgery. Healthy messages are returned by reference, so the persistence cache stays a no-op for them.

- [#1654](https://github.com/cloudflare/agents/pull/1654) [`f34cd30`](https://github.com/cloudflare/agents/commit/f34cd30253f1e808677c9621905395150503420e) Thanks [@cjol](https://github.com/cjol)! - Fix `isStreaming` staying true after aborting during server-side tool calls.

- [#1657](https://github.com/cloudflare/agents/pull/1657) [`7bff8d7`](https://github.com/cloudflare/agents/commit/7bff8d74c927a53ec11ee4a89dc6cff6b63db0ad) Thanks [@threepointone](https://github.com/threepointone)! - fix(think): serialize parallel client-tool result/approval applies so siblings aren't clobbered ([#1649](https://github.com/cloudflare/agents/issues/1649) follow-up)

  The auto-continuation barrier added in [#1651](https://github.com/cloudflare/agents/issues/1651) stopped premature continuation, but a deeper race remained in Think. Each `tool-result`/`tool-approval` WebSocket message fired an independent read-modify-write of the whole assistant message, and `_applyToolUpdateToMessages` awaits a storage read before its write. When the model fanned out parallel tool calls, the concurrent applies all read the same `input-available` snapshot, each patched only its own part, and the last write clobbered its siblings back to `input-available`. The continuation barrier then timed out and the transcript-repair backstop errored the lost calls with "The tool call was interrupted before a result was recorded."

  Applies are now chained off a serialization tail so each read-modify-write commits atomically in arrival order. `_pendingInteractionPromise` still tracks the newest link, so the barrier's single-slot wake-up transitively waits for every predecessor.

  The same serialization is applied to `@cloudflare/ai-chat` defensively: its apply is currently synchronous (no await between the message read and the SQLite write), so it does not exhibit this clobber today, but the queue keeps the invariant safe if that ever changes.

## 0.8.0

### Minor Changes

- [#1636](https://github.com/cloudflare/agents/pull/1636) [`f5a0d00`](https://github.com/cloudflare/agents/commit/f5a0d00cf59b19cd4db54c7de6e441b8da669521) Thanks [@threepointone](https://github.com/threepointone)! - Expose recovery incident identity and enrich the `onExhausted` payload so
  products can build a terminal-state policy without re-deriving anything ([#1631](https://github.com/cloudflare/agents/issues/1631)).
  - `ChatRecoveryContext` (the `onChatRecovery` argument) now includes
    `recoveryRootRequestId` — the stable request ID for the whole continuation
    chain. Unlike `requestId`, it doesn't change across chained continuations, so
    it's the right key for per-incident budget tracking / fresh-incident detection
    without re-deriving identity from message IDs.
  - `ChatRecoveryExhaustedContext` (the `onExhausted` argument) now carries
    `recoveryRootRequestId`, `terminalMessage` (the exact text shown to the user),
    `partialText` / `partialParts` (what the turn produced before it was given up
    on), and `streamId` / `createdAt` — enough to render or persist a user-facing
    terminal banner AND emit correlated terminal telemetry (e.g. time-since-turn-start,
    stream correlation) directly, without re-deriving anything.

  All fields are additive. Applied across `agents` (shared types),
  `@cloudflare/think`, and `@cloudflare/ai-chat`.

- [#1648](https://github.com/cloudflare/agents/pull/1648) [`d6827ab`](https://github.com/cloudflare/agents/commit/d6827ab03fa703058e755d17e3f5db0cd90c94b6) Thanks [@threepointone](https://github.com/threepointone)! - Surface a live "recovering…" status to chat clients during durable recovery ([#1620](https://github.com/cloudflare/agents/issues/1620))

  When a durable chat turn is interrupted (a deploy/eviction, or a stream-stall
  watchdog abort) and resumes, clients had no "in progress" signal — the turn
  looked frozen until it completed or a terminal error was replayed. A new
  `cf_agent_chat_recovering` protocol frame is now broadcast on recovery schedule
  and cleared on every terminal outcome (completed/skipped/failed/exhausted), so
  the indicator can't spin forever. In `@cloudflare/think` it's also persisted and
  replayed on connect, so a client that joins mid-recovery learns the turn is
  working. `useAgentChat` exposes a new `isRecovering` flag (distinct from
  `isStreaming` — a recovering turn isn't producing tokens yet); most UIs render
  `isStreaming || isRecovering` as "busy". Backward-compatible: clients that don't
  understand the frame ignore it.

  > Note: `@cloudflare/ai-chat` broadcasts the live signal but does not yet replay
  > it on connect (it has no idle-connect hydration path; tracked in [#1645](https://github.com/cloudflare/agents/issues/1645)).
  > `@cloudflare/think` has both.

  For recovery telemetry, subscribe to the `chat:recovery:*` observability events
  and route them to your analytics sink.

- [#1611](https://github.com/cloudflare/agents/pull/1611) [`02f9380`](https://github.com/cloudflare/agents/commit/02f93809587aca310ad39fa5683de57ee9f6e070) Thanks [@threepointone](https://github.com/threepointone)! - Add bounded, observable recovery foundations for durable chat turns and fibers.
  - Add dedicated recovery observability channels/events for fibers, chat recovery, transcript repair, and agent-tool recovery.
  - Bound internal framework fiber recovery hooks and parent agent-tool recovery scans so startup and recovery work cannot wedge indefinitely.
  - Add shared chat recovery incident tracking with attempt counts, configurable `chatRecovery` defaults, and terminal exhaustion behavior for `AIChatAgent` and `Think`. Think recovery now exhausts after six failed attempts by default and sends a terminal error frame instead of spinning indefinitely.
  - Keep the recovery attempt budget bounded even when an interrupted turn flips between `retry` and `continue` recovery kinds (the incident identity no longer includes the kind), guard a throwing `onExhausted` hook so the terminal UX is still delivered, mark incidents `failed` when the recovery dispatch throws, and reclaim incident records on success plus a TTL sweep for abandoned ones so durable storage does not grow without bound.
  - Bound generic unmanaged fiber recovery with a configurable `fiberRecoveryMaxAgeMs` so a repeatedly-throwing `onFiberRecovered()` hook cannot re-trigger forever across restarts.
  - Surface Think post-persist chat request failures through `onChatError(error, ctx)` and `chat:request:failed`.
  - Repair incomplete Think tool-call transcripts before provider calls and allow `createCompactFunction()` to use a supplied token counter for tail budgeting.

- [#1638](https://github.com/cloudflare/agents/pull/1638) [`b6c8dea`](https://github.com/cloudflare/agents/commit/b6c8dea255aff6b2c0fe0e30068c143c5eac6334) Thanks [@threepointone](https://github.com/threepointone)! - Make chat recovery's budget wall-clock-keyed-to-progress instead of raw attempt
  count, so a healthy turn under deploy churn isn't sealed prematurely ([#1637](https://github.com/cloudflare/agents/issues/1637)).

  Under continuous deploys the attempt count is the wrong primary bound: one
  rollout drops/reconnects the socket several times (~11–22s), each firing a
  recovery alarm, so the count inflated far faster than the real interruption rate
  and exhausted turns that were still advancing (0/23 model calls errored in the
  reported incident — it was pure eviction churn).

  Now:
  - **Primary bound: a 5-minute no-progress wall clock** keyed to `lastProgressAt`,
    which resets on every progress-bearing attempt. A turn that keeps producing
    content survives churn indefinitely; one that genuinely goes quiet is sealed
    within 5 minutes.
  - **Alarm debounce (~30s):** recovery alarms bunched within the window (a single
    rollout's reconnect storm) collapse into one attempt.
  - **Attempt cap is now a high secondary backstop** (default raised 6 → 10),
    resets on progress; it only catches a pathological tight alarm-loop.
  - The existing 15-minute absolute incident-age ceiling is kept as the final
    non-resetting hard stop.
  - **Progress signal moved to production time** (when new content is durably
    flushed/streamed) instead of persist time — so it advances only on genuinely
    new content and is immune to client reconnects and recovery re-persists, which
    the no-progress window depends on. (Builds on the compaction-immune counter
    from [#1628](https://github.com/cloudflare/agents/issues/1628).)

  Applies to both `@cloudflare/think` and `@cloudflare/ai-chat`, including the
  `TaskSubAgent`/sub-agent recovery path.

### Patch Changes

- [#1634](https://github.com/cloudflare/agents/pull/1634) [`a4225fd`](https://github.com/cloudflare/agents/commit/a4225fd9044ff096a29b4b36ad6cccb6b5484164) Thanks [@threepointone](https://github.com/threepointone)! - Stop chat recovery from discarding settled work when a turn is given up on
  ([#1631](https://github.com/cloudflare/agents/issues/1631)).

  Two paths could throw away a partial assistant message containing completed,
  often non-idempotent tool results:
  - When the framework's own recovery budget was exhausted, `_exhaustChatRecovery`
    sealed the turn (terminal status + banner) **before** the orphaned stream was
    ever persisted — so every settled tool result the turn had produced was lost
    and the model re-ran them on the next message. Exhaustion now persists the
    settled partial first, using the same gating as the normal recovery path so it
    can't duplicate an already-saved partial.
  - A subclass `onChatRecovery` returning `{ persist: false }` to stop a turn used
    to silently drop the settled partial. Settled work is now **never** dropped:
    `persist: false` only suppresses persistence of a partial that has nothing
    settled to lose; a partial carrying settled tool results is persisted
    regardless. An app can no longer accidentally discard completed work — and it
    never needs `{ persist: true }` just to stay safe. (A safe default beats a
    warning about an unsafe one.)

  Applied identically to `@cloudflare/think` and `@cloudflare/ai-chat`.

- [#1633](https://github.com/cloudflare/agents/pull/1633) [`1aca578`](https://github.com/cloudflare/agents/commit/1aca578fe2329e38e19d6723e64f86743cda083d) Thanks [@threepointone](https://github.com/threepointone)! - Fix chat recovery prematurely exhausting its retry budget under compaction
  ([#1628](https://github.com/cloudflare/agents/issues/1628)). The deploy-churn forward-progress signal — which resets the recovery
  budget when an interrupted turn is actually advancing — was recomputed from the
  live transcript by counting assistant messages. Compaction collapses older
  assistant messages into a summary, lowering that count, so a turn that had
  genuinely advanced could read as "no progress" between recovery attempts and
  exhaust at `maxAttempts`, sealing a healthy turn. Progress is now tracked by a
  durable, monotonic counter incremented when `_persistOrphanedStream` materializes
  a non-empty partial (the exact event the message count was proxying for), so
  compaction can never lower it. A turn that genuinely fails to advance still
  exhausts at the cap, and the 15-minute wall-clock ceiling is unchanged.

- [#1615](https://github.com/cloudflare/agents/pull/1615) [`51a771f`](https://github.com/cloudflare/agents/commit/51a771ff7a640eae4b530b588d0f741300ddb0dc) Thanks [@threepointone](https://github.com/threepointone)! - Chat recovery no longer permanently abandons a turn under repeated deploys. A
  mid-turn deploy resets the Durable Object ("code was updated") and the
  interrupted continuation is re-detected on the next wake; previously every such
  interruption consumed one of the bounded recovery attempts, so a deploy every
  few minutes exhausted the budget (`max_attempts_exceeded`) and the turn was
  terminally abandoned even though each fresh isolate was healthy. Recovery now
  distinguishes an interruption that followed forward progress (more persisted
  assistant content than the previous attempt observed) — treated as environmental
  and not counted against the budget — from a turn that never advances, which still
  exhausts at `maxAttempts`. A 15-minute wall-clock ceiling per incident bounds the
  worst case so a continuously churning environment cannot retry forever.

- [#1608](https://github.com/cloudflare/agents/pull/1608) [`7c17736`](https://github.com/cloudflare/agents/commit/7c17736fafa58c218181d7dcb30e36d3605d4395) Thanks [@cjol](https://github.com/cjol)! - Fix auto-continuation stream resumes so immediate client-tool resume requests attach to the pending continuation instead of receiving `cf_agent_stream_resume_none`.

- [#1651](https://github.com/cloudflare/agents/pull/1651) [`d118d11`](https://github.com/cloudflare/agents/commit/d118d1101a3eb76a921ee50eb96d02c5e159e5d4) Thanks [@threepointone](https://github.com/threepointone)! - Fix auto-continuation firing before all parallel client-tool results arrive
  ([#1649](https://github.com/cloudflare/agents/issues/1649)). When the model emitted multiple tool calls in one step and the client
  resolved them independently via `addToolOutput`, a fast result's `autoContinue`
  could trigger the next inference while a slower sibling was still
  `input-available`. That fed the provider an incomplete tool-result set
  (`MissingToolResultsError`) or — via the transcript-repair backstop — silently
  flipped the in-flight sibling to errored and ran a spurious extra continuation.

  Auto-continuation now waits until the transcript is stable (no
  `input-available`/`approval-requested` parts) before continuing, so a fanned-out
  tool batch coalesces into a single continuation regardless of result arrival
  order. The wait is bounded, so a genuinely orphaned tool call (e.g. the client
  disconnected mid-batch) still falls through to the existing backstop instead of
  pinning the continuation open.

- [#1641](https://github.com/cloudflare/agents/pull/1641) [`3aa1936`](https://github.com/cloudflare/agents/commit/3aa1936eb17bfff05eaa0dc225176bf408ddea78) Thanks [@threepointone](https://github.com/threepointone)! - Count a sub-agent's progress as the orchestrating parent's recovery progress

  A parent turn whose work is "run a sub-agent and await its result" produced no
  recoverable content of its own, so under deploy churn the **parent's** own
  chat-recovery no-progress window could exhaust while the child was still
  healthily streaming — abandoning the turn as `interrupted` and collecting an
  interrupted result even though the child went on to complete. (Reproduced by
  the `examples/deploy-churn --mode subagent` harness: the parent exhausted at
  `attempt 6/6` with `progress: 1` while the child self-healed all 30 steps.)

  Forwarding a child's stream to the parent's connections is now treated as
  genuine forward progress for the parent's recovery budget: `Think` and
  `AIChatAgent` advance their durable recovery-progress marker (throttled) each
  time `_forwardAgentToolStream` forwards child output, so a parent that keeps
  re-attaching to and streaming a live child survives churn indefinitely. The
  credit is only granted when the child actually produces output — a silent or
  hung child still lets the parent exhaust on its own no-progress timer, so a
  stuck sub-agent can never pin a parent's recovery open forever.

  This completes the sub-agent recovery story started by the stable-runId +
  bounded re-attach fix ([#1630](https://github.com/cloudflare/agents/issues/1630)): the child self-heals and the parent both
  re-attaches to it _and_ keeps its own recovery alive while doing so.

- [#1646](https://github.com/cloudflare/agents/pull/1646) [`a245a4a`](https://github.com/cloudflare/agents/commit/a245a4ad6fd0ad1a0fcd2609c8541109df8c6ad5) Thanks [@threepointone](https://github.com/threepointone)! - Terminalize a chat-recovery turn through `onExhausted` when it gives up waiting for stable state

  Under extreme churn (a long turn interrupted many times in quick succession), a
  recovery callback (`_chatRecoveryRetry` / `_chatRecoveryContinue`) could keep
  timing out waiting for the isolate to reach stable state until its retry budget
  drained. The give-up path only marked the incident `failed` and completed the
  recovered submission as `error` — it **bypassed `_exhaustChatRecovery`**, so
  `onExhausted` never fired, the `chat:recovery:exhausted` event was not emitted,
  the configured `terminalMessage` banner was never delivered, and the terminal
  chat status was not recorded. Apps relying on `onExhausted` for the terminal
  banner saw an eternal spinner with no terminal signal.

  The stable-state-timeout give-up now routes through the **same**
  `_exhaustChatRecovery` path as deploy-recovery and stall exhaustion: it fires
  `onExhausted` (with `reason: "stable_timeout"`), emits `chat:recovery:exhausted`,
  marks the durable submission interrupted, records the terminal chat status, and
  delivers the `terminalMessage`. As an extra backstop against silent drops, the
  give-up also terminalizes when the incident record is missing (no `incidentId`,
  or it was swept/deleted before a stale alarm fired) by synthesizing a terminal
  incident from the recovery-root request id — so a turn can never be dropped with
  no terminal UX.

- [#1623](https://github.com/cloudflare/agents/pull/1623) [`4c8b371`](https://github.com/cloudflare/agents/commit/4c8b3712b11d2b07298e384e5884844272f4697a) Thanks [@threepointone](https://github.com/threepointone)! - Fix chat recovery falsely marking a durable submission as `error` under repeated mid-turn deploys.

  When several deploys interrupt a single turn, recovery runs a _chain_ of continuations. Three bugs combined to leave the submission in `error` even when the turn actually completed every step:
  - **Lost ownership.** The submission link (`recoveredRequestId`) was derived from each continuation's own (fresh) requestId, so chained continuations dropped it — the continuation that finally completed the turn could no longer mark the submission `completed`.
  - **Stale-continuation clobber.** A superseded continuation tripped the `conversation_changed` guard because the leaf had advanced via recovery's _own_ forward progress (a new assistant message), not a new user turn, and overwrote the still-running submission to `error`.
  - **Premature `stable_timeout`.** A timeout while waiting for the isolate to settle (common while a deploy is in flight) failed the turn terminally at the first attempt.

  Now: submission ownership is keyed off the stable recovery root and threaded through the entire continuation chain (including the terminal abandon paths — recovery exhaustion and `{ continue: false }` — which previously marked the submission by the per-continuation requestId and so left a chained submission stuck `running`); a superseded continuation skips benignly (only a genuinely newer user turn marks the submission `skipped`, never `error`); and a stable-state timeout reschedules within the `maxAttempts` budget. A turn that completes under deploy churn now ends `completed`, not `error`.

  `@cloudflare/ai-chat` has the same recovery machinery but no durable-submission layer, so it receives the `stable_timeout` reschedule fix only: a transient stable-state timeout now retries within the attempt budget instead of permanently abandoning a recoverable turn at the first attempt.

- [#1606](https://github.com/cloudflare/agents/pull/1606) [`7419fbc`](https://github.com/cloudflare/agents/commit/7419fbcf1e4a0101660b1371517c4a77bb33cab3) Thanks [@threepointone](https://github.com/threepointone)! - Serialize client-tool continuation resumes so they do not overlap the active AI SDK chat request.

- [#1640](https://github.com/cloudflare/agents/pull/1640) [`edb126a`](https://github.com/cloudflare/agents/commit/edb126a72d1a6b52fa0057191d6d461ee902e914) Thanks [@threepointone](https://github.com/threepointone)! - Re-attach to a still-running sub-agent (`agentTool()`) run on parent recovery instead of abandoning and re-running it ([#1630](https://github.com/cloudflare/agents/issues/1630)).

  When a parent agent was interrupted (deploy / Durable Object eviction) while a child `agentTool()` run was still in flight, recovery marked the run `interrupted` within a ~5s window and the parent re-issued the task — re-running the child's already-completed work. For long-running children under continuous deploys this surfaced to users as "the agent went all the way back and lost the files it already wrote."

  Three changes fix this:
  - **Stable child runId.** `agentTool()` now derives the child `runId` from the (recovery-preserved) tool call id (`agent-tool:<toolCallId>`) instead of minting a fresh `nanoid` per call. A turn re-run by chat recovery now resolves to the **same** idempotent child facet rather than spawning a brand-new one, so completed child work is never re-run.
  - **Bounded re-attach.** A duplicate non-terminal `runId` (in `runAgentTool`) and a still-running child during startup reconciliation now **tail the live child to its real terminal result** and collect it, instead of immediately sealing `interrupted`. Re-attach is bounded by a generous wall-clock budget (`DEFAULT_AGENT_TOOL_REATTACH_TIMEOUT_MS`, 120s, internal): a child that keeps advancing toward terminal within the window is collected; a genuinely hung child still seals `interrupted` so recovery can never block forever.
  - **Durable child-run reconcile.** A child facet self-heals its interrupted turn via its own `chatRecovery`, but that recovery path never wrote the child's agent-tool run row — so after a real eviction the row stranded `running` (think) / was force-errored (ai-chat) and the parent could never collect the recovered result. Both `@cloudflare/think` and `@cloudflare/ai-chat` now reconcile a stale child-run row from the durable transcript on inspect: while recovery is still resolving the row stays `running`; once it settles, a completed assistant response surfaces as `completed` (so the parent collects the real result) and an empty/failed recovery as `error`. This keeps the child's own (working) recovery path untouched.

  No new public configuration. Adds an internal `agent_tool:recovery:reattach` observability event. `@cloudflare/think` and `@cloudflare/ai-chat` child tails are now read-only on consumer detach (a parent's re-attach budget expiring never cancels the still-running child).

## 0.7.2

### Patch Changes

- [#1559](https://github.com/cloudflare/agents/pull/1559) [`f942ffe`](https://github.com/cloudflare/agents/commit/f942ffe4113bdf074942cc32c2c69922ef633502) Thanks [@cjol](https://github.com/cjol)! - Stash chat turn recovery metadata before inference starts so interrupted pre-stream turns can be reconciled by chat recovery. Pre-stream interruptions now automatically retry the existing unanswered user message when it is still safe to do so.

- [#1567](https://github.com/cloudflare/agents/pull/1567) [`3cfa498`](https://github.com/cloudflare/agents/commit/3cfa49878c3ff8495f7f2b1b059a04440449bf7b) Thanks [@cjol](https://github.com/cjol)! - Return error statuses for in-band stream errors across programmatic chat turns.

## 0.7.1

### Patch Changes

- [#1541](https://github.com/cloudflare/agents/pull/1541) [`bc2b1d3`](https://github.com/cloudflare/agents/commit/bc2b1d388fdb36d597bfc41716ff9fccfdff14a9) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Keep `useAgentChat`'s first optimistic send visible when the Agent HTTP URL becomes available immediately after mount.

## 0.7.0

### Minor Changes

- [#1484](https://github.com/cloudflare/agents/pull/1484) [`364a45d`](https://github.com/cloudflare/agents/commit/364a45da3efb7418ecf1dd0da1c21cb3d4059b27) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add `cancelOnClientAbort` to `useAgentChat`. Generic browser/client stream cleanup is now local-only by default so server turns can continue and resume; explicit `stop()` still cancels the server turn. Set `cancelOnClientAbort: true` to make generic client aborts cancel the server turn.

### Patch Changes

- [#1376](https://github.com/cloudflare/agents/pull/1376) [`6561a3f`](https://github.com/cloudflare/agents/commit/6561a3fb6ba7e1833c902457a015d47045a4e4a7) Thanks [@hrushikeshdeshpande](https://github.com/hrushikeshdeshpande)! - Avoid throwing when chat stream resume negotiation/replay races with a closed WebSocket connection.

- [#1487](https://github.com/cloudflare/agents/pull/1487) [`752e25a`](https://github.com/cloudflare/agents/commit/752e25ab0a6d7dba3ac4829443e2dd4dca9481c0) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Close the original WebSocket chat transport stream when the socket disconnects before a terminal response, preventing recovered chat continuations from leaving `useAgentChat` stuck in streaming state.

- [#1481](https://github.com/cloudflare/agents/pull/1481) [`12365dd`](https://github.com/cloudflare/agents/commit/12365dd622283ad06bae3dacf80db6ca9886ef72) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fixed approval auto-continuation streams so reasoning chunks keep a valid `reasoning-start` before `reasoning-delta` sequence when continuing from an assistant message that already has reasoning, and preserve the continuation reasoning in the final persisted message.

- [#1483](https://github.com/cloudflare/agents/pull/1483) [`5373f5c`](https://github.com/cloudflare/agents/commit/5373f5ca246e756c8c36df915380fbc5319c5162) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Allow Think agent-tool children to complete without emitting assistant text. Non-chat tool-step agents can now provide structured output through `getAgentToolOutput`, with summaries derived from assistant text, string output, structured output, or an empty string.

  Fix `useAgentChat().isServerStreaming` cleanup when a resumed stream first enters the fallback observer path and later becomes transport-owned.

## 0.6.2

### Patch Changes

- [`2fffa02`](https://github.com/cloudflare/agents/commit/2fffa0201c96f6d2a395c74a843c3c25afcd53a6) Thanks [@threepointone](https://github.com/threepointone)! - Raise the minimum internal peer dependency versions for Agents chat packages so `agents`, `@cloudflare/ai-chat`, and `@cloudflare/think` require versions at least as recent as the current repo packages.

## 0.6.1

### Patch Changes

- [#1443](https://github.com/cloudflare/agents/pull/1443) [`e7d225b`](https://github.com/cloudflare/agents/commit/e7d225b72a743a2cf1491ebf73f06580c668e560) Thanks [@threepointone](https://github.com/threepointone)! - Fix sub-agent WebSockets on deployed Workers by keeping the browser WebSocket owned by the parent Agent and forwarding connect/message/close events to child facets over RPC.

  Fix resumed chat streams so a partially hydrated assistant response is rebuilt from replay chunks instead of rendering replayed text as a second assistant text part.

  Fix a resume ACK race where drill-in chat connections could miss the terminal stream frame if the helper completed between the resume notification and client acknowledgement.

## 0.6.0

### Minor Changes

- [#1421](https://github.com/cloudflare/agents/pull/1421) [`1b65ff5`](https://github.com/cloudflare/agents/commit/1b65ff5550f904e2a59bd6015703f82b02f85e4f) Thanks [@threepointone](https://github.com/threepointone)! - Add agent tool orchestration for running Think and AIChatAgent sub-agents as
  retained, streaming tools from a parent agent. The new surface includes
  `runAgentTool`, `agentTool`, parent-side run replay and cleanup, Think and
  AIChatAgent child adapter support, and headless React/client event state
  helpers.

## 0.5.4

### Patch Changes

- [#1412](https://github.com/cloudflare/agents/pull/1412) [`8fb7c03`](https://github.com/cloudflare/agents/commit/8fb7c032873933dbdd2db8c809d3134e7ba39301) Thanks [@threepointone](https://github.com/threepointone)! - Stop provider tool-call replays from regressing tool part state during continuation streams ([#1404](https://github.com/cloudflare/agents/issues/1404)).

  Some providers (notably the OpenAI Responses API) re-emit prior tool calls in continuation streams as a `tool-input-start` → `tool-input-delta` → `tool-input-available` → `tool-output-available` sequence carrying the _same_ `toolCallId` and the _same_ `output` the part already holds. The AI SDK's `updateToolPart` mutates an existing tool part in place when the toolCallId matches, so a replayed `tool-input-start` was clobbering an `output-available` part back to `input-streaming` on the client and producing the worker warn `_applyToolResult: Tool part with toolCallId X not in expected state`.

  Two fixes:
  - `_streamSSEReply` now drops replay tool-input chunks before broadcasting them to clients or storing them for resume, using the new shared `isReplayChunk` helper. The cloned server-side streaming message is never corrupted because `applyChunkToParts` is idempotent against existing toolCallIds for these chunk types (also fixed below).
  - `_applyToolResult` accepts `output-available` and `output-error` as valid starting states for _idempotent_ re-application. A duplicate `cf_agent_tool_result` (cross-tab re-run, redelivered WS frame, provider replay round-trip) is now a silent no-op rather than a warn + skipped update. The cross-message `tool-output-available`/`tool-output-error` fallback in `_streamSSEReply` gets the same tolerance.

  `_findAndUpdateToolPart` skips the SQLite write and `MESSAGE_UPDATED` broadcast when the apply produced no semantic change, so idempotent re-applies don't churn UI on connected tabs.

## 0.5.3

### Patch Changes

- [`ca510d4`](https://github.com/cloudflare/agents/commit/ca510d4fecbecb07d0d3cdad7d78c32cc226275e) Thanks [@threepointone](https://github.com/threepointone)! - Tighten the `agents` peer dependency floor from `>=0.8.7` to `>=0.11.7` to reflect the current monorepo set we actually test against. Upper bound (`<1.0.0`) is unchanged.

  No runtime change in `@cloudflare/ai-chat` itself. The visible effect for consumers: pairing the latest `@cloudflare/ai-chat` with a stale `agents` (`<0.11.7`) now produces a peer warning where it previously did not. That's the intended signal — `agents` versions older than 0.11.7 are no longer tested against this `@cloudflare/ai-chat`.

- [#1411](https://github.com/cloudflare/agents/pull/1411) [`2fa68be`](https://github.com/cloudflare/agents/commit/2fa68bea891e1bd8f30839586c2519627f364b0c) Thanks [@threepointone](https://github.com/threepointone)! - Add `options.signal` to `AIChatAgent.saveMessages` and `continueLastTurn` for external cancellation of programmatic turns, plus protected `abortRequest(id)` / `abortAllRequests()` methods ([#1406](https://github.com/cloudflare/agents/issues/1406)).

  `saveMessages` and `continueLastTurn` accept a second `SaveMessagesOptions` argument:

  ```typescript
  const result = await this.saveMessages(messages, {
    signal: controller.signal
  });
  if (result.status === "aborted") {
    // Inference loop terminated mid-stream; partial chunks persisted.
  }
  ```

  The signal is linked to AIChatAgent's per-turn `AbortController` and produces the same end state as a `chat-request-cancel` WebSocket message: the inference loop's signal aborts, partial chunks persist, the result reports `status: "aborted"`, and `onChatResponse` fires with the same status. Pre-aborted signals short-circuit before any model work runs. Listeners are detached cleanly when the turn finishes, so the same long-lived signal can be passed to many turns without leaking.

  `abortRequest(id, reason?)` and `abortAllRequests()` are protected entry points for subclasses that want to cancel turns without tracking ids.

  `SaveMessagesResult.status` now includes `"aborted"` alongside `"completed"` and `"skipped"`. Existing callers that only switch on `"completed"` are unaffected.

  **Limitations.**
  - `AbortSignal` cannot cross Durable Object RPC. Construct the controller inside the DO that calls `saveMessages`.
  - The signal lives in memory only. If the DO hibernates mid-turn and `chatRecovery` is enabled, the recovered turn runs without the original signal.

  See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the motivating use case.

## 0.5.2

### Patch Changes

- [#1374](https://github.com/cloudflare/agents/pull/1374) [`a6e22c3`](https://github.com/cloudflare/agents/commit/a6e22c362668fc295208d0718eae4cf2aa3f792a) Thanks [@threepointone](https://github.com/threepointone)! - Fix `useAgentChat` recreating the AI SDK Chat instance — and orphaning any in-flight `resumeStream` — whenever `agent.name` transitions in place.

  The `useAgent({ basePath })` + `static options = { sendIdentityOnConnect: true }` pattern lets the server own the Durable Object instance name. The browser starts with a placeholder (`"default"`), then `useAgent` mutates the agent object's `.name` to the server-assigned value when the identity frame arrives. `useAgentChat` previously included `agent.name` in the stable chat id it passed to `useChat({ id })`, so the transition changed the id and the AI SDK recreated the underlying Chat instance. The useEffect that fires `chatRef.current.resumeStream()` is keyed on the ref object, not the Chat instance, so it does not re-fire on recreation — the resumed stream kept feeding chunks into the orphaned Chat's state while React subscribed to the new Chat's state, so the user saw an empty assistant reply after a mid-stream refresh until the server's final `CF_AGENT_CHAT_MESSAGES` broadcast landed.

  `useAgentChat` now distinguishes an in-place `agent.name` mutation from a genuine "consumer switched chats" event by checking the agent object's reference identity:
  - same `agent` reference, `name` mutation → not a chat switch; keep the Chat instance stable.
  - new `agent` reference → chat switch; recompute the stable chat id so the AI SDK recreates the Chat against the new conversation.

  The stable id is also still upgraded once from the identity-only fallback to the URL-resolved key when the WebSocket handshake completes.

  Consumers who want to switch chats without remounting should pass a different `agent` object (e.g. a new `useAgent({...})` call with a different `name`). To get a completely fresh Chat (e.g. when mounting a different chat tab), the conventional React pattern — `key={chatId}` on the parent or swapping the subtree — continues to work.

- [#1395](https://github.com/cloudflare/agents/pull/1395) [`63cfae6`](https://github.com/cloudflare/agents/commit/63cfae6345c5ddc54df5e2f78a19097b9b5462ff) Thanks [@threepointone](https://github.com/threepointone)! - Share submit concurrency bookkeeping through `agents/chat` and use it from both chat agents.

  This extracts the `latest`/`merge`/`drop`/`debounce` admission state machine into a `SubmitConcurrencyController` exported from `agents/chat`. `AIChatAgent` semantics (including merge persistence) are preserved. `Think` now picks up the same pending-enqueue protection, so an overlapping submit is still detected while an accepted request is between admission and turn queue registration.

  Additional fixes:
  - `Think` now captures the turn generation immediately after admission and threads it into `_turnQueue.enqueue`, so a clear that lands between admission and queue registration cannot run a stale turn.
  - Pending-enqueue tracking is now bound to a release function tied to the controller's reset epoch, so a release from a pre-reset submit can no longer erase a post-reset submit's marker and let a third submit slip through as non-overlapping.
  - Debounce cancellation correctly resolves all in-flight waiters instead of overwriting a single timer slot.

- [#1396](https://github.com/cloudflare/agents/pull/1396) [`fdf5a8a`](https://github.com/cloudflare/agents/commit/fdf5a8a99ec1a88ce9096ddec3a9fb2adf6fd4b1) Thanks [@threepointone](https://github.com/threepointone)! - Fix Think persisting a duplicate orphan assistant row when a user submits during a streaming tool turn ([#1381](https://github.com/cloudflare/agents/issues/1381)).

  When `useAgentChat` posts an in-flight assistant snapshot it minted optimistically (client-generated ID, `state: "input-available"`), Session's INSERT-OR-IGNORE-by-ID would store it as a separate row alongside the eventual server-owned assistant for the same `toolCallId`. The next turn's `convertToModelMessages` then produced a malformed Anthropic prompt and the provider rejected it.

  `reconcileMessages` and `resolveToolMergeId` now live in `agents/chat` and Think runs them in `_handleChatRequest` before persistence. Stale `input-available` snapshots pick up the server's tool output via `mergeServerToolOutputs`, and any incoming assistant whose `toolCallId` already exists on a server row adopts the server's ID so persistence updates the existing row instead of inserting an orphan.

  `@cloudflare/ai-chat` keeps its existing reconciler behavior; the only change is that it now imports `reconcileMessages` / `resolveToolMergeId` from `agents/chat` instead of a local file.

## 0.5.1

### Patch Changes

- [#1368](https://github.com/cloudflare/agents/pull/1368) [`2fe85cb`](https://github.com/cloudflare/agents/commit/2fe85cbd26a606ad719dc3c6fb8c82d73d6cbf6e) Thanks [@threepointone](https://github.com/threepointone)! - Add `isToolContinuation: boolean` to `useAgentChat()` so consumers can disambiguate a fresh user-initiated `status === "submitted"` from one driven by a server-pushed tool continuation. See [#1365](https://github.com/cloudflare/agents/issues/1365).

  `status` already tracks the whole tool round-trip (`submitted` → `streaming` → `ready`) after `addToolOutput` / `addToolApprovalResponse`, on purpose — that's what [#1157](https://github.com/cloudflare/agents/issues/1157) asked for and what many loading-spinner UIs now rely on. But some consumers want a typing indicator _only_ for new user messages, not for mid-turn continuations, and previously had to inspect message history to tell them apart.

  `isToolContinuation` is `true` from the moment `addToolOutput` / `addToolApprovalResponse` kicks off an auto-continuation until the continuation stream closes (or is aborted by `stop()`). It is `false` otherwise — including during cross-tab server broadcasts, which surface via `isServerStreaming` only.

  ```tsx
  const { status, isStreaming, isToolContinuation } = useAgentChat({ ... });

  const isLoading = isStreaming || status === "submitted";
  const showTypingIndicator = status === "submitted" && !isToolContinuation;
  ```

  Purely additive — no change to `status`, `isServerStreaming`, or `isStreaming` semantics.

- [#1366](https://github.com/cloudflare/agents/pull/1366) [`53600d0`](https://github.com/cloudflare/agents/commit/53600d00f77523825d12c1915fcf29d0c22fe6d0) Thanks [@threepointone](https://github.com/threepointone)! - Fix `useAgentChat()` going silent while an `onToolCall` handler is running. The server's `streamText` ends the stream as soon as the model emits a client-tool call, which dropped `status` back to `ready` and `isStreaming`/`isServerStreaming` to `false` for the full duration of the client-side `tool.execute()` — often a `fetch` taking several seconds. Consumers had no single flag that covered the whole "turn in progress" window. See [#1365](https://github.com/cloudflare/agents/issues/1365).

  `useAgentChat()` now treats any unresolved client-side tool call on the latest assistant message as an active server-driven phase:
  - `isServerStreaming` is `true` from the moment the tool part appears in `input-available` (with an active handler — `onToolCall` or a deprecated `tools` entry with `execute`) until it transitions out via `addToolOutput` / `addToolResult`.
  - `isStreaming` (`status === "streaming" || isServerStreaming`) stays `true` across the whole tool round-trip, including the gap between the model emitting the call and the server pushing its continuation.
  - `status` is untouched — it still means "user-initiated submission awaiting a response." Tools waiting for explicit user confirmation are excluded from the busy signal (nothing is happening until the user acts).

  Consumer code simplifies to:

  ```tsx
  const { isStreaming, status } = useAgentChat({ ... });
  const isLoading = isStreaming || status === "submitted";
  const showTypingIndicator = status === "submitted";
  ```

  No API changes. Existing code that only looked at `status` behaves the same.

## 0.5.0

### Minor Changes

- [#1353](https://github.com/cloudflare/agents/pull/1353) [`f834c81`](https://github.com/cloudflare/agents/commit/f834c814db16a6b7cba51cebef4be02b9364a088) Thanks [@threepointone](https://github.com/threepointone)! - Align `AIChatAgent` generics and types with `@cloudflare/think`, plus a reference example for multi-session chat built on the sub-agent routing primitive.
  - **New `Props` generic**: `AIChatAgent<Env, State, Props>` extending `Agent<Env, State, Props>`. Subclasses now get properly typed `this.ctx.props`.
  - **Shared lifecycle types**: `ChatResponseResult`, `ChatRecoveryContext`, `ChatRecoveryOptions`, `SaveMessagesResult`, and `MessageConcurrency` now live in `agents/chat` and are re-exported by both `@cloudflare/ai-chat` and `@cloudflare/think`. No behavior change; one place to edit when shapes evolve.
  - **`ChatMessage` stays the public message type**: the package continues to export `ChatMessage`, and the public API/docs keep using that name.
  - **`messages` stays a public field**: `messages: ChatMessage[]`.

  The full stance (AIChatAgent is first-class, production-ready, and continuing to get features; shared infrastructure should land in `agents/chat` where both classes benefit) is captured in [`design/rfc-ai-chat-maintenance.md`](../design/rfc-ai-chat-maintenance.md).

  A new example, `examples/multi-ai-chat`, demonstrates the multi-session pattern end-to-end on top of the sub-agent routing primitive: an `Inbox` Agent owns the chat list + shared memory; each chat is an `AIChatAgent` facet (`this.subAgent(Chat, id)`). The client addresses the active chat via `useAgent({ sub: [{ agent: "Chat", name: chatId }] })` — no separate DO binding, no custom routing on the server. `Inbox.onBeforeSubAgent` gates with `hasSubAgent` as a strict registry, and `Chat` reaches its parent via `this.parentAgent(Inbox)`.

### Patch Changes

- [#1358](https://github.com/cloudflare/agents/pull/1358) [`ea229b1`](https://github.com/cloudflare/agents/commit/ea229b12dd11178881539c389c6625c6d3546e3b) Thanks [@threepointone](https://github.com/threepointone)! - Fix `useAgentChat()` crashing on first render when `agent.getHttpUrl()` returns an empty string. This happened in setups where the WebSocket handshake hadn't completed by the time React rendered — most commonly when the agent is reached through a proxy or custom-routed worker — because `@cloudflare/ai-chat` unconditionally called `new URL(agent.getHttpUrl())`. See [#1356](https://github.com/cloudflare/agents/issues/1356).

  `useAgentChat()` now treats a missing HTTP URL as "not ready yet":
  - The built-in `/get-messages` fetch is deferred until the URL is known, and applied exactly once when it resolves (empty chats only — existing messages are never overwritten).
  - Custom `getInitialMessages` callbacks continue to run and are passed `url: undefined` so they can load from other sources if they don't need the socket URL. `GetInitialMessagesOptions.url` is now `string | undefined`; callers that previously typed `url: string` should widen to `url?: string`.
  - Initial messages are cached by agent identity (class + name) rather than by URL + identity, so the URL-arrival transition no longer invalidates the cache, re-invokes the loader, or re-triggers Suspense once the chat has already been populated.
  - The underlying `useChat` instance keeps a stable `id` across the URL-arrival transition, so in-flight stream resume and chat state are preserved.

  No API or behavior changes for apps where the URL was already available synchronously on first render.

## 0.4.6

### Patch Changes

- [#1340](https://github.com/cloudflare/agents/pull/1340) [`3cbe776`](https://github.com/cloudflare/agents/commit/3cbe77668df356906244db6a75c4cfba2daa1836) Thanks [@threepointone](https://github.com/threepointone)! - `waitForIdle` and `waitUntilStable` now also drain in-flight submits that have passed the concurrency decision but haven't yet entered the turn queue (i.e. submits mid-`persistMessages`). Previously these helpers only awaited `_turnQueue.waitForIdle()`, which could return while a submit was still tracked in `_pendingEnqueueCount` — racing with anything that called them (tests, recovery code, callers waiting for quiescence).

  Fixes a long-standing flake in the `merge concatenates overlapping queued user messages into one follow-up turn` test. The test's stream durations are also bumped (10×100ms → 15×150ms) to give the WS dispatch enough headroom under CI load to bump `_latestOverlappingSubmitSequence` before the first turn finishes.

## 0.4.5

### Patch Changes

- [#1332](https://github.com/cloudflare/agents/pull/1332) [`7cb8acf`](https://github.com/cloudflare/agents/commit/7cb8acff8281a30bc17980e506ab5582f3cb1c72) Thanks [@threepointone](https://github.com/threepointone)! - Expose `createdAt` on fiber and chat recovery contexts so apps can suppress continuations for stale, interrupted turns.
  - `FiberRecoveryContext` (from `agents`) gains `createdAt: number` — epoch milliseconds when `runFiber` started, read from the `cf_agents_runs` row that was already tracked internally.
  - `ChatRecoveryContext` (from `@cloudflare/ai-chat` and `@cloudflare/think`) gains the same `createdAt` field, threaded through from the underlying fiber.

  With this, the stale-recovery guard pattern described in [#1324](https://github.com/cloudflare/agents/issues/1324) is a short override:

  ```typescript
  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    if (Date.now() - ctx.createdAt > 2 * 60 * 1000) return { continue: false };
    return {};
  }
  ```

  No behavior change for existing callers. See `docs/chat-agents.md` (new "Guarding against stale recoveries" section) for the full recipe, including a loop-protection pattern using `onChatResponse`.

## 0.4.4

### Patch Changes

- [#1313](https://github.com/cloudflare/agents/pull/1313) [`08da191`](https://github.com/cloudflare/agents/commit/08da191ab66d2df5de7337a295d5f6a081473ff9) Thanks [@threepointone](https://github.com/threepointone)! - Publish with correct peer dependency ranges for `agents` (wide ranges were being overwritten to tight `^0.x.y` by the pre-publish script)

## 0.4.3

### Patch Changes

- [#1310](https://github.com/cloudflare/agents/pull/1310) [`bd0346e`](https://github.com/cloudflare/agents/commit/bd0346ec05406e258b3c8904874c7a8c0f4608e5) Thanks [@threepointone](https://github.com/threepointone)! - Fix peer dependency ranges for `agents` — published packages incorrectly had tight `^0.10.x` ranges instead of the intended `>=0.8.7 <1.0.0` / `>=0.9.0 <1.0.0`, causing install warnings with `agents@0.11.0`. Also changed `updateInternalDependencies` from `"patch"` to `"minor"` in changesets config to prevent the ranges from being overwritten on future releases.

- [#1312](https://github.com/cloudflare/agents/pull/1312) [`89773d1`](https://github.com/cloudflare/agents/commit/89773d12c391a472ba3d45c88b83c98ba7455947) Thanks [@threepointone](https://github.com/threepointone)! - Rename `unstable_chatRecovery` to `chatRecovery` — the feature is now stable.

## 0.4.2

### Patch Changes

- [#1290](https://github.com/cloudflare/agents/pull/1290) [`6429189`](https://github.com/cloudflare/agents/commit/6429189ca284d4d00b71d493387c757257ea6778) Thanks [@threepointone](https://github.com/threepointone)! - Remove false-positive "Stream was still active when cancel was received" warning that fired on every cancellation, even when the user correctly passed `abortSignal` to `streamText()`

## 0.4.1

### Patch Changes

- [#1277](https://github.com/cloudflare/agents/pull/1277) [`0cd0487`](https://github.com/cloudflare/agents/commit/0cd0487ca6b6bd684c72d59a8349994fe82750a1) Thanks [@zebp](https://github.com/zebp)! - Fix race condition in `messageConcurrency` where rapid overlapping submits could bypass the `latest`/`merge`/`debounce` strategy. The concurrency decision checked `queuedCount()` before the turn was enqueued, but an intervening `await persistMessages()` allowed a second message handler to see a stale count of zero and skip supersede checks. A pending-enqueue counter now bridges this gap so overlapping submits are always detected.

- [#1272](https://github.com/cloudflare/agents/pull/1272) [`22da9b1`](https://github.com/cloudflare/agents/commit/22da9b19743ad643d6dbd0ca61b1ff9064fbbd76) Thanks [@threepointone](https://github.com/threepointone)! - Widen `useAgentChat` agent prop type to accept both typed and untyped `useAgent` connections. Previously, `useAgent<MyAgent>()` results could not be passed to `useAgentChat` due to incompatible `call` types. The agent prop now uses a structural type matching only the fields `useAgentChat` actually uses.

## 0.4.0

### Minor Changes

- [#1264](https://github.com/cloudflare/agents/pull/1264) [`95b4d6a`](https://github.com/cloudflare/agents/commit/95b4d6a5430744cf4022aa3c4d4dfcb211607b3b) Thanks [@threepointone](https://github.com/threepointone)! - Rename `durableStreaming` to `chatRecovery`. Fix abort controller leak when `onChatMessage` throws. Wrap all 4 chat turn paths (WS, auto-continuation, programmatic, continueLastTurn) in `runFiber` when enabled. Guard `_chatRecoveryContinue` against stale continuations via `targetAssistantId` in schedule payload.

- [#1256](https://github.com/cloudflare/agents/pull/1256) [`dfab937`](https://github.com/cloudflare/agents/commit/dfab937c81b358415e66bda3f8abe76b85d12c11) Thanks [@threepointone](https://github.com/threepointone)! - Add durable fiber execution to the Agent base class.

  `runFiber(name, fn)` registers work in SQLite, holds a `keepAlive` ref, and enables recovery via `onFiberRecovered` after DO eviction. `ctx.stash()` and `this.stash()` checkpoint progress that survives eviction.

  `AIChatAgent` gains `chatRecovery` — when enabled, each chat turn is wrapped in a fiber. `onChatRecovery` provides provider-specific recovery (Workers AI continuation, OpenAI response retrieval, Anthropic synthetic message). `continueLastTurn()` appends to the interrupted assistant message seamlessly.

  `Think` now extends `Agent` directly (no mixin). Fiber support is inherited from the base class.

  **Breaking (experimental APIs only):**
  - Removed `withFibers` mixin (`agents/experimental/forever`)
  - Removed `withDurableChat` mixin (`@cloudflare/ai-chat/experimental/forever`)
  - Removed `./experimental/forever` export from both packages
  - Think no longer has a `fibers` flag — recovery is automatic via alarm housekeeping

### Patch Changes

- [#1270](https://github.com/cloudflare/agents/pull/1270) [`87b4512`](https://github.com/cloudflare/agents/commit/87b4512985e47de659bf970a65a6d1951f5855fe) Thanks [@threepointone](https://github.com/threepointone)! - Wire Session into Think as the storage layer, achieving full feature parity with AIChatAgent plus Session-backed advantages.

  **Think (`@cloudflare/think`):**
  - Session integration: `this.messages` backed by `session.getHistory()`, tree-structured messages, context blocks, compaction, FTS5 search
  - `configureSession()` override for context blocks, compaction, search, skills (sync or async)
  - `assembleContext()` returns `{ system, messages }` with context block composition
  - `onChatResponse()` lifecycle hook fires from all turn paths
  - Non-destructive regeneration via `trigger: "regenerate-message"` with Session branching
  - `saveMessages()` for programmatic turn entry (scheduled responses, webhooks, proactive agents)
  - `continueLastTurn()` for extending the last assistant response
  - Custom body persistence across hibernation
  - `sanitizeMessageForPersistence()` hook for PII redaction
  - `messageConcurrency` strategies (queue/latest/merge/drop/debounce)
  - `resetTurnState()` extracted as protected method
  - `chatRecovery` with `runFiber` wrapping on all 4 turn paths
  - `onChatRecovery()` hook with `ChatRecoveryContext`
  - `hasPendingInteraction()` / `waitUntilStable()` for quiescence detection
  - Re-export `Session` from `@cloudflare/think`
  - Constructor wraps `onStart` — subclasses never need `super.onStart()`

  **agents (`agents/chat`):**
  - Extract `AbortRegistry`, `applyToolUpdate` + builders, `parseProtocolMessage` into shared `agents/chat` layer
  - Add `applyChunkToParts` export for fiber recovery

  **AIChatAgent (`@cloudflare/ai-chat`):**
  - Refactor to use shared `AbortRegistry` from `agents/chat`
  - Add `continuation` flag to `OnChatMessageOptions`
  - Export `getAgentMessages()` and tool part helpers
  - Add `getHttpUrl()` to `useAgent` return value

## 0.3.2

### Patch Changes

- [#1248](https://github.com/cloudflare/agents/pull/1248) [`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#1247](https://github.com/cloudflare/agents/pull/1247) [`31c6279`](https://github.com/cloudflare/agents/commit/31c6279575c876cc5a7e69a4130e13a0c1afc630) Thanks [@threepointone](https://github.com/threepointone)! - Add `ContinuationState` to `agents/chat` — shared state container for auto-continuation lifecycle. AIChatAgent's 15 internal auto-continuation fields consolidated into one `ContinuationState` instance (no public API change). Think gains deferred continuations, resume coordination for pending continuations, `onClose` cleanup, and hibernation persistence for client tools via `think_request_context` table.

## 0.3.1

### Patch Changes

- [#1235](https://github.com/cloudflare/agents/pull/1235) [`4f79280`](https://github.com/cloudflare/agents/commit/4f79280eeb0e27aabb7d9f034ae2c35ab5c73d4a) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Strip messageId from continuation start chunks server-side so clients reuse the existing assistant message instead of briefly creating a duplicate.

- [#1232](https://github.com/cloudflare/agents/pull/1232) [`2713c45`](https://github.com/cloudflare/agents/commit/2713c45b94850e8d9768421fef0c2b1524cdff1e) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Prevent duplicate assistant messages when a new user message is sent while a response is still streaming.

- [#1234](https://github.com/cloudflare/agents/pull/1234) [`809f4dd`](https://github.com/cloudflare/agents/commit/809f4dddf789644ad0a13b38da5a593d7d255df6) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix `useAgentChat().stop()` so it cancels active server-side tool continuation streams.

## 0.3.0

### Minor Changes

- [#1192](https://github.com/cloudflare/agents/pull/1192) [`28925b6`](https://github.com/cloudflare/agents/commit/28925b6048c6ac4195c62fd1e07cdbf62c387b0f) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add `AIChatAgent.messageConcurrency` to control overlapping `sendMessage()`
  submits with `queue`, `latest`, `merge`, `drop`, and `debounce` strategies.
  Enhance `saveMessages()` to accept a functional form for deriving messages
  from the latest transcript, and return `{ requestId, status }` so callers
  can detect skipped turns.

- [#1228](https://github.com/cloudflare/agents/pull/1228) [`53f27b1`](https://github.com/cloudflare/agents/commit/53f27b16c8523278441efa74010789ececadf14d) Thanks [@threepointone](https://github.com/threepointone)! - Add `onChatResponse` hook and client-side server-streaming indicators.

  **Server: `onChatResponse` hook on `AIChatAgent`**

  New protected method that fires after a chat turn completes and the assistant message has been persisted. The turn lock is released before the hook runs, so it is safe to call `saveMessages` from inside. Responses triggered from `onChatResponse` are drained sequentially via a built-in drain loop.

  ```typescript
  protected async onChatResponse(result: ChatResponseResult) {
    if (result.status === "completed") {
      this.broadcast(JSON.stringify({ streaming: false }));
    }
  }
  ```

  New exported type: `ChatResponseResult` with `message`, `requestId`, `continuation`, `status`, and `error` fields.

  **Client: `isServerStreaming` and `isStreaming` on `useAgentChat`**

  `isServerStreaming` is `true` when a server-initiated stream (from `saveMessages`, auto-continuation, or another tab) is active. Independent of the AI SDK's `status` which only tracks client-initiated requests.

  `isStreaming` is a convenience flag: `true` when either the client-initiated stream (`status === "streaming"`) or a server-initiated stream is active.

  **Behavioral fix: stream error propagation**

  Non-abort reader errors in `_streamSSEReply` and `_sendPlaintextReply` now propagate correctly instead of being silently swallowed. The client receives `error: true` on the done message, and partial messages are not persisted. Previously, stream errors were silently treated as completions and partial content was persisted.

### Patch Changes

- [#1225](https://github.com/cloudflare/agents/pull/1225) [`599390c`](https://github.com/cloudflare/agents/commit/599390ccfb569fd0f29262ec84e5aef6b79d4abd) Thanks [@threepointone](https://github.com/threepointone)! - Fix `useAgentChat` cache key including query params, which broke stream resume with cross-domain auth. Auth tokens (and other query params) change across page loads, causing cache misses that re-trigger Suspense and interrupt the stream resume handshake. The cache key now uses agent identity only (origin + pathname + agent + name), keeping it stable across token rotations.

## 0.2.6

### Patch Changes

- [#1211](https://github.com/cloudflare/agents/pull/1211) [`841b001`](https://github.com/cloudflare/agents/commit/841b00101684a90bd6e93fd021029f1d72f07490) Thanks [@threepointone](https://github.com/threepointone)! - Fix `_pendingResumeConnections` not being cleared on stream error, which caused connections in the resume handshake to be permanently excluded from broadcasts when a continuation stream errored.

## 0.2.5

### Patch Changes

- [#1188](https://github.com/cloudflare/agents/pull/1188) [`806cf5b`](https://github.com/cloudflare/agents/commit/806cf5b4a46f77fd895ec3aa0686a4d992e5891f) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix(ai-chat): preserve Anthropic replay tokens during persistence

## 0.2.4

### Patch Changes

- [#1183](https://github.com/cloudflare/agents/pull/1183)
  [`324b296`](https://github.com/cloudflare/agents/commit/324b29638878234dfb4d8f810c929cad0028b717)
  Thanks [@threepointone](https://github.com/threepointone)! - Fix
  waitForIdle race and relax test assertion

  Make waitForIdle robust against races by looping until \_chatTurnQueue is stable (capture the current promise, await it, and repeat if it changed). Update the related test: rename it to reflect behavior and relax the assertion to accept 1–2 started request IDs (documenting the nondeterministic coalescing window under load), since rapid auto-continued tool results may coalesce or form sequential turns depending on timing.

## 0.2.3

### Patch Changes

- [#1179](https://github.com/cloudflare/agents/pull/1179)
  [`adc86f8`](https://github.com/cloudflare/agents/commit/adc86f805475ea5deabf40be9f04e2540dee529b)
  Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Coalesce rapid
  client-side tool results and approvals into a single auto-continuation
  turn so ai-chat avoids duplicate model continuations and extra streamed
  output.

## 0.2.2

### Patch Changes

- [#1178](https://github.com/cloudflare/agents/pull/1178)
  [`253345e`](https://github.com/cloudflare/agents/commit/253345e2dfc5a279572e03e24e48ddc58f10151d)
  Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix multi-tab
  tool continuations so only the originating connection waits for the
  pending resume handshake, while other tabs continue receiving live stream
  updates.

## 0.2.1

### Patch Changes

- [#1162](https://github.com/cloudflare/agents/pull/1162)
  [`7053b49`](https://github.com/cloudflare/agents/commit/7053b495380075bd9e3cb39edd454c8e9b0059f2)
  Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix chained
  tool-approval continuations so they keep streaming into the existing
  assistant message instead of splitting later continuation steps into a new
  persisted message.

- [#1161](https://github.com/cloudflare/agents/pull/1161)
  [`c131923`](https://github.com/cloudflare/agents/commit/c13192311984182df82253c4754b058e7f39a63d)
  Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Prevent
  hibernation from silently dropping tool auto-continuations. Wrap
  `_queueAutoContinuation` in `keepAliveWhile` so the DO stays alive from
  the moment a continuation is queued until it finishes streaming. Also
  adds test coverage for continuation edge cases.

## 0.2.0

### Minor Changes

- [#1150](https://github.com/cloudflare/agents/pull/1150) [`81a8710`](https://github.com/cloudflare/agents/commit/81a8710938ec1c7a8e388fda936d1724409d74d6) Thanks [@threepointone](https://github.com/threepointone)! - feat: add `sanitizeMessageForPersistence` hook and built-in Anthropic tool payload truncation
  - **New protected hook**: `sanitizeMessageForPersistence(message)` — override this method to apply custom transformations to messages before they are persisted to storage. Runs after built-in sanitization. Default is identity (returns message unchanged).
  - **Anthropic provider-executed tool truncation**: Large string values in `input` and `output` of provider-executed tool parts (e.g. Anthropic `code_execution`, `text_editor`) are now automatically truncated. These server-side tool payloads can exceed 200KB and are dead weight once the model has consumed the result.

  Closes [#1118](https://github.com/cloudflare/agents/issues/1118)

- [#1138](https://github.com/cloudflare/agents/pull/1138) [`36e2020`](https://github.com/cloudflare/agents/commit/36e2020d41d3d8a83b65b7e45e5af924b09f82ed) Thanks [@threepointone](https://github.com/threepointone)! - Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.

### Patch Changes

- [#1151](https://github.com/cloudflare/agents/pull/1151) [`b0c52a5`](https://github.com/cloudflare/agents/commit/b0c52a541625b9fbfc631cd17c0f38c40f43c7f5) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix(ai-chat): simplify turn coordination API
  - rename `waitForPendingInteractionResolution()` to `waitUntilStable()` and make it wait for a fully stable conversation state, including queued continuation turns
  - add `resetTurnState()` for scoped clear handlers that need to abort active work and invalidate queued continuations
  - demote `isChatTurnActive()`, `waitForIdle()`, and `abortActiveTurn()` to private — their behavior is subsumed by `waitUntilStable()` and `resetTurnState()`
  - harden pending-interaction bookkeeping so rejected tool-result and approval applies do not leak as unhandled rejections

- [#1106](https://github.com/cloudflare/agents/pull/1106) [`3184282`](https://github.com/cloudflare/agents/commit/3184282412fe0908a7eca5e117ff02b64541c860) Thanks [@threepointone](https://github.com/threepointone)! - fix: abort/stop no longer creates duplicate split messages (issue [#1100](https://github.com/cloudflare/agents/issues/1100))

  When a user clicked stop during an active stream, the assistant message was split into two separate messages. This happened because `onAbort` in the transport immediately removed the `requestId` from `activeRequestIds`, causing `onAgentMessage` to treat in-flight server chunks as a new broadcast.
  - `WebSocketChatTransport`: `onAbort` now keeps the `requestId` in `activeRequestIds` so in-flight server chunks are correctly skipped by the dedup guard
  - `useAgentChat`: `onAgentMessage` now cleans up the kept ID when receiving `done: true`, preventing a minor memory leak

- [#1142](https://github.com/cloudflare/agents/pull/1142) [`5651ece`](https://github.com/cloudflare/agents/commit/5651eced85c04bfaf5660922467c74de7dc0896e) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix(ai-chat): serialize chat turns and expose turn control helpers
  - queue `onChatMessage()` + `_reply()` work so user requests, tool continuations, and `saveMessages()` never stream concurrently
  - make `saveMessages()` wait for the queued turn to finish before resolving, and reuse the request id for reply cleanup
  - skip queued continuations and `saveMessages()` calls that were enqueued before a chat clear
  - capture `saveMessages()` context (`_lastClientTools`, `_lastBody`) at enqueue time so a later request cannot overwrite it before execution
  - add protected `isChatTurnActive()`, `waitForIdle()`, `abortActiveTurn()`, `hasPendingInteraction()`, and `waitForPendingInteractionResolution()` helpers for subclass code that needs to coordinate active turns and pending tool interactions

- [#1096](https://github.com/cloudflare/agents/pull/1096) [`0d0b7d3`](https://github.com/cloudflare/agents/commit/0d0b7d3334ef5c96ebffbc5fe11514dd54a9a579) Thanks [@threepointone](https://github.com/threepointone)! - fix(ai-chat): prevent duplicate messages after tool calls and orphaned client IDs
  - CF_AGENT_MESSAGE_UPDATED handler no longer appends when message not found in client state, fixing race between transport stream and server broadcast
  - \_resolveMessageForToolMerge reconciles IDs by toolCallId regardless of tool state, preventing client nanoid IDs from leaking into persistent storage

## 0.1.9

### Patch Changes

- [#1116](https://github.com/cloudflare/agents/pull/1116) [`dcc3bb2`](https://github.com/cloudflare/agents/commit/dcc3bb20bc1a3ea27dc7d0e333c8b1dc657999b7) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Preserve the existing assistant message during tool approval continuations so live client state does not render duplicate assistant messages or tool parts

## 0.1.8

### Patch Changes

- [#1059](https://github.com/cloudflare/agents/pull/1059) [`d0812f7`](https://github.com/cloudflare/agents/commit/d0812f71180d29c48aa4ccc854e14d2ed8517289) Thanks [@threepointone](https://github.com/threepointone)! - Server now responds with `CF_AGENT_STREAM_RESUME_NONE` when a client sends `CF_AGENT_STREAM_RESUME_REQUEST` and no active stream exists. This collapses the previous 5-second timeout to a single WebSocket round-trip, fixing the UI stall on every conversation open/switch/refresh when there is no active stream.

## 0.1.7

### Patch Changes

- [#1046](https://github.com/cloudflare/agents/pull/1046) [`2cde136`](https://github.com/cloudflare/agents/commit/2cde13660a1231a9a14bc50cacf8485af9a07378) Thanks [@threepointone](https://github.com/threepointone)! - Add `agent` and `name` fields to observability events, identifying which agent class and instance emitted each event.

  New events: `disconnect` (WebSocket close), `email:receive`, `email:reply`, `queue:create`, and a new `agents:email` channel.

  Make `_emit` protected so subclasses can use it. Update `AIChatAgent` to use `_emit` so message/tool events carry agent identity.

## 0.1.6

### Patch Changes

- [#1040](https://github.com/cloudflare/agents/pull/1040) [`766f20b`](https://github.com/cloudflare/agents/commit/766f20bd0b1d7add65fe3522b06b7124d4f8df6c) Thanks [@threepointone](https://github.com/threepointone)! - Changed `waitForMcpConnections` default from `false` to `{ timeout: 10_000 }`. MCP connections are now waited on by default with a 10-second timeout, so `getAITools()` returns the full set of tools in `onChatMessage` without requiring explicit opt-in. Set `waitForMcpConnections = false` to restore the previous behavior.

- [#1020](https://github.com/cloudflare/agents/pull/1020) [`70ebb05`](https://github.com/cloudflare/agents/commit/70ebb05823b48282e3d9e741ab74251c1431ebdd) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

- [#1013](https://github.com/cloudflare/agents/pull/1013) [`11aaaff`](https://github.com/cloudflare/agents/commit/11aaaffb89c375eba9bedf97074ced556dcdd0e7) Thanks [@threepointone](https://github.com/threepointone)! - Fix Gemini "missing thought_signature" error when using client-side tools with `addToolOutput`.

  The server-side message builder (`applyChunkToParts`) was dropping `providerMetadata` from tool-input stream chunks instead of storing it as `callProviderMetadata` on tool UIMessage parts. When `convertToModelMessages` later read the persisted messages for the continuation call, `callProviderMetadata` was undefined, so Gemini never received its `thought_signature` back and rejected the request.
  - Preserve `callProviderMetadata` (mapped from stream `providerMetadata`) on tool parts in `tool-input-start`, `tool-input-available`, and `tool-input-error` handlers — both create and update paths
  - Preserve `providerExecuted` on tool parts (used by `convertToModelMessages` for provider-executed tools like Gemini code execution)
  - Preserve `title` on tool parts (tool display name)
  - Add `providerExecuted` to `StreamChunkData` type explicitly
  - Add 13 regression tests covering all affected codepaths

- [#989](https://github.com/cloudflare/agents/pull/989) [`8404954`](https://github.com/cloudflare/agents/commit/8404954029a62244a87ec38691639f5b8ce9e615) Thanks [@threepointone](https://github.com/threepointone)! - Fix active streams losing UI state after reconnect and dead streams after DO hibernation.
  - Send `replayComplete` signal after replaying stored chunks for live streams, so the client flushes accumulated parts to React state immediately instead of waiting for the next live chunk.
  - Detect orphaned streams (restored from SQLite after hibernation with no live LLM reader) via `_isLive` flag on `ResumableStream`. On reconnect, send `done: true`, complete the stream, and reconstruct/persist the partial assistant message from stored chunks.
  - Client-side: flush `activeStreamRef` on `replayComplete` (keeps stream alive for subsequent live chunks) and on `done` during replay (finalizes orphaned streams).

- [#996](https://github.com/cloudflare/agents/pull/996) [`baf6751`](https://github.com/cloudflare/agents/commit/baf675188c11dded29720842a988a58f8eae2f1b) Thanks [@threepointone](https://github.com/threepointone)! - Fix race condition where MCP tools are intermittently unavailable in onChatMessage after hibernation.

  **`agents`**: Added `MCPClientManager.waitForConnections(options?)` which awaits all in-flight connection and discovery operations. Accepts an optional `{ timeout }` in milliseconds. Background restore promises from `restoreConnectionsFromStorage()` are now tracked so callers can wait for them to settle.

  **`@cloudflare/ai-chat`**: Added `waitForMcpConnections` opt-in config on `AIChatAgent`. Set to `true` to wait indefinitely, or `{ timeout: 10_000 }` to cap the wait. Default is `false` (non-blocking, preserving existing behavior). For lower-level control, call `this.mcp.waitForConnections()` directly in your `onChatMessage`.

- [#993](https://github.com/cloudflare/agents/pull/993) [`f706e3f`](https://github.com/cloudflare/agents/commit/f706e3f1833d507b53c1ba776982af479ea7cc1b) Thanks [@ferdousbhai](https://github.com/ferdousbhai)! - fix(ai-chat): preserve server tool outputs when client sends approval-responded state

  `_mergeIncomingWithServerState` now treats `approval-responded` the same as
  `input-available` when the server already has `output-available` for a tool call,
  preventing stale client state from overwriting completed tool results.

- [#1038](https://github.com/cloudflare/agents/pull/1038) [`e61cb4a`](https://github.com/cloudflare/agents/commit/e61cb4a5229b4d8ca19202d5633278a87b951df2) Thanks [@threepointone](https://github.com/threepointone)! - fix(ai-chat): preserve server-generated assistant messages when client appends new messages

  The `_deleteStaleRows` reconciliation in `persistMessages` now only deletes DB rows when the incoming message set is a subset of the server state (e.g. regenerate trims the conversation). When the client sends new message IDs not yet known to the server, stale deletion is skipped to avoid destroying assistant messages the client hasn't seen.

- [#1014](https://github.com/cloudflare/agents/pull/1014) [`74a3815`](https://github.com/cloudflare/agents/commit/74a3815218f9543a0610d6ccf948fc521b1f788e) Thanks [@threepointone](https://github.com/threepointone)! - Fix `regenerate()` leaving stale assistant messages in SQLite

  **Bug 1 — Transport drops `trigger` field:**
  `WebSocketChatTransport.sendMessages` was not including the `trigger` field
  (e.g. `"regenerate-message"`, `"submit-message"`) in the body payload sent
  to the server. The AI SDK passes this field so the server can distinguish
  between a new message and a regeneration request. Fixed by adding
  `trigger: options.trigger` to the serialized body.

  On the server side, `trigger` is now destructured out of the parsed body
  alongside `messages` and `clientTools`, so it does not leak into
  `options.body` in `onChatMessage`. Users who inspect `options.body` will
  not see any change in behavior.

  **Bug 2 — `persistMessages` never deletes stale rows:**
  `persistMessages` only performed `INSERT ... ON CONFLICT DO UPDATE` (upsert),
  so when `regenerate()` removed the last assistant message from the client's
  array, the old row persisted in SQLite. On the next `_loadMessagesFromDb`,
  the stale assistant message reappeared in `this.messages`, causing:
  - Anthropic models to reject with HTTP 400 (conversation must end with a
    user message)
  - Duplicate/phantom assistant messages across reconnects

  Fixed by adding an internal `_deleteStaleRows` option to `persistMessages`.
  When the chat-request handler (`CF_AGENT_USE_CHAT_REQUEST`) calls
  `persistMessages`, it passes `{ _deleteStaleRows: true }`, which deletes
  any DB rows whose IDs are absent from the incoming (post-merge) message set.
  This uses the post-merge IDs from `_mergeIncomingWithServerState` to
  correctly handle cases where client assistant IDs are remapped to server IDs.

  The `_deleteStaleRows` flag is internal only (`@internal` JSDoc) and is
  never passed by user code or other handlers (`CF_AGENT_CHAT_MESSAGES`,
  `_reply`, `saveMessages`). The default behavior of `persistMessages`
  (upsert-only, no deletes) is unchanged.

  **Bug 3 — Content-based reconciliation mismatches identical messages:**
  `_reconcileAssistantIdsWithServerState` used a single-pass cursor for both
  exact-ID and content-based matching. When an exact-ID match jumped the
  cursor forward, it skipped server messages needed for content matching
  of later identical-text assistant messages (e.g. "Sure", "I understand").

  Rewritten with a two-pass approach: Pass 1 resolves all exact-ID matches
  and claims server indices. Pass 2 does content-based matching only over
  unclaimed server indices. This prevents exact-ID matches from interfering
  with content matching, fixing duplicate rows in long conversations with
  repeated short assistant responses.

- [#999](https://github.com/cloudflare/agents/pull/999) [`95753da`](https://github.com/cloudflare/agents/commit/95753da49cb68e9e9e486e047b588004163a27fb) Thanks [@threepointone](https://github.com/threepointone)! - Fix `useChat` `status` staying `"ready"` during stream resumption after page refresh.

  Four issues prevented stream resumption from working:
  1. **addEventListener race:** `onAgentMessage` always handled `CF_AGENT_STREAM_RESUMING` before the transport's listener, bypassing the AI SDK pipeline.
  2. **Transport instance instability:** `useMemo` created new transport instances across renders and Strict Mode cycles. When `_pk` changed (async queries, socket recreation), the resolver was stranded on the old transport while `onAgentMessage` called `handleStreamResuming` on the new one.
  3. **Chat recreation on `_pk` change:** Using `agent._pk` as the `useChat` `id` caused the AI SDK to recreate the Chat when the socket changed, abandoning the in-flight `makeRequest` (including resume). The resume effect wouldn't re-fire on the new Chat.
  4. **Double STREAM_RESUMING:** The server sends `STREAM_RESUMING` from both `onConnect` and the `RESUME_REQUEST` handler, causing duplicate ACKs and double replay without deduplication.

  Fixes:
  - Replace `addEventListener`-based detection with `handleStreamResuming()` — a synchronous method `onAgentMessage` calls directly, eliminating the race.
  - Make the transport a true singleton (`useRef`, created once). Update `transport.agent` every render so sends/listeners always use the latest socket. The resolver survives `_pk` changes because the transport instance never changes.
  - Use a stable Chat ID (`initialMessagesCacheKey` based on URL + agent + name) instead of `agent._pk`, preventing Chat recreation on socket changes.
  - Add `localRequestIdsRef` guard to skip duplicate `STREAM_RESUMING` messages for streams already handled by the transport.

- [#1029](https://github.com/cloudflare/agents/pull/1029) [`c898308`](https://github.com/cloudflare/agents/commit/c898308d670851e2d79adcc2502f1663ba478b72) Thanks [@threepointone](https://github.com/threepointone)! - Add experimental `keepAlive()` and `keepAliveWhile()` methods to the Agent class. Keeps the Durable Object alive via alarm heartbeats (every 30 seconds), preventing idle eviction during long-running work. `keepAlive()` returns a disposer function; `keepAliveWhile(fn)` runs an async function and automatically cleans up the heartbeat when it completes.

  `AIChatAgent` now automatically calls `keepAliveWhile()` during `_reply()` streaming, preventing idle eviction during long LLM generations.

## 0.1.5

### Patch Changes

- [#986](https://github.com/cloudflare/agents/pull/986) [`e0d7a75`](https://github.com/cloudflare/agents/commit/e0d7a75b9c8ef484f7d5fc26f821e575b7a567cb) Thanks [@threepointone](https://github.com/threepointone)! - Terminate the WebSocket chat transport stream when the abort signal fires so
  clients exit the "streaming" state after stop/cancel.

## 0.1.4

### Patch Changes

- [#967](https://github.com/cloudflare/agents/pull/967) [`c128447`](https://github.com/cloudflare/agents/commit/c1284478fe212ddd6e1bc915877cee5c10fcfd49) Thanks [@threepointone](https://github.com/threepointone)! - Follow-up to #956. Allow `addToolOutput` to work with tools in `approval-requested` and `approval-responded` states, not just `input-available`. Also adds support for `state: "output-error"` and `errorText` fields, enabling custom denial messages when rejecting tool approvals (addresses remaining items from #955).

  Additionally, tool approval rejections (`approved: false`) now auto-continue the conversation when `autoContinue` is set, so the LLM sees the denial and can respond naturally (e.g. suggest alternatives).

  This enables the Vercel AI SDK recommended pattern for client-side tool denial:

  ```ts
  addToolOutput({
    toolCallId: invocation.toolCallId,
    state: "output-error",
    errorText: "User declined: insufficient permissions"
  });
  ```

- [#958](https://github.com/cloudflare/agents/pull/958) [`f70a8b9`](https://github.com/cloudflare/agents/commit/f70a8b9e2774d729825b8d85152c403d0c1e6dba) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix duplicate assistant message persistence when clients resend full history with local assistant IDs that differ from server IDs.

  `AIChatAgent.persistMessages()` now reconciles non-tool assistant messages against existing server history by content and order, reusing the server ID instead of inserting duplicate rows.

- [#977](https://github.com/cloudflare/agents/pull/977) [`5426b6f`](https://github.com/cloudflare/agents/commit/5426b6f3a8f394bdbad5e6b5cf22e279249bcdae) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Expose `requestId` in `OnChatMessageOptions` so handlers can send properly-tagged error responses for pre-stream failures.

  Also fix `saveMessages()` to pass the full options object (`requestId`, `abortSignal`, `clientTools`, `body`) to `onChatMessage` and use a consistent request ID for `_reply`.

- [#973](https://github.com/cloudflare/agents/pull/973) [`969fbff`](https://github.com/cloudflare/agents/commit/969fbff702d5702c1f0ea6faaecb3dfd0431a01b) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#983](https://github.com/cloudflare/agents/pull/983) [`2785f10`](https://github.com/cloudflare/agents/commit/2785f104f187834a0d568ad7db668d961b33707f) Thanks [@threepointone](https://github.com/threepointone)! - Fix abort/cancel support for streaming responses. The framework now properly cancels the reader loop when the abort signal fires and sends a done signal to the client. Added a warning log when cancellation arrives but the stream has not closed (indicating the user forgot to pass `abortSignal` to their LLM call). Also fixed vitest project configs to scope test file discovery and prevent e2e/react tests from being picked up by the wrong runner.

- [#979](https://github.com/cloudflare/agents/pull/979) [`23c90ea`](https://github.com/cloudflare/agents/commit/23c90ea4bdd63c03f28c40e1c3594b34ff523bf7) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Fix jsonSchema not initialized error when calling getAITools() in onChatMessage

- [#980](https://github.com/cloudflare/agents/pull/980) [`00c576d`](https://github.com/cloudflare/agents/commit/00c576de0ddcbac1ae4496abb14804cfb34e251e) Thanks [@threepointone](https://github.com/threepointone)! - Fix `_sanitizeMessageForPersistence` stripping Anthropic `redacted_thinking` blocks. The sanitizer now strips OpenAI ephemeral metadata first, then filters out only reasoning parts that are truly empty (no text and no remaining `providerMetadata`). This preserves Anthropic's `redacted_thinking` blocks (stored as empty-text reasoning parts with `providerMetadata.anthropic.redactedData`) while still removing OpenAI placeholders. Fixes #978.

- [#953](https://github.com/cloudflare/agents/pull/953) [`bd22d60`](https://github.com/cloudflare/agents/commit/bd22d6005fab16d0dc358274dcb12d368a31e076) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Moved `/get-messages` endpoint handling from a prototype `override onRequest()` method to a constructor wrapper. This ensures the endpoint always works, even when users override `onRequest` without calling `super.onRequest()`.

- [#956](https://github.com/cloudflare/agents/pull/956) [`ab401a0`](https://github.com/cloudflare/agents/commit/ab401a0e0b6942490e845cc9e34d9f17f65cbde8) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix denied tool approvals (`CF_AGENT_TOOL_APPROVAL` with `approved: false`) to transition tool parts to `output-denied` instead of `approval-responded`.

  This ensures `convertToModelMessages` emits a `tool_result` for denied approvals, which is required by providers like Anthropic.

  Also adds regression tests for denied approval behavior, including rejection from `approval-requested` state.

- [#982](https://github.com/cloudflare/agents/pull/982) [`5a851be`](https://github.com/cloudflare/agents/commit/5a851bef389683a13380626c8bed515a6351b172) Thanks [@threepointone](https://github.com/threepointone)! - Undeprecate client tool APIs (`createToolsFromClientSchemas`, `clientTools`, `AITool`, `extractClientToolSchemas`, and the `tools` option on `useAgentChat`) for SDK/platform use cases where tools are defined dynamically at runtime. Fix spurious `detectToolsRequiringConfirmation` deprecation warning when using the `tools` option.

## 0.1.3

### Patch Changes

- [#954](https://github.com/cloudflare/agents/pull/954) [`943c407`](https://github.com/cloudflare/agents/commit/943c4070992bb836625abb5bf4e3271a6f52f7a2) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.1.2

### Patch Changes

- [#930](https://github.com/cloudflare/agents/pull/930) [`cd408fe`](https://github.com/cloudflare/agents/commit/cd408fe495176e67066ebbb3962c224ada702124) Thanks [@threepointone](https://github.com/threepointone)! - Fix stale agent reference in useAgentChat transport under React StrictMode

  The `agentRef` was updated via `useEffect` (async, after render), but the `WebSocketChatTransport` is created in `useMemo` (sync, during render). When the agent reconnects or switches, `useMemo` would capture the old (closed) agent because the effect hadn't fired yet — causing `sendMessage` to send to a dead WebSocket. Fixed by updating `agentRef.current` synchronously during render, matching the pattern already used by other refs in the same hook.

## 0.1.1

### Patch Changes

- [`eeadbf4`](https://github.com/cloudflare/agents/commit/eeadbf4e780e2477798185cbc7a8abbeff2eadda) Thanks [@threepointone](https://github.com/threepointone)! - Add @ai-sdk/react as peer dependency to ai-chat

  Declare @ai-sdk/react ^3.0.0 as a peerDependency in packages/ai-chat/package.json to express runtime compatibility with the React SDK. package-lock.json was updated to reflect the resulting dependency graph changes.

## 0.1.0

The first minor release of `@cloudflare/ai-chat` — a major step up from the `agents/ai-chat-agent` re-export. This release refactors the internals (extracting ResumableStream, adding a WebSocket ChatTransport, simplifying SSE parsing) and ships a wave of bug fixes for streaming, tool continuations, and message persistence. New features include `maxPersistedMessages` for storage caps, `body` for custom request data, row size protection, incremental persistence, and data parts — typed JSON blobs that can be attached to messages alongside text for citations, progress indicators, and usage metadata. Tool approval (`needsApproval`) now persists across page refresh, client tools survive DO hibernation, and `autoContinueAfterToolResult` defaults to `true` so the LLM responds after tool results without explicit opt-in.

### Minor Changes

- [#899](https://github.com/cloudflare/agents/pull/899) [`04c6411`](https://github.com/cloudflare/agents/commit/04c6411c9a73fe48784d7ce86150d62cf54becda) Thanks [@threepointone](https://github.com/threepointone)! - Refactor AIChatAgent: extract ResumableStream class, add WebSocket ChatTransport, simplify SSE parsing.

  **Bug fixes:**
  - Fix `setMessages` functional updater sending empty array to server
  - Fix `_sendPlaintextReply` creating multiple text parts instead of one
  - Fix uncaught exception on empty/invalid request body
  - Fix `CF_AGENT_MESSAGE_UPDATED` not broadcast for streaming messages
  - Fix stream resumption race condition (client-initiated resume request + replay flag)
  - Fix `_streamCompletionPromise` not resolved on error (tool continuations could hang)
  - Fix `body` lost during tool continuations (now preserved alongside `clientTools`)
  - Fix `clearAll()` not clearing in-memory chunk buffer (orphaned chunks could flush after clear)
  - Fix errored streams never cleaned up by garbage collector
  - Fix `reasoning-delta` silently dropping data when `reasoning-start` was missed (stream resumption)
  - Fix row size guard using `string.length` instead of UTF-8 byte count for SQLite limits
  - Fix `completed` guard on abort listener to prevent redundant cancel after stream completion

  **New features:**
  - `maxPersistedMessages` — cap SQLite message storage with automatic oldest-message deletion
  - `body` option on `useAgentChat` — send custom data with every request (static or dynamic)
  - Incremental persistence with hash-based cache to skip redundant SQL writes
  - Row size guard — automatic two-pass compaction when messages approach SQLite 2MB limit
  - `onFinish` is now optional — framework handles abort controller cleanup and observability
  - Stream chunk size guard in ResumableStream (skip oversized chunks for replay)
  - Full tool streaming lifecycle in message-builder (tool-input-start/delta/error, tool-output-error)

  **Docs:**
  - New `docs/chat-agents.md` — comprehensive AIChatAgent and useAgentChat reference
  - Rewritten README, migration guides, human-in-the-loop, resumable streaming, client tools docs
  - New `examples/ai-chat/` example with modern patterns and Workers AI

  **Deprecations (with console.warn):**
  - `createToolsFromClientSchemas()`, `extractClientToolSchemas()`, `detectToolsRequiringConfirmation()`
  - `tools`, `toolsRequiringConfirmation`, `experimental_automaticToolResolution` options
  - `addToolResult()` (use `addToolOutput()`)

- [#919](https://github.com/cloudflare/agents/pull/919) [`6b6497c`](https://github.com/cloudflare/agents/commit/6b6497c65e07175ffd83f8cf3a6b3371e2dc17eb) Thanks [@threepointone](https://github.com/threepointone)! - Change `autoContinueAfterToolResult` default from `false` to `true`.

  Client-side tool results and tool approvals now automatically trigger a server continuation by default, matching the behavior of server-executed tools (which auto-continue via `streamText`'s multi-step). This eliminates the most common setup friction with client tools — the LLM now responds after receiving tool results without requiring explicit opt-in.

  To restore the previous behavior, set `autoContinueAfterToolResult: false` in `useAgentChat`.

### Patch Changes

- [#900](https://github.com/cloudflare/agents/pull/900) [`16b2dca`](https://github.com/cloudflare/agents/commit/16b2dcaf5adc152e78f01230dd99d4710867d4b6) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Add support for `data-*` stream parts (developer-defined typed JSON blobs) in the shared message builder and client hook.

  **Data part handling:**

  `applyChunkToParts` now handles `data-*` prefixed chunk types, covering both server persistence and client reconstruction (stream resume, cross-tab broadcast). Transient parts (`transient: true`) are broadcast to connected clients but excluded from `message.parts` and SQLite persistence. Non-transient parts support reconciliation by type+id — a second chunk with the same type and id updates the existing part's data in-place instead of appending a duplicate.

  **`onData` callback forwarding:**

  `useAgentChat` now invokes the `onData` callback for `data-*` chunks on the stream resumption and cross-tab broadcast codepaths, which bypass the AI SDK's internal pipeline. For new messages sent via the transport, the AI SDK already invokes `onData` internally. This is the correct way to consume transient data parts on the client since they are not added to `message.parts`.

- [#922](https://github.com/cloudflare/agents/pull/922) [`c8e5244`](https://github.com/cloudflare/agents/commit/c8e524499d902229e8ac83afd6cf2864f888cecc) Thanks [@threepointone](https://github.com/threepointone)! - Fix tool approval UI not surviving page refresh, and fix invalid prompt error after approval
  - Handle `tool-approval-request` and `tool-output-denied` stream chunks in the server-side message builder. Previously these were only handled client-side, so the server never transitioned tool parts to `approval-requested` or `output-denied` state.
  - Persist the streaming message to SQLite (without broadcasting) when a tool enters `approval-requested` state. The stream is paused waiting for user approval, so this is a natural persistence point. Without this, refreshing the page would reload from SQLite where the tool was still in `input-available` state, showing "Running..." instead of the Approve/Reject UI.
  - On stream completion, update the early-persisted message in place rather than appending a duplicate.
  - Fix `_applyToolApproval` to merge with existing approval data instead of replacing it. Previously `approval: { approved }` would overwrite the entire object, losing the `id` field that `convertToModelMessages` needs to produce a valid `tool-approval-request` content part. This caused an `InvalidPromptError` on the continuation stream after approval.

- [#897](https://github.com/cloudflare/agents/pull/897) [`994a808`](https://github.com/cloudflare/agents/commit/994a808abb5620b57aba4e0e0125bbcd89c1ae5f) Thanks [@alexanderjacobsen](https://github.com/alexanderjacobsen)! - Fix client tool schemas lost after DO restart by re-sending them with CF_AGENT_TOOL_RESULT

- [#916](https://github.com/cloudflare/agents/pull/916) [`24e16e0`](https://github.com/cloudflare/agents/commit/24e16e025b82dbd7b321339a18c6d440b2879136) Thanks [@threepointone](https://github.com/threepointone)! - Widen peer dependency ranges across packages to prevent cascading major bumps during 0.x minor releases. Mark `@cloudflare/ai-chat` and `@cloudflare/codemode` as optional peer dependencies of `agents` to fix unmet peer dependency warnings during installation.

- [#912](https://github.com/cloudflare/agents/pull/912) [`baa87cc`](https://github.com/cloudflare/agents/commit/baa87cceccd11ce051af5d2918831ec8eddd86fb) Thanks [@threepointone](https://github.com/threepointone)! - Persist request context across Durable Object hibernation.

  Persist `_lastBody` and `_lastClientTools` to SQLite so custom body fields and client tool schemas survive Durable Object hibernation during tool continuation flows (issue #887). Add test coverage for body forwarding during tool auto-continuation, and update JSDoc for `OnChatMessageOptions.body` to document tool continuation and hibernation behavior.

- [#913](https://github.com/cloudflare/agents/pull/913) [`bc91c9a`](https://github.com/cloudflare/agents/commit/bc91c9a63aefa2faf37db2ad7b5f3f382a1de101) Thanks [@threepointone](https://github.com/threepointone)! - Sync `_lastClientTools` cache and SQLite when client tools arrive via `CF_AGENT_TOOL_RESULT`, and align the wire type with `ClientToolSchema` (`JSONSchema7` instead of `Record<string, unknown>`)

- [#919](https://github.com/cloudflare/agents/pull/919) [`6b6497c`](https://github.com/cloudflare/agents/commit/6b6497c65e07175ffd83f8cf3a6b3371e2dc17eb) Thanks [@threepointone](https://github.com/threepointone)! - Add auto-continuation support for tool approval (`needsApproval`).

  When a tool with `needsApproval: true` is approved via `CF_AGENT_TOOL_APPROVAL`, the server can now automatically continue the conversation (matching the existing `autoContinue` behavior of `CF_AGENT_TOOL_RESULT`). The client hook passes `autoContinue` with approval messages when `autoContinueAfterToolResult` is enabled. Also fixes silent data loss where `tool-output-available` events for tool calls in previous assistant messages were dropped during continuation streams by adding a cross-message fallback search in `_streamSSEReply`.

- [#910](https://github.com/cloudflare/agents/pull/910) [`a668155`](https://github.com/cloudflare/agents/commit/a668155598aa8cd2f53b724391d1c538f3e96a2d) Thanks [@threepointone](https://github.com/threepointone)! - Add structural message validation and fix message metadata on broadcast/resume path.

  **Structural message validation:**

  Messages loaded from SQLite are now validated for required structure (non-empty `id` string, valid `role`, `parts` is an array). Malformed rows — from corruption, manual tampering, or schema drift — are logged with a warning and silently skipped instead of crashing the agent. This is intentionally lenient: empty `parts` arrays are allowed (streams that errored mid-flight), and no tool/data schema validation is performed at load time (that remains a userland concern via `safeValidateUIMessages` from the AI SDK).

  **Message metadata on broadcast/resume path:**

  The server already captures `messageMetadata` from `start`, `finish`, and `message-metadata` stream chunks and persists it on `message.metadata`. However, the client-side broadcast path (multi-tab sync) and stream resume path (reconnection) did not propagate metadata — the `activeStreamRef` only tracked `parts`. Now it also tracks `metadata`, and `flushActiveStreamToMessages` includes it in the partial message flushed to React state. This means cross-tab clients and reconnecting clients see metadata (model info, token usage, timestamps) during streaming, not just after the final `CF_AGENT_CHAT_MESSAGES` broadcast.

## 0.0.8

### Patch Changes

- [#882](https://github.com/cloudflare/agents/pull/882) [`584cebe`](https://github.com/cloudflare/agents/commit/584cebe882f437a685b96b26b15200dc50ba70e1) Thanks [@alexanderjacobsen](https://github.com/alexanderjacobsen)! - Fix multi-step client tool calling: pass stored client tool schemas to `onChatMessage` during tool continuations so the LLM can call additional client tools after auto-continuation. Also add a re-trigger mechanism to the client-side tool resolution effect to handle tool calls arriving during active resolution.

- [#891](https://github.com/cloudflare/agents/pull/891) [`0723b99`](https://github.com/cloudflare/agents/commit/0723b9909f037d494e0c7db43e031c952578c82e) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fix `getCurrentAgent()` returning `undefined` connection when used with `@cloudflare/ai-chat` and Vite SSR

  Re-export `agentContext` as `__DO_NOT_USE_WILL_BREAK__agentContext` from the main `agents` entry point and update `@cloudflare/ai-chat` to import it from `agents` instead of the `agents/internal_context` subpath export. This prevents Vite SSR pre-bundling from creating two separate `AsyncLocalStorage` instances, which caused `getCurrentAgent().connection` to be `undefined` inside `onChatMessage` and tool `execute` functions.

  The `agents/internal_context` subpath export has been removed from `package.json` and the deprecated `agentContext` alias has been removed from `internal_context.ts`. This was never a public API.

- [#886](https://github.com/cloudflare/agents/pull/886) [`4292f6b`](https://github.com/cloudflare/agents/commit/4292f6ba6d49201c88b09553452c3b243620f35b) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Forward custom body fields from client requests to `onChatMessage` options

  Custom data sent via `prepareSendMessagesRequest` or the AI SDK's `body` option in `sendMessage` is now available in the `onChatMessage` handler through `options.body`. This allows passing dynamic context (e.g., model selection, temperature, custom metadata) from the client to the server without workarounds.

## 0.0.7

### Patch Changes

- [#859](https://github.com/cloudflare/agents/pull/859) [`3de98a3`](https://github.com/cloudflare/agents/commit/3de98a398d55aeca51c7b845ed4c5d6051887d6d) Thanks [@threepointone](https://github.com/threepointone)! - broaden peer deps

- [#865](https://github.com/cloudflare/agents/pull/865) [`c3211d0`](https://github.com/cloudflare/agents/commit/c3211d0b0cc36aa294c15569ae650d3afeab9926) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.6

### Patch Changes

- [#829](https://github.com/cloudflare/agents/pull/829) [`83f137f`](https://github.com/cloudflare/agents/commit/83f137f7046aeafc3b480b5aa4518f6290b14406) Thanks [@Muhammad-Bin-Ali](https://github.com/Muhammad-Bin-Ali)! - Fix duplicate assistant messages when using needsApproval tools

  When calling `addToolApprovalResponse`, the original assistant message is now updated in place instead of creating a duplicate with a new ID.

- Updated dependencies [[`68916bf`](https://github.com/cloudflare/agents/commit/68916bfa08358d4bb5d61aff37acd8dc4ffc950e), [`3f490d0`](https://github.com/cloudflare/agents/commit/3f490d045844e4884db741afbb66ca1fe65d4093)]:
  - agents@0.3.10

## 0.0.5

### Patch Changes

- [#813](https://github.com/cloudflare/agents/pull/813) [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#797](https://github.com/cloudflare/agents/pull/797) [`77be4f8`](https://github.com/cloudflare/agents/commit/77be4f8149e41730148a360adfff9e66becdd5ed) Thanks [@iTrooz](https://github.com/iTrooz)! - refactor(ai-chat): put SSE reply and plaintext reply logic into 2 separate functions

- [#800](https://github.com/cloudflare/agents/pull/800) [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#818](https://github.com/cloudflare/agents/pull/818) [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#795](https://github.com/cloudflare/agents/pull/795) [`99cbca0`](https://github.com/cloudflare/agents/commit/99cbca0847d0d6c97f44b73f2eb155dabe590032) Thanks [@Jerrynh770](https://github.com/Jerrynh770)! - Fix resumable streaming to avoid delivering live chunks before resume ACK

- Updated dependencies [[`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`d1a0c2b`](https://github.com/cloudflare/agents/commit/d1a0c2b73b1119d71e120091753a6bcca0e2faa9), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`fd79481`](https://github.com/cloudflare/agents/commit/fd7948180abf066fa3d27911a83ffb4c91b3f099), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`e20da53`](https://github.com/cloudflare/agents/commit/e20da5319eb46bac6ac580edf71836b00ac6f8bb), [`f604008`](https://github.com/cloudflare/agents/commit/f604008957f136241815909319a552bad6738b58), [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db), [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e), [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18), [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa), [`ded8d3e`](https://github.com/cloudflare/agents/commit/ded8d3e8aeba0358ebd4aecb5ba15344b5a21db1)]:
  - agents@0.3.7

## 0.0.4

### Patch Changes

- [#761](https://github.com/cloudflare/agents/pull/761) [`0e8fc1e`](https://github.com/cloudflare/agents/commit/0e8fc1e8cca3ad5acb51f5a0c92528c5b6beb358) Thanks [@iTrooz](https://github.com/iTrooz)! - Allow returning a non-streaming reponse from onChatMessage()

- [#771](https://github.com/cloudflare/agents/pull/771) [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- Updated dependencies [[`cf8a1e7`](https://github.com/cloudflare/agents/commit/cf8a1e7a24ecaac62c2aefca7b0fd5bf1373e8bd), [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e)]:
  - agents@0.3.4

## 0.0.3

### Patch Changes

- [`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5) Thanks [@threepointone](https://github.com/threepointone)! - trigger a new release

- Updated dependencies [[`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5)]:
  - agents@0.3.3

## 0.0.2

### Patch Changes

- [#756](https://github.com/cloudflare/agents/pull/756) [`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f) Thanks [@threepointone](https://github.com/threepointone)! - feat: split ai-chat and codemode into separate packages

  Extract @cloudflare/ai-chat and @cloudflare/codemode into their own packages
  with comprehensive READMEs. Update agents README to remove chat-specific
  content and point to new packages. Fix documentation imports to reflect
  new package structure.

  Maintains backward compatibility, no breaking changes.

- Updated dependencies [[`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f), [`f12553f`](https://github.com/cloudflare/agents/commit/f12553f2fa65912c68d9a7620b9a11b70b8790a2)]:
  - agents@0.3.2
