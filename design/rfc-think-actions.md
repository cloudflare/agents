Status: shipped (Steps 1–6 landed, including the pending-retry lease)

# RFC: Think actions — rich, production-grade tools

Related:

- [rfc-think-turns.md](./rfc-think-turns.md) — `runTurn`/`TurnSpec`; actions run inside turns and share the recovery taxonomy
- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) — recovery engine; the action ledger reconciles with its replay/progress contract
- [think.md](./think.md) — Think design doc
- [agent-tools.md](./agent-tools.md) — sub-agent orchestration (the `delegated-agent` action kind)
- Strategy plan: `think_api_strategy`

## Status and dependencies (read first)

Second of three sibling API RFCs (turns, actions, channels) to be picked up in
**separate** sessions. Recommended order: **Turns → Actions → Channels.**

- ✅ **Step 1 shipped:** `action()`, `isAction()`, the `Action` descriptor,
  default `getActions()`, and action-to-tool compilation are implemented in
  `packages/think/src/think.ts`. Compiled actions flow through the existing
  `beforeToolCall` / `afterToolCall` wrapper path.
- ✅ **First guardrails shipped:** server actions receive a combined abort signal
  (`ctx.signal`) with a default 30s timeout, thrown/timeout failures are mapped
  to a structured model-facing tool output, and oversized outputs are truncated
  before model consumption.
- ✅ **Step 2 shipped:** server actions can declare `approval` and stable display
  fields; compiled tools set AI SDK `needsApproval`, and `approval-requested`
  transcript parts carry an `ActionApprovalDescriptor` for the existing
  approval → auto-continuation path.
- ✅ **Step 3 shipped:** server actions can declare `permissions`; Think exposes
  default-full-grant `authorizeTurn` and `authorizeAction` hooks, denies before
  `execute`, and suppresses approval prompts for unauthorized approval-gated
  actions.
- ✅ **Step 4 shipped:** `cf_think_action_ledger` records settled action outputs
  and replays them for matching idempotency keys without re-running
  `execute`. The default `tool:${toolCallId}` key only dedups paths that preserve
  the tool call id; cross-recovery side-effect dedup requires an app-provided
  stable `idempotencyKey`.
- ✅ **Step 5 shipped:** `durable-pause` actions park in a dedicated
  `cf_think_action_pending_approvals` durable store (claim-by-delete, no status
  column) and resume via `approveExecution`/`rejectExecution`, surviving deploys.
  Authorization runs once at pause time (never re-authorized at approve time);
  the `approval` predicate gates whether the action parks or runs inline.
  Resolution drives a **connection-independent continuation** (modeled on the
  submission/alarm path) so a turn can be approved from a dashboard with no live
  socket — this also fixes codemode `approveExecution` from a dashboard. A
  unified `ActionApprovalDescriptor` is attached to paused parts (durable-pause
  actions, codemode pauses, and approval-gated requests), `pendingApprovals()`
  lists all pending approvals with their descriptors for cold-load
  reconciliation, an overridable `describePausedExecution()` hook enriches
  codemode descriptors, and `action:pause:*` observability plus a throttled
  TTL sweep round out retention.
- ✅ **Pending-retry lease shipped:** a stale `pending` ledger row (older than
  `actionLedgerPendingRetryLeaseMs`, default 5 min) is reclaimed and re-run, but
  ONLY for actions with an explicit `idempotencyKey`; fallback `tool:` keys and
  fresh rows still surface `ActionPendingError`. Set the lease to `false` to keep
  the old "block forever" behavior. Emits `action:ledger:reclaimed`.
- **Depends on the Turns RFC** for `TurnContext`, the `recovery-continue`/
  `recovery-retry` triggers, and `_admitTurn` (authorization resolves once per
  turn at admission). Build Turns first.
- **Depends on the chat-recovery RFC** for the ledger's replay-safety: the
  recovery-replay tests and the §7 recovery taxonomy reconcile with
  `classifyRecoveredTurn` and should be sequenced **after** chat-recovery RFC
  Phase 3. (Name reconciliation, updated 2026-06: the seam shipped as
  `ChatRecoveryAdapter` in `agents/chat`; chat-recovery Phases 0–5 and the engine
  extraction are complete. The wake-path decision shipped as the package-owned
  `ChatFiberWakeHooks` classify/dispatch hook pair (`classifyRecoveredTurn` /
  `dispatchRecoveredTurn`-shaped). Per that RFC's "Substrate capabilities are
  optional" decision, `Think`'s recovery decision stays package-owned, so the
  ledger can be consulted inside `dispatchRecoveredTurn` on recovery re-entry. Use
  the real hook names or update them here when building.)
- **Steps 1–6 have landed:** the additive descriptor, approval-descriptor,
  authorization, settled-result ledger, and durable-pause approval descriptor +
  connection-independent resume slices are shipped, along with `ctx.attachReply`
  recording and the pending-retry lease for stale, explicitly-keyed actions.
- **Produces a seam the Channels RFC consumes:** `ctx.attachReply()` (§9) is
  inert until Channels/Voice render it.

## The problem

Think tools today are plain AI SDK tools returned from `getTools(): ToolSet`
(`think.ts:2960`). They are functional, but everything a _production_ action
needs is left to application folklore:

- **Permissions/authorization.** There is no declarative way to say "this tool
  requires `billing:refund`." The only interception is the imperative
  `beforeToolCall` hook (`think.ts:3479`), which each app must hand-roll.
