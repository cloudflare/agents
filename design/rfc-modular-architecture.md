# RFC: Modular architecture — host capabilities, a shared chat runtime, and Think as an assembly

Status: proposed (migration step 1 — the L0 host seam and capability
extraction inside `packages/agents` — is implemented; steps 2–4 are not)

## The problem

Three observations about the current codebase, each with a customer-facing
consequence:

**The chat-durability harness is forked, not layered.** `Think` does not
extend `AIChatAgent` — both extend `Agent` directly (`think.ts`,
`ai-chat/src/index.ts`), and each carries its own multi-thousand-line copy of
the turn loop, recovery incidents, auto-continuation barriers, and stream
handling (down to an identically named private field,
`_activeChatRecoveryRootRequestId`, with the same comment-documented
invariant). Only low-level utilities (`ResumableStream`, `TurnQueue`,
`applyChunkToParts`, fiber-snapshot wrappers in `agents/chat/*`) are shared.
Every durability fix lands twice or drifts. See
[`think-vs-aichat.md`](./think-vs-aichat.md) for the history of the fork.

**Recovery dispatch is single-consumer.** `Agent.onFiberRecovered` is one
global override, and framework fibers route through a private
`_handleInternalFiberRecovery`. A customer building their own harness on
`Agent` cannot register a recovery handler alongside the framework's — the
exact mechanism the recovery decision tree (retry-turn / continue-partial /
preserve-tool-result / park-for-human / repair-transcript / reattach-child /
wait-on-provider) is built on is effectively reserved for Think. Customers who
want "more control over the harness than Think offers" get none of the
durability work.

**Capabilities are entangled through private state, not interfaces.**
`packages/agents/src/index.ts` (~11,500 lines) fuses state sync, SQL/schema,
RPC, scheduling, fibers, keep-alive, queues, email, facets, agent-tools,
workflows, and MCP, coordinating through ~50 private fields and one alarm.
`think.ts` (~11,000 lines) hard-wires Session, Workspace, the turn loop, and
recovery. A customer cannot take "tool calls + skills, no session management"
or "chat over RPC for SMS, no WebSockets/React" because none of those are
seams. Neither humans nor agents can reason locally about files this size.

The good news: the runtime layering is already correct. Fibers, the chunk
log, and the multiplexed alarm are genuinely general primitives. The problem
is that the seams are private. The plan is to **reify existing seams as
interfaces**, not to redesign the durability model.

## Constraint: the Durable Object platform may absorb the bottom layer

