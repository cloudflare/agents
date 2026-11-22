# RFC: hosts that only compose capabilities

Status: proposed

Related:

- [rfc-chat-turn-core.md](./rfc-chat-turn-core.md) and [chat-turn-core.md](./chat-turn-core.md): the shared chat turn core this builds on, and the record of every behaviour the two chat hosts settled.
- [durable-object-lifecycle.md](./durable-object-lifecycle.md): Lifecycle, capabilities and the job queue every capability below schedules through.
- [rfc-fibers.md](./rfc-fibers.md) (Tasks), [rfc-streams.md](./rfc-streams.md) (Streams), [sessions.md](./sessions.md) (Sessions).

## The problem

Three classes hold most of the SDK's behaviour, and each holds it as private methods on itself:

| File                                            | Lines  | Members | Constructor |
| ----------------------------------------------- | ------ | ------- | ----------- |
| `packages/agents/src/index.ts` (`Agent`)        | 10,575 | 320     | 628         |
| `packages/ai-chat/src/index.ts` (`AIChatAgent`) | 6,799  | 208     | 423         |
| `packages/think/src/think.ts` (`Think`)         | 19,004 | 566     | 247         |

That is 36,378 lines in three files, about 1,100 class members, plus 3,500 lines of module-level types and helpers in the same files.

The size is the symptom. The cause is that state which should belong to a reusable piece lives on the class, so the shared code has to call back into the class to reach it:

- The chat core in `packages/agents/src/chat` (21,789 lines) calls into its hosts through eleven `*Host` and `*Hooks` interfaces with about 100 callbacks between them, and each host implements every one. Both hosts still carry same-named adapters for recovery, admission and replay (`_chatRecoveryEngine`, `_exhaustChatRecovery`, `_routeStreamInterruption`, `_replayClientChatRequest`, `_clientChatRequest` and a dozen more).
- A request waiting to run is stored three ways (`cf_agents_chat_admissions`, `cf_think_submissions`, `cf_agent_tool_runs`) and queued in memory three more (`TurnQueue`, `SubmitConcurrency`, `AbortRegistry`).
- The loop that reads a model stream, stores it and sends it exists four times, about 2,150 lines.
- Deliver-until-acknowledged is written by hand three times in `Think` (workflow notifications, messenger replies after recovery, detached agent-tool results) and once more in `Agent`.
- Work that pauses for a human decision is written three times in `Think` (the action ledger, durable-pause approvals, codemode execution approvals).
- A tab that reconnects learns how its request ended through a hand-built resume handshake (`resume-handshake.ts`, `recent-terminals.ts`, three `replay-*` files, a client state machine). Terminal frames are not in any log, which is where every "the tab never learned how its request ended" bug came from. A resume still answers one request id only.
- `Agent` carries the facet machinery for sub-agents (192 references), a fiber engine, workflow tracking SQL, schema migrations for tables other code owns, and 1,500 lines of agent-tool orchestration.

The experimental `ThinkHarness` (`agents/src/harness/think`) shows the other way is possible. It is one Lifecycle capability, about 4,000 lines with its store, and it does what the chat core does with no host callbacks: every input is a durable operation with an id, operations in a session run one at a time from a Lifecycle job, recovery runs the operation again from its record, the transcript is Sessions, output in flight is Streams, and `ThinkChat` speaks the existing chat wire protocol over it. Its one limit is that it owns the model call, so `AIChatAgent`'s `onChatMessage` contract cannot use it.

## The proposal

### The rule for a host

A host class is a composition root. It installs capabilities in its constructor, exposes its public API as one-line delegates, and keeps its hooks and options. It owns no SQLite table, no queue, no waiter map, no timer and no wire frame. Anything with durable rows, a job or an alarm moves into a capability that owns its rows and states what it keeps durably and what it keeps in memory. Anything else moves into a plain internal module.

Six rules hold across every capability and module below:

