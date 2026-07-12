# 14 — Chat recovery & context-overflow handling

Original: `chat/recovery-engine.ts`, `recovery-incident.ts`, the
`chatRecovery` fiber wrapper, the stall watchdog routing, and Think's
`contextOverflow` reactive/proactive layers. These make a turn survive
evictions, stalls, and context-window overflows.

---

## 1. `domain/recovery/recovery.ts` — ChatRecovery

### Concepts
- Every recoverable turn runs inside a fiber (doc 06) named `"chat-turn"`
  whose stash carries `{ requestId, incidentId?, attempt, phase, messageId? }`.
- An **incident** tracks one interrupted turn's recovery across attempts:
  `{ incidentId, requestId, attempt, maxAttempts, recoveryKind }` where
  `recoveryKind` is `"retry"` (user turn had no assistant output yet — replay
  it) or `"continue"` (partial assistant output persisted — continue from it).
- Bounded: `maxAttempts` (default 6-ish; configurable via
  `chatRecovery = { maxAttempts, terminalMessage, onExhausted }`).

### Recovery decision (on fiber recovery of a chat-turn)
1. Emit `chat:recovery:detected`.
2. Validate the conversation still matches (the interrupted requestId is
   still the last turn; chat wasn't cleared) — else `chat:recovery:skipped`
   (`reason`), settle incident.
3. attempt ≥ maxAttempts → **exhaustion**: persist/announce the configured
   `terminalMessage` as the assistant outcome, fire `onExhausted`, emit
   `chat:recovery:exhausted`, clear recovering status.
4. Otherwise decide kind:
   - partial assistant message persisted for this requestId → `continue`:
     schedule a continuation turn (trigger `"continuation"`, continuation
     flag true) whose input is the repaired transcript (doc 03 repair heals
     the dangling tool call).
   - no assistant output → `retry`: re-run the original turn input.
5. Emit `chat:recovery:scheduled` and set the **recovering status** flag
   (Think broadcasts `cf_agent_chat_recovering`, replayed to connecting
   clients); clear it on every terminal outcome (completed / exhausted /
   skipped).
6. The scheduled attempt emits `chat:recovery:attempt` when it starts and
   `chat:recovery:completed` on success.

### Stall watchdog routing
- The turn engine surfaces `{ kind: "error", stalled: true }` (doc 09). With
  recovery enabled, a stalled outcome is routed into the same bounded path
  as an eviction interruption: persist the settled partial, schedule a
  continuation (incident attempt++). Exhaustion goes through the same
  terminal-message path (the user never sees a raw stall error).
- With recovery disabled, a stall terminalizes via `onChatError`
  (`stage: "stream"`).
- Sub-agent nuance (for doc 19/23): when the stalled turn is running as a
  child `chat()` with a StreamCallback, a recovering stall fires
  `onInterrupted()` instead of `onDone`/`onError` — "not done, not failed; a
  continuation owns the outcome."

### `onChatError` contract (Think hook, orchestrated here)
`onChatError(error, ctx)` with `ctx = { stage: "parse" | "persist" | "run" | "stream",
requestId, messagesPersisted, classification? }`; also emits
`chat:request:failed`. `classification` is `"context_overflow"` on terminal
unrecovered overflow.

### Proposed interface
```ts
export interface RecoveryPolicy { maxAttempts?: number; terminalMessage?: string;
  onExhausted?: (incident: Incident) => void | Promise<void>; }
export interface Incident { incidentId: string; requestId: string; attempt: number;
  maxAttempts: number; recoveryKind: "retry" | "continue"; }
export interface ChatRecovery {
  /** Wrap a turn execution in a recoverable fiber. */
  runRecoverable(args: { requestId: string; input: TurnInputSnapshot;
    execute: (signal: AbortSignal) => Promise<TurnOutcome> }): Promise<TurnOutcome>;
  /** Fiber-recovery entry: decide skip/retry/continue/exhaust. */
  onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult>;
  handleStall(requestId: string): Promise<"recovering" | "terminal">;
  isRecovering(): boolean;                       // drives the recovering broadcast
}
export function createChatRecovery(deps: {
  store: KeyValueStore;                          // prefix "recover:"
  fibers: FiberService; clock: Clock; ids: IdSource; bus: EventBus;
  policy?: RecoveryPolicy;
  conversation: {                                 // Think-provided views
    lastRequestId(): string | undefined;
    partialAssistant(requestId: string): ChatMessage | undefined;
    scheduleRetry(input: TurnInputSnapshot, incident: Incident): Promise<void>;
    scheduleContinuation(incident: Incident): Promise<void>;
    terminalize(incident: Incident, message: string): Promise<void>;
  };
}): ChatRecovery;
```

### Tests
- interruption with no assistant output → retry scheduled, kind "retry".
- partial persisted → continuation, kind "continue"; attempt increments across
  two interruptions; exhaustion at maxAttempts terminalizes with configured
  message + event + onExhausted.
- conversation changed (different last request) → skipped event, no schedule.
- stall with recovery → continuation path; stall without recovery → terminal.
- isRecovering true between scheduled and terminal; cleared on completion.

---

## 2. `domain/recovery/overflow.ts` — context-overflow guard

### Behaviors (both opt-in, both reuse the session's compaction)
- **Classifier**: `classifyChatError(error) → "context_overflow" | "rate_limit"
  | "transient" | "fatal" | "unknown"`. Ship
  `defaultContextOverflowClassifier`: matches common provider phrasings
  case-insensitively — "prompt is too long", "context_length_exceeded",
  "maximum context length", "input is too long", "too many tokens",
  "exceeds the model's context window" — on `error.message` (walk `.cause`
  chain too).
- **Reactive** (`reactive: true`, `maxRetries` default 1): when a turn errors
  and the classifier says overflow → run compaction; if history `shortened`,
  re-run the turn (attempt counter per requestId); else / retries exhausted →
  terminal `onChatError` with `classification: "context_overflow"`. Emits
  `chat:context:compacted` `{ reason: "reactive", shortened, requestId, attempt }`.
- **Proactive** (`proactive: { maxInputTokens, maxCompactions? }` default 1):
  between steps, if the last step's reported `usage.inputTokens` ≥ 90% of
  `maxInputTokens` → compact in place mid-turn (event
  `reason: "proactive"`), bounded by `maxCompactions` per turn. Uses only
  model-reported usage — no provider strings.

### Proposed interface
```ts
export type ChatErrorClassification = "context_overflow" | "rate_limit" | "transient" | "fatal" | "unknown";
export function defaultContextOverflowClassifier(error: unknown): ChatErrorClassification;
export interface OverflowGuard {
  /** step hook: returns true if a proactive compaction ran */
  maybeCompactBeforeStep(usage: { inputTokens?: number } | undefined, requestId: string): Promise<boolean>;
  /** error hook: returns "retry" if the turn should re-run */
  handleTurnError(error: unknown, requestId: string): Promise<"retry" | "terminal" | "unhandled">;
}
export function createOverflowGuard(deps: {
  config?: { reactive?: boolean; maxRetries?: number; proactive?: { maxInputTokens: number; maxCompactions?: number } };
  classify?: (e: unknown) => ChatErrorClassification | void;
  compact: () => Promise<{ shortened: boolean }>;
  bus: EventBus;
}): OverflowGuard;
```

### Tests
- classifier matrix incl. cause chains and non-Error values.
- reactive: overflow + shortened → retry once; not shortened → terminal;
  maxRetries bound; non-overflow errors → unhandled.
- proactive: threshold at 90%; maxCompactions bound per turn (reset per
  requestId); no usage info → no-op.
