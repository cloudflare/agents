# Deploy-churn / chat-recovery investigation log

Durable record of findings so progress survives editor crashes. Covers four
distinct issues found while hardening chat recovery against deploy churn.

## Status at a glance

| #   | Issue                                                                                            | Layer                                            | Status                                                |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| 1   | Recovery attempt budget burned progress-blindly under deploys                                    | `think` / `ai-chat` `_beginChatRecoveryIncident` | FIXED — PR #1615 (merged)                             |
| 2   | Recovery one-shot alarm swallowed + deleted on a superseded-isolate reset                        | `agents` `_executeScheduleCallback`              | FIXED — PR #1617 (open)                               |
| 3   | Continuation replays a trailing **partial assistant** message (prefill); modern models reject it | `think` `continueLastTurn` → `_runInferenceLoop` | FIXED — `ensureValidContinueCheckpoint` (this branch) |
| 4   | `interrupted` is a silent state — no client signal unless recovery `exhausted`                   | `think` `_chatRecoveryContinue` skip/fail paths  | CONFIRMED in code — fix TBD                           |

---

## Issue 3 — assistant-prefill rejection on continuation (REPRODUCED)

### Mechanism (code)

- `continueLastTurn` only runs when `session.getLatestLeaf()` is an **assistant**
  message (`packages/think/src/think.ts` ~5137). After a deploy interrupts a turn
  mid-stream, the last leaf is a **partial assistant** message.
- It calls `_runInferenceLoop({ continuation: true })`, which builds the model
  request from `this.messages` (ending in that partial assistant message):
  `_repairTranscriptForProvider(this.messages)` → `truncateOlderMessages` →
  `convertToModelMessages` (think.ts ~2431-2433) → `streamText({ messages })`.
- `_repairTranscriptForProvider` / `_repairToolTranscriptParts` only repair
  orphaned tool calls + malformed tool inputs. **No handling for a trailing
  assistant message.** So the model receives a transcript ending in assistant
  (an assistant-prefill).
- Nuance: auto-continuation **after a tool call** works, because a completed tool
  result converts to a tool-role (user-side) model message — the transcript ends
  in a tool message, not assistant text. The bug bites continuation of a partial
  **assistant text** turn (the redeploy-interruption case).

### Live reproduction (via the harness `/probe` routes)

Added to `src/server.ts`: `/probe/trailing-user` (control) and
`/probe/trailing-assistant` (prefill), with `?provider=workers-ai|anthropic&model=...`.
Run with `npm start`, then curl. `maxRetries: 0` so a 400 surfaces immediately.

Results:

- **Kimi 2.7 Code (`@cf/moonshotai/kimi-k2.7-code`, Workers AI): does NOT reproduce.**
  - trailing-user → `ok` ("Hello, it's a pleasure to connect with you!")
  - trailing-assistant → `ok` ("Hello, it's wonderful to meet you!")
  - Kimi tolerates a trailing assistant message (just responds). No 400.