1. **One scheduler.** A capability that waits for a time pushes a job onto the Lifecycle job queue. No capability arms the alarm, keeps a heartbeat or runs its own backoff timer that must survive a reset.
2. **Ids and idempotency everywhere.** Every record that starts work (an Inbox request, an effect, a run) has an id the caller may choose. The same id with the same payload is a no-op. A different payload under the same id is an error. The Outbox is the one exception by design: its key names a slot whose undelivered value a later send replaces, and each value gets its own idempotency key that stays the same across that value's retries, so a sink dedupes on it.
3. **Results are read separately.** Starting work returns a record. `wait(id)` is a convenience in memory; the record is the truth and outlives the isolate.
4. **Root only.** Agents are never facets after this change, so no capability supports a routed Lifecycle, and the route envelopes in Lifecycle, Tasks, Scheduler and Queue go. Facets stay for dynamic code execution (codemode, Worker Loader), which does not install a Lifecycle.
5. **Shape.** Anything that needs its own storage (tables, keys) or an alarm or scheduled work (it pushes Lifecycle jobs or must be woken) is a capability: a `LifecycleCapability` installed with `Lifecycle.use()`, owning its rows and its migrations. Anything else is a plain internal module: functions or a small class that takes what it needs. Hosts and modules own no tables and never touch alarms or the job queue directly.
6. **Exposure.** Nothing new is public. See [Exposure](#exposure).

### What each class holds when done

| Class         | Today  | Budget              | Why that number                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`       | 10,575 | 2,000               | About 130 public members (hooks, options, `sql`, `setState`, `schedule*`, `queue*`, `runFiber`, the workflow methods, `addMcpServer`, `broadcast`, `destroy`) at 10-15 lines each with their JSDoc, plus a constructor of about 120 lines that installs State, WebSockets, Scheduler, Queue, Tasks, Fibers, Workflows, MCP, Email and AgentRuns.                                                                                                                 |
| `AIChatAgent` | 6,799  | 900                 | About 40 public members (options such as `messageConcurrency` and `chatRecovery`, hooks such as `onChatMessage`, `onChatResponse` and `sanitizeMessageForPersistence`, and `messages`, `saveMessages`, `persistMessages`, `continueLastTurn`, `abortRequest`), plus its responder: about 80 lines that call `onChatMessage` and hand the `Response` to the chat capability.                                                                                      |
| `Think`       | 19,004 | 3,000 in `think.ts` | About 120 public members, many of them hooks with long JSDoc (`getModel`, `getTools`, `beforeTurn`, `beforeToolCall`, `authorizeAction`, `configureSession` and so on), plus a constructor that installs Chat, Approvals and Scheduler declarations. The inference loop is Think's responder and lives in modules under `packages/think/src` (`inference/`, `tool-decision.ts`, `action-tools.ts`, `context-overflow.ts`). Public types move to `turn-types.ts`. |

A budget much lower than these means removing public API, which is a decision per member and not part of this RFC.

### The capabilities

Existing capabilities are extended. New ones are marked new.

| Capability                                              | Durable                                                                                                                                                                                                                                         | In memory                                                                                             | What it guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle job queue (exists)                            | `cf_agents_jobs`                                                                                                                                                                                                                                | dispatch revisions                                                                                    | The one scheduler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `KeepAlive` (new, internal)                             | one `keep-alive` job while refs are held                                                                                                                                                                                                        | the refs                                                                                              | `keepAlive()` and `keepAliveWhile(fn)` move here from `Agent`. Any capability can hold the object awake, so the chat core stops asking its host for `keepAliveWhile`. An eviction drops the refs and the work they protected; a later start finds the job with no refs and deletes it.                                                                                                                                                                                                                                                                                                                                                  |
| `State` (exists)                                        | the state row                                                                                                                                                                                                                                   | the cached value                                                                                      | Persist, then broadcast, then `onStateChanged`. The broadcast half of `Agent._handleStateChanged` moves in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `EventLog` (new, internal, part of `WebSockets`)        | per log: events with a sequence number in rows of whole events, bounded by count and bytes; an epoch; gap rows                                                                                                                                  | subscribers, the unflushed tail of a batch                                                            | A client subscribes with its last cursor. Retained events replay in order, then live events follow with nothing between them. A cursor that is absent, ahead, trimmed or inside a gap gets `resync` and the client rebuilds from the host's snapshot. A crash loses at most a batch's unflushed tail, and a client that saw part of it is told. At-least-once on reconnect, no per-client acks. An event is capped at 1 MiB, never split. Own tables, not Streams, because a log is trimmed from the head and Streams settles whole streams.                                                                                            |
| `Streams` (exists)                                      | chunk logs per stream                                                                                                                                                                                                                           | write buffer                                                                                          | The model chunk log a reply is rebuilt from after a reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Sessions` (exists)                                     | transcript tree, context blocks                                                                                                                                                                                                                 | the hydrated window                                                                                   | One transcript cache and hydration for both chat hosts, in the chat core.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Inbox` (new, internal)                                 | one record per request: id, kind, lane, sequence, status (`pending`, `running`, `completed`, `error`, `aborted`, `skipped`), attempt, idempotency key, payload and result split past the row limit, progress, timestamps; one job per open lane | running handlers' abort controllers, `wait()` promises, debounce timers                               | One request runs at a time per lane, in order. Arrival policies (`queue`, `latest`, `merge`, `drop`, debounce) are decided on arrival and stored, and supersession is applied at the front of the lane. `cancel(id)` reaches a pending and a running request. `clear(lane)` ends every open request. After a reset a `running` request runs again with `attempt + 1` ahead of the pending ones (at-least-once). Records stay until deleted or purged. Replaces `cf_agents_chat_admissions`, `cf_think_submissions`, the queue side of `cf_agent_tool_runs`, `TurnQueue`, `SubmitConcurrency`, `AbortRegistry`, and Think's waiter maps. |
| `Outbox` (new, internal)                                | one record per `(sink, key)`: value, status, attempts, first failure, next attempt, last error, checkpoint, idempotency key; one job per pending delivery                                                                                       | which deliveries run in this isolate                                                                  | A send to an existing key replaces a value not yet delivered. A send with no key gets a new one, which is how "every message" works. Each key retries with backoff until its sink returns, or gives up (`maxAttempts`, `giveUpAfterMs`), emits `outbox:give_up` and calls the sink's `onGiveUp`. No order between keys. The attempt is counted before the sink runs, so a value that kills the isolate gives up like any other.                                                                                                                                                                                                         |
| Declared schedules (new, internal, part of `Scheduler`) | one job per declared name, `singleflight`                                                                                                                                                                                                       | the declaration and its closures                                                                      | `declareSchedules(scheduler, set)` reconciles jobs to the declaration on start: new names armed, removed names cancelled, changed timing re-armed. At most one pending occurrence per name, never two runs at once, at-least-once per occurrence, no backfill after a late alarm. No table of its own.                                                                                                                                                                                                                                                                                                                                  |
| `Tasks` (exists)                                        | runs and their step journal                                                                                                                                                                                                                     | live closures                                                                                         | Durable replayable functions. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Fibers` (new, internal to `agents`)                    | `cf_agents_runs`, `cf_agents_fibers`, one recovery job                                                                                                                                                                                          | the closure, its abort controller, waiters                                                            | `runFiber`, `startFiber`, `stash` and the inspect, cancel, resolve and delete methods move out of `Agent` unchanged. A body runs at most once; after an eviction the recovery hook gets the last checkpoint. Not built on Tasks: a fiber has a mutable checkpoint and can be resolved from outside, and a Task has neither.                                                                                                                                                                                                                                                                                                             |
| `Workflows` (new, internal to `agents`)                 | `cf_agents_workflows` tracking rows                                                                                                                                                                                                             | nothing                                                                                               | The local mirror of workflow instances, updated by callbacks and control calls. The Workflows service stays the truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MCPClientManager` (exists)                             | server registrations                                                                                                                                                                                                                            | connections                                                                                           | Takes `addMcpServer`'s result mapping out of `Agent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Approvals` (new, internal)                             | effect ledger rows (key, name, input hash, status, recorded value); decision rows (`pending`, `decided`, `settled`, verdict, outcome, acknowledged); one recovery job per unfinished decision                                                   | the running effect promise shared by same-isolate callers, the running continuation, `wait()` waiters | `once(key, run)` runs a side effect at most once per key while its claim is held and records the value; a crash between the effect and the record leaves it `in-doubt`. `park` records a pending decision; `decide` takes one verdict and runs the continuation at least once across resets; `onSettled` runs until the host acknowledges it. Replaces Think's action ledger, durable-pause approvals and codemode outcome bookkeeping.                                                                                                                                                                                                 |
| `AgentRuns` (new, internal)                             | parent: one row per child run (child class, child name, status, result, last sequence); child: the run is an Inbox request                                                                                                                      | the tail, the no-progress timer                                                                       | A child agent is an ordinary named Durable Object reached through its namespace. The parent starts a run (idempotent by run id), follows the child's output by cursor, cancels it and reads its result. The child's terminal reaches the parent through an Outbox sink on the child.                                                                                                                                                                                                                                                                                                                                                    |
| `Chat` (new, internal)                                  | none of its own                                                                                                                                                                                                                                 | the live reply of the running request                                                                 | Composes Sessions, an Inbox lane, Streams, the event log, the Outbox (owed `onResponse` calls) and Approvals. It installs the Inbox, Outbox and Approvals it uses itself; a host installs `WebSockets` and `Chat`. A host supplies a responder and hooks. See below.                                                                                                                                                                                                                                                                                                                                                                    |

### The `Chat` capability

`Chat` is internal: the engine under `AIChatAgent` and `Think`. One capability can own the transcript, admission, the stream pump, recovery and the wire protocol, and a host can be reduced to one function plus hooks. `ThinkHarness` already shows the first four for one responder. The change is that the model call becomes the host's.

```ts
import type { UIMessage, UIMessageChunk } from "ai";
import type { ClientToolSchema } from "agents/chat";

/** One model call. Built from the Inbox record and the transcript, never
 *  from a closure, so a reset can build it again. */
export interface ChatModelCall {
  readonly session: string;
  /** The Inbox request id. Every attempt of a turn keeps it. */
  readonly requestId: string;
  /** 1 on the first run, higher after a reset or a live interruption. */
  readonly attempt: number;
  /** Answer the question, or continue the reply a cut-off attempt left. */
  readonly mode: "answer" | "continue";
  readonly trigger:
    | "submit-message"
    | "regenerate-message"
    | "tool-answer"
    | "server";
  /** The user message this turn answers. */
  readonly questionId?: string;
  /** The assistant message a `continue` extends. */
  readonly replyId?: string;
  /** Repaired transcript, ending at this turn's question or reply. */
  readonly messages: readonly UIMessage[];
  readonly clientTools: readonly ClientToolSchema[];
  readonly body?: Readonly<Record<string, unknown>>;
  /** Channel and turn metadata stamped on the question. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Aborted by a stop, a clear, a supersede or `cancel(requestId)`. */
  readonly signal: AbortSignal;
}

/** A `Response` is read as SSE when its content type says so, otherwise
 *  as plain text, as `AIChatAgent` does today. */
export type ChatModelStream =
  | AsyncIterable<UIMessageChunk>
  | ReadableStream<UIMessageChunk>
  | Response
  | { toUIMessageStream(): ReadableStream<UIMessageChunk> };

export interface ChatResponder {
  respond(call: ChatModelCall): Promise<ChatModelStream | undefined>;
}

export interface ChatHooks {
  /** After the reply is stored. Owed calls are delivered after a reset. */
  onResponse?(result: ChatTurnResult): void | Promise<void>;
  /** A turn found interrupted. Default: continue within the budget. */
  onRecovery?(
    context: ChatRecoveryContext
  ): ChatRecoveryOptions | void | Promise<ChatRecoveryOptions | void>;
  /** Default: every error is terminal. */
  classifyError?(
    error: unknown,
    inBand: boolean
  ): "terminal" | "transient" | "overflow";
  /** Make room, and say whether to call the model again. */
  onContextOverflow?(call: ChatModelCall): Promise<boolean>;
  /** Rewrite a chunk before it is stored and sent. */
  transformChunk?(
    chunk: UIMessageChunk,
    parts: readonly UIMessage["parts"][number][]
  ): UIMessageChunk;
  /** Rewrite a message before it is stored. */
  sanitizeForPersistence?(message: UIMessage): UIMessage;
  repairInterruptedToolPart?(part: ToolPart): ToolPart;
}

export interface ChatOptions {
  readonly responder: ChatResponder;
  readonly hooks?: ChatHooks;
  readonly webSockets: WebSockets;
  /** The Inbox arrival policy for overlapping requests. */
  readonly concurrency?:
    | "queue"
    | "latest"
    | "merge"
    | "drop"
    | { debounceMs: number };
  /** `tree` keeps every regeneration as a branch; `flat` replaces the old reply. */
  readonly transcript?: "tree" | "flat";
  readonly recovery?:
    | false
    | { maxAttempts?: number; stallTimeoutMs?: number; budgetMs?: number };
  readonly maxPersistedMessages?: number;
  readonly hydrationByteBudget?: number;
}

export class Chat extends LifecycleCapability {
  constructor(options: ChatOptions);
  session(id?: string): ChatSession;
}

export interface ChatSession {
  readonly id: string;
  submit(
    input: ChatInput,
    options?: { requestId?: string; source?: "client" | "server" }
  ): Promise<ChatReceipt>;
  wait(
    requestId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<ChatTurnResult | undefined>;
  /** Send one request's reply to a caller as well as to sockets (an RPC callback, an SSE response). */
  follow(requestId: string, sink: ReplySink): Promise<ChatTurnResult>;
  cancel(requestId?: string): Promise<boolean>;
  clear(): Promise<void>;
  answerTool(
    answer: ToolAnswer,
    options?: { autoContinue?: boolean }
  ): Promise<ChatReceipt>;
  messages(): readonly UIMessage[];
  persist(messages: readonly UIMessage[]): Promise<void>;
  waitUntilStable(): Promise<void>;
  hasPendingInteraction(): boolean;
}
```

Inside `Chat`:

- **Admission.** A request is an Inbox request on lane `chat:<session>`. Its payload holds the new user messages, the client tools, the body and the trigger. The messages are held on the record and joined to the transcript when the turn reaches the front of the lane, so a turn answers its own message, as `chat-turn-core.md` requires today. Server-started turns (`saveMessages`, `continueLastTurn`, a tool-result continuation) are durable requests too, so a reset has something to run again. `saveMessages(fn)` keeps its rule that the function runs when the turn reaches the front of the lane, against the transcript as it is then. The function is held in memory beside the record; once it has run, the turn's input is checkpointed on the record. A reset before it ran ends the request `skipped` with nothing stored, which is what a reset does to a queued `saveMessages` today. Stop, cancel and clear are Inbox calls.
- **The turn.** The lane handler joins the held messages, repairs the transcript (`before-turn.ts`), builds a `ChatModelCall`, calls `respond`, and runs the pump.
- **The pump.** One loop reads the chunk stream into a `StreamAccumulator`, appends chunks to Streams, sends every frame through the event log, applies `transformChunk`, and watches for a stop, a stall and errors. At the end it stores the message in one transaction that also settles the stream. `follow()` adds a sink; there is no second pump for RPC.
- **Recovery.** A reset makes the Inbox run the `running` request again with `attempt + 1`. A stall or a transient error ends the attempt with an `interrupted` result, and the handler runs the next attempt in the same invocation. Each attempt reads the evidence (the request's latest stream, the stored transcript): a reply with content is continued, a question with no reply is answered again, a conversation that moved on ends the turn `skipped`, and a spent budget ends it `error`. The request id never changes across attempts, so a tab follows one id from the first chunk to the terminal frame. No fiber snapshot, no recovery Task, no closure map keyed by a nonce.
- **The wire protocol.** `Chat` registers its handlers on `WebSockets`, parses the `cf_agent_chat_*` messages and calls the session methods. Every outbound frame, terminal frames included, is an event on the session's log. A tab resumes by cursor, and a resume covers every request that ran while it was away. The snapshot for a resync is the stored transcript, the running request's reply so far, and the status of every open request and every request settled within the log's retention, read from the Inbox records. A tab whose cursor was trimmed still learns that its request failed before it produced a reply.
- **Tool answers.** A client tool result or an approval is an Inbox request too, as `ThinkHarness` treats it, deduplicated by its tool call id. Arrival policies apply to turns only: a tool answer is never superseded, merged, dropped or debounced. It is applied ahead of the queued turns, as both hosts apply it at once today, and the continuation it starts follows the existing rule (D18): it takes over a reply under recovery at its first content chunk. The apply chain each host keeps today goes.

When `Chat` lands, the eleven host interfaces and `ChatRecoveryAdapter` go, and so do `turn-fiber.ts`, `turn-task.ts`, `recovery-task.ts`, `recovery-route.ts`, `recovery-attempt.ts`, `resume-handshake.ts`, `recent-terminals.ts`, the three `replay-*` files, the fiber half of `recovery-engine.ts`, and in each host the recovery adapters, the admission replay, the protocol dispatch, the stream wrappers and the message cache.

What stays different between the hosts is their responder, their hooks and one option. `AIChatAgent`'s responder calls `onChatMessage` and returns its `Response`. `Think`'s responder is its inference loop (tools, actions, extensions, `beforeTurn`, `beforeStep`, `beforeToolCall`, telemetry) and returns the `streamText` result. `AIChatAgent` uses `transcript: "flat"` because its regenerate replaces the old reply; `Think` uses `"tree"`.

`Chat` does not run server tools itself one durable call at a time, as `ThinkHarness` does. Server tools run inside the responder's `streamText` loop, as today. `ThinkHarness`'s per-tool durability can become a responder on `Chat`, and its operation records move onto the Inbox.

### How a host composes

`AIChatAgent` and `Think` install `Chat` in their constructors, with their responder and their hooks wired into `ChatHooks` once. `AIChatAgent`'s responder calls `onChatMessage` and returns its `Response`; `Think`'s runs its inference loop and returns the `streamText` result. Their public methods become delegates: `messages` reads `chat.session().messages()`, `saveMessages` is `submit` with `source: "server"` followed by `wait`, `abortRequest` is `cancel`, `persistMessages` is `persist`. Apps keep using the two classes.

### Exposure

Nothing this work adds is exposed to apps yet. Every new capability and module (event logs, Inbox, Outbox, Approvals, KeepAlive, Fibers, workflow tracking, declared schedules, AgentRuns, Chat, and the chat core modules) stays internal until it has shipped inside `Think` and `AIChatAgent` for at least one release and is shown correct. Then each is a separate decision.

- No new `package.json` export and no new symbol in a public entry point. The one new subpath is `agents/internal`, documented as sibling-package support for `@cloudflare/think` and `@cloudflare/ai-chat`, as `agents/chat` already was; every symbol in it is `@internal`.
- No new public method on an existing public class. A new operation on a public capability is a free function in `agents/internal` (`declareSchedules(scheduler, …)`, `declareEventLog(webSockets, …)`).
- No user docs page. The design docs under `design/` carry the contract: what is durable, what is in memory, and the failure cases.
- Changesets describe what apps of `Agent`, `Think` and `AIChatAgent` see, never the new capability.
- Public API that existed before this work keeps working unchanged.
- `pnpm run check` runs `scripts/public-api.ts`, which reads the built `.d.ts` of every published entry and fails on an export subpath or a symbol in a public entry that is not on `scripts/public-api-allow-list.json`. The allow-list was taken from the release before this work began.

### Order of landing

Each step is a set of small PRs, each green alone. A step only starts when the steps it depends on are merged.

1. Independent of each other: the shared stream pump in `agents/chat` (first among the chat work, because admission, recovery and the event log adopt its sink); the event log, Inbox, Outbox and Approvals, each as a capability alone with integration tests on a minimal Durable Object and a design doc; declared schedules on Scheduler and `KeepAlive`; Fibers and Workflows out of `Agent`; moving Think's periphery into modules and AIChatAgent's helpers into the chat core, starting with the regions furthest from the chat turn; moving the agent-tool parent side out of `Agent` unchanged.
2. First adoptions: Think submissions on the Inbox; workflow notifications and messenger replies on the Outbox; Think's three decision ledgers on Approvals; chat frames on the event log (after the pump).
3. Chat admissions, the turn queue, submit concurrency and the abort registry on the Inbox. From here every chat turn is an Inbox request.
4. Recovery as replay. The turn's attempts run from its Inbox record. The chat-turn Task, the recovery Task and the fiber path for chat turns are deleted. It waits for step 3 rather than running first on the chat-turn Task. A Task driver would work (Tasks hands a long attempt to the alarm's memory-limit breaker once its dispatch budget runs out), but it keeps a second durable record of the turn beside the admission record, and the order between queued requests and a recovering one stays a hand-off between the two. On the Inbox lane that order is the lane order, so the runner is written once, against its final record.
5. `AgentRuns` over ordinary Durable Objects. Child runs become Inbox requests on the child, delivery to the parent goes through the Outbox, and the sub-agent facet API and Lifecycle route envelopes are removed (major). A run left open by the earlier version ends `error` on the parent's first start, with the terminal event and hooks the parent expects. Facet storage is not deleted, only no longer reached: apps that kept data in sub-agent facets (`examples/multi-ai-chat` keeps conversations there) read it once through `ctx.facets.get` and write it to the new child objects, and the migration guide shows how.
6. The `Chat` capability. `ChatTurns`, the pump, recovery and the protocol become one capability; the host interfaces are deleted; both hosts become a responder and hooks.
7. Schema. The last tables in `Agent._ensureSchema` move to the capability that owns them.

## The alternatives

**A shared `ChatAgent` base class.** `AIChatAgent` and `Think` would extend one class holding the turn core. Every shared method becomes part of each class's inheritance chain, where a subclass can override it, and the core stays tied to `Agent`. A plain Durable Object could not use it, and neither could `ThinkHarness`. [rfc-chat-turn-core.md](./rfc-chat-turn-core.md) rejected this for the same reasons.

**Move both hosts onto `ThinkHarness` as it is.** It already has durable operations and recovery by replay. It owns the model call, so `AIChatAgent`'s contract (any `Response` from `onChatMessage`) does not fit, and `Think` has features the harness lacks (submissions, actions, channels, extensions, messengers, agent tools). Making the model call a responder is the smaller change that keeps the harness's design.

**Keep the host interfaces and shrink them.** Fewer callbacks would cut lines, but the callbacks exist because the state they reach lives on the host. Moving the state into capabilities removes the reason for them. Shrinking them keeps the reason.

**Build everything on Tasks.** Tasks gives a durable input, replay and `cancel(runId)`. It has no lanes, no order between runs and no arrival policies, which is most of what the Inbox is. A fiber needs a mutable checkpoint and outside resolution, which Tasks does not have. An outbox delivery is not a replayed function. A chat turn on Tasks would also be a second record of the request beside its Inbox record.

**Make the new pieces public as they land.** Inbox, Approvals and the event log were exported and documented in their first PRs. Each is useful on its own, but each would be a promise to apps before the chat hosts had run on it for a release, and a removed export is a breaking change. They are internal until that release.

**Put chat frames on Streams instead of a new event log.** Streams settles and deletes whole streams; a session's log is one sequence trimmed from the head. Bending Streams to do both would make it worse at the first.

## Open questions

- **Chunks are written twice.** The reply's chunks go to Streams, where recovery rebuilds a reply from them, and to the event log, where tabs resume from them. That is two row writes per batch. Once the event log is in use, measure it, and decide whether the log can serve as a reply's evidence while a turn is open (retention would have to keep an open turn's rows).
- **Merge.** `AIChatAgent` merges the bodies of overlapping messages under `merge`; `Think` supersedes like `latest`. The Inbox decides one rule when chat admissions move onto it, recorded in `chat-turn-core.md`.
- **Server tools as durable steps.** With a turn as a durable run, a server tool call could be a recorded step (`ThinkHarness` does this). It is not part of this RFC.

## The decision

To be filled in after review.
