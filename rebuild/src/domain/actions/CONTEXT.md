# Actions

Durable, approvable, per-turn-authorized tools. An action compiles into a Tool
(see the Tools context) but earns its own language: a durable ledger, approval and
parking flows, permission grants, and reply attachments. See the
[context map](../../../CONTEXT-MAP.md).

## Language

**Action**:
A descriptor (description, input schema, executor, plus authorization/approval/
idempotency options) that compiles into a model-facing tool.
_Avoid_: tool (an action *becomes* a tool but is authored differently)

**Action kind**:
The execution class of an action: `server` (plain), `approval-gated` (needs inline
approval), or `durable-pause` (parks execution durably).

**Action context**:
The per-call runtime object handed to an action's executor: request id, tool call
id, messages, abort signal, and `attachReply`.

**Reply attachment**:
A structured side-output (e.g. an email draft, a card) collected during execution
via `attachReply`, delivered at end of turn. Capped per turn; not re-fired on
replay.
_Avoid_: attachment (loosely), side effect

**Authorization decision**:
A boolean or `{ allowed, reason?, grantedPermissions? }` gating an action.
_Avoid_: permission check result

**Grant**:
The set of permissions authorized for a turn by the once-per-turn turn
authorization; individual calls are allowed when their required permissions are a
subset of the grant.
_Avoid_: allowance

**Permissions**:
The static or input-derived permission strings an action requires; denial yields
an authorization error value.

**Action ledger**:
The durable store of action executions (status pending/settled, input hash,
output) enabling idempotency and replay.
_Avoid_: history, audit log

**Idempotency key (action)**:
The identity of a ledgered execution (the declared key, or the tool call id). A
settled row with the same key returns its stored output even if the input differs —
the *key* is the identity.

**Replay**:
Returning a settled ledger row's stored output without re-executing. Replays do not
re-fire reply attachments.
_Avoid_: retry — the event-stream sense of "replay" (Conversation's
`ConversationEventLog`, re-sent on reconnect by the websocket-chat adapter) is
unrelated.

**Pending retry lease**:
The age after which a still-`pending` ledger row (with an explicit idempotency key)
may be reclaimed and re-run; otherwise the call returns a pending error value.
_Avoid_: lock timeout

**Approval descriptor**:
The payload emitted when an approval-gated action suspends a turn: action, summary,
input, permissions, risk, kind.

**Parked execution**:
A durably persisted, paused `durable-pause` action awaiting resolution; the turn
ends `suspended` and the tool part persists in an approval-requested state.
_Avoid_: pending action, paused tool

**Approve / reject execution**:
Resolving a parked or approval-gated action — approve runs the executor once
(idempotent) and writes output into the persisted message; reject settles without
executing.