- **Approval.** Two separate approval mechanisms exist — AI SDK `needsApproval`
  (transcript `approval-requested` → `tool-approval` event → auto-continuation)
  and the execute/codemode durable-pause path (`approveExecution`,
  `think.ts:9026`). Neither exposes a _stable approval descriptor_ a UI, voice,
  or messenger surface can render consistently.
- **Idempotency.** There is **no per-tool-call execution ledger**
  (confirmed across `think.ts`). Idempotency exists only at other layers:
  `cf_think_submissions.idempotency_key` for submissions
  (`think.ts:5815`), `idempotencyKeyForEvent` for messenger events
  (`messengers/chat-sdk.ts:636`), and transcript "first-write-wins" on tool
  parts (`tool-state.ts`). A side-effecting tool that executes, then has its
  result lost to a crash before persistence, can re-execute on recovery.
- **Guardrails.** There is no generic per-tool timeout, no standard structured
  tool-error envelope, and no standard output truncation in the inference loop.
  Those protections exist only inside specific tools (workspace bash, the
  execute sandbox) — `workspace.ts:1186`, `execute.ts:103`, not for ordinary
  `getTools()` tools. The turn `AbortSignal` _is_ forwarded into `execute`
  (`think.ts:4442`), but nothing bounds a slow tool.
- **Delivery influence.** A tool cannot tell the channel "send this reply as a
  voice note / email draft / card." Messenger delivery strips everything except
  `text-delta` chunks (`messengers/delivery.ts:190`); there is no per-reply
  side-channel.

The result: every team rebuilds permissions, approval UX, idempotency, and
guardrails on top of raw tools, inconsistently. This is exactly the
"production semantics as folklore" problem the strategy targets.

## Goals

- A public `action()` wrapper that compiles to an AI SDK tool but carries
  declarative production metadata: permissions, approval policy, idempotency,
  timeout/guardrails, and a recovery classification.
- A durable **action ledger** that makes settled server actions replay-safe on
  recovery, reconciled with the existing submission/event idempotency keyspaces.
- A stable **approval descriptor** so approvals render/resolve identically
  across web, voice, messengers, and workflows — built on the _existing_
  approval/HITL machinery, not a new one.
- Default **guardrails**: per-action timeout, combined `AbortSignal`, structured
  tool errors, output truncation, safe stringification.
- `ctx.attachReply(...)` — a typed side-channel for delivery metadata that does
  not change what the model sees as the tool result.
- Fully additive: `getTools()` and `beforeToolCall`/`afterToolCall` keep working
  unchanged; actions interoperate with them.

## Non-goals

- Replacing `getTools()`. Raw AI SDK tools remain first-class; `action()` is an
  opt-in richer descriptor.
- Owning channel delivery. `attachReply` only _records_ intent; the Channels and
  Voice RFCs own how attachments render.
- Changing recovery policy. The ledger plugs into the recovery engine's existing
  replay contract; it does not change budgets or scheduling
  (see [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md)).
- A new approval transport. Actions reuse the two existing approval paths.

## The proposal

### 1. `action()` descriptor

`action()` returns a branded `Action` descriptor. It is generic over input and
output, inferring the input type from the schema so `execute` is fully typed
without any code generation.

```ts
type ActionKind =
  | "server" // runs server-side; ledger-protected; default
  | "client" // resolved on the client (compiles to a client tool)
  | "approval-gated" // requires approval before execute (AI SDK needsApproval path)
  | "durable-pause" // long-running; parks the turn (execute/codemode path)
  | "delegated-agent"; // delegates to a sub-agent (agent-tool path)

interface ActionConfig<Input, Output> {
  /** Defaults to the registration key when registered via getActions(). */
  name?: string;
  description: string;
  /** Zod (or AI SDK) schema; input type is inferred from it. */
  inputSchema: StandardSchemaV1<Input> | ZodType<Input>;
  outputSchema?: StandardSchemaV1<Output> | ZodType<Output>;

  /** Declarative permission scopes required to run. */
  permissions?:
    | string[]
    | ((args: { input: Input; ctx: ActionContext }) => string[]);

  /**
   * Approval policy. `true` always requires approval; a predicate decides per
   * input. Compiles to AI SDK `needsApproval` for "approval-gated", or to the
   * durable-pause path for long-running server work.
   */
  approval?:
    | boolean
    | ((args: {
        input: Input;
        ctx: ActionContext;
      }) => boolean | Promise<boolean>);

  /**
   * Stable key for ledger dedup. When omitted, the ledger falls back to the
   * tool-call id (see "Idempotency ledger"). Provide one to dedup across
   * retries/webhooks (e.g. `refund:${input.paymentId}:${input.amount}`).
   */
  idempotencyKey?: string | ((input: Input) => string);

  /** Per-action timeout. Default applied by kind (see "Guardrails"). */
  timeoutMs?: number;

  /** Explicit kind; otherwise inferred (see "Recovery taxonomy"). */
  kind?: ActionKind;

  execute(input: Input, ctx: ActionContext): Promise<Output> | Output;
}

declare function action<Input, Output>(
  config: ActionConfig<Input, Output>
): Action<Input, Output>;

/**
 * The descriptor returned by action(): an opaque, branded carrier of the
 * resolved config. The brand lets getActions()/getTools() sugar detect an
 * Action vs a plain AI SDK tool. Implemented as a frozen object with a
 * `Symbol.for("cf.think.action")` key.
 */
interface Action<Input = unknown, Output = unknown> {
  readonly [ACTION_BRAND]: true;
  readonly config: ActionConfig<Input, Output>;
}
```

