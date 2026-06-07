# @cloudflare/think

## 0.8.5

### Patch Changes

- [#1690](https://github.com/cloudflare/agents/pull/1690) [`f6a8bc4`](https://github.com/cloudflare/agents/commit/f6a8bc4a3f1836e214cc9ac984d3bfc2ba0537b2) Thanks [@threepointone](https://github.com/threepointone)! - Surface a terminal chat-recovery outcome to clients that reconnect after it ended ([#1645](https://github.com/cloudflare/agents/issues/1645)).

  When a durable chat turn exhausted recovery (e.g. during a deploy/reconnect storm) while no client was connected, the terminal error was only broadcast transiently, so a client that connected afterward never learned the turn failed and the conversation appeared frozen. The outcome is now persisted durably and replayed over the resume handshake on the next reconnect — `STREAM_RESUMING` → `STREAM_RESUME_ACK` → terminal error frame on the resumed stream — which is the only path that surfaces as `useAgentChat`'s `error` on the real client. (A bare replayed frame is dropped by the client because it never reaches a transport stream reader.) The record is cleared once a later turn supersedes it — on a new client request, and also when any later turn ends in a non-error outcome (completed or aborted, including turns driven server-side via `saveMessages`), so a stale exhaustion can never replay after the conversation has recovered. Terminal non-exhaustion errors (e.g. a provider 500) are now durably recorded too, not just transiently broadcast, so they also replay to a reconnecting client.

  `@cloudflare/think` previously recorded the outcome durably but only replayed it as a bare on-connect frame (dropped by the client); it now uses the same resume-handshake delivery.

- [#1688](https://github.com/cloudflare/agents/pull/1688) [`4d050c7`](https://github.com/cloudflare/agents/commit/4d050c7600d5d763414fc8766a05c23acf3070a4) Thanks [@threepointone](https://github.com/threepointone)! - Fix `ThinkWorkflow` `step.prompt({ output })` failing on Workers AI with `AiError 5023: JSON Schema mode is not supported with stream mode`.

  Structured workflow prompts previously requested output via the AI SDK `Output.object` path, which streams a JSON Schema `response_format` — rejected by some providers (notably Workers AI). `step.prompt()` now runs a full agentic turn that returns its structured result by calling an internal `think_final_answer` tool whose arguments match the schema. This uses ordinary tool calling, so it works across every provider Think supports (verified on Workers AI, OpenAI, and Anthropic), keeps Think's streaming engine (persistence, recovery, resumable streams), and lets the agent use its own tools across multiple steps before producing the final structured answer.

  The `think_final_answer` tool name is reserved; its call and result are stripped from the persisted conversation so the transcript and later turns do not see Think's internal plumbing.

## 0.8.4

### Patch Changes

- [#1686](https://github.com/cloudflare/agents/pull/1686) [`1e49880`](https://github.com/cloudflare/agents/commit/1e498803fe26970aa264678d5ae3a2c96dd28258) Thanks [@threepointone](https://github.com/threepointone)! - Batch and pack chat-persistence SQLite writes to reduce rows written and round-trips.
  - `agents`: `ResumableStream` now **packs** each buffered group of stream chunks into a single SQLite row (a JSON array of chunk bodies) instead of writing one row per chunk. Single-chunk and large-chunk segments are stored unwrapped, and a per-segment byte cap keeps rows within the 2 MB SQLite row limit. This cuts chunk rows written / stored / scanned-on-replay by up to ~10×. Reads (replay, orphan reconstruction, `getStreamChunks`) transparently unpack both packed segments and legacy per-chunk rows, so existing stored data keeps working. Adds shared `buildInClauseStrings` and `MAX_BOUND_PARAMS` helpers exported from `agents/chat`.
  - `@cloudflare/ai-chat`: message cleanup (stale-row pruning and `maxPersistedMessages` enforcement) previously issued one `DELETE` per row in a loop; it now deletes rows in batched `DELETE ... WHERE id IN (...)` queries (capped at 100 bound parameters per query).
  - `@cloudflare/think`: `deleteSubmissions()` cleanup previously issued one `DELETE` per terminal submission (up to 500 per call); it now deletes rows in batched `DELETE ... WHERE submission_id IN (...)` queries.
  - `@cloudflare/ai-chat` & `@cloudflare/think`: chat-recovery incident TTL sweep previously deleted each stale incident with a separate awaited `storage.delete(key)` (which also defeats Durable Object write-coalescing); it now deletes incidents in batched `storage.delete(keys)` calls (up to 128 keys per call).

## 0.8.3

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

- [#1668](https://github.com/cloudflare/agents/pull/1668) [`d40cc8a`](https://github.com/cloudflare/agents/commit/d40cc8ac5c5200668fcb7739af700083608c4339) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix RPC resource leaks in workflows.

  Workflows that use `waitForApproval()` or `ThinkWorkflow.prompt()` now release their RPC stubs promptly, preventing resource leaks and the associated "RPC stub was not disposed" warnings in your logs.

- [#1670](https://github.com/cloudflare/agents/pull/1670) [`5d64940`](https://github.com/cloudflare/agents/commit/5d64940c2115822ef5ba4c8b35bfe5c2632ce11d) Thanks [@threepointone](https://github.com/threepointone)! - Fix: a deploy that interrupts an in-flight `runAgentTool` child no longer abandons the still-running child as `interrupted`.

  Parent recovery re-attaches to a still-running child and tails it to its real terminal. Previously that re-attach used a flat 120s wall-clock budget that was **not** reset by the child's forward progress, so a healthy child whose recovery legitimately ran longer than the budget was sealed `interrupted` (and its already-completed work re-run from scratch), even while it was actively streaming.

  The re-attach budget is now **progress-keyed**: it bounds how long the parent waits with _no_ forward progress from the child (resetting on every forwarded chunk), so a genuinely hung/silent child still seals `interrupted` after one no-progress window and can never block recovery forever, while a healthy child that keeps streaming is followed through to terminal. The parent re-arms (opens a fresh tail) **only when the child's stream closes cleanly while it is still advancing** — i.e. a re-evicted-but-progressing child. A full no-progress window (the child went silent) seals `no-progress` immediately even if the child streamed earlier in that window; it no longer grants a bonus window. This is both the honest stall signal and what keeps at most one pending tail reader alive per re-attach (no per-cycle reader accumulation).

  `@cloudflare/think` and `@cloudflare/ai-chat` additionally finalize a child facet's own agent-tool run row as soon as its recovered turn settles — regardless of whether recovery took the continue path (`_chatRecoveryContinue`) or the pre-stream retry path (`_chatRecoveryRetry`) — so a re-attached parent collects the terminal result immediately instead of waiting out a full no-progress window after the child has already finished.

  This release also adds:
  - **Typed interrupted cause.** `RunAgentToolResult`, the `agentTool()` `AgentToolFailure` envelope, the `onAgentToolFinish` lifecycle result, and the `agent-tool-event` wire event (kind `"interrupted"`) now carry a machine-readable `reason` (`AgentToolInterruptedReason`: `"no-progress" | "window-exceeded" | "not-tailable" | "inspect-timeout" | "inspect-failed" | "recovery-deadline"`) and a `childStillRunning` boolean on `interrupted` results, so callers (and UIs) can branch on _why_ a run was abandoned (and whether the child is still running) instead of pattern-matching the human-readable `error` prose. `retryable` stays coarse (always `true` for `interrupted`); refine with `reason` / `childStillRunning`. These fields are **persisted** (schema bump), so they survive a reconnect replay — a client that reconnects after an interrupt reconstructs the same `reason` / `childStillRunning` a live client saw, rather than `undefined`. The persisted cause is cleared when a soft `interrupted` row is later repaired to `completed`/`error`.
  - **Configurable re-attach budgets.** Two new public `AgentStaticOptions` — `agentToolReattachNoProgressTimeoutMs` (default 120000, the progress-keyed no-progress budget) and `agentToolReattachMaxWindowMs` (default **`Infinity`** — no implicit wall-clock cap) — let an Agent tune re-attach. The hard ceiling defaults to uncapped to mirror chat-recovery's `maxRecoveryWork: Infinity`: a re-attached parent follows a healthy, still-advancing child for as long as it makes progress — exactly as it would on the live (never-evicted) path — so it never abandons a long-running-but-healthy child that simply outlasts a fixed wall clock under deploy churn. A hung/silent child is bounded by the no-progress budget; a content-runaway is bounded uniformly (live and recovery) by the child's own `maxRecoveryWork` / `shouldKeepRecovering`. Integrators that want a hard wall-clock cap (and the `window-exceeded` child teardown it triggers) can set `agentToolReattachMaxWindowMs` to a finite value. Symmetrically, setting `agentToolReattachNoProgressTimeoutMs` to `Infinity` now means **"never seal on no-progress"** (a silent-but-alive child is followed until its stream closes or the hard ceiling fires) instead of silently skipping the wait — `0` remains the "don't wait, collect only an already-terminal child" sentinel.
  - **Give-up teardown (ceiling only).** When the parent gives up at the hard `window-exceeded` ceiling — where the child has had its full recovery window and is truly exhausted — it now cancels the child (`childStillRunning: false`) so it stops consuming a fiber / keep-alive. `no-progress` give-ups stay **soft** (`childStillRunning: true`): the child is left running so a re-issue can still re-attach and repair it if it self-heals, preserving the repair-on-re-issue path. In both `@cloudflare/think` and `@cloudflare/ai-chat`, `cancelAgentToolRun` also aborts an in-flight chat-recovery turn (not just the original in-isolate run) and releases live tails — Think sweeps its `_submissionAbortControllers`, ai-chat its request `AbortRegistry` (`abortAllRequests`) — so a torn-down child stops grinding instead of finishing an orphaned recovered turn.

- [#1675](https://github.com/cloudflare/agents/pull/1675) [`d915bc6`](https://github.com/cloudflare/agents/commit/d915bc6f6d8da70df8e3b97be185b773c28c309e) Thanks [@threepointone](https://github.com/threepointone)! - The skill runner now imports `just-bash` and `@cloudflare/codemode` statically instead of dynamically, and both have moved from optional peer dependencies to regular dependencies of `agents`. The dynamic imports were ineffective in bundled Workers (the bundler includes them eagerly regardless) and triggered `INEFFECTIVE_DYNAMIC_IMPORT` warnings when bundled alongside `@cloudflare/think`, which imports them statically. `@cloudflare/think` also now statically imports its internal `ExtensionManager` instead of dynamically, removing the third such warning.

- [#1662](https://github.com/cloudflare/agents/pull/1662) [`df6c0d6`](https://github.com/cloudflare/agents/commit/df6c0d68d2195fa22c74ff0b7bb6801d15dd3eee) Thanks [@threepointone](https://github.com/threepointone)! - Add opt-in recovery for mid-turn context-window overflow.

  Compaction only fires between turns (`Session.compactAfter` checks the threshold on `appendMessage`). A single long, tool-heavy turn grows the prompt step-by-step inside one `streamText` loop and can exceed the model's context window mid-turn, before the next pre-turn check — the provider then 400s (`"prompt is too long"` / `context_length_exceeded`) and the turn dies terminally. Think deliberately ships no provider-specific error matching, so it could neither detect nor recover from this.

  This adds opt-in, provider-agnostic recovery (all default off — no behavior change unless enabled), configured through a single `contextOverflow` property on `Think`:
  - **`classifyChatError(error, ctx)`** — the app maps a raw error (or the in-stream error string) to a `ChatErrorClassification` (`"context_overflow" | "rate_limit" | "transient" | "fatal" | "unknown"`). Same framework-owns-the-mechanism / app-owns-the-provider-knowledge split as `tokenCounter`. The classification is also threaded to `onChatError`/observers via `ChatErrorContext.classification`. The bundled, exported `defaultContextOverflowClassifier` covers the common providers (Anthropic, OpenAI, Google, Bedrock, …) for apps that do not need custom classification.
  - **`contextOverflow.reactive`** + **`contextOverflow.maxRetries`** — when a turn fails with a `context_overflow` the app classified, Think discards the truncated partial, runs `session.compact()`, and re-runs the turn (bounded) from the compacted history instead of dying. The partial is intentionally not persisted: the retry restarts the turn from scratch, so keeping the cut-off partial would orphan a half-finished assistant message beside the recovered answer (and duplicate any tool work the retry re-issues). A no-op compaction or a spent budget surfaces the overflow terminally through `onChatError` with `classification: "context_overflow"` — never a silent end, never an infinite loop. Wired into the WebSocket, `chat()`/RPC, and programmatic (`saveMessages`/`submitMessages`) turn paths.
  - **`contextOverflow.proactive`** — a `{ maxInputTokens, headroom?, maxCompactions? }` pre-step guard: when the previous step's model-reported `usage.inputTokens` crosses `maxInputTokens * (headroom ?? 0.9)`, Think compacts in place and feeds the recompacted history into the upcoming step, heading off the provider 400 before it happens. Keys off model-reported usage (every provider reports it), not provider error strings. Bounded per step loop by its own `maxCompactions` (default 1, independent of the reactive `maxRetries` budget).

  Also adds a `chat:context:compacted` observability event (`agents`) emitted (once) on both proactive and reactive compaction.

  Notes:
  - Provider context-overflow errors always surface as in-stream error parts (confirmed against the AI SDK: `streamText` re-enqueues even top-level rejections as `{ type: "error" }` fullStream parts, and `toUIMessageStream` passes them through without throwing), so the in-stream seam catches them on every path; the thrown-error catch path does not need separate wiring.
  - Recovery effectiveness depends on the app's compaction config — a no-op compaction cannot rescue an over-budget turn (handled gracefully: terminal, not a loop). A one-time warning fires if `contextOverflow.reactive` is enabled but `classifyChatError` was never overridden.

## 0.8.2

### Patch Changes

- [#1667](https://github.com/cloudflare/agents/pull/1667) [`919bfaa`](https://github.com/cloudflare/agents/commit/919bfaa35c95e94302bad443f070b015bcaf4cb7) Thanks [@threepointone](https://github.com/threepointone)! - fix(think): make the parallel-tool auto-continuation barrier event-driven ([#1650](https://github.com/cloudflare/agents/issues/1650), follow-up to [#1649](https://github.com/cloudflare/agents/issues/1649))

  [#1649](https://github.com/cloudflare/agents/issues/1649) added a barrier so auto-continuation waits for all of a step's parallel client-tool results before firing, but bounded the wait with a fixed 60s timeout that fired through on expiry. That timeout was the wrong primary mechanism: a human-in-the-loop tool with no `execute` (an `ask_user`/`display_ui`-style prompt) emitted in parallel with a fast tool legitimately parks at `input-available` for minutes, so the barrier would fire through and repair the still-open tool to errored while the user was answering. Orphans (a client disconnecting mid-batch) also pinned the isolate alive via `keepAlive` for the full 60s.

  Auto-continuation is only ever triggered by a tool-result/approval event, so the barrier is now purely event-driven. When the coalesce timer fires on an incomplete batch, Think drains the in-flight applies, re-checks, and — if a sibling is still unanswered — returns without firing and without holding the isolate, leaving the pending continuation in place. The next sibling's result re-arms the timer (or, after eviction, re-creates the pending state from the persisted transcript) and re-runs the check; the continuation fires exactly once when the final sibling lands. A legitimately slow human answer never fires through to a spurious error, a true orphan never auto-continues and never pins the isolate, and the case is self-healing across hibernation. This removes `AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS` (and its `console.warn`) from the Think path entirely.

  Because the barrier now keys off events rather than polling message state, it also handles the case where the result that completes a parallel batch is an errored one: the client sends `autoContinue: false` for an errored tool result, so that event no longer schedules a continuation. When a sibling has already opted in (a pending continuation exists), such a result now re-arms the barrier check so the batch still continues exactly once — without ever creating a continuation for a standalone errored tool.

  Crucially, this also fixes [#1649](https://github.com/cloudflare/agents/issues/1649)'s headline race (`MissingToolResultsError`): the model emits parallel tool calls sequentially within one step, so a fast client tool can resolve and round-trip a result to the server **while the model is still streaming the slower siblings** — at which point those siblings exist nowhere (not in the persisted transcript, not in the in-flight accumulator), so no batch check can see them and the barrier fires prematurely. The continuation then repairs the later-materialized siblings to errored. The barrier now holds while the assistant turn is streaming (`_streamingAssistant != null`) and re-checks when the stream finalizes (`_onStreamingTurnFinalized`) — which also covers the all-fast batch whose every result landed mid-stream, where there is no later tool-result event to re-arm it.

  `@cloudflare/ai-chat` keeps the bounded-wait barrier for now (its barrier runs inside the queued continuation turn and can't return-and-wait without occupying the chat-turn queue); making it event-driven requires moving the batch gate before queueing, tracked alongside the think↔ai-chat unification ([#1642](https://github.com/cloudflare/agents/issues/1642)).

- [#1671](https://github.com/cloudflare/agents/pull/1671) [`ebd0bf2`](https://github.com/cloudflare/agents/commit/ebd0bf2ea95f980e62e0712d23ec74b40f5d6f0e) Thanks [@threepointone](https://github.com/threepointone)! - fix(think): don't re-arm the auto-continuation barrier when an RPC stall routes into bounded recovery ([#1667](https://github.com/cloudflare/agents/issues/1667) follow-up)

  The RPC streaming path (`_streamResultToRpcCallback`) re-armed the auto-continuation coalesce timer in its `finally` even on the stream-stall recovery early-returns (`scheduled`/`exhausted`), unlike the WebSocket `_streamResult` recovery paths which deliberately do a plain `_streamingAssistant = null` without re-arming. When a parallel tool batch had a pending continuation at the moment the stall watchdog fired, that re-arm could fire a second continuation alongside the alarm-scheduled recovery continuation — a spurious double model invocation on the turn queue. The RPC recovery early-returns now mirror the WebSocket path (plain clear, no re-arm); the scheduled recovery continuation re-runs the turn and its own stream finalize re-triggers the held barrier exactly once.

## 0.8.1

### Patch Changes

- [#1657](https://github.com/cloudflare/agents/pull/1657) [`7bff8d7`](https://github.com/cloudflare/agents/commit/7bff8d74c927a53ec11ee4a89dc6cff6b63db0ad) Thanks [@threepointone](https://github.com/threepointone)! - fix(think): apply client-tool results that arrive mid-stream so they aren't dropped ([#1649](https://github.com/cloudflare/agents/issues/1649) follow-up)

  The serialization fix in [#1657](https://github.com/cloudflare/agents/issues/1657) stopped parallel results from clobbering each other, but a deeper window remained: during a streaming turn the assistant message lives only in the in-flight `StreamAccumulator` until `_persistAssistantMessage` writes it at the turn boundary. The `tool-input-available` chunk is broadcast to the client mid-stream, so a fast client can resolve the tool and send `cf_agent_tool_result` before the message is ever persisted. `_applyToolUpdateToMessages` only scanned durable storage, so the apply silently no-op'd, the end-of-stream persist then wrote `input-available`, and the auto-continuation's transcript repair errored the call with "The tool call was interrupted before a result was recorded."

  `_applyToolUpdateToMessages` now applies the update to the in-flight accumulator (in place, so it rides into the eventual persist) in addition to durable storage, mirroring `@cloudflare/ai-chat`'s `_streamingMessage` handling. The accumulator is exposed via `_streamingAssistant` for the duration of each streaming turn and cleared on every exit path and on `resetTurnState`. Applying to both locations is monotonic, so a stall-recovery partial persist can't downgrade an already-applied result back to `input-available`.

- [#1665](https://github.com/cloudflare/agents/pull/1665) [`13d6db0`](https://github.com/cloudflare/agents/commit/13d6db042315937ed8d393775f3d576d56984f44) Thanks [@threepointone](https://github.com/threepointone)! - Avoid starting empty submission and workflow notification drains during agent startup, preventing short-lived facet initializations from leaving background keep-alive work behind.

- [#1661](https://github.com/cloudflare/agents/pull/1661) [`41315b6`](https://github.com/cloudflare/agents/commit/41315b602c4d68dbd5cad99cc949fbf13e256c51) Thanks [@threepointone](https://github.com/threepointone)! - Unwedge sessions corrupted by a malformed `tool_use.input`, and make the failure observable.
  1. **Read-side repair gap.** Transcript repair already normalized a `null`/`undefined`/stringified-JSON tool input, but left an empty string `""`, an array, and other non-object primitives untouched — so a session that persisted one of those shapes before the write-side guard shipped kept 400ing forever with `tool_use.input: Input should be an object` (Anthropic rejects array inputs the same way it rejects `""`/`null`). `_normalizeToolInput` now delegates to the shared `normalizeToolInput`, collapsing any non-object input to `{}` so the pre-send repair pass rescues the session on its next turn.

  2. **Observability.** An AI-SDK provider error surfaces as a stream error part, not a thrown exception, so it took the in-band `error` branch that emitted `message:error` but never `chat:request:failed`. That branch now also emits `chat:request:failed` (`stage: "stream"`), so observers and turn-count telemetry see the post-`beforeTurn`, in-stream failure class without needing to know whether the error threw or arrived as a chunk.

- [#1657](https://github.com/cloudflare/agents/pull/1657) [`7bff8d7`](https://github.com/cloudflare/agents/commit/7bff8d74c927a53ec11ee4a89dc6cff6b63db0ad) Thanks [@threepointone](https://github.com/threepointone)! - fix(think): serialize parallel client-tool result/approval applies so siblings aren't clobbered ([#1649](https://github.com/cloudflare/agents/issues/1649) follow-up)

  The auto-continuation barrier added in [#1651](https://github.com/cloudflare/agents/issues/1651) stopped premature continuation, but a deeper race remained in Think. Each `tool-result`/`tool-approval` WebSocket message fired an independent read-modify-write of the whole assistant message, and `_applyToolUpdateToMessages` awaits a storage read before its write. When the model fanned out parallel tool calls, the concurrent applies all read the same `input-available` snapshot, each patched only its own part, and the last write clobbered its siblings back to `input-available`. The continuation barrier then timed out and the transcript-repair backstop errored the lost calls with "The tool call was interrupted before a result was recorded."

  Applies are now chained off a serialization tail so each read-modify-write commits atomically in arrival order. `_pendingInteractionPromise` still tracks the newest link, so the barrier's single-slot wake-up transitively waits for every predecessor.

  The same serialization is applied to `@cloudflare/ai-chat` defensively: its apply is currently synchronous (no await between the message read and the SQLite write), so it does not exhibit this clobber today, but the queue keeps the invariant safe if that ever changes.

- [#1659](https://github.com/cloudflare/agents/pull/1659) [`f99f890`](https://github.com/cloudflare/agents/commit/f99f89022ced86115fa81f652e49ecb74340dbf2) Thanks [@threepointone](https://github.com/threepointone)! - Fix two chat-recovery failures that could leave a turn wedged at a half-finished assistant message after a deploy/eviction, with no terminal banner.
  1. **Server-tool recovery deadlock.** When a server-side tool's `execute()` was interrupted by an eviction, the recovered turn's orphaned tool part was left at `input-available` — but no client `tool-result` will ever arrive for a server tool, so `waitUntilStable` could never converge. The recovery continuation burned its whole attempt budget on a wait that could not succeed. `waitUntilStable` now treats an `input-available` part as pending only when it is genuinely client-resolvable (a registered client tool whose result the SPA can replay, or an `approval-requested` part). A dead server-tool orphan no longer blocks stability, so recovery converges and the existing transcript-repair pass flips the orphan to an errored result and the model continues the turn.

  2. **Silent seal on a thrown recovery callback.** A non-reset error thrown by `_chatRecoveryContinue` / `_chatRecoveryRetry` was re-thrown and then swallowed by the scheduler, which deleted the one-shot recovery alarm row — terminating the turn with no `onExhausted` event and no terminal banner. The recovery callbacks now terminalize a non-reset throw through the same exhaustion path (firing `onExhausted` with reason `recovery_error` and delivering the `terminalMessage`), while still re-throwing a genuine Durable Object code-update reset so the platform re-runs recovery on the fresh isolate. The terminal banner is also now broadcast before the bookkeeping storage writes in the exhaustion path, and those writes are best-effort, so a storage failure during give-up can no longer suppress the user-visible terminalization.

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

- [#1584](https://github.com/cloudflare/agents/pull/1584) [`87006e2`](https://github.com/cloudflare/agents/commit/87006e27498ee535feabd2a9bd207366f33621be) Thanks [@threepointone](https://github.com/threepointone)! - Add a framework-agnostic Agent Skills engine at `agents/skills`: skill sources (`fromManifest`, R2), a `SkillRegistry` that produces a catalog prompt and AI SDK activation tools (`activate_skill`, `read_skill_resource`, `run_skill_script`), binary-safe resource reads, and qualified cross-skill resource paths. Bundled skills are imported through the Agents Vite plugin with the `agents:skills` specifier (defaulting to a `./skills` directory), typed via ambient declarations shipped from `agents`. `@cloudflare/think` re-exports the engine as `skills` and wires `getSkills()` into the turn; any AI SDK caller (including `@cloudflare/ai-chat`) can build a `SkillRegistry` directly.

  Skill loading is resilient: duplicate or failing sources are skipped with a warning (first source wins) instead of throwing. Optional, experimental script execution (`skills.runner`) runs function-style JavaScript/TypeScript (`export default run(input, ctx)` with `ctx = { skill, files, workspace, tools, output }`) plus path-based Python and Bash, all behind a single capability and permission bridge.

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

- [#1587](https://github.com/cloudflare/agents/pull/1587) [`32ea71e`](https://github.com/cloudflare/agents/commit/32ea71ef805e25e7926cfbcb849350e40df739d3) Thanks [@threepointone](https://github.com/threepointone)! - Add first-class Think messengers with provider-neutral routing, durable Chat SDK state, streamed Think replies, action events, and a Telegram provider entrypoint.

  The messenger runtime depends directly on Chat SDK, supports provider-specific adapter names for multi-bot setups, and exposes the Telegram provider as both a named and default export.

- [#1643](https://github.com/cloudflare/agents/pull/1643) [`bc86dce`](https://github.com/cloudflare/agents/commit/bc86dcee955eea7f0dbfa1b117b4f7b98330ba2a) Thanks [@threepointone](https://github.com/threepointone)! - Route a stream-stall watchdog abort into bounded recovery instead of a terminal error ([#1626](https://github.com/cloudflare/agents/issues/1626))

  When `chatStreamStallTimeoutMs` is set and the inactivity watchdog fires on a
  hung model/transport stream, the turn is no longer failed terminally. Because a
  stall is just another interruption — like a deploy or eviction — it is now
  routed into the **same bounded chat-recovery path**: the settled partial is
  preserved, a continuation is scheduled, and the turn resumes. A transient hang
  (the common case under deploy churn) recovers automatically; a persistently
  hanging provider still terminalizes once the recovery budget is exhausted (the
  watchdog's original "kill the infinite spinner" guarantee, now after bounded
  retries). Exhaustion goes through the **same** `_exhaustChatRecovery` path as
  deploy-recovery exhaustion, so your configured `terminalMessage` is delivered,
  `onExhausted` fires, and the `chat:recovery:exhausted` event is emitted — rather
  than leaking the raw `"Chat stream stalled…"` error.

  This is automatic whenever the watchdog is enabled and `chatRecovery` is on
  (the Think default) — no new configuration. Idempotency matches deploy
  recovery: settled tool results are durable and are not re-run, but a tool that
  was mid-execution when the stall fired re-runs on the continuation. With
  `chatRecovery` disabled, a stall stays terminal as before.

  Also adds a per-turn `TurnConfig.chatStreamStallTimeoutMs` override (returned
  from `beforeTurn`): a turn known to invoke a slow tool can raise or disable
  (`0`) the watchdog for that turn only, instead of permanently widening the
  instance-level window. It auto-resets after the turn.

- [#1647](https://github.com/cloudflare/agents/pull/1647) [`0b29be5`](https://github.com/cloudflare/agents/commit/0b29be5345c6b7e37d8f9dfefc0dcac710423ff1) Thanks [@threepointone](https://github.com/threepointone)! - Add `StreamCallback.onInterrupted()` so a `chat()`-driven turn interrupted by recovery isn't silently abandoned

  When a turn driven through `chat(userMessage, callback)` is interrupted and routed
  into bounded recovery (a stream-stall watchdog abort), the scheduled continuation
  runs in a **later isolate invocation without the original callback** — so neither
  `onDone()` nor `onError()` ever fires for that callback. Because the isolate is
  still alive, the RPC promise resolves **cleanly**, and a consumer that keys off the
  clean resolve mis-reads it as success: it finalizes whatever partial it had
  streamed. For the built-in messenger delivery this meant posting a **truncated**
  answer as final, while the real recovered answer was produced later and broadcast
  only to WebSocket connections.

  `StreamCallback` now has an optional `onInterrupted?()` signal, emitted from the
  stall→recovery branches of the RPC stream path instead of returning silently. It
  means "not done, not a terminal error — a continuation owns the final outcome";
  consumers should keep the channel open / show a recovering state / re-attach
  rather than finalizing the partial. It is **optional**, so existing
  `StreamCallback` implementers are unaffected.

  Messenger delivery is wired to it: an interrupted reply now surfaces an
  "interrupted, please retry" message instead of finalizing the truncated partial.

  Note: a deploy/eviction interruption kills the isolate (and the callback) before
  this can fire — the caller observes a transport break instead. `onInterrupted`
  covers the in-isolate stall→recovery path.

- [#1598](https://github.com/cloudflare/agents/pull/1598) [`f5e37bf`](https://github.com/cloudflare/agents/commit/f5e37bfa313634105fd0bdb7912498f9f92b24c6) Thanks [@threepointone](https://github.com/threepointone)! - Add `ThinkWorkflow` with durable `step.prompt()` support for Workflow-owned Think reasoning steps.

- [#1635](https://github.com/cloudflare/agents/pull/1635) [`5995fa8`](https://github.com/cloudflare/agents/commit/5995fa84bf6fc5a115d40d7ed9c6e9ec2e781de7) Thanks [@threepointone](https://github.com/threepointone)! - Add a `repairInterruptedToolPart` hook so subclasses can control how an
  interrupted tool call is repaired during transcript repair ([#1631](https://github.com/cloudflare/agents/issues/1631)).

  Transcript repair flips a tool call with no settled result to an errored
  tool-result (preserving the record and keeping the provider from 400ing). That
  is the right default for server tools, but wrong for client-resolved tools like
  `ask_user` — a question with no server `execute`, answered by the user's next
  message — where the interrupted call _is_ a question and should be preserved as
  text so the model sees normal Q→A conversation and compaction keeps the prompt
  verbatim. Because repair runs (and persists) before `beforeTurn`, a subclass had
  no way to shape this for the current turn.

  `repairInterruptedToolPart(part)` defaults to the existing errored-result
  behavior and runs during repair, so an override (e.g. converting an interrupted
  `ask_user` into a text part carrying the prompt) takes effect on the same turn,
  not just the next one.

- [#1623](https://github.com/cloudflare/agents/pull/1623) [`4c8b371`](https://github.com/cloudflare/agents/commit/4c8b3712b11d2b07298e384e5884844272f4697a) Thanks [@threepointone](https://github.com/threepointone)! - Add an opt-in inactivity watchdog for the streaming read loop, so a hung provider/transport surfaces a terminal error instead of an infinite spinner.

  Previously, if a model stream parked without ever throwing — no chunk, no error, no `done` — the chat read loop would wait forever and the client would spin indefinitely. There was no detection for a silently hung turn (only recovery-path `stable_timeout`, which guards recovery scheduling, not a live stream).

  Set `chatStreamStallTimeoutMs` on a Think subclass to arm it: if no UI-message-stream chunk arrives within that window, the watchdog aborts the turn and the loop exits with a terminal stream error (routed through `onChatError` with `stage: "stream"`), emitting a new `chat:stream:stalled` observability event.

  It is **off by default** (`0`) and applies to both the WebSocket turn loop and the `chat()` / sub-agent callback loop. Note it measures the gap _between_ stream chunks, which includes server-side tool execution time (no chunks flow while a tool runs) — set it comfortably above your slowest model time-to-first-token and slowest tool, or you will abort healthy long turns. A good starting point is `120_000`.

- [#1585](https://github.com/cloudflare/agents/pull/1585) [`8ad724b`](https://github.com/cloudflare/agents/commit/8ad724b1a436398b9e17b8234ca914f2caa4a859) Thanks [@threepointone](https://github.com/threepointone)! - Add declarative scheduled tasks for Think agents with a typed recurring DSL, timezone-aware reconciliation, and durable idempotent submissions.

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

- [#1618](https://github.com/cloudflare/agents/pull/1618) [`e6b6c0b`](https://github.com/cloudflare/agents/commit/e6b6c0b91b55e12e5cf4ced0719938155d845720) Thanks [@threepointone](https://github.com/threepointone)! - Chat continuation no longer fails on models that reject assistant-prefill.
  Continuing a partial assistant turn (e.g. after a deploy interrupts a stream)
  replayed a transcript whose final message was that partial assistant message.
  Modern chat models reject a request ending in an assistant message — Anthropic
  Claude 4.6+ returns a 400 ("This model does not support assistant message
  prefill. The conversation must end with a user message.") — so the continuation
  threw and the turn was left interrupted. Think now appends an ephemeral user
  "continue" checkpoint whenever a model request would otherwise end in an
  assistant message, so continuation works across providers. The checkpoint
  shapes only the model request and is never persisted to the transcript.

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

- [#1629](https://github.com/cloudflare/agents/pull/1629) [`7d38363`](https://github.com/cloudflare/agents/commit/7d383638970622cdde89b2330b1193ec5b91c204) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix server-side `needsApproval` tool continuations remaining stuck after the
  user approves them. Think now keeps approved/denied/errored tool parts in the
  model transcript, updates its live transcript before an immediate continuation,
  and persists and broadcasts terminal tool output emitted for a prior assistant
  message. Continuation response frames are also labelled consistently so
  `useAgentChat` can apply streamed continuation updates to the active UI state.
  A pending `approval-responded` tool is no longer mis-reported by the
  incomplete-tool-call backstop, so approval continuations stop logging a false
  "repair gap" warning and emitting a spurious `chat:transcript:repaired` event.

  The cross-message tool result now flows through `StreamAccumulator`'s
  `cross-message-tool-update` action and a shared, replay-safe
  `crossMessageToolResultUpdate` builder (exported from `agents/chat`): it matches
  terminal states for first-write-wins idempotency against provider replays (e.g.
  the OpenAI Responses API, [#1404](https://github.com/cloudflare/agents/issues/1404)), preserves a streamed `preliminary` flag, and
  lets `Think` skip redundant writes/broadcasts when a result is already settled.

- [#1601](https://github.com/cloudflare/agents/pull/1601) [`0fb0acf`](https://github.com/cloudflare/agents/commit/0fb0acf818d2d45543bc49998c1aee30db578d53) Thanks [@threepointone](https://github.com/threepointone)! - Require fixed StreamCallback RPC handlers so sub-agent chat callbacks do not probe missing remote methods.

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

- [#1621](https://github.com/cloudflare/agents/pull/1621) [`fac4463`](https://github.com/cloudflare/agents/commit/fac44632a26530412dd2457164fa58140b9bef48) Thanks [@threepointone](https://github.com/threepointone)! - Settled tool results are now flushed to durable storage immediately during a
  chat turn, so recovery never re-runs an already-completed (often non-idempotent)
  tool call. Stream chunks are batched in memory and flushed to SQLite every ~10
  chunks; the WebSocket chat path did not force a flush on settled tool results,
  so an isolate eviction (deploy) before the next batch flush lost them. Recovery
  then rebuilt the partial assistant message without those tool calls and the
  model re-ran them (e.g. duplicate INSERTs). The sub-agent RPC streaming path
  already flushed recoverable content; this brings the WebSocket path to parity
  via a shared `_storeChunkDurably` helper that flushes immediately on
  `tool-output-available` / `tool-output-error`. Net effect: recovery loses at
  most the single in-flight step, even when multiple evictions hit one turn.

  Also closes two remaining "frozen turn" hydration gaps from the terminal-status
  work: a turn that fails before the stream starts (e.g. a message reconciliation
  error in `_handleChatRequest`) now records its terminal status, and a recovery
  skip caused by `onChatRecovery` returning `{ continue: false }` now surfaces a
  terminal error too. Both were previously broadcast (or silent) but not persisted,
  so a client disconnected at that moment stayed frozen on reconnect. Benign skips
  such as `conversation_changed` (a newer turn already owns the UI) remain silent.

- [#1623](https://github.com/cloudflare/agents/pull/1623) [`4c8b371`](https://github.com/cloudflare/agents/commit/4c8b3712b11d2b07298e384e5884844272f4697a) Thanks [@threepointone](https://github.com/threepointone)! - Transcript repair now preserves an interrupted/abandoned tool call as an errored result instead of deleting it.

  Previously, a tool call with no recorded output (e.g. a tool interrupted mid-execution by a deploy, or an `ask_user` answered by the user's next message) was **removed** from the durable transcript before the next turn. That made the call visibly "disappear" from the broadcast transcript and let the model silently **re-run** it (duplicating non-idempotent side effects).

  It is now flipped to `state: "output-error"` with an explanatory message, so:
  - the user-visible record survives (no disappearing tool calls),
  - the model sees the tool errored rather than re-running it blind, and
  - the provider still receives a valid tool-result (no `AI_MissingToolResultsError`).

  Malformed tool `input`s are normalized in the same pass: a stringified-JSON `input` is parsed back into an object, and a missing/`null` `input` on a settled or interrupted tool call is defaulted to `{}` (Anthropic rejects a `tool_use` block whose `input` is absent).

  As a last-line backstop, `convertToModelMessages` is now called with `ignoreIncompleteToolCalls: true`, so any incomplete tool call that still slips past the repair (compaction edges, `addToolOutput` races, unrecognized part shapes) is dropped at conversion rather than 400ing the provider.

  Repair recognizes all of the AI SDK's settled terminal tool states — `output-available`, `output-error`, and `output-denied` (a user-denied approval) — via a single shared predicate, so a tool call that already has a provider-acceptable result is never re-flipped into a generic errored result. Previously `output-error` was re-flipped on every turn (clobbering a real `errorText` with the generic "interrupted" message and emitting spurious `chat:transcript:repaired` events/writes/broadcasts for the life of the conversation), and `output-denied` was converted into an errored result that lost the denial. A denied tool result is also now flushed to durable storage immediately (like other settled results) so it survives an eviction.

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

- [#1619](https://github.com/cloudflare/agents/pull/1619) [`6d1a8f9`](https://github.com/cloudflare/agents/commit/6d1a8f9d89f7df2919d70d611c97d2e0bbf3f3d9) Thanks [@threepointone](https://github.com/threepointone)! - Interrupted/failed chat turns are no longer silently "frozen" for clients that
  reconnect after the failure. The terminal `MSG_CHAT_RESPONSE` broadcast (on a
  turn error or exhausted recovery) is transient — a client disconnected at that
  moment (e.g. during a deploy / WebSocket reconnect storm) misses it, and on
  reconnect `onConnect` previously replayed only the current messages with no
  terminal signal, so the turn appeared stuck with no completed response and no
  error. Think now persists a durable record of the last terminal turn and
  replays it on connect, so a reconnecting client learns the turn failed. The
  record is cleared when a later turn completes; benign recovery skips (e.g.
  `conversation_changed`, where a newer turn owns the UI) are intentionally not
  surfaced.

- [#1640](https://github.com/cloudflare/agents/pull/1640) [`edb126a`](https://github.com/cloudflare/agents/commit/edb126a72d1a6b52fa0057191d6d461ee902e914) Thanks [@threepointone](https://github.com/threepointone)! - Re-attach to a still-running sub-agent (`agentTool()`) run on parent recovery instead of abandoning and re-running it ([#1630](https://github.com/cloudflare/agents/issues/1630)).

  When a parent agent was interrupted (deploy / Durable Object eviction) while a child `agentTool()` run was still in flight, recovery marked the run `interrupted` within a ~5s window and the parent re-issued the task — re-running the child's already-completed work. For long-running children under continuous deploys this surfaced to users as "the agent went all the way back and lost the files it already wrote."

  Three changes fix this:
  - **Stable child runId.** `agentTool()` now derives the child `runId` from the (recovery-preserved) tool call id (`agent-tool:<toolCallId>`) instead of minting a fresh `nanoid` per call. A turn re-run by chat recovery now resolves to the **same** idempotent child facet rather than spawning a brand-new one, so completed child work is never re-run.
  - **Bounded re-attach.** A duplicate non-terminal `runId` (in `runAgentTool`) and a still-running child during startup reconciliation now **tail the live child to its real terminal result** and collect it, instead of immediately sealing `interrupted`. Re-attach is bounded by a generous wall-clock budget (`DEFAULT_AGENT_TOOL_REATTACH_TIMEOUT_MS`, 120s, internal): a child that keeps advancing toward terminal within the window is collected; a genuinely hung child still seals `interrupted` so recovery can never block forever.
  - **Durable child-run reconcile.** A child facet self-heals its interrupted turn via its own `chatRecovery`, but that recovery path never wrote the child's agent-tool run row — so after a real eviction the row stranded `running` (think) / was force-errored (ai-chat) and the parent could never collect the recovered result. Both `@cloudflare/think` and `@cloudflare/ai-chat` now reconcile a stale child-run row from the durable transcript on inspect: while recovery is still resolving the row stays `running`; once it settles, a completed assistant response surfaces as `completed` (so the parent collects the real result) and an empty/failed recovery as `error`. This keeps the child's own (working) recovery path untouched.

  No new public configuration. Adds an internal `agent_tool:recovery:reattach` observability event. `@cloudflare/think` and `@cloudflare/ai-chat` child tails are now read-only on consumer detach (a parent's re-attach budget expiring never cancels the still-running child).

## 0.7.3

### Patch Changes

- [#1559](https://github.com/cloudflare/agents/pull/1559) [`f942ffe`](https://github.com/cloudflare/agents/commit/f942ffe4113bdf074942cc32c2c69922ef633502) Thanks [@cjol](https://github.com/cjol)! - Stash chat turn recovery metadata before inference starts so interrupted pre-stream turns can be reconciled by chat recovery. Pre-stream interruptions now automatically retry the existing unanswered user message when it is still safe to do so.

- [#1567](https://github.com/cloudflare/agents/pull/1567) [`3cfa498`](https://github.com/cloudflare/agents/commit/3cfa49878c3ff8495f7f2b1b059a04440449bf7b) Thanks [@cjol](https://github.com/cjol)! - Return error statuses for in-band stream errors across programmatic chat turns.

## 0.7.2

### Patch Changes

- [#1570](https://github.com/cloudflare/agents/pull/1570) [`4f14b9c`](https://github.com/cloudflare/agents/commit/4f14b9c7d16c3fe76268b053c2c3bde3b308915c) Thanks [@threepointone](https://github.com/threepointone)! - Broadcast message updates from programmatic `Think.chat()` turns and `clearMessages()` so connected `useAgentChat` clients stay in sync without reconnecting.

## 0.7.1

### Patch Changes

- [#1561](https://github.com/cloudflare/agents/pull/1561) [`831ba1d`](https://github.com/cloudflare/agents/commit/831ba1d20d76c35c9de6ff1799c5f103256dee31) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Expose additive `TurnConfig.stopWhen` conditions so Think subclasses can end an agentic loop early, for example after a designated tool call, while retaining the existing `maxSteps` safety bound.

- [#1563](https://github.com/cloudflare/agents/pull/1563) [`32cde40`](https://github.com/cloudflare/agents/commit/32cde406b3ab022ec83707863c42f22c741527d8) Thanks [@threepointone](https://github.com/threepointone)! - Add RPC-safe cancellation for `chat()` turns with `StreamCallback.onStart()` and `cancelChat()`.

## 0.7.0

### Minor Changes

- [#1297](https://github.com/cloudflare/agents/pull/1297) [`d151e6d`](https://github.com/cloudflare/agents/commit/d151e6d6ccd37820c37d5fd4208a531fd8144950) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Add experimental Postgres-backed session, context, and search providers for external session storage via Hyperdrive-compatible `pg` clients.

  Session APIs now consistently return promises so callers can use the same surface with local SQLite or external storage providers. Think's session integration has been updated for the async session API, including cache-aware handling for idempotent appends and compaction overlays.

## 0.6.1

### Patch Changes

- [#1520](https://github.com/cloudflare/agents/pull/1520) [`f9c68e8`](https://github.com/cloudflare/agents/commit/f9c68e8d04184939714578e70cf1bfa739ae8840) Thanks [@threepointone](https://github.com/threepointone)! - Improve Think's default system prompt and append a turn-specific capability block based on the tools exposed to the model.

## 0.6.0

### Minor Changes

- [#1456](https://github.com/cloudflare/agents/pull/1456) [`787e73d`](https://github.com/cloudflare/agents/commit/787e73dbc6bdee3aee5f44099a1bc64f119c934f) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Stop applying `pruneMessages({ toolCalls: "before-last-2-messages" })` to the model context by default. The previous default silently stripped client-side tool results (no `execute`, output supplied via `addToolOutput`) from any turn beyond the second, breaking multi-turn flows where the user's choices live in those tool results (see [#1455](https://github.com/cloudflare/agents/issues/1455)). `truncateOlderMessages` still runs as before, so context cost stays bounded.

  This is a behavior change. Subclasses that relied on the old aggressive pruning can opt back in from `beforeTurn`:

  ```typescript
  import { pruneMessages } from "ai";

  beforeTurn(ctx) {
    return {
      messages: pruneMessages({
        messages: ctx.messages,
        toolCalls: "before-last-2-messages"
      })
    };
  }
  ```

- [#1517](https://github.com/cloudflare/agents/pull/1517) [`449b421`](https://github.com/cloudflare/agents/commit/449b4216038e57ef3dcfd4a27e5f617deebcf6f3) Thanks [@threepointone](https://github.com/threepointone)! - Wrap `Think.chat()` RPC turns in chat recovery fibers and persist their stream chunks so interrupted sub-agent turns can recover partial output. `ChatOptions.tools` has been removed from the TypeScript API; runtime `options.tools` values passed by legacy callers are ignored with a warning. Define durable tools on the child agent or use agent tools for orchestration.

- [#1511](https://github.com/cloudflare/agents/pull/1511) [`bf3860c`](https://github.com/cloudflare/agents/commit/bf3860c20412b70a4c5c3d514d9ad62f41bb4e80) Thanks [@threepointone](https://github.com/threepointone)! - Add durable programmatic submissions for Think. `submitMessages()` now provides fast durable acceptance, idempotent retries, status inspection, cancellation, and cleanup for server-driven turns that should continue after the caller returns.

### Patch Changes

- [#1500](https://github.com/cloudflare/agents/pull/1500) [`7090e9e`](https://github.com/cloudflare/agents/commit/7090e9eec337ae1496afce1a544044d9c765a021) Thanks [@threepointone](https://github.com/threepointone)! - Preserve structured tool output shapes when truncating older messages or oversized persisted rows, preventing custom `toModelOutput` handlers from crashing or mis-replaying compacted results.

  Also harden Think's workspace `read` tool so legacy raw-string read outputs replay as text instead of stalling subsequent turns.

- [#1483](https://github.com/cloudflare/agents/pull/1483) [`5373f5c`](https://github.com/cloudflare/agents/commit/5373f5ca246e756c8c36df915380fbc5319c5162) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Allow Think agent-tool children to complete without emitting assistant text. Non-chat tool-step agents can now provide structured output through `getAgentToolOutput`, with summaries derived from assistant text, string output, structured output, or an empty string.

  Fix `useAgentChat().isServerStreaming` cleanup when a resumed stream first enters the fallback observer path and later becomes transport-owned.

- [#1463](https://github.com/cloudflare/agents/pull/1463) [`ab2b1db`](https://github.com/cloudflare/agents/commit/ab2b1db31971ac2d2ddab9d962986f208c69a422) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Avoid throwing when chat stream resume negotiation/replay races with a closed WebSocket connection. Resume protocol sends and the `_handleStreamResumeAck` fallback now go through `sendIfOpen` helpers that swallow the `TypeError: WebSocket send() after close` race instead of letting it propagate up through `onMessage`.

## 0.5.3

### Patch Changes

- [#1447](https://github.com/cloudflare/agents/pull/1447) [`c7998b2`](https://github.com/cloudflare/agents/commit/c7998b29e54d0a865550c322c76f0ce5d68181ab) Thanks [@threepointone](https://github.com/threepointone)! - Expose stable AI SDK `streamText` call settings on Think `TurnConfig`, including `timeout` and `maxRetries`, so `beforeTurn` can tune generation behavior per turn.

## 0.5.2

### Patch Changes

- [`2fffa02`](https://github.com/cloudflare/agents/commit/2fffa0201c96f6d2a395c74a843c3c25afcd53a6) Thanks [@threepointone](https://github.com/threepointone)! - Raise the minimum internal peer dependency versions for Agents chat packages so `agents`, `@cloudflare/ai-chat`, and `@cloudflare/think` require versions at least as recent as the current repo packages.

## 0.5.1

### Patch Changes

- [#1443](https://github.com/cloudflare/agents/pull/1443) [`e7d225b`](https://github.com/cloudflare/agents/commit/e7d225b72a743a2cf1491ebf73f06580c668e560) Thanks [@threepointone](https://github.com/threepointone)! - Fix sub-agent WebSockets on deployed Workers by keeping the browser WebSocket owned by the parent Agent and forwarding connect/message/close events to child facets over RPC.

  Fix resumed chat streams so a partially hydrated assistant response is rebuilt from replay chunks instead of rendering replayed text as a second assistant text part.

  Fix a resume ACK race where drill-in chat connections could miss the terminal stream frame if the helper completed between the resume notification and client acknowledgement.

- [#1435](https://github.com/cloudflare/agents/pull/1435) [`b197faf`](https://github.com/cloudflare/agents/commit/b197faf0ca79d9e921d2f80c5fcafe4899995d11) Thanks [@threepointone](https://github.com/threepointone)! - Add multimodal-aware workspace reads for images and PDFs while keeping persisted tool results compact.

## 0.5.0

### Minor Changes

- [#1421](https://github.com/cloudflare/agents/pull/1421) [`1b65ff5`](https://github.com/cloudflare/agents/commit/1b65ff5550f904e2a59bd6015703f82b02f85e4f) Thanks [@threepointone](https://github.com/threepointone)! - Add agent tool orchestration for running Think and AIChatAgent sub-agents as
  retained, streaming tools from a parent agent. The new surface includes
  `runAgentTool`, `agentTool`, parent-side run replay and cleanup, Think and
  AIChatAgent child adapter support, and headless React/client event state
  helpers.

### Patch Changes

- [#1424](https://github.com/cloudflare/agents/pull/1424) [`58ca2fc`](https://github.com/cloudflare/agents/commit/58ca2fc1edda0f8a91ddce853014f8a7c8662f64) Thanks [@threepointone](https://github.com/threepointone)! - Add `sendReasoning` controls to Think. Subclasses can set an instance-wide default, and `beforeTurn` can return a per-turn override to include or suppress reasoning chunks in UI message streams.

- [#1423](https://github.com/cloudflare/agents/pull/1423) [`0ed42a9`](https://github.com/cloudflare/agents/commit/0ed42a908ed28181d12dfaa9c97e182e831d0218) Thanks [@threepointone](https://github.com/threepointone)! - Forward `TurnConfig.experimental_telemetry` to Think's internal AI SDK
  `streamText()` call so applications can configure per-turn LLM observability.

## 0.4.2

### Patch Changes

- [`ca510d4`](https://github.com/cloudflare/agents/commit/ca510d4fecbecb07d0d3cdad7d78c32cc226275e) Thanks [@threepointone](https://github.com/threepointone)! - Tighten internal peer dependency floors to reflect the current monorepo set we actually test against: `agents` (`>=0.8.7` → `>=0.11.7`), `@cloudflare/codemode` (`>=0.0.7` → `>=0.3.4`), and `@cloudflare/shell` (`>=0.2.0` → `>=0.3.4`). Upper bounds (`<1.0.0`) are unchanged.

  No runtime change in `@cloudflare/think` itself. The visible effect for consumers: pairing the latest `@cloudflare/think` with a stale `agents` (`<0.11.7`), `@cloudflare/codemode` (`<0.3.4`), or `@cloudflare/shell` (`<0.3.4`) now produces a peer warning where it previously did not. That's the intended signal — those older combinations are no longer tested in the monorepo.

- [#1411](https://github.com/cloudflare/agents/pull/1411) [`2fa68be`](https://github.com/cloudflare/agents/commit/2fa68bea891e1bd8f30839586c2519627f364b0c) Thanks [@threepointone](https://github.com/threepointone)! - Add `options.signal` to `Think.saveMessages` and `Think.continueLastTurn` for external cancellation of programmatic turns, plus protected `abortRequest(id)` / `abortAllRequests()` methods to replace bracket access into the private `_aborts` registry ([#1406](https://github.com/cloudflare/agents/issues/1406)).

  `saveMessages` and `continueLastTurn` accept a second `SaveMessagesOptions` argument:

  ```typescript
  const result = await this.saveMessages(messages, {
    signal: controller.signal
  });
  if (result.status === "aborted") {
    // Inference loop terminated mid-stream; partial chunks persisted.
  }
  ```

  The signal is linked to Think's per-turn `AbortController` for the duration of the call. When it aborts:
  - the inference loop's signal aborts (the same path `chat-request-cancel` takes);
  - partial chunks already streamed are persisted to the resumable stream;
  - `saveMessages` resolves with `{ status: "aborted" }`;
  - `onChatResponse` fires with `status: "aborted"`.

  Pre-aborted signals short-circuit before any model work runs. Listeners are detached cleanly when the turn finishes, so passing the same long-lived `AbortSignal` to many turns (e.g. a parent chat-turn signal driving multiple sub-agent calls) is safe and leak-free.

  `abortRequest(id, reason?)` and `abortAllRequests()` are protected entry points for DO subclasses (e.g. RPC-driven helpers) that want to cancel turns without tracking ids — they replace the historical `(this as unknown as { _aborts: ... })._aborts.destroyAll()` workaround used by helper-as-sub-agent implementations.

  `SaveMessagesResult.status` now includes `"aborted"` alongside `"completed"` and `"skipped"`. Existing callers that only switch on `"completed"` are unaffected.

  **Limitations.**
  - `AbortSignal` cannot cross Durable Object RPC. Construct the controller inside the DO that calls `saveMessages`. To bridge a parent's intent into a child DO, return a `ReadableStream` from the child whose `cancel` callback aborts a per-turn controller — `examples/agents-as-tools` shows the canonical pattern.
  - The signal lives in memory only. If the DO hibernates mid-turn and `chatRecovery` is enabled, the recovered turn calls `continueLastTurn()` internally without the original signal — an abort fired after restart has no effect on the recovered turn.

  See [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406) for the motivating use case.

## 0.4.1

### Patch Changes

- [#1395](https://github.com/cloudflare/agents/pull/1395) [`63cfae6`](https://github.com/cloudflare/agents/commit/63cfae6345c5ddc54df5e2f78a19097b9b5462ff) Thanks [@threepointone](https://github.com/threepointone)! - Share submit concurrency bookkeeping through `agents/chat` and use it from both chat agents.

  This extracts the `latest`/`merge`/`drop`/`debounce` admission state machine into a `SubmitConcurrencyController` exported from `agents/chat`. `AIChatAgent` semantics (including merge persistence) are preserved. `Think` now picks up the same pending-enqueue protection, so an overlapping submit is still detected while an accepted request is between admission and turn queue registration.

  Additional fixes:
  - `Think` now captures the turn generation immediately after admission and threads it into `_turnQueue.enqueue`, so a clear that lands between admission and queue registration cannot run a stale turn.
  - Pending-enqueue tracking is now bound to a release function tied to the controller's reset epoch, so a release from a pre-reset submit can no longer erase a post-reset submit's marker and let a third submit slip through as non-overlapping.
  - Debounce cancellation correctly resolves all in-flight waiters instead of overwriting a single timer slot.

- [#1394](https://github.com/cloudflare/agents/pull/1394) [`a0a0d17`](https://github.com/cloudflare/agents/commit/a0a0d179a862547715b0dd2e38d37065f24eabe5) Thanks [@threepointone](https://github.com/threepointone)! - think: add `beforeStep` lifecycle hook and `output` passthrough on `TurnConfig`.
  - **`beforeStep(ctx)`** — new lifecycle hook called before each AI SDK step in the agentic loop, wired to `streamText({ prepareStep })`. Receives a `PrepareStepContext` (the AI SDK's `PrepareStepFunction` parameter — `steps`, `stepNumber`, `model`, `messages`, `experimental_context`) and may return a `StepConfig` (`PrepareStepResult`) to override `model`, `toolChoice`, `activeTools`, `system`, `messages`, `experimental_context`, or `providerOptions` for the current step. Use `beforeTurn` for turn-wide assembly and `beforeStep` when the decision depends on the step number or previous step results. Resolves [#1363](https://github.com/cloudflare/agents/issues/1363).
  - **`TurnConfig.output`** — new optional field on `TurnConfig` forwarded to `streamText`. Accepts the AI SDK's structured-output spec (e.g. `Output.object({ schema })`, `Output.text()`) so a single agent can keep tools enabled on intermediate turns and return schema-validated structured output on a designated turn — without losing tools at model construction. Combine with `activeTools: []` for providers that strip tools when `responseFormat: "json"` is active (e.g. `workers-ai-provider`). Resolves [#1383](https://github.com/cloudflare/agents/issues/1383).
  - New re-exports from `@cloudflare/think`: `PrepareStepFunction`, `PrepareStepResult`, `PrepareStepContext`, `StepConfig`.

  `beforeStep` is available to subclasses; it is not dispatched to extensions (the AI SDK `prepareStep` boundary surfaces non-serializable inputs like `LanguageModel` instances). The AI SDK does not expose `output` or `maxSteps` per step — set those at the turn level via `TurnConfig`. All other extension hook subscriptions are unchanged.

- [#1372](https://github.com/cloudflare/agents/pull/1372) [`040da0f`](https://github.com/cloudflare/agents/commit/040da0fae4bbbcc5d3f412f68441674e84207c8c) Thanks [@threepointone](https://github.com/threepointone)! - Remove Think's unused internal `session_id` config scaffolding and move Think's private config into a dedicated `think_config` table.

  Older builds wrote Think-owned config into Session's shared `assistant_config(session_id, key, value)` table even though Think never actually had top-level multi-session support and `_sessionId()` always returned the empty string. Think now stores its private config rows in `think_config(key, value)`, which better matches the shipped model of one Think Durable Object per conversation and avoids overloading Session's shared metadata table.

  Existing Durable Objects are migrated automatically on startup: legacy Think-owned keys stored in `assistant_config` with `session_id = ''` are copied into `think_config` before config reads and writes continue.

- [#1396](https://github.com/cloudflare/agents/pull/1396) [`fdf5a8a`](https://github.com/cloudflare/agents/commit/fdf5a8a99ec1a88ce9096ddec3a9fb2adf6fd4b1) Thanks [@threepointone](https://github.com/threepointone)! - Fix Think persisting a duplicate orphan assistant row when a user submits during a streaming tool turn ([#1381](https://github.com/cloudflare/agents/issues/1381)).

  When `useAgentChat` posts an in-flight assistant snapshot it minted optimistically (client-generated ID, `state: "input-available"`), Session's INSERT-OR-IGNORE-by-ID would store it as a separate row alongside the eventual server-owned assistant for the same `toolCallId`. The next turn's `convertToModelMessages` then produced a malformed Anthropic prompt and the provider rejected it.

  `reconcileMessages` and `resolveToolMergeId` now live in `agents/chat` and Think runs them in `_handleChatRequest` before persistence. Stale `input-available` snapshots pick up the server's tool output via `mergeServerToolOutputs`, and any incoming assistant whose `toolCallId` already exists on a server row adopts the server's ID so persistence updates the existing row instead of inserting an orphan.

  `@cloudflare/ai-chat` keeps its existing reconciler behavior; the only change is that it now imports `reconcileMessages` / `resolveToolMergeId` from `agents/chat` instead of a local file.

- [#1374](https://github.com/cloudflare/agents/pull/1374) [`a6e22c3`](https://github.com/cloudflare/agents/commit/a6e22c362668fc295208d0718eae4cf2aa3f792a) Thanks [@threepointone](https://github.com/threepointone)! - Fix stream resumption on page refresh: do not broadcast `cf_agent_chat_messages` from Think's `onConnect` while a resumable stream is in flight.

  Previously, Think unconditionally sent a `cf_agent_chat_messages` frame on every new WebSocket connection. When a client refreshed during an active chat turn, that broadcast arrived in the same connect sequence as `cf_agent_stream_resuming` and overwrote the in-progress assistant message the client was about to rebuild from the resumed stream. The assistant reply would stay hidden until the server finished the turn and re-broadcast the persisted history.

  Now Think only broadcasts `cf_agent_chat_messages` on connect when there is no active resumable stream. During an active stream the resume flow is the authoritative source of state: `STREAM_RESUMING` triggers replay of buffered chunks, and the final state broadcast happens when the turn completes. This matches the behavior that `AIChatAgent` already had.

  Marked the internal `_resumableStream` field as `protected` (previously `private`) so framework subclasses and focused tests can coordinate around the resume lifecycle.

- [#1384](https://github.com/cloudflare/agents/pull/1384) [`a7059d4`](https://github.com/cloudflare/agents/commit/a7059d4a5a1071a10c60be0e777968fc7ff5d36c) Thanks [@threepointone](https://github.com/threepointone)! - Introduce `WorkspaceLike` — type the `this.workspace` field as the minimum surface Think actually uses instead of the concrete `Workspace` class.

  `Think`'s `workspace` is now typed as `WorkspaceLike` (`Pick<Workspace, "readFile" | "writeFile" | "readDir" | "rm" | "glob" | "mkdir" | "stat">`) rather than `Workspace`. `createWorkspaceTools()` likewise accepts any `WorkspaceLike`. The default runtime value is unchanged — a full `Workspace` backed by the DO's SQLite — so the vast majority of consumers need no changes.

  This unlocks patterns like a shared workspace across multiple agents: a child agent can override `workspace` with a proxy that forwards each call to a parent DO via RPC, and the rest of Think's workspace-aware code (the builtin tools, lifecycle hooks) keeps working without cast gymnastics. See `examples/assistant` for the cross-chat shared workspace built on this.

  Consumers who use `createWorkspaceStateBackend(workspace)` from `@cloudflare/shell` (codemode's `state.*` API) still need a concrete `Workspace` — that helper reaches for more of the filesystem surface than `WorkspaceLike` covers.

## 0.4.0

### Minor Changes

- [#1350](https://github.com/cloudflare/agents/pull/1350) [`3a1140f`](https://github.com/cloudflare/agents/commit/3a1140fa561fdff5d1925f0c2b3b7436af8b483f) Thanks [@threepointone](https://github.com/threepointone)! - Align `Think` generics with `Agent` / `AIChatAgent`.

  `Think` is now `Think<Env, State, Props>` and extends `Agent<Env, State, Props>`, so subclasses get properly typed `this.state`, `this.setState()`, `initialState`, and `this.ctx.props`. The previous `Config` class generic is removed.

  `configure()` and `getConfig()` remain, but the config type is now specified at the call site via a method-level generic:

  ```ts
  // Before
  export class MyAgent extends Think<Env, MyConfig> {
    getModel() {
      const tier = this.getConfig()?.modelTier ?? "fast";
      // ...
    }
  }

  // After
  export class MyAgent extends Think<Env> {
    getModel() {
      const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
      // ...
    }
  }
  ```

  This is a breaking change for anyone using the second type parameter of `Think`. Update the class declaration and any direct `configure(...)` / `getConfig()` call sites that relied on the class-level `Config` type.

## 0.3.0

### Minor Changes

- [#1340](https://github.com/cloudflare/agents/pull/1340) [`3cbe776`](https://github.com/cloudflare/agents/commit/3cbe77668df356906244db6a75c4cfba2daa1836) Thanks [@threepointone](https://github.com/threepointone)! - Align Think lifecycle hooks with the AI SDK and fix latent bugs around tool-call hooks and extension dispatch.

  **Lifecycle hook context types are now derived from the AI SDK** (resolves [#1339](https://github.com/cloudflare/agents/issues/1339)). `StepContext`, `ChunkContext`, `ToolCallContext`, and `ToolCallResultContext` are derived from `StepResult`, `TextStreamPart`, and `TypedToolCall` so users get full typed access to `reasoning`, `sources`, `files`, `providerMetadata` (where Anthropic cache tokens live), `request`/`response`, etc., instead of `unknown`. The relevant AI SDK types are re-exported from `@cloudflare/think`.

  **`beforeToolCall` / `afterToolCall` now fire with correct timing.** `beforeToolCall` runs **before** the tool's `execute` (Think wraps every tool's `execute`), and `afterToolCall` runs **after** with `durationMs` and a discriminated `success`/`output`/`error` outcome (backed by `experimental_onToolCallFinish`).

  **`ToolCallDecision` is now functional.** Returning `{ action: "block", reason }`, `{ action: "substitute", output }`, or `{ action: "allow", input }` from `beforeToolCall` actually intercepts execution.

  **Extension hook dispatch.** `ExtensionManifest.hooks` claimed support for `beforeToolCall`/`afterToolCall`/`onStepFinish`/`onChunk` but Think only ever dispatched `beforeTurn`. All five hooks now dispatch to subscribed extensions with JSON-safe snapshots. Extension hook handlers also receive `(snapshot, host)` (symmetric with tool `execute`); previously only tool executes got the host bridge.

  **Breaking renames** (per AI SDK conventions): `ToolCallContext.args` → `input`, `ToolCallResultContext.args` → `input`, `ToolCallResultContext.result` → `output`. `afterToolCall` is now a discriminated union — read `output` only when `ctx.success === true`, and `error` when `ctx.success === false`. Equivalent renames on `ToolCallDecision`.

  See [docs/think/lifecycle-hooks.md](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md) for the full hook reference.

### Patch Changes

- [#1340](https://github.com/cloudflare/agents/pull/1340) [`3cbe776`](https://github.com/cloudflare/agents/commit/3cbe77668df356906244db6a75c4cfba2daa1836) Thanks [@threepointone](https://github.com/threepointone)! - Fix `_wrapToolsWithDecision` to `await originalExecute(...)` before checking for `Symbol.asyncIterator`. The previous code missed `Promise<AsyncIterable>` returns from plain async functions (`async function execute(...) { return makeIter(); }`) — `Symbol.asyncIterator in promise` is always false, the collapse logic was skipped, and the AI SDK ended up treating the iterator instance itself as the final output value (which the wrapper's own comment warned about). Both sync-returned-iterable and async-returned-iterable cases are now covered, with regression tests for each.

## 0.2.5

### Patch Changes

- [#1330](https://github.com/cloudflare/agents/pull/1330) [`b4d3fcf`](https://github.com/cloudflare/agents/commit/b4d3fcfcce7363b137ad47c31d40aebcb34d9a28) Thanks [@threepointone](https://github.com/threepointone)! - Fix `subAgent()` cross-DO I/O errors on first use and drop the `"experimental"` compatibility flag requirement.

  ### `subAgent()` cross-DO I/O fix

  Three issues in the facet initialization path caused `"Cannot perform I/O on behalf of a different Durable Object"` errors when spawning sub-agents in production:
  - `subAgent()` constructed a `Request` in the parent DO and passed it to the child via `stub.fetch()`. The `Request` carried native I/O tied to the parent isolate, which the child rejected.
  - The facet flag was set _after_ the first `onStart()` ran, so `broadcastMcpServers()` fired with `_isFacet === false` on the initial boot.
  - `_broadcastProtocol()`, the inherited `broadcast()`, and `_workflow_broadcast()` iterated the connection registry without an `_isFacet` guard, letting broadcasts reach into the parent DO's WebSocket registry from a child isolate.

  Replaces the fetch-based handshake with a new `_cf_initAsFacet(name)` RPC that runs entirely in the child isolate, sets `_isFacet` before init, and seeds partyserver's `__ps_name` key directly. Adds `_isFacet` guards to `_broadcastProtocol()` and overrides `broadcast()` to no-op on facets so downstream callers (chat-streaming paths, workflow broadcasts, user `this.broadcast(...)`) are covered. Removes the previous internal `_cf_markAsFacet()` method — `_cf_initAsFacet(name)` is the correct entry point (it sets the flag before running the first `onStart()`, which `_cf_markAsFacet` did not).

  ### `"experimental"` compatibility flag no longer required

  `ctx.facets`, `ctx.exports`, and `env.LOADER` (Worker Loader) have graduated out of the `"experimental"` compatibility flag in workerd. `agents` and `@cloudflare/think` no longer require it:
  - `subAgent()` / `abortSubAgent()` / `deleteSubAgent()` — the `@experimental` JSDoc tag and runtime error messages no longer reference the flag. The runtime guards on `ctx.facets` / `ctx.exports` stay in place and now nudge users toward updating `compatibility_date` instead.
  - `Think` — the `@experimental` JSDoc tag no longer references the flag.

  No code change is required; remove `"experimental"` from your `compatibility_flags` in `wrangler.jsonc` if it was only there for these features.

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

## 0.2.4

### Patch Changes

- [#1314](https://github.com/cloudflare/agents/pull/1314) [`61309f7`](https://github.com/cloudflare/agents/commit/61309f71438482a3e42b37a5a981975e4963af06) Thanks [@threepointone](https://github.com/threepointone)! - Enable `chatRecovery` by default — chat turns are now wrapped in `runFiber` for durable execution out of the box.

## 0.2.3

### Patch Changes

- [#1310](https://github.com/cloudflare/agents/pull/1310) [`bd0346e`](https://github.com/cloudflare/agents/commit/bd0346ec05406e258b3c8904874c7a8c0f4608e5) Thanks [@threepointone](https://github.com/threepointone)! - Fix `getConfig()` throwing "no such table: assistant_config" when called inside `configureSession()`

  The config storage helpers (`getConfig`, `configure`) now lazily ensure the `assistant_config` table exists before querying it, so they are safe to call at any point in the agent lifecycle — including during `configureSession()`.

- [#1312](https://github.com/cloudflare/agents/pull/1312) [`89773d1`](https://github.com/cloudflare/agents/commit/89773d12c391a472ba3d45c88b83c98ba7455947) Thanks [@threepointone](https://github.com/threepointone)! - Rename `unstable_chatRecovery` to `chatRecovery` — the feature is now stable.

## 0.2.2

### Patch Changes

- [#1163](https://github.com/cloudflare/agents/pull/1163) [`d3f757c`](https://github.com/cloudflare/agents/commit/d3f757c264f6271cb34863daaad0e381e40e6a6f) Thanks [@threepointone](https://github.com/threepointone)! - Add first-class browser tools (`@cloudflare/think/tools/browser`) for CDP-based web automation, matching the execution ladder alongside workspace, execute, and extensions.

## 0.2.1

### Patch Changes

- [#1275](https://github.com/cloudflare/agents/pull/1275) [`37b2ce3`](https://github.com/cloudflare/agents/commit/37b2ce37913566ce81d30377d5cb5b224765a3f3) Thanks [@threepointone](https://github.com/threepointone)! - Add built-in workspace to Think. Every Think instance now has `this.workspace` backed by the DO's SQLite storage, and workspace tools (read, write, edit, list, find, grep, delete) are automatically merged into every chat turn. Override `workspace` to add R2 spillover for large files. `@cloudflare/shell` is now a required peer dependency.

- [#1278](https://github.com/cloudflare/agents/pull/1278) [`8c7caab`](https://github.com/cloudflare/agents/commit/8c7caabb68361c8ce71b10e292d6dd33a9cc72dd) Thanks [@threepointone](https://github.com/threepointone)! - Think now owns the inference loop with lifecycle hooks at every stage.

  **Breaking:** `onChatMessage()`, `assembleContext()`, and `getMaxSteps()` are removed. Use lifecycle hooks and the `maxSteps` property instead. If you need full custom inference, extend `Agent` directly.

  **New lifecycle hooks:** `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk` — fire on every turn from all entry paths (WebSocket, `chat()`, `saveMessages`, auto-continuation).

  **`beforeTurn(ctx)`** receives the assembled system prompt, messages, tools, and model. Return a `TurnConfig` to override any part — model, system prompt, messages, tools, activeTools, toolChoice, maxSteps, providerOptions.

  **`maxSteps`** is now a property (default 10) instead of a method. Override per-turn via `TurnConfig.maxSteps`.

  **MCP tools auto-merged** — no need to manually merge `this.mcp.getAITools()` in `getTools()`.

  **Dynamic context blocks:** `Session.addContext()` and `Session.removeContext()` allow adding/removing context blocks after session initialization (e.g., from extensions).

  **Extension manifest expanded** with `context` (namespaced context block declarations) and `hooks` fields.

## 0.2.0

### Minor Changes

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

- [#1256](https://github.com/cloudflare/agents/pull/1256) [`dfab937`](https://github.com/cloudflare/agents/commit/dfab937c81b358415e66bda3f8abe76b85d12c11) Thanks [@threepointone](https://github.com/threepointone)! - Add durable fiber execution to the Agent base class.

  `runFiber(name, fn)` registers work in SQLite, holds a `keepAlive` ref, and enables recovery via `onFiberRecovered` after DO eviction. `ctx.stash()` and `this.stash()` checkpoint progress that survives eviction.

  `AIChatAgent` gains `chatRecovery` — when enabled, each chat turn is wrapped in a fiber. `onChatRecovery` provides provider-specific recovery (Workers AI continuation, OpenAI response retrieval, Anthropic synthetic message). `continueLastTurn()` appends to the interrupted assistant message seamlessly.

  `Think` now extends `Agent` directly (no mixin). Fiber support is inherited from the base class.

  **Breaking (experimental APIs only):**
  - Removed `withFibers` mixin (`agents/experimental/forever`)
  - Removed `withDurableChat` mixin (`@cloudflare/ai-chat/experimental/forever`)
  - Removed `./experimental/forever` export from both packages
  - Think no longer has a `fibers` flag — recovery is automatic via alarm housekeeping

## 0.1.2

### Patch Changes

- [#1248](https://github.com/cloudflare/agents/pull/1248) [`c74b615`](https://github.com/cloudflare/agents/commit/c74b6158060f49faf0c73f6c84f33b6db92c9ad0) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#1247](https://github.com/cloudflare/agents/pull/1247) [`31c6279`](https://github.com/cloudflare/agents/commit/31c6279575c876cc5a7e69a4130e13a0c1afc630) Thanks [@threepointone](https://github.com/threepointone)! - Add `ContinuationState` to `agents/chat` — shared state container for auto-continuation lifecycle. AIChatAgent's 15 internal auto-continuation fields consolidated into one `ContinuationState` instance (no public API change). Think gains deferred continuations, resume coordination for pending continuations, `onClose` cleanup, and hibernation persistence for client tools via `think_request_context` table.

- [#1237](https://github.com/cloudflare/agents/pull/1237) [`f3d5557`](https://github.com/cloudflare/agents/commit/f3d555797934c6bd15cf5af2678f5e20aa74713a) Thanks [@threepointone](https://github.com/threepointone)! - Add `TurnQueue` to `agents/chat` — a shared serial async queue with
  generation-based invalidation for chat turn scheduling. AIChatAgent and
  Think now both use `TurnQueue` internally, unifying turn serialization
  and the epoch/clear-generation concept. Think gains proper turn
  serialization (previously concurrent chat turns could interleave).

## 0.1.1

### Patch Changes

- [#1220](https://github.com/cloudflare/agents/pull/1220) [`31d96cb`](https://github.com/cloudflare/agents/commit/31d96cb10ab1c8cbd9fd96b73d82ef55c5524138) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix `@cloudflare/shell` peer dependency to require `>=0.2.0`. Previously, npm could resolve an incompatible shell version, causing runtime errors. If you hit `Workspace` constructor errors, upgrade `@cloudflare/shell` to 0.2.0 or later.

## 0.1.0

### Minor Changes

- [#1138](https://github.com/cloudflare/agents/pull/1138) [`36e2020`](https://github.com/cloudflare/agents/commit/36e2020d41d3d8a83b65b7e45e5af924b09f82ed) Thanks [@threepointone](https://github.com/threepointone)! - Drop Zod v3 from peer dependency range — now requires `zod ^4.0.0`. Replace dynamic `import("ai")` with `z.fromJSONSchema()` from Zod 4 for MCP tool schema conversion, removing the `ai` runtime dependency from the agents core. Remove `ensureJsonSchema()`.

## 0.0.2

### Patch Changes

- [#1125](https://github.com/cloudflare/agents/pull/1125) [`3b0df53`](https://github.com/cloudflare/agents/commit/3b0df53df10899df79d80e1d1938dbad0ae39b75) Thanks [@threepointone](https://github.com/threepointone)! - first publish
