Status: accepted — `runTurn`, `addMessages`, `TurnSpec`, and `_admitTurn`
shipped; the remaining input-superset work is tracked as follow-up.

# RFC: Think turns — `runTurn()`, `TurnSpec`, and `addMessages()`

Related:

- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) — the lower-layer recovery extraction this RFC must coordinate with
- [think.md](./think.md) — Think design doc
- [think-sessions.md](./think-sessions.md) — Session tree, compaction, FTS
- [think-vs-aichat.md](./think-vs-aichat.md) — boundary with AIChatAgent
- Strategy plan: `think_api_strategy` (the parent plan this RFC implements)

## Status and dependencies (read first)

This is one of three sibling API RFCs (turns, actions, channels) meant to be
picked up in **separate** sessions. Build them in this order — **Turns →
Actions → Channels** — because the later two depend on seams this RFC defines:

- **Actions RFC** needs the `TurnContext`/recovery taxonomy and the
  `recovery-continue`/`recovery-retry` triggers defined here, and authorizes at
  `_admitTurn` time.
- **Channels RFC** (shipped) uses `runTurn({ channel })` and `addMessages()` (for
  `informModel`). It threads the bare `channel` id through `_admitTurn` into a
  turn-scoped `_activeChannelContext` rather than the originally-reserved
  `TurnSpec.channelContext` (never built).

What is already built vs. still open in **this** RFC:

- ✅ **`addMessages()` — SHIPPED** (`packages/think/src/think.ts`, method
  `addMessages` ~`think.ts:6986`; `AddMessagesOptions` exported ~`think.ts:913`).
  Section 3 below is the spec it shipped against; it is kept for context and as
  the upsert/append/idempotency contract — **do not re-implement it.** Any
  divergence found in code is the source of truth, not this section.
- ✅ **`runTurn()` facade — SHIPPED** (step 2). Public `runTurn(options)` with
  `mode: "wait" | "submit" | "stream"` delegates to the existing
  `saveMessages` / `continueLastTurn` / `submitMessages` / `chat` methods.
  Step-2 option surface is intentionally narrowed per mode (no unified
  `RunTurnBase` superset yet); in-queue re-entrancy guard deferred to step 3
  `_admitTurn`. Exported types: `TurnInputMessages`, `RunTurnBase`, `RunTurnWait`,
  `RunTurnSubmit`, `RunTurnStream`, `RunTurnOptions`, `TurnResult`.
- ✅ **`TurnSpec`/`_admitTurn` — SHIPPED** (step 3). The as-built extraction keeps
  path-specific bodies/order intact while routing every turn admission through an
  internal `TurnSpec`/`_admitTurn` spine. Submission admission and submission
  drain execution are split so the drain never re-enters row insert/dedup.
  Blocking nested queue admissions (`wait`/`continuation`/`stream`) now throw via
  an async-local admitted-turn marker; legitimate concurrent non-nested turns
  still enqueue behind. Current `saveMessages([])` and function-returning-empty
  behavior is preserved for compatibility.

Recovery-RFC gate (see "Coordination with the chat-recovery RFC"): the
`runTurn` _facade_ (suggested order step 2) can land anytime, but the
`_admitTurn`/`TurnSpec` _extraction_ should follow chat-recovery RFC Phases 0–1
(ideally Phase 3) so it targets `ThinkRecoveryAdapter`
(`classifyRecoveredTurn`/`resolveStreamForRecovery`) rather than the
pre-refactor private methods.

> **Name reconciliation (updated 2026-06).** The recovery seam shipped
> as **`ChatRecoveryAdapter`** in `agents/chat` (not `ThinkRecoveryAdapter`). Chat-recovery
> Phases 0–5 and the engine extraction are complete; the wake-path decision shipped as the
> package-owned `ChatFiberWakeHooks` hook pair — a `classifyRecoveredTurn`-shaped classifier
> plus a `dispatchRecoveredTurn` decision — which is exactly the seam `_admitTurn` should
> target via the `recovery-continue` / `recovery-retry` triggers. The chat-recovery RFC's
> "Substrate capabilities are optional" decision guarantees `Think`'s recovery decision
> stays package-owned (submission lifecycle + Session leaf live in `Think`), so this
> RFC's extraction is unblocked. When implementing, use the real names or update them
> here in the same change — don't leave both drifting.

## The problem

Every model turn in Think converges on one private method,
`_runInferenceLoop(input: TurnInput)` (`packages/think/src/think.ts:3873`). That
convergence is good. The problem is everything _above_ it: there are at least
seven public/internal admission paths that each re-implement "persist some
messages, bind a request id, optionally wrap a recovery fiber, enqueue on the
turn queue, pick a stream sink, run the loop, stream the result" with small
differences:

- `chat(userMessage, callback, options)` — sub-agent RPC / messenger entry, RPC
  callback sink (`think.ts:4664`).
- `_handleChatRequest(connection, event)` — WebSocket browser chat, broadcast
  sink, client-supplied request id, concurrency/generation binding
  (`think.ts:7524`).
- `saveMessages(messages, options)` → `_runProgrammaticMessagesTurn` —
  programmatic blocking turn, silent persistence sink (`think.ts:6916`,
  `6926`).