**Shipped subset:** the current implementation includes `name`,
`description`, schema-inferred `inputSchema` typing for `execute(input, ctx)`,
`outputSchema` as reserved metadata, `permissions`, `timeoutMs`, `kind`,
`approval`, `approvalSummary`, `approvalRisk`, and `execute`. `idempotencyKey`
remains planned-only until the ledger slice lands.

Example:

```ts
const refundPayment = action({
  description: "Refund a payment",
  inputSchema: z.object({ paymentId: z.string(), amount: z.number() }),
  permissions: ["billing:refund"],
  approval: ({ input }) => input.amount > 100,
  idempotencyKey: ({ paymentId, amount }) => `refund:${paymentId}:${amount}`,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    return ctx.env.BILLING.refund(input.paymentId, input.amount);
  }
});
```

### 2. Registration and compilation to tools

Add a new hook alongside `getTools()`:

```ts
getActions(): Record<string, Action> | Promise<Record<string, Action>> {
  return {};
}
```

(Allows `Promise` for parity with other async registration hooks, e.g. when an
action set depends on `env`/remote config.)

In `_runInferenceLoop`, actions are converted and merged into the tool set after
`getTools()` (so later layers still win, matching the existing merge order at
`think.ts:3887`):

```ts
const actionTools = mapValues(this.getActions(), (a, name) =>
  actionToTool(a, name, this)
);
const tools = {
  ...workspaceTools,
  ...baseTools, // getTools()
  ...actionTools, // getActions()  <-- new
  ...extensionTools,
  ...contextTools,
  ...skillTools,
  ...(this.mcp?.getAITools?.() ?? {}),
  ...clientToolSet
};
```

`actionToTool(action)` produces a normal AI SDK tool whose `execute` is the
guardrailed/authorized/ledgered pipeline (below) and whose `needsApproval` is
derived from the `approval` policy. Because the result is an ordinary tool, it
**flows through the existing `_wrapToolsWithDecision` path** (`think.ts:4446`),
so `beforeToolCall`/`afterToolCall` still fire — `beforeToolCall` remains the
outermost gate (it can still block), and the action pipeline is innermost.

Why a separate `getActions()` rather than allowing `Action` objects inside
`getTools()`: `ToolSet` is an AI SDK type, and an `Action` is not an AI SDK
tool. Keeping them in distinct hooks keeps both type surfaces clean. (We may
additionally detect `Action` instances inside `getTools()` and convert them, as
sugar — see Open Questions.)

#### Compiled execute pipeline (ordered)

`actionToTool` composes these layers, outermost to innermost. This is the
authoritative order; sections 4–8 detail each step.

1. `_wrapToolsWithDecision` -> `beforeToolCall` (existing; can block/substitute,
   stays the outermost gate).
2. **Authorization** (`authorizeAction`). Deny -> structured tool output,
   skip the rest. Also consulted when deriving `needsApproval` so an
   _unauthorized_ approval-gated action is never prompted (authorize before
   approval, never prompt for something that would be denied).
3. **Approval.** `approval-gated` gates here via AI SDK `needsApproval` before
   `execute`; `durable-pause` uses the paused path. Denied -> `output-denied`.
4. **Idempotency ledger lookup** (settled -> return stored result; see §6).
5. **Timeout/abort** — `ctx.signal` (turn signal + per-action timeout).
6. `execute(input, ctx)`.
7. **Output handling** — `outputSchema` validation (if set) -> safe-stringify
   -> truncation.
8. **Ledger write** (`settled` on success, `failed` on throw).
9. **Structured error mapping** on throw -> `output-error` (stream survives).
10. `afterToolCall` via `experimental_onToolCallFinish` (existing; observation).

`needsApproval` is an AI SDK tool option (`boolean | (opts) => boolean |
Promise<boolean>`); the `approval` policy plus the authorization check (step 2)
compile into it for the `approval-gated` kind.

**Shipped subset:** the compiled tool currently performs timeout/abort,
structured error mapping, JSON-safe output normalization (including bigint and
circular-reference handling), output truncation, authorization checks, and AI SDK
`needsApproval` derivation for approval-gated actions. Authorization also runs
while deriving `needsApproval`, so denied actions never prompt for approval. It
leaves `beforeToolCall`/`afterToolCall` behavior to the existing Think wrapper,
so approved actions still pass through that outer gate before `execute`; if that
hook rewrites the input for an already-approved action, Think returns a
structured `ActionApprovalInputError` instead of executing different arguments
than the human approved. It does not yet run output-schema validation, ledger
lookup, or ledger writes.

### 3. `ActionContext` (`ctx`)

The context is a superset of what AI SDK passes to `execute`
(`{ toolCallId, messages, abortSignal }`, `think.ts:4420`) plus Think
production affordances:

```ts
interface ActionContext {
  /** The agent instance. */
  agent: Think;
  env: Cloudflare.Env;
  /** The current turn's request id. */
  requestId: string;
  toolCallId: string;
  /** Model messages visible at call time. */
  messages: ReadonlyArray<ModelMessage>;
  /**
   * Combined abort signal: turn signal + per-action timeout. Aborts when the
   * turn is cancelled OR the action times out.
   */
  signal: AbortSignal;

  /** Authorization context resolved for this turn (see "Permissions"). */
  authorization: AuthorizationContext;

  /** Attach side-channel delivery metadata for the final reply. */
  attachReply(attachment: ReplyAttachment): void;

  /** Structured logger; emits action:* observability events. */
  log: ActionLogger;
}
```