- **Anthropic Sonnet 4.6 (`claude-sonnet-4-6`): REPRODUCES (this is the customer's model).**
  - trailing-user → `ok` (control passes)
  - trailing-assistant → `ok:false`, `AI_APICallError`, 414ms:
    `"This model does not support assistant message prefill. The conversation must end with a user message."`
- Confirmed by Anthropic docs: prefilling the final assistant message is
  **deprecated and returns 400 on Claude 4.6+** (Opus 4.6/4.7, Sonnet 4.6).
  Anthropic's migration guidance: _"For continuations, move the desired
  continuation text into a user message instead of an assistant message."_

### Proposed fix (think `continueLastTurn` / `_runInferenceLoop`)

When a continuation would otherwise send a transcript ending in a partial
assistant message, make it provider-safe. Options:

1. **(lean) Append a minimal "continue" user message** so the request ends in a
   user turn — cross-provider; matches Anthropic's own guidance. Keep the nudge
   out of the persisted transcript.
2. Provider-aware prefill: keep trailing-assistant only for models that support
   it (older Anthropic / Kimi); else fall back to (1).
3. Finalize the partial as the answer (no second model call) when there is no
   pending tool call — simplest, but truncated.
4. Regenerate from the last user message — customer explicitly does NOT want to
   re-run the failed step.

Recommendation: **(1)**, optionally gated by capability detection for (2).

### Fix shipped (option 1)

`think.ts` `ensureValidContinueCheckpoint(messages)` appends an ephemeral user
"continue" checkpoint when a model request would otherwise end in an assistant
message; applied to `finalMessages` in `_runInferenceLoop` (after `beforeTurn`,
so subclass overrides are also protected). Never persisted. Regression test:
`think-session.test.ts` "continuation does not replay a trailing assistant
message (assistant prefill)" — uses a mock model that rejects a trailing
assistant prompt; fails without the fix, passes with it. Full think suite: 432.

---

## Issue 4 — silent `interrupted` state (CONFIRMED in code)

- Recovery incident states (`detected/scheduled/attempting/completed/skipped/
exhausted/failed`) are **observability only**; clients render chat messages +
  `MSG_CHAT_RESPONSE` broadcasts.
- Only `_exhaustChatRecovery` broadcasts a terminal `MSG_CHAT_RESPONSE
{ done: true, error: true }` (think.ts ~5771-5776) that a client banners on.
- `_chatRecoveryContinue` **skip** paths (e.g. `conversation_changed`, think.ts
  ~7205-7219) and several **fail** paths just update the incident + `return` —
  **no client broadcast**. So a turn whose recovery is skipped (e.g. a concurrent
  message changed the latest leaf) or fails (e.g. prefill 400) without reaching
  `exhausted` leaves the client with no completed response and no error → frozen.
- Customer's SPA only banners on `failed` / recovery `exhausted`, so `interrupted`
  shows nothing; the WS reconnect storm also lost the stall watchdog's turn.

### The silent paths (think.ts `_chatRecoveryContinue` / `_chatRecoveryRetry`)

- `skipped`: `conversation_changed`, `no_unanswered_user_message`,
  `stream_terminal`, `not_recoverable`, `submission_not_running`,
  `continue_disabled` → update incident + `return`. No client broadcast.
- `failed`: `stable_timeout`, or a thrown continuation → update incident,
  re-throw (then swallowed by `_executeScheduleCallback`). No client broadcast,
  and (post-#1617) only re-armed if the throw was a code-update reset — a
  prefill/other failure is terminal with no client signal.
- `exhausted`: the ONLY path that broadcasts a terminal
  `MSG_CHAT_RESPONSE { done: true, error: true }` (think.ts ~5771) — what the
  customer's SPA banners on.

### Design options

- **A. Surface terminal `failed` recovery** like exhaustion: when a continuation
  fails and will not be retried, broadcast the terminal `MSG_CHAT_RESPONSE`
  (error) so the client banners instead of freezing. Safe — a dead turn should
  surface.
- **B. Recovery-progress broadcast**: on `detected`/`scheduled`, broadcast a
  non-error "recovering" status so the client shows a spinner rather than
  nothing; clear on completion. Directly fixes the "frozen" symptom.
- **C. Keep benign skips silent**: `conversation_changed` /
  `no_unanswered_user_message` mean a newer turn owns the UI — do NOT
  false-banner there.
- **D. Expose recovery status via agent state / observability** the client
  subscribes to; client decides what to render (least intrusive, most flexible).

Recommendation: **A + C** (surface terminal failures, keep benign skips silent),
optionally **B** for the best UX. NOTE: the customer's specific frozen case was a
`conversation_changed` _skip_ — under C that stays silent because a newer turn
should own the UI; if their newer turn also didn't render, part of that is the
SPA's WS-reconnect/stall-watchdog, not the SDK. Needs a UX decision before
implementing, since it changes client-facing behavior.

### KEY INSIGHT (re-scopes Issue 4): it's a HYDRATION gap, not a missing broadcast

`_streamResult`'s catch ALREADY broadcasts a terminal
`MSG_CHAT_RESPONSE { error: true }` when a continuation stream throws
(think.ts ~6033). So a connected client _does_ get an error. The real problem:
that broadcast is **transient**. During the WS reconnect storm the client is
disconnected when it fires; on reconnect, `onConnect` (think.ts ~5355) only
re-sends `MSG_CHAT_MESSAGES` (current messages) — there is **no durable record
of the failed/interrupted turn**, so the reconnected client sees no completed
response and no error → frozen.

Therefore the correct Issue 4 fix is **hydration-backed durable turn status**:
persist a per-turn terminal/`recovering` status and replay it on connect
(extend the `onConnect` hydration), so a client that reconnects after the event
learns the turn failed / is recovering. This subsumes B (recovering status,
hydrated) and most of A (terminal status, hydrated). A bare broadcast does NOT
fix the customer's reconnect-storm case.

Scope: durable status table/field + `onConnect` replay + a backward-compatible
client signal + `useAgentChat` / SPA rendering + browser validation. This is a
focused feature (cross-package, client-involved), not a one-line bugfix — best
as its own design/PR rather than folded into the Issue 3 branch.

---

## Harness additions (this branch, uncommitted)

- `wrangler.jsonc`: `ai` binding (`remote: true`) + `/probe/*` in `run_worker_first`.
- `src/server.ts`: `probeTrailingRole()` + `/probe/trailing-{user,assistant}` routes
  (Workers AI default; `?provider=anthropic&model=claude-sonnet-4-6`).
- `package.json`: `@ai-sdk/anthropic`, `workers-ai-provider`.
- `.dev.vars.example` (ANTHROPIC_API_KEY); `.dev.vars` is gitignored.

### How to re-run the repro

```
cd examples/deploy-churn
# put ANTHROPIC_API_KEY in .dev.vars
npm start            # vite dev (note: heavy; has crashed the editor — prefer short sessions)
curl "http://localhost:5173/probe/trailing-user?provider=anthropic&model=claude-sonnet-4-6"
curl "http://localhost:5173/probe/trailing-assistant?provider=anthropic&model=claude-sonnet-4-6"
# Kimi (no key): drop the query params (defaults to @cf/moonshotai/kimi-k2.7-code)
```

## Notes

- The vite dev server + remote-binding tunnel appears to destabilize the editor
  (crashed 3×). Prefer stopping it promptly; the probe call itself is ~0.4s.
- Issues 1 & 2 are already fixed/PR'd. Issues 3 & 4 still need fixes + (ideally)
  a deterministic test each, following the same "reproduce first" approach.
