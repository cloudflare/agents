# RFC: hosts that only compose capabilities

Status: accepted (22 Nov 2026, with the revision in [The decision](#the-decision))

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
- `Agent` carries the sub-agent machinery (the facet API, socket forwarding and 1,500 lines of agent-tool orchestration in one class), and five capabilities each route a facet's wakes their own way. `Agent` also carries a fiber engine, workflow tracking SQL, and schema migrations for tables other code owns.

The experimental `ThinkHarness` (`agents/src/harness/think`) shows the other way is possible. It is one Lifecycle capability, about 4,000 lines with its store, and it does what the chat core does with no host callbacks: every input is a durable operation with an id, operations in a session run one at a time from a Lifecycle job, recovery runs the operation again from its record, the transcript is Sessions, output in flight is Streams, and `ThinkChat` speaks the existing chat wire protocol over it. Its one limit is that it owns the model call, so `AIChatAgent`'s `onChatMessage` contract cannot use it.

## The proposal

### The rule for a host

A host class is a composition root. It installs capabilities in its constructor, exposes its public API as one-line delegates, and keeps its hooks and options. The only one-line delegates on a host are public or protected API that existed before this work. A private method whose whole body forwards to another object is not kept: when code moves, its call sites and the tests that reached into it move in the same PR to call the new owner. It owns no SQLite table, no queue, no waiter map, no timer and no wire frame. Anything with durable rows, a job or an alarm moves into a capability that owns its rows and states what it keeps durably and what it keeps in memory. Anything else moves into a plain internal module.

Seven rules hold across every capability and module below:

1. **One scheduler.** A capability that waits for a time pushes a job onto the Lifecycle job queue. No capability arms the alarm, keeps a heartbeat or runs its own backoff timer that must survive a reset.
2. **Ids and idempotency everywhere.** Every record that starts work (a task run, an effect, a chat request) has an id the caller may choose. The same id with the same payload is a no-op. A different payload under the same id is an error. The Outbox is the one exception by design: its key names a slot whose undelivered value a later send replaces, and each value gets its own idempotency key that stays the same across that value's retries, so a sink dedupes on it.
3. **Results are read separately.** Starting work returns a record. `wait(id)` is a convenience in memory; the record is the truth and outlives the isolate.
4. **Works in a facet, with no facet code.** Sub-agents stay facets: a child with its own class and isolated storage inside its parent's object. Every capability and module works inside one. A facet has no alarm of its own, and today each capability routes its own wakes through the root in its own way (Tasks mirrors each wake, Scheduler stores a facet's schedules in the root, Queue, Fibers and KeepAlive each differ). That becomes one mechanism in the Lifecycle job queue: a facet's Lifecycle keeps its own job queue in its own storage, and where a root arms the alarm, a facet asks its root to hold one job for its earliest due time. When that job fires the Lifecycle makes one call into the facet, whose queue runs its due jobs with the same code as a root. No capability then contains facet code, and a new capability has nothing to consider. The exception is a capability that owns sockets, which must accept a connection the root forwards.
5. **Shape.** Anything that needs its own storage (tables, keys) or an alarm or scheduled work (it pushes Lifecycle jobs or must be woken) is a capability: a `LifecycleCapability` installed with `Lifecycle.use()`, owning its rows and its migrations. Anything else is a plain internal module: functions or a small class that takes what it needs. Hosts and modules own no tables and never touch alarms or the job queue directly.
6. **Exposure.** Nothing new is public. See [Exposure](#exposure).
7. **Exactly what is necessary.** No row, column, index, key or job that no reader needs, and no fact stored twice. On a hot path (a chat turn, a queued request, a task run, a fiber, a stream chunk, a socket connect or resume, startup) the rows written and read, the KV operations, the alarm writes and the `storage.sync()` calls do not rise against the tree before this work without a reason stated in the PR, and the folds onto Tasks and Streams should lower them. Nothing in memory is unbounded: every map keyed by request, run or connection has a bound and a removal path, stated in the design doc. Nothing is built before its call site, and what a change replaces is deleted in the same PR or the next one in its stack.

### What each class holds when done

| Class         | Today  | Budget              | Why that number                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`       | 10,575 | 2,000               | About 130 public members (hooks, options, `sql`, `setState`, `schedule*`, `queue*`, `runFiber`, the workflow methods, `addMcpServer`, `broadcast`, `destroy`) at 10-15 lines each with their JSDoc, plus a constructor of about 120 lines that installs State, WebSockets, Scheduler, Queue, Tasks, Workflows, MCP and Email, and creates the fiber and AgentRuns modules on Tasks.                                                                                                           |
| `AIChatAgent` | 6,799  | 900                 | About 40 public members (options such as `messageConcurrency` and `chatRecovery`, hooks such as `onChatMessage`, `onChatResponse` and `sanitizeMessageForPersistence`, and `messages`, `saveMessages`, `persistMessages`, `continueLastTurn`, `abortRequest`), plus its responder: about 80 lines that call `onChatMessage` and hand the `Response` to the chat module.                                                                                                                       |
| `Think`       | 19,004 | 3,000 in `think.ts` | About 120 public members, many of them hooks with long JSDoc (`getModel`, `getTools`, `beforeTurn`, `beforeToolCall`, `authorizeAction`, `configureSession` and so on), plus a constructor that registers the chat turn definition, creates Approvals and declares its schedules. The inference loop is Think's responder and lives in modules under `packages/think/src` (`inference/`, `tool-decision.ts`, `action-tools.ts`, `context-overflow.ts`). Public types move to `turn-types.ts`. |

A budget much lower than these means removing public API, which is a decision per member and not part of this RFC.

### The capabilities

Chat is not in this table. It owns no storage and schedules nothing, so it is an internal module: see [The chat module](#the-chat-module).

Existing capabilities are extended. New ones are marked new.

Revised 22 Nov: there is one durable engine, Tasks. The Inbox, Fibers, the Outbox, Approvals and AgentRuns were first built as separate capabilities; each now becomes Tasks code (the Inbox's lanes) or a thin internal module on Tasks with no storage of its own. Their unreleased tables need no migration, and no package release goes out until the fold is complete. Rows from released versions (Think's submissions and action ledger, `cf_agents_runs`, `cf_agents_fibers`, `cf_agent_tool_runs`) move into task runs.

| Capability                                              | Durable                                                                                                                                                                                                                                                                               | In memory                                                                                             | What it guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle job queue (exists)                            | `cf_agents_jobs`                                                                                                                                                                                                                                                                      | dispatch revisions                                                                                    | The one scheduler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `KeepAlive` (new, internal)                             | one `keep-alive` job while refs are held                                                                                                                                                                                                                                              | the refs                                                                                              | `keepAlive()` and `keepAliveWhile(fn)` move here from `Agent`. Any capability can hold the object awake, so the chat core stops asking its host for `keepAliveWhile`. An eviction drops the refs and the work they protected; a later start finds the job with no refs and deletes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `State` (exists)                                        | the state row                                                                                                                                                                                                                                                                         | the cached value                                                                                      | Persist, then broadcast, then `onStateChanged`. The broadcast half of `Agent._handleStateChanged` moves in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EventLog` (new, internal, part of `WebSockets`)        | none of its own: it is the socket view over a stream in Streams                                                                                                                                                                                                                       | subscribers                                                                                           | A client subscribes with its last cursor. Retained chunks replay in order, then live chunks follow with nothing between them. A cursor that is absent, ahead, trimmed or from another epoch gets `resync` and the client rebuilds from the host's snapshot. At-least-once on reconnect, no per-client acks. It first shipped with two tables of its own, so a chat chunk was written twice; those tables were never released and go.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Streams` (exists, becomes the one chunk log)           | chunk logs per stream, packed several chunks to a row; tags; a cursor per stream                                                                                                                                                                                                      | the unflushed tail of a batch                                                                         | The one durable log for a token stream. Batched appends with a stated crash loss (the unflushed tail, and a reader that saw part of it is told), retention and head trim, lookup by tag, reclaim of abandoned streams, and cutover to a stored message in one transaction. Recovery rebuilds a reply from the same rows a tab replays from. What `chat/resumable-stream.ts` does that is not chat-specific moves in, with its tests; each addition lands with the call site that needs it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Sessions` (exists)                                     | transcript tree, context blocks                                                                                                                                                                                                                                                       | the hydrated window                                                                                   | One transcript cache and hydration for both chat hosts, in the chat core.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Inbox (folds into Tasks)                                | none after the fold                                                                                                                                                                                                                                                                   | none                                                                                                  | Its lane, policy, report, token and parts code moves into Tasks (T2), with its tests. Think submissions and `ChatLane` become Tasks lane runs. Its tables were never released, so they need no migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Outbox` (internal module on Tasks)                     | none of its own: one run per `(sink, key)` of kind `__cf_outbox:<sink>`                                                                                                                                                                                                               | which deliveries run in this isolate                                                                  | A send to an existing key replaces a value not yet delivered (`replace`, or a `latest` lane per key). A send with no key gets a new one. Each delivery retries with backoff until its sink returns, or gives up (`maxAttempts`, `giveUpAfterMs`) and calls the sink's `onGiveUp`. The attempt is counted before the sink runs, so a value that kills the isolate gives up like any other. Hold is a parked run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Declared schedules (new, internal, part of `Scheduler`) | one job per declared name, `singleflight`                                                                                                                                                                                                                                             | the declaration and its closures                                                                      | `declareSchedules(scheduler, set)` reconciles jobs to the declaration on start: new names armed, removed names cancelled, changed timing re-armed. At most one pending occurrence per name, never two runs at once, at-least-once per occurrence, no backfill after a late alarm. No table of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Tasks` (exists, becomes the one engine)                | one record per run: id, token, kind, input (split past the row limit), idempotency key, optional lane and sequence, status, attempt, metadata, `retain`, timestamps; the run's checkpoint (keyed entries, `step.do` results among them); one job per run outside a lane, one per lane | running attempts' abort controllers, `wait()` promises, each run's `local` companion (attempt 1 only) | A run's attempt is committed with `storage.sync()` before user code runs; after a reset the run is called again with `attempt + 1` and its checkpoint, ahead of its lane's pending runs. `run.do(name, fn)` is for work that should not repeat: a step whose result was stored is skipped on replay. A step is still at-least-once, because a reset after its effect and before its result is stored runs it again; the step gets a stable idempotency key for the far side to dedupe on, and the next attempt is told which step was cut off. `checkpoint.set(key, value)` is for state the next attempt reads. In a lane one run executes at a time, in arrival order, under an arrival policy (`queue`, `latest`, `merge`, `drop`, debounce) decided on arrival; `cancel(id)` and `clear(lane)` reach pending and running runs. A run can park and be released once from outside. Each verb lands with the first call site that needs it. The T1 PR adds its design doc with the API and storage. |
| Fibers (sugar on Tasks, internal to `agents`)           | none of its own: a fiber is a one-step run of kind `__cf_fiber`; `stash` is a checkpoint write                                                                                                                                                                                        | the closure (the run's `local`), waiters                                                              | `runFiber`, `startFiber`, `stash` and the inspect, cancel, resolve and delete methods keep their public shape. Attempt 1 runs the closure; after a reset there is no closure and the recovery hook gets the checkpoint. A fiber the hook leaves open is parked and `resolveFiber` releases it. `cf_agents_runs` and `cf_agents_fibers` rows from released versions move into runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Workflows` (new, internal to `agents`)                 | `cf_agents_workflows` tracking rows                                                                                                                                                                                                                                                   | nothing                                                                                               | The local mirror of workflow instances, updated by callbacks and control calls. The Workflows service stays the truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MCPClientManager` (exists)                             | server registrations                                                                                                                                                                                                                                                                  | connections                                                                                           | Takes `addMcpServer`'s result mapping out of `Agent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Approvals` (internal module on Tasks)                  | none of its own: an effect is a run of kind `__cf_effect` keyed by the effect key; a decision is a parked run of kind `__cf_decision`                                                                                                                                                 | the running effect promise shared by same-isolate callers                                             | `once(key, run)` runs a side effect at most once per key and records its value as the run's result; a reset between the effect and the record leaves it `in-doubt`. `park` records a pending decision; `decide` releases it once and its continuation runs at least once across resets. Think's public approval methods keep their shape. Replaces Think's action ledger, durable-pause approvals and codemode outcome bookkeeping; Think's released ledger rows move into runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AgentRuns` (internal module on Tasks)                  | none of its own: the parent's run is a task of kind `__cf_agent_run` (input: the child's address and the tool input; checkpoint: last stream cursor); the child's run is a run in the child's chat lane, idempotency key = run id                                                     | the tail, while someone is watching                                                                   | One agent-run protocol, with the child's address as the only difference: a facet of this object (the default: no configuration, no hop), or another Durable Object reached through its class's namespace (an addition, for agents that call other agents). Four calls on the child, each idempotent by run id: start, read from a cursor, cancel, status. The child's settle report calls the parent until acknowledged, and the parent's run is released once, so exactly one terminal arrives. The parent cancels the child when it settles or abandons the run, and a child whose parent no longer knows the run cancels itself, so neither side is orphaned. `cf_agent_tool_runs` rows from released versions move into runs.                                                                                                                                                                                                                                                                    |

### The chat module

There is no `Chat` capability. By the shape rule a capability owns storage or schedules work, and chat does neither once the folds land: a turn is a task run in a lane, its chunks are a stream, its frames are the event log's view of that stream, its transcript is Sessions, and its recovery budget and request facts are the run's checkpoint. So chat is plain functions in `agents/src/chat` that plug into Tasks, Streams, Sessions and WebSockets:

- one task definition for the turn. Its handler builds the model call through the host's `respond(call)`, runs the pump into the stream, stores the reply and settles. An attempt after the first is the recovery decision;
- the inbound protocol dispatch and the resume, functions the host's socket handlers call;
- small pure helpers: the continuation rule, the transcript repair, tool-part updates, frame builders.

It owns no table, no job, no alarm and no registry that outlives a turn. The one thing it holds in memory is the live reply of an attempt running in this isolate, at most one per lane: the handler puts it in `deps.live` when its pump starts and removes it when the attempt returns, so a tool answer can reach it on any attempt, a recovery attempt included. What a host supplies is one function and its hooks. `ThinkHarness` already shows this shape for one responder; the change is that the model call becomes the host's.

```ts
import type { UIMessage, UIMessageChunk } from "ai";
import type { ClientToolSchema } from "agents/chat";

/** One model call. Built from the task run and the transcript, never
 *  from a closure, so a reset can build it again. */
export interface ChatModelCall {
  readonly session: string;
  /** The task run id. Every attempt of a turn keeps it. */
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
  /** The Tasks lane arrival policy for overlapping requests. */
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

/** What a host supplies. */
export interface ChatHost {
  readonly respond: ChatResponder["respond"];
  readonly hooks?: ChatHooks;
  readonly options?: ChatOptions;
}

/** The capabilities the functions are given. They own every row and job. */
export interface ChatDeps {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly sessions: Sessions;
  readonly webSockets: WebSockets;
  readonly session?: string;
  /** The live reply of the attempt running in this isolate, per lane. Set
   *  by the handler when its pump starts and removed when the attempt
   *  returns, on every attempt. At most one entry per lane. */
  readonly live: Map<string, LiveReply>;
}

/** The one task definition. The host registers it on its Tasks. */
export function chatTurnDefinition(
  deps: ChatDeps,
  host: ChatHost
): TaskDefinition<ChatTurnInput, ChatTurnResult>;

/** Called by the host's socket handlers. */
export function dispatchChatProtocol(
  deps: ChatDeps,
  host: ChatHost,
  connection: Connection,
  message: WSMessage
): Promise<boolean>;
export function resumeChat(
  deps: ChatDeps,
  connection: Connection,
  cursor?: ChatCursor
): void;

/** What the hosts' public methods call: a few lines each over Tasks and Sessions. */
export function submitTurn(
  deps: ChatDeps,
  input: ChatTurnInput,
  options?: { requestId?: string; local?: unknown }
): Promise<ChatReceipt>;
export function cancelTurn(
  deps: ChatDeps,
  requestId?: string
): Promise<boolean>;
export function clearChat(deps: ChatDeps): Promise<void>;
export function answerTool(
  deps: ChatDeps,
  host: ChatHost,
  answer: ToolAnswer,
  options?: { autoContinue?: boolean; clientTools?: ClientToolSchema[] }
): Promise<void>;
/** Send one request's reply to a caller as well as to sockets (an RPC
 *  callback, an SSE response). Reads the run's stream and its terminal. */
export function followTurn(
  deps: ChatDeps,
  requestId: string,
  sink: ReplySink
): Promise<ChatTurnResult>;
```

How the functions use the capabilities:

- **Admission.** A request is a task run on lane `chat:<session>`. Its payload holds the new user messages, the client tools, the body and the trigger. The messages are held on the record and joined to the transcript when the turn reaches the front of the lane, so a turn answers its own message, as `chat-turn-core.md` requires today. Server-started turns (`saveMessages`, `continueLastTurn`, a tool-result continuation) are durable requests too, so a reset has something to run again. `saveMessages(fn)` keeps its rule that the function runs when the turn reaches the front of the lane, against the transcript as it is then. The function is held in memory beside the record; once it has run, the turn's input is checkpointed on the record. A reset before it ran ends the request `skipped` with nothing stored, which is what a reset does to a queued `saveMessages` today. Stop, cancel and clear are Tasks calls.
- **The turn.** The lane handler joins the held messages, repairs the transcript (`before-turn.ts`), builds a `ChatModelCall`, calls `respond`, and runs the pump.
- **The pump.** One loop reads the chunk stream into a `StreamAccumulator`, appends each chunk to Streams once, where both recovery and tab replay read it, fans it out live through the event log, applies `transformChunk`, and watches for a stop, a stall and errors. At the end it stores the message in one transaction that also settles the stream. `followTurn` gives an RPC caller the same chunks by reading the run's stream as a follower, then the terminal from the run; there is no second pump for RPC. A run has one stream for all its attempts, open until the reply is stored, so a follower and a tab's cursor never switch streams during a recovery: an attempt that continues the reply appends to it, and an attempt that answers again first appends a marker that tells readers to drop the partial.
- **Recovery.** A reset makes Tasks run the `running` request again with `attempt + 1`. A stall or a transient error ends the attempt with a returned settlement (`TaskSettlement.defer`), and the next attempt runs from the lane, which the turn keeps. Each attempt reads the evidence (the request's latest stream, the stored transcript): a reply with content is continued, a question with no reply is answered again, a conversation that moved on ends the turn `skipped`, and a spent budget ends it `error`. The request id never changes across attempts, so a tab follows one id from the first chunk to the terminal frame. No fiber snapshot, no recovery Task, no closure map keyed by a nonce.
- **The wire protocol.** The host's socket handlers call `dispatchChatProtocol`, which parses the `cf_agent_chat_*` messages and calls the functions above, and `resumeChat` on connect. A reply's chunks are read from its stream, and how a request ended (outcome, terminal, message id) is read from its task run, so neither is stored a second time. A tab resumes by cursor (the last run it saw and its offset in that run's stream), and a resume covers every request that ran while it was away. Runs that settled since the cursor are not replayed chunk by chunk: their replies are in the transcript. The resume sends, in one synchronous block: the transcript frame when it changed, which carries every settled reply and wins for stored messages; the terminal of each run settled since the cursor, in lane order; the running run's chunks, from the cursor's offset when the cursor is in that run and from its start otherwise; and the running run's status. The transcript frame leaves out the running run's reply, as the connect view does today, even when a recovery stored a partial of it: the run's stream holds the chunks of every attempt, so replaying it rebuilds the whole reply and the two never carry parts of the same message. Frames that are neither a chunk nor a terminal (the transcript, a `MESSAGE_UPDATED` for a tool result or an approval, the recovering status) are not logged, and a resume supplies them from what is stored:

  - **The transcript.** Without more, a tab that reconnects by cursor in the middle of a turn would keep a stale tool state until the turn's closing transcript frame. So the cursor also carries a transcript marker: a counter held in memory, bumped on each transcript write, sent with an id for the isolate that counted it. A resume sends one transcript frame when the counter moved, or when the id is from an earlier isolate. That costs one transcript frame on the first reconnect after an eviction and no storage.
  - **Order.** The transcript frame goes before any terminal the resume sends. A terminal unlocks the composer, and a transcript arriving after it would replace the list and drop a message the user sent in between (the rule `terminal-frame-order.test.ts` pins for live turns).
  - **Status.** A resume ends with the status of the running turn when it has one to show (waiting out a recovery backoff, waiting for its stream to start), read from its task run, whether or not the transcript changed. A tab that reconnects during a backoff sees "recovering" as it does today.
  - **Two different mismatches.** The log's epoch belongs to the session, not to a reply's stream, because streams come and go with turns: it is a value on the session in Sessions, set when the session is created and replaced on a clear. A cursor carries it: a cursor from another log epoch gets `resync`, and the tab rebuilds from the snapshot. The isolate id on the transcript marker is not an epoch of the log: a mismatch there only adds the transcript frame, and the chunk replay by cursor still happens. The snapshot for a resync is the stored transcript, the running request's reply so far, and the status of every open request and every request settled within the log's retention, read from the task runs. A tab whose cursor was trimmed still learns that its request failed before it produced a reply.

- **Tool answers.** A client tool result or an approval is not a run and no arrival policy applies to it. For a stored message it is one synchronous Sessions write, idempotent by its tool call id. For a tool call still in the live reply it is applied to that reply through `deps.live` and written to the turn's stream as a chunk, so a reset keeps it and other tabs see it. With `autoContinue: false` the answer is stored and it starts no continuation of its own, which is how a standalone tool error is recorded without another model call. In a batch of tool calls one continuation runs when the last answer arrives if any answer opted in. The first answer that opts in submits the continuation run, idempotent by the reply's message id; when it reaches the front of the lane with calls of that reply still unanswered it parks, and the answer that completes the batch releases it, whether or not that answer opted in. The opt-in is therefore on a run, and survives a reset. An answer that carries replacement client tool schemas writes them to the session's value before the continuation is submitted, so the continuation reads the new list. The continuation is a run in the lane, submitted in the same block, and follows the existing rule (D18): it takes over a reply under recovery at its first content chunk. A turn waiting out a recovery backoff keeps its lane, so the continuation cannot queue behind it: the answer makes the waiting turn due at once, and the attempt that starts is the continuation, under the same request id. If it produces content the recovery is over (`continued_by_interaction`); if the provider errors, the turn waits again on the schedule it had. The apply chain each host keeps today goes.
- **What chat used to store.** Every state holder in today's chat core has a destination: the lane (`TurnQueue`, `SubmitConcurrencyController`, `ContinuationState`, `PreStreamTurns`), the run and its `signal` (`AbortRegistry`, `ChatAdmissions`, the recent terminals, owed `onResponse` calls through the run's settle report), the run's checkpoint (the recovery incident, the turn snapshot, stream facts), the stream (`ResumableStream`'s packing and reclaim, progress), a pure function (the recovery decision, the continuation rule) or deletion. One thing fits none of them: the client tools and body of the last client request, which a later server-started turn or continuation reads. They outlive the run that brought them, are not transcript and must not reach tabs. Sessions gets a small keyed value per session for them, cleared with the session. The log's epoch is a third key there.

When the module is complete, the eleven host interfaces and `ChatRecoveryAdapter` go, and so do `turn-fiber.ts`, `turn-task.ts`, `recovery-task.ts`, `recovery-route.ts`, `recovery-attempt.ts`, `resume-handshake.ts`, `recent-terminals.ts`, the three `replay-*` files, the fiber half of `recovery-engine.ts`, and in each host the recovery adapters, the admission replay, the protocol dispatch, the stream wrappers and the message cache.

What stays different between the hosts is their responder, their hooks and one option. `AIChatAgent`'s responder calls `onChatMessage` and returns its `Response`. `Think`'s responder is its inference loop (tools, actions, extensions, `beforeTurn`, `beforeStep`, `beforeToolCall`, telemetry) and returns the `streamText` result. `AIChatAgent` uses `transcript: "flat"` because its regenerate replaces the old reply; `Think` uses `"tree"`.

The chat module does not run server tools itself one durable call at a time, as `ThinkHarness` does. Server tools run inside the responder's `streamText` loop, as today. `ThinkHarness`'s per-tool durability can become a responder for the same task definition, and its operation records move onto Tasks.

### How a host composes

`AIChatAgent` and `Think` install `Tasks`, `Sessions`, `Streams` and `WebSockets` in their constructors and register `chatTurnDefinition(deps, host)` on Tasks, with their responder and their hooks wired into `ChatHooks` once. `AIChatAgent`'s responder calls `onChatMessage` and returns its `Response`; `Think`'s runs its inference loop and returns the `streamText` result. Their public methods call the capabilities and the chat functions directly: `messages` reads the session in Sessions, `saveMessages` is `submitTurn` followed by `tasks.wait`, `abortRequest` is `cancelTurn`, `persistMessages` is a Sessions write. Apps keep using the two classes.

### Exposure

Nothing this work adds is exposed to apps yet. Every new capability and module (event logs, the new Tasks surface, Outbox, Approvals, KeepAlive, the fiber module, workflow tracking, declared schedules, AgentRuns, Chat, and the chat core modules) stays internal until it has shipped inside `Think` and `AIChatAgent` for at least one release and is shown correct. Then each is a separate decision.

- No new `package.json` export and no new symbol in a public entry point. The one new subpath is `agents/internal`, documented as sibling-package support for `@cloudflare/think` and `@cloudflare/ai-chat`, as `agents/chat` already was; every symbol in it is `@internal`.
- No new public method on an existing public class. A new operation on a public capability is a free function in `agents/internal` (`declareSchedules(scheduler, …)`, `declareEventLog(webSockets, …)`).
- No user docs page. The design docs under `design/` carry the contract: what is durable, what is in memory, and the failure cases.
- Changesets describe what apps of `Agent`, `Think` and `AIChatAgent` see, never the new capability.
- Public API that existed before this work keeps working unchanged.
- `pnpm run check` runs `scripts/public-api.ts`, which reads the built `.d.ts` of every published entry and fails on an export subpath or a symbol in a public entry that is not on `scripts/public-api-allow-list.json`. The allow-list was taken from the release before this work began.

### Order of landing

Each step is a set of small PRs, each green alone. A step only starts when the steps it depends on are merged.

1. Done or merging: the shared stream pump in `agents/chat`; the event log; declared schedules on Scheduler and `KeepAlive`; Workflows out of `Agent`; Think's periphery in modules and AIChatAgent's helpers in the chat core; the interim Inbox, Outbox and Approvals capabilities and their first adoptions (Think submissions, `ChatLane`, workflow notifications, messenger replies, Think's decision ledgers), whose host-facing seams do not change in the fold.
2. T1: Tasks gets the record, the checkpoint, the crash contract and `local`, with every current Tasks call site updated in the same PR.
3. T2: lanes and arrival policies move from the Inbox into Tasks; Think submissions and `ChatLane` call Tasks; the Inbox is deleted.
4. The adopters, each in its own PR and each bringing only the Tasks verbs it needs. After T1: fibers as one-step runs (F), and the Approvals effect ledger (A); Approvals' decisions follow with the verbs they bring. After T2: the chat turn's input, stash, budget and recovery attempts inside its own lane run, so a request and its turn are one run (C), and agent-tool runs on both sides (R). The Outbox on Tasks (O) needs no lane and lands with the hold and replace verbs it brings. F, O and A share one shape for a run settled from outside.
5. One facet wake in the Lifecycle job queue, then the routed paths in Tasks, Scheduler, Queue, Fibers and KeepAlive are deleted. Until it lands, each fold keeps its capability working in a facet with the tests that exist. Then `AgentRuns` as one protocol: the parent side moves out of `Agent` with the child still a facet, and another Durable Object as a child is added as a second address kind. No sub-agent API is removed.
6. The chat module, after C. `ChatTurns`, the pump, recovery and the protocol become one task definition and a few functions; the host interfaces are deleted; both hosts become a responder and hooks.
7. One log, in parallel with steps 2 to 4 where it does not need Tasks: Streams gets packing, retention, tags, reclaim and a cursor; the event log becomes a view over a stream and its tables go; a chat chunk is written once; `chat/resumable-stream.ts` and the hosts' `_resumableStream` wrappers are deleted. Moving the turn's facts (request id, message id, outcome, terminal) from the stream onto the task run waits for T1 and C.
8. Schema. The last tables in `Agent._ensureSchema` move to the capability that owns them.

## The alternatives

**A shared `ChatAgent` base class.** `AIChatAgent` and `Think` would extend one class holding the turn core. Every shared method becomes part of each class's inheritance chain, where a subclass can override it, and the core stays tied to `Agent`. A plain Durable Object could not use it, and neither could `ThinkHarness`. [rfc-chat-turn-core.md](./rfc-chat-turn-core.md) rejected this for the same reasons.

**Move both hosts onto `ThinkHarness` as it is.** It already has durable operations and recovery by replay. It owns the model call, so `AIChatAgent`'s contract (any `Response` from `onChatMessage`) does not fit, and `Think` has features the harness lacks (submissions, actions, channels, extensions, messengers, agent tools). Making the model call a responder is the smaller change that keeps the harness's design.

**Keep the host interfaces and shrink them.** Fewer callbacks would cut lines, but the callbacks exist because the state they reach lives on the host. Moving the state into capabilities removes the reason for them. Shrinking them keeps the reason.

**Keep the Inbox, Fibers, Outbox and Approvals as separate engines.** This was the first plan: Tasks had no lanes, no mutable checkpoint and no outside resolution, so each piece got its own records, wakes and crash rules. Built side by side they turned out to be the same engine five times: a record with an id and an idempotency key, an attempt counted before user code, a wake job, a report on settle. Five crash contracts are five places for the same bug. One engine with lanes, a checkpoint and a park/release shape grows Tasks by about 1,600 lines and cuts the total by about 4,200 (about 9,700 lines across the five pieces and their chat-core glue today, about 5,500 after).

**Make the new pieces public as they land.** Inbox, Approvals and the event log were exported and documented in their first PRs. Each is useful on its own, but each would be a promise to apps before the chat hosts had run on it for a release, and a removed export is a breaking change. They are internal until that release.

**A separate event log with its own storage.** The event log first shipped with two tables and its own batching, because a session's log is trimmed from the head and Streams settled whole streams. With chat frames on it, every chunk was written twice (Streams for recovery, the log for replay), and `chat/resumable-stream.ts` (1,307 lines) was a third layer adding packing, tags, reclaim and replay on top of Streams. Three pieces of code for one need. Streams gets retention, packing and a cursor, the event log reads from it, and the adapter is deleted.

## Open questions

- **Merge.** `AIChatAgent` merges the bodies of overlapping messages under `merge`; `Think` supersedes like `latest`. One rule is decided when chat admissions move onto the Tasks lane, recorded in `chat-turn-core.md`.
- **Server tools as durable steps.** With a turn as a durable run, a server tool call could be a recorded step (`ThinkHarness` does this). It is not part of this RFC.

## The decision

Accepted on 22 Nov 2026, with one revision made the same day.

The RFC as first accepted built the Inbox, Fibers, the Outbox and Approvals as separate capabilities, and rejected "build everything on Tasks" because Tasks had no lanes, no mutable checkpoint and no outside resolution. Once the four were built, they had the same parts: a record with an id and an idempotency key, an attempt counted before user code, a wake job and a report on settle. The revision makes Tasks the one engine and gives it those three missing things. The capability table, the `Chat` section and the order of landing above describe the revised design; the rejected alternative is recorded under [The alternatives](#the-alternatives).

Also decided the same day: there is one durable chunk log, Streams. The event log keeps no storage of its own, a chat chunk is written once, and facts about a turn live on its task run, not on its stream.

Revised on 23 Nov 2026: sub-agents stay facets. The RFC first said agents are never facets and capabilities are root only; that is reversed (rule 4). What changes is the routing, which becomes one mechanism in the Lifecycle. An agent that is another Durable Object is an added address kind for agent runs, not a replacement.

Also decided: nothing this work adds is public until it has shipped inside `Think` and `AIChatAgent` for a release ([Exposure](#exposure)), and no package release goes out until the fold onto Tasks is complete, so the interim tables never ship.