`agent`, `env`, and `messages` give actions everything a tool needs; `signal`
and `attachReply` are the new affordances.

### 4. Permissions and authorization

Two halves: what an action _requires_ (declared on the action), and what the
caller _has_ (resolved per turn).

- **Required:** `permissions: string[]` (or a predicate) on the action.
- **Granted:** an `AuthorizationContext` resolved once per turn via a new
  overridable hook:

```ts
type ActionAuthorizationDecision =
  | boolean
  | {
      allowed: boolean;
      reason?: string;
      grantedPermissions?: readonly string[];
    };

authorizeTurn(turn: TurnContext): ActionAuthorizationDecision {
  // default: true (full grant, back-compatible)
  return true;
}

authorizeAction(ctx: ActionAuthorizationContext): ActionAuthorizationDecision {
  // default: grantedPermissions is undefined => full grant; otherwise require
  // every declared permission to be present in the turn grant.
}
```

Where granted permissions come from is deliberately app-owned via
`authorizeTurn`. Common sources: the channel (a channel could declare default
grants — **not yet built**; the Channels RFC shipped v1 without channel grants,
but `ChannelContext` carries a documented seam for a future `grants` slice that
would feed `authorizeTurn`), the session, or the request `body`.
On denial the action does not execute; the model receives a structured tool
output (`{ error: { name: "ActionAuthorizationError", ... } }`), so the assistant
can explain rather than crash. This is intentionally not a UI `output-error`
part in the shipped slice. Default behavior is **full grant**, so existing apps
see no change until they opt in.

**Shipped subset:** `permissions`, `authorizeTurn`, and `authorizeAction` are
implemented for server actions. `authorizeTurn` runs once per turn after
`beforeTurn` overrides are applied. The default `authorizeAction` enforces the
turn's `grantedPermissions` when provided and otherwise grants all permissions.
Approval-gated actions consult authorization while deriving `needsApproval`, so
denied actions skip the prompt and return the structured authorization error
from `execute`. Because `permissions` and `approval` predicates can run once
while deciding whether to prompt and again when an approved call resumes, they
should be pure and side-effect free.

### 5. Approval — reuse, don't reinvent

`approval` compiles onto the two existing mechanisms rather than a new one:

- **`approval-gated` (default for approval):** sets AI SDK `needsApproval` on the
  compiled tool. This uses the existing transcript path: `approval-requested`
  part state → `tool-approval` WS event → `_applyToolApproval` /
  `toolApprovalUpdate` (`tool-state.ts:195`) → auto-continuation
  (`_scheduleAutoContinuation`, `think.ts:11163`).
- **`durable-pause` (long-running server approval):** parks in a dedicated
  durable store (`cf_think_action_pending_approvals`) and resumes via
  `approveExecution`/`rejectExecution`, so the turn ends and resumes later,
  surviving deploys. Parked execution ids are prefixed `actpause_` so the resume
  path can distinguish action pauses from codemode pauses and route accordingly;
  when no pending row matches, resume falls back to the codemode runtime.

On top of both, actions emit a **stable approval descriptor** so every surface
renders the same thing:

```ts
type ActionApprovalDescriptor = {
  requestId: string;
  toolCallId: string;
  action: string;
  /** Model/app-provided summary of what will happen. */
  summary: string;
  input: unknown;
  permissions: string[];
  /** Coarse risk hint for UIs; advisory only. */
  risk?: "low" | "medium" | "high";
  kind: "approval-gated" | "durable-pause";
};
```

This descriptor is attached to the approval-requested part and exposed to
clients (web/voice/messenger), so a voice agent can speak it and a web UI can
render a card from the same data.

**Authorization runs once, at pause time.** A `durable-pause` action authorizes
and evaluates its `approval` predicate when it first parks; the row is only
written if it is allowed to proceed. Approve/resume does **not** re-authorize (it
has no turn context to authorize against), so authorization decisions are
captured at pause time and the resume path simply runs the approved input.
`kind: "durable-pause"` with `approval: false` is rejected by `action()` (a
never-parking durable pause is a programming error).

**Resolution is connection-independent.** `approveExecution`/`rejectExecution`
claim the pending row (claim-by-delete: `DELETE ... WHERE execution_id=?` and
check `changes()==1`, so concurrent approve/reject/replay is idempotent —
exactly one caller wins), run the approved action through the shared
`_runLedgeredAction` pipeline, then drive `_applyExecutionOutcome`. When no live
client connection is present, the outcome schedules a self-driven continuation
(modeled on the submission/alarm path) so the chat turn advances after a
dashboard approval with no socket. This same path also fixes codemode
`approveExecution` from a dashboard.

**Shipped subset:** approval-gated actions compile onto AI SDK `needsApproval`;
durable-pause actions park in `cf_think_action_pending_approvals`. The unified
`ActionApprovalDescriptor` is attached for all three approval surfaces:

- **approval-gated** requests carry it on `part.approval.descriptor` (the AI SDK
  approval object, which also carries the eventual decision), preserved by
  `toolApprovalUpdate` on approve/reject.
- **durable-pause and codemode pauses** are settled `output-available` parts, not
  AI SDK approvals; their descriptor rides on a sibling `part.approvalDescriptor`
  field. Attaching it to `part.approval` (which has no decision yet) would make
  `convertToModelMessages` emit an invalid `tool-approval-request` for an
  already-resolved output on the next turn, so the sibling field is deliberate.