- `submitMessages(messages, options)` — durable async submission with
  idempotency, drains into `_runProgrammaticMessagesTurn` (`think.ts:6421`).
- `continueLastTurn(body, options)` — continuation turn from the latest
  assistant leaf (`think.ts:7130`).
- `_retryLastUserTurn(...)` / `_chatRecoveryRetry` and `_chatRecoveryContinue` —
  recovery re-entry (`think.ts:7226`, `10702`, `10942`).
- `_fireAutoContinuation` — tool-batch auto-continuation (`think.ts:11419`).

`startAgentToolRun` is an eighth caller of `_runProgrammaticMessagesTurn`
(`think.ts:4961`). Scheduled prompt tasks (`_runDeclaredScheduledTask`,
`think.ts:5734`) and workflow `step.prompt` (`workflows.ts:104`) both funnel
through `submitMessages`.

Two consequences:

1. **No single mental model for "run a turn."** Users learn `chat`,
   `saveMessages`, `submitMessages`, and "WebSocket just works" as unrelated
   APIs, even though they are the same operation with different admission and
   delivery. This directly undercuts the strategy goal of making Think _smaller
   to learn_.
2. **Admission logic is duplicated and drifts.** Each path independently decides
   request-id source, persistence, recovery-fiber wrapping, turn-queue
   generation binding, and overflow-retry policy. This is the same class of
   drift the recovery RFC is removing one layer down.

Separately, there is a **documentation/API gap**: docs reference a Think
`persistMessages()` for silent transcript writes, but Think has no such public
method. No-turn writes today go only through protected hooks
(`appendMessageToHistory`, `updateMessageInHistory`, `think.ts:2657`, `2665`)
and internal helpers (`_hostSendMessage`, `_appendMessageToHistory`). There is
no supported public way to add a message to history _without_ starting a model
turn.

## Goals

- Introduce one public, explicit API — `runTurn(...)` — that is the unifying
  mental model for starting/continuing a turn, with admission and delivery
  expressed as options rather than as separate methods.
- Introduce an internal `TurnSpec` that captures every dimension the existing
  admission paths vary on, so those paths become thin adapters over one shared
  admission routine.
- Add a public `addMessages(...)` for no-turn transcript writes with
  append/upsert semantics into the Session tree, distinct from AIChatAgent's
  replace-semantics `persistMessages()`.
- Keep every existing public API working with unchanged signatures and return
  values. `runTurn` leads the docs; the existing methods become documented
  shortcuts.
- Coordinate the internal refactor with the chat-recovery foundation RFC so the
  two large `think.ts` rewrites do not collide.

## Non-goals

- Changing recovery policy, budgets, or the `chatRecovery` / `onChatRecovery`
  surface. That is the recovery RFC's domain; `runTurn` rides on it.
- Changing the inference loop (`_runInferenceLoop` / `TurnInput`) semantics.
- Channels, notices, `deliverNotice()`, rich `action()`, or voice. Those are
  separate RFCs. This RFC only adds a `channel` passthrough field so the channel
  RFC has a seam to attach to.
- Multi-session routing changes (see `rfc-think-multi-session.md`).
- Any change to `AIChatAgent` beyond documenting the `persistMessages` vs
  `addMessages` distinction.

## The proposal

Three additions, in order of importance (all three have shipped — see Status):

1. `runTurn(options)` — public unifying turn API. **(✅ shipped)**
2. `TurnSpec` + an internal `_admitTurn(spec)` routine — the shared admission
   path the existing methods delegate to. **(✅ shipped)**
3. `addMessages(...)` — public no-turn transcript write. **(✅ shipped)**

### 1. `runTurn(options)`

`runTurn` is a single method whose `mode` selects admission/delivery. It is the
recommended way to start work from application code; the existing methods remain
as shortcuts.

```ts
type TurnInputMessages =
  | string
  | UIMessage
  | UIMessage[]
  | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>);

interface RunTurnBase {
  /**
   * Messages to admit. A string is sugar for a single user text message.
   * Optional ONLY when `continuation: true` (continue the latest assistant
   * leaf with no new input). Providing both `input` and `continuation: true`,
   * or neither, is an error. See "Input shapes and evaluation".
   */
  input?: TurnInputMessages;
  /**
   * Caller-supplied request id. Defaults to a generated UUID. Provide one to
   * correlate logs/traces or to cancel the turn (`cancelChat(requestId)`)
   * before `callback.onStart` fires. The WebSocket path supplies the client's
   * `event.id` here internally.
   */
  requestId?: string;
  /** External abort signal, bridged into the turn's request controller. */
  signal?: AbortSignal;
  /** Per-turn client tool schemas (not persisted to `_lastClientTools`). */
  clientTools?: ClientToolSchema[];
  /** Custom body exposed on `TurnContext.body` for `beforeTurn`. */
  body?: Record<string, unknown>;
  /**
   * Optional channel/surface tag (a plain string). Delivered by the Channels
   * RFC: it threads through every `runTurn` dispatch mode into `_admitTurn`,
   * where the runtime resolves it to a turn-scoped `_activeChannelContext` and
   * persists the id as `metadata.channel` on the user message (so recovery can
   * re-resolve and re-apply per-channel policy). It is no longer routed via a
   * serialized `TurnSpec.channelContext`. The Channels RFC owns the string ->
   * `ChannelContext` resolution and what `channel` _means_.
   */
  channel?: string;
  /**
   * Continue the latest assistant leaf instead of answering a user turn.
   * Advanced; defaults to false. Mirrors `continueLastTurn`. Requires the
   * latest leaf to be a `role: "assistant"` message; otherwise the turn is
   * skipped. When true, omit `input`.
   */
  continuation?: boolean;
}

interface RunTurnWait extends RunTurnBase {
  mode?: "wait"; // default
}

interface RunTurnSubmit extends RunTurnBase {
  mode: "submit";
  idempotencyKey?: string;
  submissionId?: string;
  metadata?: Record<string, unknown>;
}

interface RunTurnStream extends RunTurnBase {
  mode: "stream";
  callback: StreamCallback;
  onClientToolCall?: ClientToolExecutor;
}

type RunTurnOptions = RunTurnWait | RunTurnSubmit | RunTurnStream;
```