[`durable-agents`](../durable-agents.pdf) ("Durable Agents Need More Than
Durable State") identifies four platform asks that may one day live in the DO
runtime itself:

1. **Durable fibers/tasks as a runtime primitive** — "this logical operation
   is running", snapshot/checkpoint, structured recovery callback.
2. **Named or multiple durable timers** — today every framework multiplexes
   one physical alarm.
3. **Structured interruption reasons** — today framework code string-matches
   `"This script has been upgraded"` to classify resets.
4. **Per-object production forensics** — inspect durable state, pending
   timers, fibers, incidents, recent events; export a scrubbed diagnostic
   bundle.

This is a first-order design constraint on the host layer:

> **Every Layer-0 interface must be specifiable without mentioning SQLite,
> tables, or the single physical alarm.** The SQL-backed implementations are
> userspace **polyfills** behind platform-shaped interfaces. When the runtime
> ships native equivalents, we write an adapter satisfying the same interface
> and nothing above Layer 0 changes.

Concretely: snapshots are opaque values (never rows), timer keys carry
explicit identity and payload (`chat-recovery:<incident>:continue`,
`submission:<id>:drain`, `agent-tool:<run>:reattach`), interruption reasons
are a closed structured union interpreted in exactly one place (the polyfill),
and backing tables are never public API — read access goes through forensics
views.

## The design

Five layers. Every module depends only on narrow interfaces from the layer
below, owns its own SQL tables (single-writer), registers its own namespaced
migrations, and lives in its own file (target: 200–500 lines, independently
testable against fake hosts).

```
L5  Assemblies        Think, AIChatAgent  = recipes over createChatRuntime()
L4  Channels          WebSocket | RPC | SMS/Email | Messenger adapters → ChatIntake/TurnHandle
L3  Durability        DurableTurnRunner = TurnRunner × FiberHost × RecoveryPolicy × ProgressTracker
L2  Conversation      MessageStore | ChunkLog | ToolSource | ToolGate | TurnRunner | TurnMiddleware
L1  Capabilities      Scheduler | Queue | SyncedState | McpHub | SubAgentTree | Workflows | AgentToolRunner
L0  Host (kernel)     SqlHost | TimerHost | FiberHost | LifetimeHost | EventHost | ConnectionHost | KvHost | DiagnosticsHost
```

Principles:

- **Composition over inheritance.** The `Agent` class survives unchanged for
  back-compat, but becomes a façade: it implements the L0 host interfaces and
  delegates its current public API to L1 modules.
- **Production decoupled from delivery.** The turn loop writes to a durable
  chunk log; channels independently consume it streamed, batched, or
  final-only. This is what makes "chat over SMS via RPC" fall out for free,
  and it matches production behavior: resumable streaming and recovery
  reconstruction read the same log, differing only in whether a live reader
  exists.
- **Mechanism generalizes; policy stays product-shaped.** Per the
  durable-agents writeup, retry/continue/park choices differ across a chat
  turn, a messenger reply, a workflow step, and a background job. The
  exported durability layer is mechanisms only (incidents, progress budgets,
  terminal replay, the fiber wrapper); the seven-way decision tree is the
  chat runtime's own `RecoveryPolicy`, and other products write theirs.

### Layer 0 — host capabilities

The kernel seam. Code lives in `packages/agents/src/core/host.ts`. `Agent`
implements all of these; tests implement fakes. Interfaces are sketched here;
`core/host.ts` is the authoritative, fully documented version.

```ts
interface SqlHost {
  sql<T>(strings: TemplateStringsArray, ...values: SqlValue[]): T[];
  /** Modules own their tables; migrations are namespaced and idempotent. */
  registerMigrations(namespace: string, migrations: HostMigration[]): void;
}

interface KvHost {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
}

/** Named logical timers (platform ask #2). Polyfill: multiplexed over the
    single DO alarm — formalizes today's private _scheduleNextAlarm. */
interface TimerHost {
  setTimer(key: string, at: number, payload?: unknown): Promise<void>;
  cancelTimer(key: string): Promise<void>;
  onTimer(prefix: string, handler: TimerHandler): Disposable;
}

interface LifetimeHost {
  keepAlive(): Promise<() => void>;
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** Durable execution (platform ask #1). The critical change vs today:
    recovery is a namespaced registry, not a single override. */
interface FiberHost {
  startFiber(
    name: string,
    fn: (ctx: FiberContext) => Promise<void>,
    options?: StartFiberOptions
  ): Promise<StartFiberResult>;
  inspectFiber(fiberId: string): Promise<FiberInspection | null>;
  listFibers(options?: ListFibersOptions): Promise<FiberInspection[]>;
  /** Returns false if the fiber is unknown or already terminal. */
  cancelFiber(fiberId: string, reason?: string): Promise<boolean>;
  /** Fiber names are namespaced ("chat:turn:…", "myapp:…"); interrupted
      fibers route to the handler owning the longest matching prefix.
      Unclaimed names fall through to onFiberRecovered (back-compat). */
  onRecovery(namespace: string, handler: FiberRecoveryHandler): Disposable;
}

/** Platform ask #3 — never string-match platform error messages outside
    the polyfill. */
type InterruptionReason =
  | { kind: "code-updated" }
  | { kind: "eviction" }
  | { kind: "exception"; error: { name: string; message: string } }
  | { kind: "cancelled" }
  | { kind: "unknown"; detail?: string };

interface EventHost {
  /** Named emitEvent (not emit) so the method can live flat on Agent
      without colliding with userland subclass methods. */
  emitEvent(event: HostEvent): void;
}

/** Async and explicitly optional: hibernated sockets and facet/root
    boundaries make connection access cross-DO native I/O. Channels must
    tolerate no-live-reader (that is what the ChunkLog is for). */
interface ConnectionHost {
  broadcast(msg: string, exclude?: string[]): void | Promise<void>;
  send(connectionId: string, msg: string): void | Promise<void>;
  connections(tag?: string): Iterable<HostConnectionInfo>;
}

/** Platform ask #4 — read-only forensics. Modules contribute views; backing
    tables are never the read surface. */
interface DiagnosticsHost {
  registerInspector(namespace: string, fn: () => Promise<unknown>): Disposable;
  diagnostics(opts?: { scrub?: boolean }): Promise<DiagnosticBundle>;
}

/** KV is a `kv` property rather than flat methods: generic names like
    get/delete would pollute the Agent public API and collide with
    userland subclass methods. */
type AgentHost = SqlHost &
  TimerHost &
  LifetimeHost &
  FiberHost &
  EventHost &
  DiagnosticsHost & { readonly kv: KvHost } & Partial<ConnectionHost>;
```

**Host lifecycle contract.** Initialization ordering is part of the L0 spec,
not an accident (production found recovery running before user startup hooks
restored the in-memory state the recovery decision depended on):

```
construct → migrations → module init (incl. user onStart) → recovery dispatch → traffic
```

`FiberHost.onRecovery` and `TimerHost.onTimer` handlers are never invoked
before init completes. Any implementation — polyfill or platform — must
preserve this.

**Platform absorption ledger.**

| L0 interface         | Platform ask             | Polyfill today                                    | When platform ships                               |
| -------------------- | ------------------------ | ------------------------------------------------- | ------------------------------------------------- |
| `FiberHost`          | durable fibers/tasks     | `cf_agents_runs`/`cf_agents_fibers` + alarm scans | adapter over runtime fiber API; scanner deleted   |
| `TimerHost`          | named durable timers     | multiplexing over the one physical alarm          | adapter over multi-alarm API; multiplexer deleted |
| `InterruptionReason` | structured reset reasons | string-matching, centralized in the polyfill      | runtime supplies the reason; matcher deleted      |
| `DiagnosticsHost`    | per-object forensics     | module inspectors, SDK-aggregated bundle          | platform forensics become additional data sources |
| `ChunkLog` (L2)      | durable stream cursors   | SQLite chunk rows, opaque cursors                 | native stream store implements the same interface |

### Layer 1 — kernel capabilities

Each current `Agent` feature becomes a module `createX(host)` in its own
file; `Agent` keeps its public methods by delegating, so nothing breaks:

- `Scheduler` (schedules + cron; consumes `TimerHost`)
- `TaskQueue`
- `SyncedState<S>` (state row + connection broadcast + validation hook)
- `McpHub` (wraps the existing `MCPClientManager`; also a `ToolSource`)
- `SubAgentTree` (facets: registry, WS bridging, path routing)
- `AgentToolRunner` (child-agent runs, durable chunk replay, reattach by
  stable `runId`)
- `WorkflowBridge`

### Layer 2 — conversation building blocks

This is where the Think/ai-chat fork collapses into one implementation.

```ts
/** Transcript persistence. Impls: SqliteMessageStore (flat, single thread —
    what AIChatAgent needs) and SessionMessageStore (Think's Session:
    multi-session, context blocks, compaction, FTS). */
interface MessageStore {
  list(opts?: { limit?: number; sessionId?: string }): Promise<UIMessage[]>;
  append(msg: UIMessage): Promise<void>;
  update(msg: UIMessage): Promise<void>;
  delete(ids: string[]): Promise<void>;
  repair(policy?: TranscriptRepairPolicy): Promise<RepairReport>;
  onChanged(listener: (change: MessageChange) => void): Disposable;
}

/** THE durable chunk log: one write path, two read modes (live tail for
    resumable streaming, replay for recovery reconstruction). Extracted from
    ResumableStream + the per-package chunk-persistence code. */
interface ChunkLog {
  open(streamId: string, messageId: string): ChunkWriter;
  read(streamId: string, fromCursor?: number): AsyncIterable<StoredChunk>;
  tail(streamId: string, fromCursor?: number): AsyncIterable<StoredChunk>;
  status(
    streamId: string
  ): Promise<"active" | "complete" | "error" | "missing">;
  gc(policy?: ChunkRetention): Promise<void>;
}

/** Pluggable tool provisioning, composed by array. Shipped impls:
    workspaceTools, skillTools, mcpTools, clientTools, codemodeTools,
    extensionTools. */
interface ToolSource {
  id: string;
  getTools(ctx: TurnContext): Promise<ToolSet>;
  onInvalidated?(listener: () => void): Disposable;
}

/** Tool execution policy: approvals, idempotency, durable settlement.
    Encodes "preserve-tool-result" (settled results are never re-run) and
    "park-for-human" (budget-free waits). */
interface ToolGate {
  before(
    call: ToolCall,
    ctx: TurnContext
  ): Promise<
    | { action: "run" }
    | { action: "reuse"; result: ToolResult }
    | { action: "park"; awaiting: "approval" | "client-result" }
    | { action: "deny"; message: string }
  >;
  /** Persist durably BEFORE the loop continues — no duplicate side effects. */
  settle(call: ToolCall, result: ToolResult): Promise<void>;
  resolveParked(
    callId: string,
    resolution: ApprovalResponse | ToolResult
  ): Promise<void>;
}

interface TurnConfigSource {
  resolve(ctx: TurnContext): Promise<TurnConfig>;
}

/** Uniform hook pipeline: extensions, messengers, context-overflow handling,
    and user hooks all register as middleware instead of hard-wired sites. */
interface TurnMiddleware {
  beforeTurn?(ctx: TurnContext, cfg: TurnConfig): Promise<TurnConfig | void>;
  beforeStep?(ctx: StepContext): Promise<void>;
  beforeToolCall?(
    call: ToolCall,
    ctx: TurnContext
  ): Promise<ToolCallDirective | void>;
  afterToolCall?(
    call: ToolCall,
    result: ToolResult,
    ctx: TurnContext
  ): Promise<void>;
  onChunk?(chunk: UIMessageChunk, ctx: TurnContext): void;
  afterTurn?(outcome: TurnOutcome, ctx: TurnContext): Promise<void>;
  onError?(
    err: ClassifiedChatError,
    ctx: TurnContext
  ): Promise<ErrorDirective | void>;
}

/** The pure inference loop. No transport, no fibers, no persistence policy —
    reads transcript, streams to ChunkWriter, consults gate & middleware. */
interface TurnRunner {
  run(input: TurnInput, io: TurnIO): Promise<TurnOutcome>;
}
interface TurnIO {
  transcript: MessageStore;
  chunks: ChunkWriter;
  signal: AbortSignal;
}
type TurnOutcome =
  | { kind: "complete"; message: UIMessage }
  | { kind: "parked"; awaiting: ParkedInteraction[] }
  | { kind: "error"; error: ClassifiedChatError; partial?: UIMessage };
```

### Layer 3 — durability mechanisms

The reusable layer is deliberately smaller than "Think recovery": incident
records, durable progress budgets, recovery observability events, terminal
replay helpers, and the fiber/turn wrapper that sits under both Think and
AIChat. It stays internal (`agents/recovery` unexported) until both products
run on it — the un-forking migration is itself the required second use.

```ts
interface RecoveryPolicy {
  classify(evidence: RecoveryEvidence): Promise<RecoveryDecision>;
}
type RecoveryDecision =
  | "retry-turn"
  | "continue-partial"
  | "preserve-tool-result"
  | "park-for-human"
  | "repair-transcript"
  | "reattach-child"
  | "wait-on-provider"
  | "seal";

/** Everything the classifier may inspect — reconstructed, not replayed. */
interface RecoveryEvidence {
  snapshot: TurnSnapshot; // stashed via FiberContext.stash
  reason: InterruptionReason; // structured, from FiberHost
  storedChunks: StoredChunk[]; // from ChunkLog
  settledTools: ToolResult[]; // from ToolGate
  parked: ParkedInteraction[];
  childRuns: AgentToolRunInfo[];
  progress: ProgressSnapshot;
  attempt: number;
}

/** Monotonic progress counter: increments on real work (chunks, settled
    tools, child advance); the no-progress timer resets on each bump; humans
    and healthy children are budget-free. Replaces wall-clock ceilings and
    attempt counts as the primary liveness signal. */
interface ProgressTracker {
  bump(units?: number): void;
  snapshot(): ProgressSnapshot;
  budget(opts: {
    noProgressTimeoutMs: number;
    maxWork: number;
  }): ProgressBudget;
}

interface IncidentLog {
  open(turnId: string, detail: IncidentDetail): Promise<Incident>;
  update(id: string, patch: Partial<IncidentDetail>): Promise<void>;
  close(
    id: string,
    outcome: "completed" | "skipped" | "failed" | "exhausted"
  ): Promise<void>;
  list(filter?: IncidentFilter): Promise<Incident[]>;
}

/** Wraps any TurnRunner with fibers + recovery. AIChatAgent, Think, AND
    raw-Agent customers get durability through this one function. */
function createDurableTurnRunner(
  inner: TurnRunner,
  deps: {
    fibers: FiberHost; // registers onRecovery("chat:turn")
    timers: TimerHost; // "chat-recovery:<incident>:continue"
    chunks: ChunkLog;
    gate: ToolGate;
    policy?: RecoveryPolicy; // default ships WITH the chat runtime
    incidents?: IncidentLog;
    budgets?: RecoveryBudgetOptions;
    onRecovery?: (
      incident: Incident,
      decision: RecoveryDecision
    ) => Promise<RecoveryDirective | void>;
  }
): TurnRunner;
```

### Layer 4 — channels

Channels never touch the turn loop; they talk to `ChatIntake` and observe via
`TurnHandle`. This is the fix for "chat over SMS via RPC, no WebSockets".

```ts
interface ChatIntake {
  submit(messages: UIMessage[], opts?: SubmitOptions): Promise<TurnHandle>;
  resolveToolResult(callId: string, result: ToolResult): Promise<void>;
  resolveApproval(callId: string, response: ApprovalResponse): Promise<void>;
  cancel(turnId: string): Promise<void>;
  attach(turnId: string): Promise<TurnHandle | undefined>; // reconnect / cross-channel
}

interface TurnHandle {
  turnId: string;
  status(): Promise<TurnStatus>; // includes "recovering" — observable recovery
  tail(fromCursor?: number): AsyncIterable<UIMessageChunk>; // streaming consumers
  result(): Promise<UIMessage>; // batch consumers (SMS/email wait here)
  cancel(): Promise<void>;
}

/** Generalizes SubmitConcurrencyController + TurnQueue admission. */
interface AdmissionPolicy {
  decide(
    incoming: SubmitOptions,
    inflight: TurnStatus | undefined
  ): "queue" | "replace" | "merge" | "debounce" | "reject";
}

/** Generalizes the WS protocol handler, the chat() RPC path, and Think's
    MessengerDefinition into one shape. */
interface ChatChannel {
  id: string;
  attach(
    intake: ChatIntake,
    host: Partial<ConnectionHost> & EventHost
  ): Disposable;
  delivery: DeliveryPolicy;
}
type DeliveryPolicy =
  | { mode: "stream" } // tail ChunkLog live (WebSocket)
  | { mode: "final" } // await result() (SMS, email, RPC)
  | { mode: "batched"; intervalMs: number }; // edit-in-place (Slack/Telegram)
```

Shipped channels: `webSocketChannel()` (the existing `CF_AGENT_*` wire
protocol, unchanged on the wire), `rpcChannel()`, `httpSseChannel()`,
`emailChannel()`, `messengerChannel(def)` wrapping existing chat-sdk
adapters. Client-side, `WebSocketChatTransport`'s existing `AgentConnection`
interface is already the right seam and is kept.

### Layer 5 — assembly

```ts
interface ChatRuntimeOptions {
  transcript: MessageStore;
  config: TurnConfigSource;
  tools?: ToolSource[];
  gate?: ToolGate;
  middleware?: TurnMiddleware[];
  durability?: RecoveryBudgetOptions | false; // false ⇒ bare TurnRunner
  channels?: ChatChannel[];
  admission?: AdmissionPolicy;
}

/** Registers its timers, migrations, and recovery handlers against the host. */
function createChatRuntime(
  host: AgentHost,
  opts: ChatRuntimeOptions
): ChatIntake & {
  dispose(): void;
};
```

`Think` becomes a ~500-line recipe over `createChatRuntime` (Session store +
workspace/skills/extension tool sources + messenger channels + declarative
tasks + the existing subclass hook surface mapped through a back-compat
middleware). `AIChatAgent` is the same file minus four entries
(`SqliteMessageStore`, no skills/extensions/messengers/scheduled-tasks). A
customer who outgrows both writes their own assembly with full durability —
the original complaint, solved. Customer scenarios:

```ts
// "Tools + codemode + skills, no session management":
class MyAgent extends Agent<Env> {
  chat = createChatRuntime(this, {
    transcript: new SqliteMessageStore(this),
    config: { resolve: async () => ({ model: myModel, system: PROMPT }) },
    tools: [skillTools(registry), codemodeTools(executor)],
    durability: { maxAttempts: 3 }
  });
}

// "Chat over SMS via RPC, no WebSockets/React":
class SmsAgent extends Agent<Env> {
  chat = createChatRuntime(this, { ...core, channels: [] });
  @callable() async onSms(from: string, text: string) {
    const handle = await this.chat.submit([userMessage(text)]);
    return (await handle.result()).parts; // delivery mode "final"
  }
}
```

## Where the lines go

| Today in `think.ts` / `ai-chat/index.ts`                          | Becomes                                             |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| turn loop + stream accumulation                                   | `TurnRunner` (shared)                               |
| recovery incidents, progress, retry/continue, fiber wrapping      | `createDurableTurnRunner` + chat `RecoveryPolicy`   |
| resumable stream buffering, chunk persistence, cleanup alarms     | `ChunkLog`                                          |
| Session wiring, message repair/sanitization, compaction, overflow | `SessionMessageStore` + `contextOverflowMiddleware` |
| workspace / skills / extensions / MCP / client-tool merging       | five `ToolSource` impls                             |
| approvals, out-of-order client results, continuation barriers     | `ToolGate` + `ChatIntake.resolve*`                  |
| WS protocol handling, `chat()` RPC, messengers, delivery policies | three `ChatChannel` impls                           |
| declarative scheduled tasks + reconciliation                      | `declarativeTasks()` Scheduler consumer             |
| submit debounce/queue/replace                                     | `AdmissionPolicy`                                   |

## Migration sequencing (strangler, no flag-day)

1. **L0 inside `packages/agents`.** _Done._ Define the host interfaces
   (`core/host.ts`); `Agent` implements them; extract
   Scheduler/Queue/Fibers/Timers/State/MCP/SubAgents/Workflows/AgentTools
   into one file each with `Agent` delegating (plus Email and the
   agent-tools cluster; see `src/capabilities/`). Pure reorg; public API
   unchanged; `index.ts` went from ~11.6k to ~5.7k lines. The one real
   behavior change: the namespaced `FiberHost.onRecovery` registry, with
   `onFiberRecovered` as the default-namespace fallback, plus the
   documented init-before-recovery lifecycle guarantee.
2. **Un-fork the chat harness.** Extract L2+L3 from the Think copy (it is
   ahead on recovery hardening) into `agents/chat` internals; rewrite
   `AIChatAgent` and `Think` to delegate. Wire protocols and public APIs stay
   identical — the existing e2e suites are the safety net.
3. **Channels.** Introduce `ChatIntake`/`TurnHandle`; re-express the WS
   protocol handler and the `chat()` RPC path as the first two `ChatChannel`
   impls; port messengers as the third.
4. **Expose `createChatRuntime`** as the documented composition API; convert
   each remaining Think feature until `Think` is an assembly.

Step 1 is low-risk and immediately fixes local reasoning; step 2 is the
highest-value (kills the fork and ships the durability work to every `Agent`
consumer); steps 3–4 land incrementally per channel/feature.

## Decisions taken (revisitable)

- **The turn queue stays a per-agent global.** Both codebases document that
  recovery-chain safety depends on turn serialization; relaxing it is a
  separate project.
- **Extract from Think's copy of the harness**, not ai-chat's — the recent
  recovery hardening landed there first.
- **`userHooksMiddleware` keeps the subclass-override style working**;
  greenfield consumers pass middleware directly, and the override style can
  be deprecated later without touching the runtime.

## Alternatives considered

- **Make Think extend AIChatAgent.** Re-layers the inheritance ladder but
  keeps the god-class shape: customers still take all-or-nothing, files stay
  enormous, and the durability work stays welded to chat. Rejected.
- **A generic `agents/recovery` public package now.** Premature per the
  "used twice" rule; recovery policy is product-shaped and the mechanisms
  should be proven under both Think and AIChat before being exposed.
- **Deterministic replay (Temporal-style) instead of reconstruction.**
  Rejected upstream of this RFC: reconstruction rebuilds what survived and
  applies a per-turn policy, imposing no determinism constraints and always
  running new deployed code.
