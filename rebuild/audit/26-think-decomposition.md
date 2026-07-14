# 26 — Think decomposition: extracting the remaining deep modules

**Refactor wave, bundled with doc 25.** After waves 0–6, `app/think.ts` is
~1,440 lines: a real composition root plus ~700 lines of orchestration logic
that accreted there for the same structural reason the original god class
grew — the root is the only place that sees everything. This doc extracts the
logic into deep modules and defines what is *allowed* to remain.

## What may remain in `app/think.ts` (target ≤ ~450 lines)

- The overridable configuration surface (fields, hook properties, `getX()`
  methods, `configure()`/`getConfig()` blob).
- The constructor: `createX(...)` wiring with scoped stores.
- `ensureRuntime()` (the subclass-field-initialization-order workaround).
- Entry points as **thin** delegation: normalize input → build `TurnRequest`
  → call the pipeline / service. A method body longer than ~15 lines is a
  smell; move the logic into the owning module.

Same rule applies to `app/agent.ts` (already close; doc 25 removes its
frame/connection code).

## Extraction 1 — `domain/chat/turn-state.ts` (ConversationTurnState)

Think currently hand-writes raw keys (`partialKey`, `channelKey`,
last-request-id) and implements `commitInterruptedPartial` inline — violating
the "each module owns its prefix" rule. Extract:

```ts
export interface ConversationTurnState {
  recordPartial(requestId: string, message: ChatMessage): void;
  partialFor(requestId: string): ChatMessage | undefined;
  clearPartial(requestId: string): void;
  lastRequestId(): string | undefined;
  setLastRequestId(id: string): void;
  channelFor(requestId: string): string | undefined;
  stampChannel(requestId: string, channelId: string): void;
  /** Repair the recorded partial (repairTranscript on the single message) and
      append it to the session; clears the partial. No-op without a partial. */
  commitInterruptedPartial(requestId: string, session: Session,
    repairPart?: (part: ToolPart) => MessagePart): Promise<ChatMessage | undefined>;
}
export function createConversationTurnState(deps: { store: KeyValueStore /* prefix "turnstate:" */ }): ConversationTurnState;
```
`createChatRecovery`'s `conversation` dep shrinks: it takes this object plus
two callbacks (`scheduleTurn(request)`, `terminalize(incident, message)`)
instead of five Think closures.

## Extraction 2 — `domain/chat/continuation.ts` (PendingInteraction service)

The client-tool / approval resolution loop is one domain concept currently
smeared across `handleToolResultFrame`, `handleToolApprovalFrame`,
`maybeAutoContinue`, and `onActionResolved`:

```ts
export interface PendingInteractions {
  /** Write a client tool's output into the persisted message's matching tool
      part; publish message:updated; maybe schedule continuation. */
  applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void>;
  /** Approval for an approval-gated tool part (execute or deny) or a parked
      durable-pause execution (delegates to ActionService). */
  resolveApproval(args: { toolCallId?: string; executionId?: string;
    approved: boolean; reason?: string }): Promise<void>;
  /** Called after any message mutation: if the last assistant message's tool
      parts are all settled, debounce then request a continuation turn. */
  maybeContinue(message: ChatMessage): void;
  cancelPending(): void;   // clear debounce timers (used by clearMessages/destroy)
}
export function createPendingInteractions(deps: {
  session: () => Promise<Session>;
  actions: ActionService;
  tools: () => Promise<AssembledTools>;         // to re-execute approved server tools
  publish: (e: ConversationEvent) => void;
  requestContinuation: () => void;              // Think enqueues a continuation TurnRequest
  debounceMs?: number;                          // default 150; 0 = sync
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}): PendingInteractions;
```
Think's public `applyToolResult`/`resolveApproval` (doc 25) delegate here.
Behavior to preserve: approval-denied → tool part `output-error`
("denied: <reason>") + continuation; approved server tool executes with a
fresh ToolExecutionContext; all-parts-settled check; per-message debounce
keyed by message id; timers cancellable.

## Extraction 3 — `domain/chat/assembly.ts` (TurnAssembly)

`buildAssembly` is a pure-ish algorithm (merge order, prompt concatenation)
that deserves direct tests:

```ts
export interface AssemblyInputs {
  session: Session; skills: SkillRegistry; policy: ChannelPolicy;
  workspaceTools?: ToolSet; fetchTools?: ToolSet; actions: ToolSet;
  userTools: ToolSet; clientTools?: ToolSet;
  hooks?: ToolHooks; clock: Clock;
}
export function assembleTurn(inputs: AssemblyInputs):
  Promise<{ system: string; tools: AssembledTools }>;
```
Prompt order (unchanged, now tested here): frozen session prompt →
channel instructions → skills catalog → capability block, joined by blank
lines, empty segments dropped. Tool merge order unchanged (doc 08).

## Extraction 4 — durable-pause parking moves into ActionService

`finalizeOutcome`'s suspended-case block reads `metadata.durablePause`,
`resolvePermissions`, `approvalRisk` — metadata that `ActionService.compile`
wrote. The writer should be the interpreter:

```ts
// on ActionService:
maybeParkSuspension(args: { requestId: string;
  pending: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  tools: AssembledTools }): { parked: boolean; executionId?: string };
```
Think's outcome handling calls this and otherwise stays metadata-blind.

## Extraction 5 — kill the facades: Agent exposes its services

`buildSchedulerFacade`/`buildFiberFacade` and the
`__thinkRunDeclaredTaskOccurrence` fake-method dispatch hack exist only
because `Agent` constructs its `Scheduler`/`FiberService`/`KeepAlive`
privately. Change `Agent` to expose them to subclasses:

```ts
protected readonly schedulerService: Scheduler;
protected readonly fiberService: FiberService;
protected readonly keepAliveService: KeepAlive;
/** Register an internal scheduler callback ("$internal:*") — replaces the
    prototype-method dispatch hack for module-owned callbacks. */
protected registerInternalCallback(name: string, fn: (payload: unknown) => Promise<void>): void;
```
Public wrapper methods (`schedule()`, `runFiber()`, ...) stay — they're the
app-facing API — but Think passes the real services to
`createScheduledTaskService`/`createChatRecovery` and both facades plus the
fake method are deleted.

## Extraction 6 — `SessionBuilder` moves to `domain/session/builder.ts`

Mechanical move (it's domain logic living in app/), unchanged behavior,
re-exported from think.ts for API compatibility.

## Resulting shape of the pipeline (stays in Think, now legible)

After extractions 1–4 plus doc 25's event publishing, `runAdmittedTurn`
should read as a ~50-line sequence with no inline algorithms:

```
stamp channel (turnState) → append new messages (session)
→ assembleTurn(...) → authorizeTurnOnce
→ publish(turn:started) → engine.run with emit = publish(chunk) + turnState.recordPartial
   (wrapped in recovery when enabled)
→ stall/overflow outcome routing (services decide; Think switches)
→ settle: persist message, actions.maybeParkSuspension, publish(turn:settled)
→ pendingInteractions.maybeContinue
```
The `emit` closure becomes two calls (publish + recordPartial); the
relay/broadcast/buffer sinks are gone (doc 25 — subscribers of the log).

## Test guidance

Each extracted module gets its own test file (move the relevant cases out of
`think.test.ts`, which shrinks to config-surface + wiring tests). Add one
"shape" test: `think.ts` line count under a threshold (~500) and the doc-25
banned-token grep — crude, but it's the regression alarm for god-object
re-accretion.