#### Modes and return contracts

`runTurn`'s return type is a discriminated union keyed on `mode`. Each mode maps
exactly onto an existing path so return values stay compatible.

- `mode: "wait"` (default) — blocking turn. Resolves when the turn completes,
  errors, is skipped, or is aborted. Returns `TurnResult` (a superset of the
  existing `SaveMessagesResult`, adding the finalized message for parity with
  the `onChatResponse` hook's `ChatResponseResult`):

  ```ts
  type TurnResult = SaveMessagesResult & {
    /** Finalized assistant message, when the turn produced one. */
    message?: UIMessage;
    /** Whether this turn continued a previous assistant turn. */
    continuation: boolean;
  };
  ```

  Backing path: `_runProgrammaticMessagesTurn` (same as `saveMessages`). When
  `continuation: true`, backing path is `continueLastTurn`.

- `mode: "submit"` — durable async admission. Returns synchronously after the
  submission row is durably accepted; the turn runs later via the submission
  drain. Returns the existing `SubmitMessagesResult`
  (`{ accepted, submissionId, requestId, status, ... }`, `think.ts:1147`).
  Backing path: `submitMessages`.

- `mode: "stream"` — caller supplies a `StreamCallback` and receives chunks
  through it; the request id arrives via `callback.onStart({ requestId })`.
  Returns `Promise<void>` to match `chat()`. Backing path: `chat` (or
  `chatWithMessengerContext` when `channel` is set).

```ts
function runTurn(options: RunTurnWait): Promise<TurnResult>;
function runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
function runTurn(options: RunTurnStream): Promise<void>;
```

#### Why a `mode` enum and not a fluent builder

`mode` is explicit, debuggable, trivially serializable in logs/traces, and maps
one-to-one onto the existing paths. A fluent builder (`this.turn(...).run()`)
adds surface area without buying anything unless we expect long per-turn
configuration chains, which we do not. See Alternatives.

#### Naming

`runTurn` is chosen over `startTurn` (ambiguous for the blocking case),
`submitTurn` (collides with `submitMessages` semantics), `respond` (too
chat/voice-narrow), and `run` (too generic on an Agent subclass).

#### Input shapes and evaluation

All three modes accept the same `input` shapes (`string | UIMessage |
UIMessage[] | (current) => ...`), so callers do not relearn input per mode. Two
behaviors must be specified:

- **Function form evaluation timing.** `(current) => messages` is evaluated
  against the live transcript at the moment the turn is _admitted to run_:
  immediately for `wait`/`stream`, and at **drain time** for `submit` (not at
  the `runTurn` call). A `submit` function input therefore sees the transcript
  as it is when the durable submission actually executes, which may be after
  other turns. Callers needing call-time evaluation should pass a resolved
  array.
- **Empty input.** If `input` resolves to an empty array (and
  `continuation` is not set), the call is a no-op turn: nothing is persisted, no
  inference runs, and `wait` resolves `{ status: "skipped" }`. This mirrors
  guarding against empty programmatic submits today.
- **`input` vs `continuation`.** Exactly one must be supplied. `input` starts a
  new turn; `continuation: true` continues the latest assistant leaf with no new
  message. Supplying both, or neither, throws a `TypeError` at the call site
  (fail fast — this is a programming error, not a runtime condition).

#### Calling `runTurn` from inside a turn (re-entrancy)

This is an easy footgun and must be documented prominently. A blocking
`runTurn({ mode: "wait" })` (or `saveMessages`) called from inside a tool
`execute`, `beforeTurn`, or any code running _within_ an active turn will
**deadlock**: the active turn holds the turn queue, and `wait` enqueues behind
it. The same applies to `continuation`.

Supported patterns for "do more work from inside a turn":

- **`mode: "submit"`** — durable, runs after the current turn drains. Safe from
  anywhere. Preferred for "schedule follow-up work".
- **Sub-agent `mode: "stream"`/`"wait"` on a _different_ agent** — a child agent
  has its own turn queue; this is how `startAgentToolRun` / agent tools already
  work.
- **`addMessages(...)`** — to add transcript context without running a turn (it
  deliberately bypasses the turn queue; see below).

`runTurn` must detect **in-queue** re-entrancy for `wait`/`continuation`/`stream`
and throw a clear error ("runTurn({ mode: 'wait' }) cannot be called while a turn
is active; use mode: 'submit' or addMessages()") rather than hang.

**Step-2 facade vs step-3 `_admitTurn`.** The step-2 `runTurn` facade
deliberately does **not** implement this guard: `_turnQueue.isActive` is too
blunt — it is true whenever _any_ turn is executing, so guarding on it would
throw on legitimate _concurrent, non-nested_ `wait` calls (e.g. a scheduled task
or RPC issued while a WebSocket turn runs) that `saveMessages`/`continueLastTurn`
handle today by enqueuing behind. There is no cheap precise "inside a turn body"
signal at the facade layer (`agentContext` wraps all agent ops, not just turn
bodies). The step-2 facade documents the deadlock footgun in its doc comment
(behavior identical to calling `saveMessages`/`continueLastTurn` from inside a
turn today — no regression). **As built in step 3:** `_admitTurn` owns precise
nested-call detection via an async-local turn marker set around turn-body
execution, so separate concurrent RPC/alarm invocations still enqueue behind
instead of throwing.

#### Recipes (DX)

| Task                                                 | Call                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Browser chat                                         | handled by the WebSocket path; no app code                                       |
| Sub-agent / RPC streaming reply                      | `runTurn({ mode: "stream", input, callback })`                                   |
| Webhook / inbound event (durable, retried)           | `runTurn({ mode: "submit", input, idempotencyKey })`                             |
| Background job that must finish before returning     | `runTurn({ mode: "wait", input })`                                               |
| Add context the next turn should see (no model call) | `await addMessages(...)` then `runTurn(...)`                                     |
| Continue a partial/aborted assistant answer          | `runTurn({ continuation: true })`                                                |
| Cancel an in-flight turn                             | capture `requestId` (pass it in or read `onStart`), then `cancelChat(requestId)` |

### 2. `TurnSpec` + `_admitTurn(spec)`

`TurnSpec` is **internal** (`@internal`, not exported). It is the superset of
everything the admission paths vary on today. `runTurn` and every existing
method build a `TurnSpec` and call one shared `_admitTurn(spec)`.

```ts
type TurnTrigger =
  | "ws-chat"
  | "rpc"
  | "programmatic"
  | "submission"
  | "auto-continuation"
  | "recovery-continue"
  | "recovery-retry"
  | "agent-tool"
  | "scheduled";

type TurnSink =
  | { kind: "ws-broadcast"; connectionId?: string }
  | { kind: "rpc-callback"; callback: StreamCallback }
  | { kind: "programmatic-silent" };

interface TurnSpec {
  /** Caller-supplied (WS uses client `event.id`) or generated. */
  requestId: string;
  trigger: TurnTrigger;
  /** Whether the turn enters the turn queue or the durable submission drain. */
  admission: "queue" | "submit";
  continuation: boolean;

  /** Messages to persist before running, and how. */
  messages?: TurnInputMessages;
  persist: "append-user" | "continue-from-leaf" | "none";

  sink: TurnSink;

  /** Wrap in `_runChatRecoveryFiber`. */
  recoveryFiber: boolean;
  /** Turn-queue generation binding for WS supersede/clear semantics. */
  generation?: number;
  /** Run the context-overflow compact-and-retry loop around the turn. */
  overflowRetry: boolean;

  // Passthroughs into `TurnInput`:
  signal?: AbortSignal;
  clientTools?: ClientToolSchema[];
  clientToolExecutor?: ClientToolExecutor;
  body?: Record<string, unknown>;
  workflowPrompt?: ThinkWorkflowPromptContext;

  // Submission-only:
  idempotencyKey?: string;
  submissionId?: string;
  metadata?: Record<string, unknown>;

  // Channel passthrough: the bare `channel` id flows through `_admitTurn`; the
  // Channels RFC resolves it to a turn-scoped `_activeChannelContext` rather than
  // a serialized `channelContext`. (`TurnSpec.channelContext` was reserved here
  // but never built — see the Channels RFC "Coordination" / D2.)
  channel?: string;
}
```

`_admitTurn(spec)` owns the shared sequence currently copy-pasted across paths:

1. Resolve `requestId` (caller-supplied or `crypto.randomUUID()`).
2. Bind abort: `_aborts.getSignal(requestId)` + `linkExternal(requestId, spec.signal)`.
3. If `admission === "submit"`: insert/dedup the submission row and schedule the
   drain (today's `submitMessages` body); return `SubmitMessagesResult`.
4. **In-queue re-entrancy guard** (blocking queue admission only). If the spec
   would enqueue and block on `_turnQueue` (`wait`/`continuation`/`stream`
   semantics), and the caller is already inside an active turn body (async-local
   turn marker — **not** `_turnQueue.isActive` alone, which is also true for
   legitimate concurrent non-nested calls that should enqueue behind), throw the
   documented error rather than deadlock.
5. Else enqueue on `_turnQueue` with `spec.generation` (today's WS/programmatic
   enqueue), honoring skipped/stale/superseded semantics.
6. Persist per `spec.persist` (append user message(s); none; or
   continue-from-leaf precondition check).
7. Optionally wrap in `_runChatRecoveryFiber(requestId, continuation, body)`.
8. Run `_runInferenceLoop({ signal, clientTools, clientToolExecutor, body,
workflowPrompt, continuation })` inside the overflow-retry loop when
   `spec.overflowRetry`.
9. Stream via the sink: `_streamResult` (ws-broadcast / programmatic-silent) or
   `_streamResultToRpcCallback` (rpc-callback).

#### Mapping existing paths onto `TurnSpec`

The refactor is mechanical: each existing method becomes a `TurnSpec` builder
plus a call to `_admitTurn`. No public signature changes.

- `chat` / `chatWithMessengerContext`: `{ trigger: "rpc", admission: "queue",
continuation: false, persist: "append-user", sink: { kind: "rpc-callback",
callback }, recoveryFiber: chatRecovery, overflowRetry: true, channelContext }`.
- `_handleChatRequest`: `{ trigger: "ws-chat", admission: "queue",
requestId: event.id, persist: "append-user" (post-reconcile), sink:
{ kind: "ws-broadcast", connectionId }, generation: epoch,
recoveryFiber: chatRecovery, overflowRetry: true }`.
- `saveMessages`: `{ trigger: "programmatic", admission: "queue",
persist: "append-user", sink: { kind: "programmatic-silent" },
recoveryFiber: chatRecovery, overflowRetry: true }`.
- `submitMessages`: `{ trigger: "submission", admission: "submit",
idempotencyKey, submissionId, metadata, persist: "append-user",
sink: { kind: "programmatic-silent" } }`.
- `continueLastTurn`: `{ trigger: "programmatic", continuation: true,
persist: "continue-from-leaf", sink: { kind: "programmatic-silent" } }`.
- `_chatRecoveryContinue` / `_chatRecoveryRetry`: `{ trigger:
"recovery-continue" | "recovery-retry", ... }` — these stay owned by the
  recovery layer and call the same `_admitTurn`.
- `_fireAutoContinuation`: `{ trigger: "auto-continuation", continuation: true,
persist: "continue-from-leaf", sink: { kind: "ws-broadcast" } }`.
- `startAgentToolRun`: `{ trigger: "agent-tool", admission: "queue",
requestId: <pre-assigned>, sink: { kind: "programmatic-silent" } }`.

This table is the contract for "did the extraction drop a path?" — every row
must remain behavior-identical (see Testing).

### 3. `addMessages(...)` — no-turn transcript write — ✅ SHIPPED

> **Shipped** in `packages/think/src/think.ts` (`addMessages` ~`think.ts:6986`,
> `AddMessagesOptions` exported ~`think.ts:913`). This section is the spec it was
> built against; treat the code as source of truth. Listed here so the `runTurn`
> work has the full picture of the no-turn write it complements.

Public method to add messages to history **without** starting a model turn.
Distinct name from AIChatAgent's `persistMessages()` to avoid a
same-name/different-semantics trap: AIChatAgent's version replaces/reconciles a
flat array; Think's appends/upserts into the Session tree.

```ts
interface AddMessagesOptions {
  /**
   * Parent to attach under. Omitted → latest committed leaf at call time.
   * `null` → attach at root.
   */
  parentId?: string | null;
  /**
   * "append": insert new rows (idempotent by message id).
   * "upsert": insert, or update in place if the id already exists.
   */
  mode?: "append" | "upsert"; // default "append"
  /** Broadcast the change to connected clients. Default true. */
  broadcast?: boolean;
}

function addMessages(
  messages:
    | UIMessage[]
    | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
  options?: AddMessagesOptions
): Promise<void>;
```

Semantics and implementation:

- Built on the existing Session primitives: `session.appendMessage(message,
parentId)` (idempotent by id, `providers/agent.ts:245`) and
  `session.updateMessage` for `mode: "upsert"`. Reuses
  `_appendMessageToHistory` so sanitization/row-size enforcement and the
  `_cachedMessages` refresh happen for free (`think.ts:2617`).
- **Does not enter the turn queue and does not start inference.** It follows the
  `_hostSendMessage` pattern (`think.ts:4631`) specifically to avoid the
  turn-queue deadlock that an append-during-tool-execution would otherwise hit.
- **Default attach point** is the latest committed leaf, matching
  `appendMessage`'s default. Passing `parentId: null` writes a root-level
  message. An explicit `parentId` that does not exist throws (fail fast rather
  than silently misattach).
- **Array chaining.** When `messages` is an array, the entries are appended
  **linearly** — the first attaches under the resolved parent (default leaf or
  explicit `parentId`), and each subsequent message attaches under the previous
  one. This matches how `saveMessages` appends multiple messages today and keeps
  imported history as one path, not a fan-out of siblings.
- **Allowed roles.** Any role (`user` / `assistant` / `system`) may be written,
  which is what makes `addMessages` useful for importing history or injecting
  system breadcrumbs. Writing an `assistant` message does **not** mark a
  completed model turn and does **not** trigger auto-continuation; it is inert
  transcript data the next `runTurn` will see.
- **Idempotency.** `appendMessage` is idempotent by message id, so re-calling
  `addMessages` with the same ids (e.g. a retried webhook that both imports
  context and submits) is a safe no-op in `append` mode. This pairs well with
  `runTurn({ mode: "submit", idempotencyKey })`.
- **`upsert` + `parentId`.** In `upsert` mode, if the id already exists the
  message is updated **in place** and any `parentId` is ignored (re-parenting is
  not supported — it would rewrite the tree). `parentId` only applies when the
  id is new.
- **Tree / branching caveat (must be documented):** if `addMessages` is called
  while a turn is mid-stream, the in-flight assistant message is not yet
  committed, so the new message attaches to the last _committed_ leaf and can
  create a branch. The supported pattern is "background context the **next**
  turn should see": call `addMessages`, then `runTurn`. Calling it
  concurrently with an active turn is allowed but branch-creating and is
  flagged in the docs.
- **Compaction + FTS:** appended messages are normal Session rows — they are
  FTS-indexed and subject to compaction like any other message
  (see `think-sessions.md`). No special-casing.
- **No `replace` mode by default.** Whole-transcript replacement is far more
  dangerous in Think's tree/branching/compaction model than in AIChatAgent's
  flat array, so it is intentionally not the default and not part of v1. If a
  destructive reset is ever needed it should be a separate, explicit method.

This also closes the documentation gap: docs currently implying a Think
`persistMessages()` are corrected to `addMessages()` with these semantics (the
`qw-docs` and `qw-addmessages` quick wins in the parent plan can ship the thin
version ahead of the full `runTurn` work, since `addMessages` has no dependency
on the admission refactor).

## Coordination with the chat-recovery RFC

This is the highest-risk intersection: both this RFC and
[rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) rewrite
Think admission/recovery in the same ~9k-line file.

- `runTurn`/`TurnSpec` is an **admission/entry** abstraction; the recovery
  engine owns **what happens when an admitted turn is interrupted**. They are
  layered, not competing: `_admitTurn` calls the same `_runChatRecoveryFiber`
  the recovery engine governs.
- **Sequencing.** Land this RFC's `_admitTurn` extraction on top of the
  recovery extraction, not beside it:
  - Recovery RFC Phases 0–1 (characterization tests + pure-function extraction)
    should precede the `_admitTurn` refactor.
  - Ideally introduce `TurnSpec`/`_admitTurn` after recovery RFC Phase 3 ("wire
    `Think`"), so `_admitTurn` targets the `ThinkRecoveryAdapter` contract
    (`classifyRecoveredTurn`, `resolveStreamForRecovery`) rather than the
    pre-refactor private methods.
- **Shared seam.** `TurnSpec.trigger` values `recovery-continue` /
  `recovery-retry` are exactly the points the recovery adapter re-enters a turn.
  After both refactors, recovery re-entry and first-time admission share one
  `_admitTurn` body, which removes a class of drift (e.g. recovery forgetting an
  overflow-retry or generation rule that first-admission has).
- **No new recovery API.** Consistent with the recovery RFC's "no new public
  recovery API" stance, `runTurn` does not expose recovery internals; it only
  reuses them.

## Observability

`_admitTurn` is the natural single place to emit turn lifecycle events,
paralleling the recovery layer's `chat:recovery:*`:

- `chat:turn:start` — emitted when an admitted queued turn body actually starts
  executing; payload includes `{ requestId, trigger, admission, continuation? }`
  plus path-specific fields such as `generation` when present.
- `chat:turn:finish` — emitted exactly once for the started turn body with
  `{ requestId, trigger, admission, status, durationMs }`, optional
  `continuation`, and `error` when the turn body throws.

The shipped contract is intentionally smaller than the original proposed
per-status event set: durable `submitMessages()` acceptance does not emit a turn
event, while the later submission drain execution does. Event names are additive;
payloads must stay back-compatible with anything recovery observability already
emits.

## Versioning and compatibility

- `@cloudflare/think` is pre-1.0 (0.9.x), so additive minor bumps are the
  expected vehicle.
- `runTurn` and `addMessages` are **purely additive** — minor bump,
  changeset required.
- The `_admitTurn` refactor is intended to be **behavior-preserving**: existing
  signatures and return values (`chat`/`saveMessages`/`submitMessages`/
  `continueLastTurn`) are unchanged. Any behavior change discovered during
  extraction must be called out as an intentional convergence with its own
  changeset (mirroring the recovery RFC's "better-behavior convergence" stance).
- Deprecation stance: the existing methods are **not** deprecated. Docs lead with
  `runTurn` and present the others as shortcuts/admission modes. No removal is
  planned.

## Testing strategy

Layered, in the spirit of the recovery RFC's approach:

1. **TurnSpec builder unit tests.** For each existing method, assert the
   `TurnSpec` it produces matches the mapping table above (pure, fast, the
   anti-drop guard).
2. **`_admitTurn` unit tests** with fake sinks/queue: request-id resolution,
   persist modes, generation/skipped semantics, submit dedup, overflow-retry
   wrapping, recovery-fiber wrapping, **in-queue re-entrancy guard** (nested
   `wait`/`continuation` throws; concurrent non-nested `wait` enqueues behind;
   `submit`/`addMessages` exempt).
3. **Behavior-parity integration tests.** Run the existing
   chat/saveMessages/submitMessages/continueLastTurn/WS suites unchanged against
   the refactored implementation — they are the regression gate.
4. **`runTurn` surface tests.** Each mode returns the documented type and
   matches its backing method's behavior (`wait` ≡ `saveMessages`, `submit` ≡
   `submitMessages`, `stream` ≡ `chat`).
5. **`addMessages` tests.** Append/upsert idempotency by id, default-leaf vs
   explicit `parentId` vs `null`, no turn started, broadcast on/off,
   branch-creation when called mid-turn, FTS indexing, compaction interaction.
6. **Recovery-coordination tests.** After the recovery RFC lands, assert
   recovery re-entry (`recovery-continue`/`recovery-retry`) and first admission
   share `_admitTurn` and produce identical overflow/generation behavior.

## Edge cases and invariants

- **Request-id source must be preserved per trigger.** WS uses client
  `event.id` (`think.ts:7566`); everything else generates. `submitMessages`
  keeps `requestId === submissionId` unless overridden (`think.ts:6478`).
- **`continuation` precondition.** `continue-from-leaf` requires the latest leaf
  to be `role: "assistant"`; otherwise the turn is skipped
  (`{ status: "skipped" }`), matching `continueLastTurn` today
  (`think.ts:7134`).
- **No-turn writes never touch the turn queue.** `addMessages` must keep the
  `_hostSendMessage` no-deadlock guarantee.
- **In-queue re-entrancy.** Blocking `wait`/`continuation`/`stream` from inside
  an active turn body would deadlock on `_turnQueue`; `_admitTurn` throws via an
  async-local turn marker. Legitimate concurrent non-nested queue admissions must
  still enqueue behind, not throw.
- **Empty programmatic input.** Step 3 preserves the current compatibility
  behavior for `saveMessages([])` and function inputs that resolve to `[]`: they
  still reach the admitted programmatic turn and may run inference on existing
  history. The narrower step-2 `runTurn(wait)` static empty-input skip remains.
- **Per-turn vs persisted client tools.** `chat()`/`stream` mode client tools
  are per-turn and must not be persisted to `_lastClientTools` (avoids recovery
  misclassification, `think.ts:4686`); WS/programmatic continue to persist
  `_lastClientTools`/`_lastBody`.
- **Abort parity.** External `signal` must abort exactly like a
  `chat-request-cancel`/`MSG_CHAT_CANCEL`: partial chunks persisted, result
  `status: "aborted"` (see `SaveMessagesOptions` docs, `lifecycle.ts:40`).
- **Submission async outcome.** `mode: "submit"` returns acceptance, not the
  turn outcome; the outcome is observed via submission status / workflow
  notification, unchanged from `submitMessages`. The returned `submissionId` is
  usable with `cancelSubmission(submissionId)`.
- **Already-aborted signal.** If `signal` is already aborted when `runTurn` is
  called, no inference runs and `wait` resolves `{ status: "aborted" }`
  (matching `SaveMessagesOptions`, `lifecycle.ts:40`). `submit` still records
  the submission row but the drain immediately marks it aborted.
- **`wait` can return without running.** `{ status: "skipped" }` is a normal
  outcome (empty input, superseded by a `CHAT_CLEAR` generation bump, or a
  failed `continuation` precondition). Callers must handle `skipped`, not assume
  every `wait` produced a message.
- **Target session.** `runTurn` and `addMessages` operate on the agent's active
  session, identical to the existing methods. Multi-session routing
  (`rfc-think-multi-session.md`) is unchanged and out of scope.
- **`addMessages` is not turn-queue-or-generation bound.** A concurrent
  `CHAT_CLEAR` can remove just-added messages; a mid-turn `addMessages` can
  branch (documented above). It is a transcript write, not a turn.

## The alternatives

- **Leave the duplication.** Cheapest now, but perpetuates drift and the
  "many unrelated turn APIs" learning cost the strategy is trying to remove.
  Rejected.
- **Replace the existing methods with only `runTurn`.** Cleaner surface but a
  breaking change for every Think user, and it discards genuinely useful
  shorthand (e.g. `submitMessages` reads better for webhooks). Rejected in favor
  of additive `runTurn` + retained shortcuts.
- **Fluent builder (`this.turn(input).stream(cb)` / `.wait()` / `.submit()`).**
  Marginally nicer for chained config, but more surface area, harder to log, and
  no real per-turn config chains exist. Rejected; `mode` options object is
  simpler.
- **Separate methods `runTurnAndWait` / `runTurnStream` / `submitTurn` instead
  of a `mode` field.** Avoids the discriminated-union return type but multiplies
  method names for what is one concept. Kept as an open question rather than
  rejected outright (see below).
- **Do `TurnSpec` extraction without a public `runTurn`.** Removes drift but
  delivers none of the user-facing "smaller to learn" benefit. The two should
  ship together; the internal extraction is the means, `runTurn` is the end.
- **Fold `addMessages` into `runTurn` (e.g. `mode: "none"`).** Conflates
  "modify transcript" with "run the model" and reintroduces turn-queue coupling
  for a write that must avoid it. Rejected; `addMessages` stays separate.

## Open questions and what could force a redesign

- **Return shape for `mode: "wait"`.** Return the existing `SaveMessagesResult`
  verbatim (simplest, fully compatible) or the richer `TurnResult` with the
  finalized `message`? Leaning `TurnResult` since it is additive, but it means
  `runTurn(wait)` and `saveMessages` differ in return type. Could instead expose
  the message only via the `onChatResponse` hook.
- **`mode` field vs distinct methods.** If the discriminated-union overloads
  prove awkward in practice (especially for callers that compute `mode`
  dynamically), split into `runTurn` (wait), `streamTurn`, and keep
  `submitMessages`. Decision deferred until the prototype (`qw-demo`) exercises
  real call sites.
- **`channel` field scope → resolved by the Channels RFC.** Per-channel admission
  policy (tools/instructions/turn caps) _is_ decided at admission, but **not** via
  a richer serialized `TurnSpec.channelContext`. The Channels RFC threads the bare
  `channel` id through `_admitTurn`, resolves it to a turn-scoped
  `_activeChannelContext`, and persists the id as `metadata.channel` for recovery
  re-resolution. `TurnSpec.channelContext` was never built; the seam is the
  `channel` string plus turn-scoped context.
- **Sequencing risk.** If the recovery RFC slips, do we land `runTurn` as a thin
  facade over the _current_ private methods first (user-facing win, no internal
  unification yet), then unify `_admitTurn` after recovery lands? This is the
  likely fallback and is compatible with everything above.
- **Concurrency policy exposure.** WebSocket submits honor `MessageConcurrency`
  (`queue`/`latest`/`merge`/`drop`/`debounce`, `lifecycle.ts:296`); programmatic
  paths are serialized. Should `runTurn` accept a `concurrency` option, or does
  exposing it invite confusion across modes (it is meaningless for `wait` and
  `submit`)? Leaning toward not exposing it in v1 and keeping concurrency a
  WS/connection-level setting; revisit if the demo needs per-call control.
- **`stream` ergonomics.** `mode: "stream"` requires a `StreamCallback`. Many
  callers would prefer `for await (const chunk of agent.streamTurn(...))`. A
  thin `AsyncIterable` wrapper (a future `streamTurn`) could adapt the callback
  without changing the core. Deferred to avoid over-designing before the demo.

## Implementation notes (for a fresh session)

Line numbers in this RFC are approximate (captured at writing time); search by
symbol name first — `think.ts` is ~9k lines and changes frequently.

Where things live:

- Package `packages/think/`; main class `packages/think/src/think.ts` (`Think`).
  `runTurn`/`addMessages` are new public methods on `Think` — no new export path
  is needed (they ride the existing `exports["."]` -> `dist/think.js`).
- Shared chat result types: `packages/agents/src/chat/lifecycle.ts`
  (`SaveMessagesResult`, `SaveMessagesOptions`, `ChatResponseResult`,
  `MessageConcurrency`). `SaveMessagesResult.status` already includes
  `"skipped"`/`"aborted"`.
- `StreamCallback`, `TurnInput`, `SubmitMessagesResult`, `TurnContext` are
  defined in `think.ts`. `ClientToolSchema`/`ClientToolExecutor`:
  `packages/agents/src/chat/client-tools.ts`. `MessengerContext`:
  `packages/think/src/messengers/events.ts`. `UIMessage`/`ModelMessage`: `ai`.
- Session primitives used by `addMessages`:
  `packages/agents/src/experimental/memory/session/providers/agent.ts`
  (`appendMessage` idempotent-by-id, `updateMessage`). Think wraps these via
  `_appendMessageToHistory` / `_hostSendMessage` in `think.ts`.
- Tests: `packages/think/src/tests/` (`npm run test:workers` from the package).
  Build: `tsx ./scripts/build.ts`. Repo gate before "done": `pnpm run check`.
  A changeset is required for `packages/` changes (`pnpm exec changeset`).
  Lint forbids `any`; use `import type` for type-only imports.

Suggested implementation order (decouples from the recovery RFC's timeline):

1. ✅ `addMessages()` — **done** (shipped ahead of the admission refactor; it has
   no dependency on it, and closed the `persistMessages` doc gap). Remaining work
   starts at step 2.
2. ✅ `runTurn()` as a thin facade delegating to the existing
   `chat`/`saveMessages`/`submitMessages`/`continueLastTurn`. User-facing "smaller
   to learn" win with zero internal churn; safe even if the recovery RFC slips.
   **Does not** implement the in-queue re-entrancy guard (deferred to step 3).
   **Shipped** with per-mode option narrowing (see Status block).
3. ✅ After recovery RFC Phases 0-1 (ideally Phase 3): extract `_admitTurn` +
   `TurnSpec`, repoint the existing methods and `runTurn` at it, and gate the
   change on the behavior-parity suite + the mapping table in section 2.
   **Shipped** with an async-local re-entrancy guard for blocking
   `wait`/`continuation`/`stream`, submission admission vs drain execution split,
   and path-specific ordering preserved.
4. ✅ Add `chat:turn:*` observability inside `_admitTurn`. **Shipped** as the
   intentionally small `chat:turn:start` / `chat:turn:finish` pair around actual
   queue execution. Durable submission acceptance does not emit a turn event; the
   submission drain does.

The `_admitTurn` step list in section 2 is the _logical_ sequence; exact ordering
(e.g. WS persists/reconciles before enqueue) follows the current per-path code and
must be preserved by the parity tests, not by this prose.

## The decision

Accepted and shipped. `runTurn` + `addMessages` landed as additive APIs,
`_admitTurn`/`TurnSpec` landed as a behavior-preserving internal refactor after
the recovery foundation, and docs can lead with `runTurn` while keeping existing
methods as shortcuts. Remaining input-superset work is tracked separately:
`stream` should accept array/function input, while `submit` + function input
requires durable submission pipeline changes.
