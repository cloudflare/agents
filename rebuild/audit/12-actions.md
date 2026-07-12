# 12 — Actions: idempotent, approvable, authorized tools

Original: `action()` descriptor factory + compilation into tools + a durable
action ledger + approval flows (inline and durable-pause) + per-turn
authorization + reply attachments, all inside think.ts. This is the richest
Think subsystem; port it faithfully.

## The descriptor

```ts
export interface ActionConfig<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input, ctx: ActionContext) => Output | Promise<Output>;
  name?: string;                                   // defaults to map key
  idempotencyKey?: string | ((args: { input: Input }) => string);
  permissions?: readonly string[] | ((args: { input: Input }) => readonly string[]);
  approval?: boolean | ((args: { input: Input }) => boolean | Promise<boolean>);
  approvalSummary?: string;                        // default: description
  approvalRisk?: "low" | "medium" | "high";
  kind?: "server" | "approval-gated" | "durable-pause";  // inferred: approval set → approval-gated, else server
  timeoutMs?: number;                              // default 30_000
}
export interface ActionContext {
  requestId: string; toolCallId: string;
  messages: ReadonlyArray<ChatMessage>;
  signal: AbortSignal;                             // aborts on turn cancel OR timeoutMs
  attachReply(attachment: ReplyAttachment): void;
}
export type ReplyAttachment = { type: string; [k: string]: unknown };  // built-ins: email_draft, card, voice_note
export function action<I, O>(config: ActionConfig<I, O>): Action<I, O>;
export function isAction(v: unknown): v is Action;
```

Definition-time validation: `kind: "durable-pause"` without an `approval`
policy → ValidationError ("an action that would never park is rejected").

## Compilation to tools (`compileActions(actions, deps) → ToolSet`)

Each action becomes a `Tool` whose execute wraps the pipeline below. Output is
normalized to JSON and truncated (`truncateForModel`, cap ~16k chars) before
the model sees it. A thrown execute becomes `{ error: { name, message } }` —
the turn never crashes.

### Pipeline per call
1. **Authorization.** Resolve `requiredPermissions` (static or fn). Consult
   the authorization decision (below). Denied → output
   `{ error: { name: "ActionAuthorizationError", message, permissions } }`;
   execute never runs.
2. **Approval.**
   - `approval-gated`: evaluate the predicate; if approval needed, the
     compiled tool reports `needsApproval` → turn suspends with an
     `ActionApprovalDescriptor`
     `{ requestId, toolCallId, action, summary, input, permissions, risk, kind: "approval-gated" }`.
     On approve → continue to step 3; on reject → output error value
     `{ error: { name: "ActionRejectedError", message } }`.
   - `durable-pause`: park the execution durably
     (`{ executionId, descriptor, input, requestId, toolCallId, status: "parked" }`),
     end the turn (outcome `suspended`, reason `durable-pause`); the tool part
     persists in `approval-requested` state. Resume via `approveExecution` /
     `rejectExecution` below.
3. **Ledger / idempotency.** Key: declared `idempotencyKey` (fn gets input) or
   fallback `toolCallId`. Ledger key `action:<name>:<key>`, storing
   `{ status: "pending" | "settled", inputHash, output?, settledAt?, createdAt }`.
   - Existing `settled` row **with matching inputHash** → return stored output
     without executing (replay). Mismatched inputHash → execute normally under
     a new composite key? No — preserve original semantics: same key + different
     input is still a replay of the settled result (the key is the identity).
   - Existing `pending` row: if the action has an **explicit** idempotencyKey
     AND the row is older than `pendingRetryLeaseMs` (default 300_000; `false`
     disables reclaim) → reclaim (treat as ours, re-run). Otherwise → output
     `{ error: { name: "ActionPendingError", message } }`.
   - Write `pending` before execute; settle on success; **delete** on throw or
     timeout (clean retry).
4. **Execute** with validated input, a signal that aborts on turn-abort or
   timeout, and `attachReply` collecting attachments (JSON-normalized, capped
   at 20/turn, discarded if execute fails; replays do NOT re-fire attachments;
   attachReply is a no-op inside permissions/approval/idempotencyKey callbacks).

## Authorization decisions

```ts
export type AuthorizationDecision = boolean | { allowed: boolean; reason?: string; grantedPermissions?: readonly string[] };
```
- Per turn, Think calls `authorizeTurn(turnCtx)` once (default `true` = full
  grant) and caches the grant set.
- Per call, `authorizeAction(ctx)` decides (default: allowed iff
  `required ⊆ granted`, where a full grant passes everything).
  ctx: `{ requestId, toolCallId, action, kind, input, requiredPermissions, grantedPermissions }`.

## Parked executions API (on the ActionService)

```ts
pendingApprovals(executionId?): Promise<PendingApproval[]>;   // parked durable-pause rows
approveExecution(executionId): Promise<unknown>;   // runs execute once (idempotent — second call no-op),
                                                   // writes tool output into the persisted message,
                                                   // triggers auto-continuation of the turn
rejectExecution(executionId, reason?): Promise<void>;  // settles without executing; tool part → output-error
```
Approve/reject idempotency: settled executions return their prior result / are
no-ops. The continuation wiring (updating the message, resuming the turn) is
Think's (doc 23) — the service exposes callbacks
`onResolved(executionId, { toolCallId, requestId, output | rejection })`.

## Proposed interface (service)

```ts
export interface ActionService {
  compile(actions: Record<string, Action>): ToolSet;   // wraps pipeline; call per turn
  authorizeTurnOnce(ctx: TurnContext): Promise<void>;  // caches grant for requestId
  pendingApprovals(executionId?: string): PendingApproval[];
  approveExecution(executionId: string): Promise<unknown>;
  rejectExecution(executionId: string, reason?: string): Promise<void>;
  attachments(requestId?: string): ReplyAttachment[];  // deep-copied
  clearTurn(requestId: string): void;                  // drop per-turn grant/attachment state
}
export function createActionService(deps: {
  store: KeyValueStore;              // prefixes "action:ledger:", "action:parked:"
  clock: Clock; ids: IdSource; bus: EventBus;
  authorizeTurn?: (ctx: TurnContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeAction?: (ctx: ActionAuthorizationContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  pendingRetryLeaseMs?: number | false;
  onResolved?: (executionId: string, resolution: ParkedResolution) => void | Promise<void>;
}): ActionService;
```

## Tests (TDD list)
- action() inference & definition-time durable-pause validation.
- replay: settled ledger row returns stored output, execute not called.
- pending row without explicit key → ActionPendingError value.
- stale pending + explicit key → reclaimed and re-run; lease disabled → error.
- throw/timeout deletes row (subsequent call re-runs); timeout aborts signal.
- authorization: full grant default; narrowed grant denies with permissions in
  the error; authorizeAction override wins.
- approval-gated predicate (per-input); rejection error value.
- durable-pause: parks, approve runs once (second approve no-op) and fires
  onResolved; reject settles without execute.
- attachments: recorded on success, discarded on failure, capped, not
  re-fired on replay; no-op in key/permission callbacks.
- output truncation for huge outputs.
