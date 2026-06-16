# Think ops-agent demo findings (qw-demo)

Type: analysis (point-in-time discovery record)

This captures the ergonomic gaps found while building a realistic non-coding
agent on **today's** Think APIs. The prototype lives at
`experimental/ops-approval-agent` and is a refund/dispute operations agent: it
looks up an order and issues a refund — a money-moving side effect that must be
permission-gated, human-approved, and idempotent. Those three guarantees are
where today's primitives strain.

The prototype typechecks against the real `@cloudflare/think` API. Every
`GAP(...)` comment in its `src/server.ts` maps to a finding below.

## What worked well today

- **`submitMessages()` durable acceptance** is exactly right for "accept a
  request now, run the turn in the background, check status later." The
  `submissionId` + `idempotencyKey` + `metadata` shape needed no workaround.
- **`addMessages()`** (the new quick-win API) cleanly injects out-of-band
  context with no turn — the webhook path was a one-liner. Its limitation is
  scope, not ergonomics (see Channels below).
- **`getScheduledTasks()`** made the proactive daily-digest trigger trivial to
  declare.
- **`tool({ needsApproval })`** parks the turn correctly at
  `approval-requested`. The gap is resolving it, not requesting it.

## Findings → Actions RFC (`rfc-think-actions.md`)

The refund tool needed three things every production side effect needs, and all
three were hand-rolled:

1. **Permissions / authorization.** There is no first-class "this action needs
   scope X." The prototype persists an ad-hoc `grantedScopes` set in agent state
   and calls a private `_requireScope()` at the top of every side-effecting
   `execute`, throwing a string on denial. Problems this confirms the RFC should
   fix:
   - The check is per-tool boilerplate, easy to forget on a new tool.
   - The model can't see which tools mutate state (no read/write metadata), so
     it can't reason about caution.
   - Denial is an unstructured thrown error, not a replayable, inspectable
     outcome. → validates `action({ permissions })` + `authorizeTurn()` and the
     structured denial result.

2. **Idempotency.** Issuing a refund must settle exactly once across retries and
   redeploys. The prototype hand-rolls a `cf_demo_refund_ledger` SQLite table,
   derives an idem key (`refund:<order>:<amount>`), and branches on
   "already issued." This is precisely the Actions RFC's `cf_think_action_ledger`
   - `action({ idempotency })`. **Refinement for the RFC:** the natural idem key
     here is derived from the tool _inputs_, not supplied by the caller — the RFC
     should make input-derived keys a first-class option (e.g. a
     `idempotencyKey: (input) => string`), not only a caller-passed string.

3. **Approval resolution.** `needsApproval: true` parks the turn, but there is
   **no server-side / programmatic way to resolve a generic tool approval**.
   The only approve/reject API (`approveExecution`/`rejectExecution`,
   `think.ts:9133`) is specific to the codemode execute runtime. Today a backend
   workflow (the realistic approver for a refund — a manager hitting an internal
   tool, not a chat client) cannot cleanly approve. → strongly validates the
   Actions RFC's **stable approval descriptor** and argues it must come with a
   server-callable resolve path, not just a client/WebSocket one. This is the
   sharpest gap the demo found.

## Findings → Turns RFC (`rfc-think-turns.md`)

- **Three doors to start a turn.** The same logical event ("process this
  refund") maps to `submitMessages` (durable accept), `saveMessages` (wait), or
  the WebSocket chat path (a human), and proactive work is a NL-string `prompt`
  in `getScheduledTasks`. The prototype only needed `submitMessages`, but
  choosing among the doors required knowing their admission/return semantics
  up front. → validates `runTurn()` unifying trigger + admission + body.
- **Scheduled prompt is a stringly-typed trigger.** A scheduled task is a
  natural-language string, disconnected from the structured `submitMessages`
  shape. A unified `runTurn({ trigger: "scheduled", ... })` would let scheduled
  and programmatic turns share one body/typed input.
- **Approval continuation is invisible at the API.** After approval the turn
  must continue, but today that continuation is internal machinery. The Turns
  RFC's explicit continuation as a first-class turn (with the action ledger
  guaranteeing the approved side effect isn't re-run) is the right model — the
  demo shows the user-facing call site has no handle on it today.

## Findings → Channels RFC (`rfc-think-channels.md`)

- **No single "notify out of band" primitive.** The dispute-webhook needs to
  (a) let the model see the escalation and (b) notify the operator. Today those
  are two unrelated mechanisms: `addMessages()` (model sees it) and a broadcast
  (web clients see it) — and a non-web surface (email/Slack/voice) gets neither.
  → validates `deliverNotice({ informModel })` as the missing unifier, and that
  it must target a **channel**, not just web WebSocket clients.
- **`addMessages` injects as a `user` message.** There's no "system/notice"
  provenance for injected context, so the model can misread ops context as the
  customer speaking. A notice with explicit provenance (and an `informModel`
  toggle) is cleaner than overloading the `user` role. → minor refinement to the
  Channels RFC: notices should carry provenance distinct from user turns.

## Cross-cutting

- The agent is ~60% "production-semantics plumbing" (authz, ledger, approval
  wiring) and ~40% domain logic. That ratio is the thesis of the whole API
  strategy: Think should own the plumbing so app code is mostly domain logic.
- All three RFCs converge on **one durable concept**: a side effect that is
  authorized, approved, settled-once, and continued — i.e. the action ledger +
  turn continuation are load-bearing for the others. Suggest sequencing Actions
  (ledger + approval descriptor) before Channels, since notices/continuations
  lean on settled-once semantics.

## Status / next

- Prototype is headless and typechecks; it is intentionally not a polished
  example. Hardening into a shipped `examples/` app (UI + approval resolution
  demo) is deferred until the Actions approval-resolve path exists — without it
  the approval loop can't complete end to end, which is itself the headline
  finding.
