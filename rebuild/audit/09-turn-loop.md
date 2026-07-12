# 09 — Turn loop engine & admission queue

The heart of Think. Original: a giant private method cluster around one
`streamText` call per step, plus a turn queue that serializes concurrent
entry points (WebSocket messages, `chat()`, `saveMessages`, submissions,
continuations). Rebuild as two modules: a pure **TurnEngine** (no storage —
takes inputs, streams chunks, returns outcome) and a **TurnQueue** (admission
+ serialization). Persistence/broadcast/recovery orchestration belongs to
Think (doc 23).

---

## 1. `domain/turn/loop.ts` — TurnEngine

### Inputs & config

```ts
export interface TurnHooks extends ToolHooks {
  beforeTurn?: (ctx: TurnContext) => void | TurnConfig | Promise<void | TurnConfig>;
  beforeStep?: (ctx: { stepNumber: number; messages: ModelMessage[] }) => void | StepConfig | Promise<void | StepConfig>;
  onStepFinish?: (ctx: StepResult) => void | Promise<void>;
  onChunk?: (ctx: { chunk: ModelChunk }) => void | Promise<void>;
}
export interface TurnConfig {
  model?: ModelClient;
  system?: string;
  messages?: ModelMessage[];             // override assembled prompt messages
  tools?: ToolSet;                       // ADDITIVE merge
  activeTools?: string[];
  toolChoice?: "auto" | "none" | { toolName: string };
  maxSteps?: number;
  stopWhen?: (ctx: { steps: StepResult[] }) => boolean;   // composed with maxSteps, never replaces it
  sendReasoning?: boolean;
  settings?: ModelCallSettings;          // temperature, maxOutputTokens, seed, headers, ...
  stallTimeoutMs?: number;               // per-turn override of the watchdog (0 = off)
}
export interface StepConfig { system?: string; messages?: ModelMessage[]; activeTools?: string[];
  toolChoice?: TurnConfig["toolChoice"]; model?: ModelClient; settings?: ModelCallSettings }
export interface StepResult {
  stepNumber: number; text: string; reasoning: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; output: unknown; isError: boolean }>;
  finishReason: string; usage?: { inputTokens?: number; outputTokens?: number };
}
export interface TurnContext {
  requestId: string;
  trigger: "websocket" | "chat" | "save" | "submission" | "continuation" | "schedule";
  continuation: boolean;
  channelId?: string;
  messages: ReadonlyArray<ChatMessage>;   // full history incl. new input
}
```

### The loop (behaviors to preserve)

1. Resolve config: defaults ← channel policy (doc 18, applied by Think) ←
   `beforeTurn` return (wins). `maxSteps` default 10.
2. Per step (until stop):
   a. `beforeStep` may override step-scoped settings.
   b. Build `ModelRequest` from system + repaired model messages + tool
      descriptors (narrowed by activeTools) and call `model.stream()`.
   c. Forward chunks: text/reasoning deltas → UiChunks (reasoning only when
      `sendReasoning`, default true) and `onChunk`; tool-call chunks collect.
   d. **Stall watchdog**: when `stallTimeoutMs > 0`, an inactivity timer
      spanning the gap between model chunks; firing aborts the turn with a
      distinguished `StallError` and emits `chat:stream:stalled`
      `{ requestId, timeoutMs }`. (Timer must be injectable/fake-able —
      accept a `setTimeout`-like via deps for tests.)
   e. After `finish/tool-calls`: execute tool calls **sequentially** via
      `AssembledTools.execute`; each emits `tool-input-available` before and
      `tool-output-available` after. Client tools / approval-needed tools
      **suspend** the turn (see outcome `suspended` below).
   f. `onStepFinish` with the StepResult.
   g. Stop conditions: finishReason `stop|length|content-filter|error` → done;
      steps ≥ maxSteps → done (finishReason preserved); custom `stopWhen`
      true → done. Otherwise loop (tool-calls round).
3. Abort: the external `AbortSignal` cancels the model stream and tool
   executions; outcome `aborted`; chunks so far remain valid.
4. Errors from the model stream propagate as outcome `error` with the raw
   error attached (classification is doc 14's job). Chunks already emitted
   stand (partial persistence is Think's job via the accumulator).
5. Every turn ends with a `finish` UiChunk (except `suspended`, which ends
   with the suspension chunk).

### Outcome

```ts
export type TurnOutcome =
  | { kind: "completed"; steps: StepResult[]; finishReason: string }
  | { kind: "suspended"; reason: "client-tool" | "approval" | "durable-pause";
      pending: Array<{ toolCallId: string; toolName: string; input: unknown }> ; steps: StepResult[] }
  | { kind: "aborted"; reason?: string; steps: StepResult[] }
  | { kind: "error"; error: unknown; stalled?: boolean; steps: StepResult[] };

export interface TurnEngine {
  run(args: {
    context: TurnContext;
    system: string;
    tools: AssembledTools;
    model: ModelClient;
    config?: TurnConfig;                 // pre-resolved channel/default config
    hooks?: TurnHooks;
    emit: (chunk: UiChunk) => void;      // Think fans out: accumulator + stream buffer + connections
    signal?: AbortSignal;
  }): Promise<TurnOutcome>;
}
export function createTurnEngine(deps: { clock: Clock; ids: IdSource; bus: EventBus;
  setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout }): TurnEngine;
```

### Tests (TDD list — FakeModel drives everything)
- single text turn: chunk order (start, deltas, finish), outcome completed.
- tool round-trip: tool-call → execute → second model call sees tool result in
  messages; two-step outcome.
- maxSteps cap; stopWhen composed (fires early but never exceeds cap).
- beforeTurn overrides model/system; beforeStep narrows activeTools (request
  captured by FakeModel shows narrowed descriptors).
- sendReasoning false suppresses reasoning chunks.
- block/substitute decisions visible to model as outputs.
- client tool suspends with pending call; approval tool suspends.
- abort mid-stream → aborted outcome, no further chunks.
- stall watchdog: hang script + fake timers → error outcome with stalled flag,
  event emitted; watchdog resets on each chunk; 0 disables.
- model throw mid-stream → error outcome; earlier chunks emitted.

---

## 2. `domain/turn/admission.ts` — TurnQueue

### Responsibilities (original semantics)
- One turn runs at a time per agent. Entry points enqueue an admission:
  `{ admission: "queue" }` waits FIFO; `{ admission: "replace" }` cancels the
  running turn (abort) then runs; `{ admission: "reject" }` fails fast if busy.
- `waitUntilStable()`: resolves when no turn is running and queue empty.
- Exposes the running turn's `requestId` + abort controller so
  `cancelChat(requestId)` / `cancelAllChats()` work.
- Reentrancy: a turn may schedule a follow-up (continuation) which enqueues
  normally; it must not deadlock when enqueued from inside the running turn.

### Proposed interface
```ts
export interface TurnQueue {
  run<T>(task: { requestId: string; trigger: string; admission?: "queue" | "replace" | "reject";
                 execute: (signal: AbortSignal) => Promise<T> }): Promise<T>;
  cancel(requestId: string, reason?: string): boolean;
  cancelAll(reason?: string): void;
  running(): { requestId: string; trigger: string } | null;
  pending(): number;
  waitUntilStable(): Promise<void>;
}
export function createTurnQueue(): TurnQueue;
```

### Tests
- FIFO serialization (interleaving check with deferred promises); replace
  aborts running; reject when busy; cancel by requestId; waitUntilStable;
  enqueue-from-within-turn does not deadlock.