Durable-pause descriptors are rebuilt from the pending row on cold load;
codemode descriptors are derived from the live paused execution and may be
enriched by the overridable `describePausedExecution(pending, ctx)` hook
(default `undefined`). `pendingApprovals()` merges codemode and action pending
rows into one list, each carrying its descriptor, for cold-load reconciliation.
Approved action calls execute with the approved input; `beforeToolCall` may still
block or substitute the result, but input substitution for an already-approved
action returns `ActionApprovalInputError`.

Retention: abandoned pending rows are swept by `_sweepActionPendingApprovals`
(select-then-delete-by-id, throttled, generous configurable
`actionPendingApprovalTtlMs`) wired into `onStart` recovery. Lifecycle is
observable via `action:pause:created` / `:approved` / `:rejected` / `:swept`.

### 6. Idempotency ledger

A durable table makes settled server actions replay-safe for a stable action
key. This closes the same-key replay gap: if a server action has already settled,
Think returns the stored model-visible output instead of running `execute` again.

Important recovery boundary: the fallback key `tool:${toolCallId}` only dedups
paths that preserve the tool call id (approval continuations and
auto-continuation replays). A full recovery retry may re-run the model, causing a
new tool call id; side-effecting actions that must dedup across recovery re-runs,
submissions, or webhooks should provide a semantic `idempotencyKey` derived from
stable domain data (for example an order id or inbound event id). Do not include
`ctx.requestId`, timestamps, or random values in the key.

```sql
CREATE TABLE IF NOT EXISTS cf_think_action_ledger (
  key          TEXT PRIMARY KEY,   -- action:name:key OR `tool:${toolCallId}`
  action_name  TEXT NOT NULL,
  request_id   TEXT,
  tool_call_id TEXT,
  input_hash   TEXT NOT NULL,      -- stable hash of normalized input
  status       TEXT NOT NULL,      -- 'pending' | 'settled'
  result_json  TEXT,               -- JSON envelope for settled model output
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

Pipeline inside `actionToTool`'s `execute`:

1. After authorization and approved-input validation, compute `key` =
   `action:${actionName}:${action.idempotencyKey(input)}` if provided, else
   `tool:${toolCallId}` when a tool call id exists.
2. **Lookup.** If a row exists:
   - `settled` and `input_hash` matches → return stored `result_json`
     (no re-execution). Emit `action:ledger:replayed`.
   - same key but different action/input hash → structured `ActionKeyConflict`
     (idempotency key reused with different input — a programming error).
   - `pending` → an earlier attempt is mid-flight or crashed mid-execute. If a
     same-isolate active promise owns the key, await it. Otherwise apply the
     **pending-retry lease**: if the action has an explicit `idempotencyKey` and
     the row is stale (`updated_at` older than `actionLedgerPendingRetryLeaseMs`,
     default 5 min), reclaim it — refresh `updated_at`/`request_id`/`tool_call_id`
     in place (still `pending`, an ownership lease, not a new status), emit
     `action:ledger:reclaimed`, and re-run `execute` (which re-runs the keyed
     side effect — the explicit key is the developer's assertion that this is
     safe). A fresh row, a fallback `tool:` key, or a disabled lease (`false`)
     instead surfaces structured `ActionPendingError` and does not re-execute.
3. Insert `pending`, register an in-memory active promise for same-isolate
   coalescing, run `execute`.
4. On success: store the prepared, JSON-roundtripped model-visible output as
   `settled`. On throw/timeout: delete the pending row and return the normal
   structured action error, allowing a later retry to run again.
5. Retention sweeping is best-effort. `settled` rows default to 30 days;
   `pending` rows default to 90 days; apps can disable sweeping per status.
   Retention is distinct from the retry lease: retention decides when an old row
   is _deleted_; the lease decides when a stale `pending` row may be _reclaimed_.
   Keep `pendingMs` well above the lease so reclaim happens before a sweep.

Reconciliation with existing keyspaces (the "one keyspace" requirement):

- The ledger is a separate table, but its `key` is **derivable from** the
  upstream identity so a webhook → submission → action chain dedups end to end:
  callers should set `idempotencyKey` to incorporate the
  `cf_think_submissions.idempotency_key` or `idempotencyKeyForEvent` value when
  the action is the side effect of a deduped event. The RFC does not auto-couple
  them (that would be surprising); it documents the pattern and lets the action
  derive a stable semantic key from its input/context.
- Transcript first-write-wins (`tool-state.ts`) still applies and is the _model-
  visible_ dedup; the ledger is the _side-effect_ dedup. They are complementary:
  transcript prevents the model from re-calling; the ledger prevents a recovery
  retry from re-executing.

Coordination with the recovery RFC: the ledger is consulted on every action
execution including recovery re-entry (`recovery-continue`/`recovery-retry` from
the Turns RFC). The recovery engine's "a settled tool result is not accidentally
replayed" promise is implemented here for side effects when the action key is
stable across the re-entry path.

### 7. Recovery taxonomy

`ActionKind` maps to concrete recovery behavior, mirroring the recovery
adapter's `classifyRecoveredTurn` outcomes so one model covers tools and
channels:

| Kind              | On crash mid-flight                                                              | Replay safety                                                                                            |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `server`          | re-run via recovery retry                                                        | ledger returns settled result for stable keys; otherwise re-executes                                     |
| `client`          | client re-resolves                                                               | resolved client-side; not server-executed                                                                |
| `approval-gated`  | parked (pending interaction → budget-free)                                       | re-executes only after approval; ledger applies post-approval                                            |
| `durable-pause`   | parked in durable store; resumes via `approveExecution` (connection-independent) | claim-by-delete on the pending row is the dedup anchor; the approved run flows through the action ledger |
| `delegated-agent` | child run reattached, not restarted                                              | child's own ledger/recovery (`agent-tools.md`)                                                           |

Kind is inferred when not explicit: `approval` set → `approval-gated`; no server
`execute` → `client`; delegates to a sub-agent → `delegated-agent`; otherwise
`server`. **`durable-pause` is never inferred** — it changes the turn lifecycle
(the turn ends and resumes later), so it must be requested explicitly via
`kind: "durable-pause"`.

### 8. Guardrails (defaults)

Standardize the protections that currently exist only inside specific tools:

- **Per-action timeout.** Default by kind (`server`: 30s; `client`/`approval`/
  `durable-pause`: none). Implemented as an `AbortController` linked to the turn
  signal; `ctx.signal` is the combined signal. (Today only bash/execute bound
  time — `workspace.ts:1186`, `execute.ts:103`.)
- **Structured tool errors.** Thrown errors are caught and mapped to a stable
  envelope surfaced as the existing `output-error` part state with `errorText`
  (`message-builder.ts:315`), so the stream never crashes on a tool throw and
  the model sees `{ error: { name, message } }` it can reason about.
- **Output truncation.** Large outputs are truncated with a truncation notice,
  reusing `truncateToolOutput` semantics (`workspace.ts:1234`); overflow is
  recorded as observability.
- **Safe stringification.** Outputs are serialized defensively (handle
  circular refs / bigint) before persistence, reusing/extending
  `normalizeToolInput`-style safety (`message-builder.ts:83`).

These are defaults; each is overridable per action.

### 9. `ctx.attachReply(...)`

A typed side-channel for delivery metadata that influences how the final reply
is rendered without changing the tool's model-visible output. Today messenger
delivery strips everything except text deltas (`delivery.ts:190`), so there is
no way for a tool to say "deliver this as audio."

```ts
type ReplyAttachment =
  | { type: "voice_note" }
  | { type: "email_draft"; subject?: string; to?: string[] }
  | { type: "card"; payload: unknown }
  | { type: string; [k: string]: unknown }; // open union; channels extend it

const markAsVoiceNote = action({
  description: "Send the final reply as a voice note",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    ctx.attachReply({ type: "voice_note" });
    return { acknowledged: true };
  }
});
```

Implementation: attachments accumulate on the active turn (keyed by
`requestId`) and are exposed at the existing response hook point —
`onChatResponse` / `_fireResponseHook` — via
`ChatResponseResult.attachments`. Think also exposes
`replyAttachments(requestId?)` as a server-side getter for programmatic callers
that need to inspect the most recent turn after it completes. This RFC only
defines the recording API and the open `ReplyAttachment` union; it does not
render anything.

**Shipped subset:** `ctx.attachReply(attachment)` is implemented for normal
server-action execution and for approval-gated actions after approval (the AI
SDK re-invokes `execute` inside a regular turn). Attachments are advisory and
best-effort: invalid values are ignored, payloads are JSON-normalized on record
(so bigint/circular/function/symbol values cannot break downstream persistence
or RPC), snapshots are deep-copied on read, and a per-turn cap drops extras.
Policy callbacks (`approval`, `permissions`, function-valued `idempotencyKey`)
receive a no-op `attachReply`; attachments from an `execute` that later throws
or aborts are discarded. The shared `agents/chat` lifecycle type uses an open
base shape for `ChatResponseResult.attachments`; Think exports the named
`voice_note` / `email_draft` / `card` union for `ctx.attachReply` DX.

`durable-pause` approved actions are a v1 no-op for `attachReply`: approval runs
their `execute` under the original pause row, then delivers the result through a
later continuation turn with a new `requestId`. Persisting attachments on the
pause row or ledger so they survive that handoff remains future work. This is
the same lifetime rule as ledger replay: attachments are guaranteed only on the
producing attempt and are not re-applied when `execute` is skipped.

## Type integration

- `action<Input, Output>` infers `Input` from `inputSchema`, so `execute` is
  fully typed with no code generation. This is the primary type story.
- `getActions()` returns `Record<string, Action>`; the registration key is the
  default action name.
- The framework discovery/manifest already models tools
  (`ThinkFrameworkTool`, `framework/manifest.ts`); discovery can additionally
  record action `name`/`permissions`/`approval`/`kind` so `think inspect` and
  docs can list them. The generated `think.d.ts` (`framework/types-codegen.ts`)
  does **not** need per-action types — TS inference covers `execute`. (Optional,
  coordinated with the tooling-dx work.)

## Observability

New `action:*` events, parallel to `chat:recovery:*` and the Turns RFC's
`chat:turn:*`:

- `action:invoked` — `{ requestId, toolCallId, action, kind }`
- `action:authorized` / `action:denied` — `{ action, required, granted }`
- `action:approval-requested` / `action:approval-resolved` — `{ approved }`
- `action:settled` — `{ durationMs, truncated }`
- `action:replayed` — `{ from: "ledger" }`
- `action:timed-out` / `action:error` — `{ name, message }`
- `action:reply-attached` — `{ action?, attachmentType }`

These give a consistent action ledger across surfaces and feed the
recovery-visible UI story.

## Versioning and compatibility

- `@cloudflare/think` is pre-1.0 (0.9.x); these are additive minor changes with
  a changeset.
- New: `action()` export, `getActions()` hook (default `{}`),
  `authorizeTurn`/`authorizeAction` hooks (default full-grant → no behavior
  change), approval descriptors on action approval parts, `ctx.attachReply`, and
  `ChatResponseResult.attachments`.
- Unchanged: `getTools()`, `beforeToolCall`/`afterToolCall`, both approval paths.
  Actions are ordinary tools downstream, so they compose with all of these.
- `attachReply` records advisory delivery hints only; Channels/Voice still own
  rendering, so unrecognized attachments are ignored by consumers.

## Testing strategy

1. **Conversion unit tests.** `actionToTool` produces a valid AI SDK tool;
   `needsApproval` derives from `approval`; `beforeToolCall` still gates it.
2. **Authorization tests.** Default full-grant is back-compatible; required ⊄
   granted → structured `output-error`, no execute; custom `authorizeAction`.
3. **Ledger tests.** Settled key replays stored result without re-executing;
   reused key + different input errors; `pending` window policy; key derived
   from submission/event id dedups end to end.
4. **Approval flow tests.** `approval-gated` drives the existing
   `approval-requested → tool-approval → auto-continuation` path;
   `durable-pause` parks and resumes via `approveExecution`. Stable descriptor
   present on the part.
5. **Reply attachment tests.** `ctx.attachReply` records JSON-safe attachments
   on normal and approval-gated action execution, caps per-turn volume, exposes
   them on `ChatResponseResult.attachments` / `replyAttachments()`, ignores
   predicate/durable-pause-resume no-op calls, and does not re-fire on ledger
   replay.
6. **Guardrail tests.** Timeout aborts via `ctx.signal`; thrown error →
   `output-error` (stream survives); truncation + notice; safe-stringify on
   circular/bigint.
7. **Recovery-coordination tests.** A settled action is not re-executed on
   `recovery-continue`/`recovery-retry`; reuse the deploy-churn e2e style
   (which already uses a `tool_ledger` fixture) to prove no double side effect
   across a crash.

## Edge cases and invariants

- **`beforeToolCall` precedence.** It remains the outermost gate. A `block`
  there short-circuits before authorization/ledger/execute, unchanged.
- **Client actions never hit the ledger or server execute** — they compile to
  schema-only client tools (`createToolsFromClientSchemas`, `client-tools.ts`).
- **Ledger applies per settled outcome, not per attempt** — a `failed` row does
  not block a legitimate retry; only `settled` short-circuits.
- **Approval denial is terminal for that call** — maps to `output-denied`
  (`tool-state.ts:204`); the action does not execute and the ledger records
  nothing.
- **`attachReply` is advisory** — it never alters the tool's model-visible
  output, invalid values are ignored, payloads are JSON-normalized and capped per
  turn, and an unrecognized attachment type is ignored by surfaces that don't
  understand it.
- **`attachReply` belongs to successful `execute`.** Approval predicates,
  permission policies, and function-valued idempotency keys receive a no-op
  recorder; if `execute` attaches and then fails/aborts, the attachments from
  that failed attempt are rolled back.
- **`attachReply` lifetime.** Normal server actions and approval-gated actions
  after approval can attach reply metadata in the producing turn. Durable-pause
  approved actions are a v1 no-op because the final reply is delivered by a later
  continuation turn with a new request id; persisting attachments across that
  handoff remains future work.
- **Timeout vs turn abort** — `ctx.signal` fires on either; the action must
  treat abort as "stop now," and partial side effects are the action's
  responsibility (the ledger records `failed`/`pending`, not partial success).
- **Full-grant default** — until an app overrides `authorizeTurn`, every action
  is permitted, so adding `permissions` to an action is non-breaking until
  authorization is wired.
- **Authorize before approval.** Authorization (step 2) runs before the approval
  prompt (step 3): an unauthorized approval-gated action returns `output-error`
  immediately and is never surfaced for approval.
- **`attachReply` on ledger replay.** A replayed (settled) action returns its
  stored `result_json` _without_ running `execute`, so its `attachReply` side
  effect does not re-fire. In v1, attachments are best-effort and guaranteed only
  on the producing attempt (delivery is same-turn). If an attachment must survive
  replay, store it in the ledger alongside `result_json` and re-apply on replay
  (see Open Questions).

## The alternatives

- **Document `beforeToolCall` for all of this.** Keeps surface small but leaves
  permissions/idempotency/guardrails as imperative per-app code — the status quo
  we are trying to fix. Rejected.
- **Use AI SDK `needsApproval` and nothing else.** Covers approval only; no
  stable descriptor, permissions, idempotency, or guardrails. Rejected as
  insufficient, but reused _as a backend_.
- **Idempotency keyed only by `toolCallId`.** Simple and crash-safe within one
  turn, but cannot dedup across webhook retries or submissions. Kept as the
  _fallback_ key; explicit `idempotencyKey` is the cross-cutting one.
- **Auto-derive `idempotencyKey` from an input hash by default.** Dangerous:
  two legitimate identical refunds would collapse. Rejected as a default;
  available by opt-in.
- **Put actions only in `getTools()` (auto-detect `Action`).** Tempting for one
  hook, but muddies the `ToolSet` type. Proposed as optional sugar on top of the
  dedicated `getActions()` hook.
- **A separate `@cloudflare/actions` package.** Premature; actions are tightly
  coupled to Think's turn/recovery internals. Keep in `@cloudflare/think`
  (top-level or `@cloudflare/think/actions` subpath — Open Question).

## Open questions and what could force a redesign

- **`pending` ledger window.** The hardest case: an action inserted `pending`,
  executed its side effect, then crashed before marking `settled`. On recovery
  we cannot know if the side effect happened. Options: (a) require
  side-effecting actions to be externally idempotent and re-execute; (b) surface
  an "unknown outcome" error and require human/compensation handling; (c) a
  two-phase `prepare`/`commit` action shape. Likely (a) as default with (b) as
  opt-in. This could force an `ActionConfig` shape change.
- **Where granted permissions come from.** Still open. The Channels RFC shipped
  v1 **without** channel grants, so `authorizeTurn` does not yet receive any
  channel-injected default grants. The seam exists: `ChannelContext` is resolved
  turn-scoped at admission and is the natural place to hang a future `grants`
  field that `authorizeTurn` would read. This is a future slice, not built.
- **`attachReply` delivery lifetime + replay.** Exact storage and the surfaces
  that consume it are owned by the Channels/Voice RFCs; if they need richer
  per-attachment routing, the union and storage may grow. Open sub-question:
  whether to persist attachments in the ledger so they survive a settled-action
  replay (v1 treats them as best-effort, producing-attempt only).
- **`action()` package location** (top-level vs `@cloudflare/think/actions`)
  during the experimental phase.
- **Ledger retention/TTL** and size bounds (settled rows accumulate).
- **Should `getActions()` and `getTools()` eventually merge** once `Action`
  detection in `getTools()` is proven.

## Implementation notes (for a fresh session)

Line numbers in this RFC are approximate (captured at writing time); search by
symbol name first.

Where things live:

- Package `packages/think/`; main class `packages/think/src/think.ts`. The tool
  merge (where `getActions()` plugs in), `_wrapToolsWithDecision`, and the
  `beforeToolCall`/`afterToolCall` hooks all live in `_runInferenceLoop` in
  `think.ts`.
- Approval/HITL: `_applyToolApproval`, `approveExecution`/`rejectExecution`, and
  auto-continuation (`_scheduleAutoContinuation`) in `think.ts`; tool part-state
  helpers in `packages/agents/src/chat/tool-state.ts`; part states
  (`output-error`/`output-denied`, `errorText`) in
  `packages/agents/src/chat/message-builder.ts`.
- Client tools: `packages/agents/src/chat/client-tools.ts`
  (`ClientToolSchema`, `ClientToolExecutor`, `createToolsFromClientSchemas`) —
  the `client` action kind compiles to these.
- Idempotency keyspaces to reconcile with: `cf_think_submissions.idempotency_key`
  (`think.ts`) and `idempotencyKeyForEvent` (`packages/think/src/messengers/chat-sdk.ts`).
- Guardrail patterns to reuse: `truncateToolOutput` and bash time-bounding in
  `packages/think/src/tools/workspace.ts`; execute truncation in
  `packages/think/src/tools/execute.ts`; input normalization
  (`normalizeToolInput`) in `packages/agents/src/chat/message-builder.ts`.
- Reply delivery hook points `attachReply` feeds: `_fireResponseHook` /
  `onChatResponse` (`think.ts`) and the messenger `TextStreamCallback`
  (`packages/think/src/messengers/delivery.ts`).
- Types: `ToolSet`/`ModelMessage`/`tool`/`StandardSchemaV1` from `ai`;
  `Cloudflare.Env` is ambient; `TurnContext`/`StreamCallback` from `think.ts`.
- Framework discovery/manifest (optional `think inspect` integration):
  `packages/think/src/framework/manifest.ts`, codegen in
  `packages/think/src/framework/types-codegen.ts`.
- Tests: `packages/think/src/tests/` (`npm run test:workers`). The deploy-churn
  e2e already uses a `tool_ledger`-style fixture to model the new ledger tests
  on. Build `tsx ./scripts/build.ts`; repo gate `pnpm run check`; changeset
  required for `packages/` changes; no `any`, use `import type`.

Suggested implementation order:

1. `action()` + `Action` brand + `getActions()` + `actionToTool` with guardrails
   (timeout, structured errors, truncation, safe-stringify). No
   permissions/ledger yet — pure additive win.
2. Stable approval descriptor over the existing approval-gated AI SDK path, and
   (Step 5) the unified descriptor + durable-pause store + connection-independent
   resume for durable-pause and codemode pauses.
3. `authorizeTurn`/`authorizeAction` (default full-grant).
   Shipped for server actions.
4. `cf_think_action_ledger` for replay-safe settled server actions; reconcile
   keys with submissions/events. Sequence the recovery-replay tests after the
   chat-recovery RFC lands.
5. `ctx.attachReply` recording shipped: advisory, JSON-safe reply attachments
   surface on `ChatResponseResult.attachments` / `replyAttachments()` and remain
   inert until Channels/Voice consume them.
6. `action:*` observability.

## The decision

_Pending review._ Proposed direction: ship `action()` + `getActions()` with
authorization hooks defaulting to full-grant, a `cf_think_action_ledger` for
replay-safe settled server actions reconciled with submission/event keys, a
stable approval descriptor over the two existing approval paths, standard
guardrails, and `ctx.attachReply()` recording for the Channels/Voice RFCs to
consume. All additive; sequence the ledger/recovery reconciliation after the
chat-recovery foundation lands.
