Status: proposed

# `agents/harness`: one developer API for every harness, and a remote Claude Code runtime

## The problem

We ship three harnesses under `examples/next/harnesses/` (pi, codex, self-modifying).
None is exported. Each is the same capability written a third time: a
`LifecycleCapability`, one reserved `__cf` Tasks definition, one Streams log per unit
of work, durable admission before any model work, replay-safe settlement, and a
near-identical browser envelope (`snapshot` / `events{seq,lastSeq}` / `stream_end` /
`result` / `error`). They also expose three different developer APIs: pi has
`submit/prompt/waitForResult/abort/steer/getMessages/snapshot`, codex has
`submit/list/snapshot/events/message`, self-modifying has `submit/prompt/getTurn/snapshot`.
`prompt()` already means two different things in shipped code (pi: submit and wait;
self-modifying: run attached). `webSockets()` already has two arities.

All three run their agent loop inside the Durable Object. We want a fourth harness
whose loop cannot: Claude Code, running in a Container as a remote binary, driven from
the Durable Object over a Cap'n Web session. Issue #1829 proposed adopting Vercel's
`@ai-sdk/harness` for that; we do not want it (see the alternatives), and the local
harnesses already give us most of what it would.

Two things must therefore happen together:

1. **One developer API.** Every harness, local or remote, is driven the same way:
   `harness.session(id)`, then `prompt()`, `interrupt()`, `reply()`, `messages()`,
   `status()`, `events()`. The shape is the most limited common version of our three
   harnesses, OpenCode's current API, pi's harness API, the Claude Agent SDK and
   Anthropic's Managed Agents, not the union.
2. **One capability, pluggable runtime.** `agents/harness` owns the durable parts
   (sessions, inbox, operations, requests, event logs) once. A `HarnessRuntime` does
   the work: in the DO for pi, codex and self-modifying; in a container for Claude
   Code. The capability cannot tell which.

This design came out of three research passes over the repo, cloudflare/computer,
`@cloudflare/sandbox`, cloudflare/claude-managed-agents, capnweb 0.12, the Claude Agent
SDK, OpenCode `dev`, pi's vendored build, and the workerd, edgeworker and cloudchamber
sources, then a four-way design panel and an adversarial verification pass whose
corrections are folded in. Facts that decide something are cited as `file:line` in the
checked-out sources (main at b9142be5) or as a doc URL. Runtime facts were read from
workerd, edgeworker and cloudchamber, not inferred.

## The proposal

### Vocabulary

| Word                 | Meaning here                                                                                                                   | Managed Agents equivalent    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **Harness**          | the Lifecycle capability                                                                                                       | (the control plane)          |
| **Runtime**          | the thing that executes the agent loop; a `HarnessRuntime` implementation                                                      | environment                  |
| **Daemon**           | the program in the container that hosts a remote runtime's engine                                                              | (self-hosted worker)         |
| **Engine**           | the plug-in inside the daemon (Claude Code via the Agent SDK)                                                                  | agent                        |
| **Session**          | one conversation; a handle on the harness. pi's lanes are sessions on one DO; a container-backed session is exactly one per DO | session                      |
| **Operation**        | one unit of work with a durable receipt: a prompt turn, a compaction                                                           | (turn)                       |
| **Request**          | an open question from the agent: permission, question, host tool                                                               | `requires_action`            |
| **Frame**            | a durable event envelope in a Streams log                                                                                      | event                        |
| **Preview**          | a live-only token delta; never persisted, never replayed                                                                       | `event_delta`                |
| **Runtime identity** | a UUID minted per container generation; the fencing token                                                                      | (work item secret)           |
| **Engine session**   | Claude Code's own `session_id` and `.jsonl`                                                                                    | (the container's transcript) |

"Session" never means a `Sessions` capability row; "engine session" never means a
harness session.

### The developer API

This is the API every harness exposes. It is the intersection of the nine systems
compared, plus one deliberate loosening (`requests`/`reply`) explained below. The
block type-checks on its own.

```ts
// agents/harness/protocol — the only module both sides of a wire import
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// agents/harness
import type { SessionMessage, SessionMessagePart } from "agents/sessions"; // type-only

/** A runtime declares its vocabulary once. The base stores it opaquely and types it at the seam. */
export type HarnessProtocol = {
  /** Runtime-specific event bodies, delivered as `{ type: "extension", body }`. Must carry a discriminant. */
  readonly event: { readonly type: string } & {
    readonly [key: string]: JsonValue;
  };
  /** Runtime-specific submissions beyond the reserved kinds. */
  readonly submit: { readonly kind: string; readonly payload: JsonValue };
  /** The runtime's terminal record, surfaced as HarnessResult.raw. */
  readonly result: JsonValue;
};

export interface HarnessSessions<P extends HarnessProtocol = HarnessProtocol> {
  /** Idempotent on sessionId; the same id with a different config throws HarnessConflictError.
   *  Throws HarnessCapabilityUnsupportedError("sessions") for a second id on a single-session runtime. */
  create(options?: HarnessSessionCreateOptions): Promise<HarnessSession<P>>;
  /** A handle. Synchronous, total, no I/O. Default id is "". */
  open(sessionId?: string): HarnessSession<P>;
  list(options?: HarnessSessionListOptions): Promise<HarnessSessionPage>;
  /** Destroy this session's durable state. Idempotent. */
  delete(sessionId: string): Promise<void>;
}

export interface HarnessSessionCreateOptions {
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly config?: HarnessConfigPatch;
}
export interface HarnessSessionListOptions {
  readonly limit?: number;
  readonly cursor?: string; // opaque, from a previous page
  readonly order?: "asc" | "desc";
}
export interface HarnessSessionInfo {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly state: HarnessRunState;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface HarnessSessionPage {
  readonly sessions: readonly HarnessSessionInfo[];
  readonly cursor?: string;
}

export interface HarnessSession<P extends HarnessProtocol = HarnessProtocol> {
  readonly sessionId: string;

  // drive
  /** Admit one input. Resolves once the input and its wake are durable. Never waits for the model. */
  prompt(
    input: HarnessInput,
    options?: HarnessPromptOptions
  ): Promise<HarnessReceipt>;
  /** Durably ask the active operation to stop. A no-op when idle. */
  interrupt(options?: HarnessInterruptOptions): Promise<HarnessInterruptResult>;

  // answer
  /** Every unanswered request from the agent. Empty for harnesses that never ask. */
  requests(): Promise<readonly HarnessRequest[]>;
  /** Answer one. A duplicate or late answer returns accepted:false rather than throwing. */
  reply(
    requestId: string,
    reply: HarnessReply
  ): Promise<{ readonly accepted: boolean }>;

  // read
  messages(options?: HarnessMessagesOptions): Promise<HarnessMessagePage>;
  status(): Promise<HarnessStatus>;
  result(operationId: string): Promise<HarnessResult<P> | undefined>;
  /** Resolves with the terminal result whatever its status. Throws HarnessTimeoutError,
   *  HarnessOperationNotFoundError. Pins the DO while waiting; durable callers use events(). */
  wait(
    operationId: string,
    options?: HarnessWaitOptions
  ): Promise<HarnessResult<P>>;
  /** Replay the durable log from `from`, then tail live. Ends when `signal` aborts. */
  events(
    options?: HarnessEventsOptions
  ): AsyncIterable<HarnessEvent<P> | HarnessPreview>;

  // lifetime
  /** Release live resources (a remote runtime parks its container). Durable state untouched.
   *  The next prompt() re-attaches; nothing throws HarnessClosedError until delete(). */
  close(): Promise<void>;
  /** Destroy durable state for this session. Subsequent calls throw HarnessClosedError. */
  delete(): Promise<void>;

  /** Escape hatch: a runtime-specific submission, typed by the protocol parameter. */
  submit(
    submission: P["submit"],
    options?: HarnessSubmitOptions
  ): Promise<HarnessReceipt>;

  // Always present on the prototype (the handle is served as an RpcTarget). Each throws
  // HarnessCapabilityUnsupportedError unless status().capabilities advertises it.
  compact(options?: HarnessCompactOptions): Promise<HarnessReceipt>; // "compact"
  fork(options?: HarnessForkOptions): Promise<HarnessSession<P>>; // "fork"
  rewind(
    toMessageId: string,
    options?: HarnessRewindOptions
  ): Promise<HarnessRewindResult>; // "rewind"
  configure(patch: HarnessConfigPatch): Promise<HarnessConfig>; // "configure"
  cancelQueued(operationId: string): Promise<boolean>; // "queue"
}

export type HarnessInput =
  | string
  | { readonly text?: string; readonly parts?: readonly SessionMessagePart[] };

export interface HarnessPromptOptions {
  /** Idempotency key. Same id + same input + same delivery replays the receipt with
   *  accepted:false; same id + different input throws HarnessConflictError. Callers that need
   *  idempotency across retries must supply it (mint a uuidv7 client-side); the default is
   *  minted inside the DO and gives none. */
  readonly operationId?: string;
  /** "queue" (default) runs when idle, behind anything queued. "steer" folds into the
   *  running turn at its next boundary; requires the "steer" capability. While the session is
   *  blocked on a request, "queue" waits for the reply and "steer" throws
   *  HarnessCapabilityUnsupportedError("steer"). */
  readonly delivery?: "queue" | "steer";
  /** Cancels this call only, never the admitted operation. */
  readonly signal?: AbortSignal;
}
export interface HarnessSubmitOptions {
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export interface HarnessReceipt {
  readonly operationId: string;
  readonly sessionId: string;
  readonly streamId: string;
  /** Opaque cursor positioned at the start of this operation's log. */
  readonly cursor: string;
  /** False when this operation id was already admitted or already settled. */
  readonly accepted: boolean;
  readonly state: "queued" | "running" | "settled";
  readonly delivery: "queue" | "steer";
}

export interface HarnessInterruptOptions {
  readonly operationId?: string; // default: the active one
  readonly reason?: string;
  /** Also withdraw queued-but-unstarted operations. Default true. */
  readonly drain?: boolean;
  readonly signal?: AbortSignal;
}
export interface HarnessInterruptResult {
  readonly operationId: string | null;
  readonly newlyRequested: boolean;
  /** Queued operations withdrawn before they started (settled "declined"), so a client can
   *  restore unsent text. Engine-side queued input is reported on the result as stillQueued. */
  readonly drained: readonly {
    readonly operationId: string;
    readonly input: HarnessInput;
  }[];
}

interface HarnessRequestBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly createdAt: number;
  /** The base settles the request as timed out at this instant (policy.requestTimeoutMs). */
  readonly expiresAt: number;
}
export type HarnessRequest =
  | (HarnessRequestBase & {
      readonly type: "permission";
      readonly toolCallId?: string;
      readonly action: string;
      readonly resources: readonly string[];
      readonly input?: JsonValue;
    })
  | (HarnessRequestBase & {
      readonly type: "question";
      readonly toolCallId?: string;
      readonly questions: readonly HarnessQuestion[];
    })
  | (HarnessRequestBase & {
      readonly type: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    })
  | (HarnessRequestBase & {
      readonly type: "extension";
      readonly kind: string;
      readonly payload: JsonValue;
    });

export interface HarnessQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: readonly {
    readonly label: string;
    readonly description?: string;
  }[];
  readonly multiple?: boolean;
  readonly custom?: boolean;
}

export type HarnessReply =
  | {
      readonly type: "permission";
      readonly decision: "allow" | "allow_always" | "deny";
      readonly message?: string;
      readonly input?: JsonValue;
    }
  | {
      readonly type: "question";
      readonly answers: readonly (readonly string[])[] | null;
      readonly message?: string;
    }
  | {
      readonly type: "tool";
      readonly output: JsonValue;
      readonly isError?: boolean;
    }
  | {
      readonly type: "extension";
      readonly kind: string;
      readonly payload: JsonValue;
    };

/** idle: nothing running. running: an operation is executing. blocked: at least one request is
 *  open. retrying: the runtime is waiting out a provider retry (pi's waiting:"retry"; Claude's
 *  api_retry). terminated: the session was deleted, or its runtime was lost and cannot resume. */
export type HarnessRunState =
  | "idle"
  | "running"
  | "blocked"
  | "retrying"
  | "terminated";

export interface HarnessStopReason {
  readonly type:
    | "end_turn"
    | "interrupted"
    | "declined"
    | "max_turns"
    | "max_tokens"
    | "budget"
    | "refusal"
    | "error"
    | "runtime_lost"
    | "other";
  readonly raw?: string; // the harness's own verbatim reason
}

export interface HarnessUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** A client-side estimate, never billing data. */
  readonly costUsd?: number;
}

export interface HarnessStatus {
  readonly sessionId: string;
  readonly state: HarnessRunState;
  readonly operationId?: string;
  readonly stopReason?: HarnessStopReason;
  /** Open request ids. Non-empty implies state === "blocked". */
  readonly pendingRequests: readonly string[];
  readonly queuedOperations: number;
  /** Head of the event log; a fresh client subscribes from here. */
  readonly cursor: string;
  /** The single answer a client renders feature gates from. */
  readonly capabilities: readonly HarnessCapability[];
  readonly usage?: HarnessUsage;
  readonly config?: HarnessConfig;
}

export interface HarnessResult<P extends HarnessProtocol = HarnessProtocol> {
  readonly operationId: string;
  readonly sessionId: string;
  /** declined: withdrawn before it started (an interrupt drain, or admission refused by budget). */
  readonly status: "completed" | "aborted" | "failed" | "declined";
  readonly stopReason: HarnessStopReason;
  readonly streamId: string;
  readonly cursor: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage?: HarnessUsage;
  /** Engine-side queued input still pending after an interrupt (Claude's still_queued). */
  readonly stillQueued?: readonly string[];
  readonly startedAt: number;
  readonly endedAt: number;
  /** The runtime's own terminal record. */
  readonly raw?: P["result"];
}

export interface HarnessWaitOptions {
  readonly timeoutMs?: number; // default: none
  readonly signal?: AbortSignal;
}

export interface HarnessMessagesOptions {
  /** Newest-first byte budget. Sessions has no count-bounded read today (see Transcript). */
  readonly maxBytes?: number;
  /** Opaque anchor from a previous page. */
  readonly cursor?: string;
}
export interface HarnessMessagePage {
  /** SessionMessage from agents/sessions. There is no harness message type. */
  readonly messages: readonly SessionMessage[];
  readonly cursor?: string;
  /** The event-log position this page reflects. Subscribe from here and history and tail meet once. */
  readonly asOf: string;
}

export interface HarnessEventsOptions {
  /** Opaque token from a receipt, status, result, page or event. Omitted: the start of the session's log. */
  readonly from?: string;
  /** Also yield live previews (token deltas). Default false. */
  readonly previews?: boolean;
  readonly signal?: AbortSignal;
  /** Fires once when replay is drained and the reader is live. */
  readonly onUpToDate?: () => void;
}

export interface HarnessEvent<P extends HarnessProtocol = HarnessProtocol> {
  /** Session-monotonic, assigned by the base when the frame is appended. */
  readonly seq: number;
  readonly streamId: string;
  /** Opaque; pass back as events({ from }). */
  readonly cursor: string;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly replay?: true;
  readonly body:
    | HarnessCoreEvent
    | { readonly type: "extension"; readonly body: P["event"] };
}
/** Live only. No seq, no cursor, never persisted, never replayed. */
export interface HarnessPreview {
  readonly preview: true;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly body:
    | {
        readonly type: "text_delta";
        readonly messageId: string;
        readonly delta: string;
      }
    | {
        readonly type: "reasoning_delta";
        readonly messageId: string;
        readonly delta: string;
      };
}

export type HarnessCoreEvent =
  | { readonly type: "session_opened"; readonly status: HarnessStatus }
  | { readonly type: "operation_started"; readonly delivery: "queue" | "steer" }
  | { readonly type: "operation_settled"; readonly result: HarnessResult }
  | {
      readonly type: "message_start";
      readonly messageId: string;
      readonly role: string;
    }
  | {
      readonly type: "message_end";
      readonly messageId: string;
      readonly parts: readonly SessionMessagePart[];
    }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly output: JsonValue;
      readonly isError: boolean;
    }
  | { readonly type: "request_raised"; readonly request: HarnessRequest }
  | {
      readonly type: "request_replied";
      readonly requestId: string;
      readonly reply: HarnessReply;
      readonly by: "client" | "timeout" | "lost";
    }
  | { readonly type: "status"; readonly status: HarnessStatus }
  | { readonly type: "usage"; readonly usage: HarnessUsage }
  | {
      readonly type: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

export type HarnessCapability =
  | "sessions"
  | "steer"
  | "queue"
  | "requests"
  | "compact"
  | "fork"
  | "rewind"
  | "configure"
  | "usage"
  | "workspace"
  | (string & {});

export interface HarnessConfig {
  readonly model?: string;
  readonly agent?: string;
  readonly permissionMode?:
    | "default"
    | "ask"
    | "accept_edits"
    | "plan"
    | "bypass";
  readonly tools?: { readonly [name: string]: boolean };
  readonly instructions?: string;
}
export type HarnessConfigPatch = Partial<HarnessConfig>;
export interface HarnessCompactOptions {
  readonly instructions?: string;
  readonly operationId?: string;
}
export interface HarnessForkOptions {
  readonly fromMessageId?: string;
  readonly sessionId?: string;
}
export interface HarnessRewindOptions {
  readonly files?: boolean;
  readonly dryRun?: boolean;
}
export interface HarnessRewindResult {
  readonly messageId: string;
  readonly removedMessageIds: readonly string[];
  readonly filesChanged?: readonly string[];
  readonly applied: boolean;
}

export class HarnessError extends Error {
  readonly code: string = "E_HARNESS";
  toJSON(): JsonValue {
    return { name: this.name, code: this.code, message: this.message };
  }
}
export class HarnessCapabilityUnsupportedError extends HarnessError {
  constructor(readonly capability: string) {
    super(capability);
  }
}
export class HarnessConflictError extends HarnessError {
  constructor(readonly operationId: string) {
    super(operationId);
  }
}
export class HarnessSessionNotFoundError extends HarnessError {
  constructor(readonly sessionId: string) {
    super(sessionId);
  }
}
export class HarnessOperationNotFoundError extends HarnessError {
  constructor(readonly operationId: string) {
    super(operationId);
  }
}
export class HarnessRequestNotFoundError extends HarnessError {
  constructor(readonly requestId: string) {
    super(requestId);
  }
}
export class HarnessBackpressureError extends HarnessError {}
export class HarnessTimeoutError extends HarnessError {}
export class HarnessDetachedError extends HarnessError {}
export class HarnessClosedError extends HarnessError {}
```

What the strawman `.sessions().prompt()` becomes:

```ts
const session = this.harness.session(); // handle: no await, no I/O
const { operationId } = await session.prompt(text); // durable before it resolves
for await (const e of session.events({ from: page.asOf, previews: true })) {
  if ("preview" in e) render.delta(e.body);
  else if (e.body.type === "request_raised") render.ask(e.body.request);
  else if (e.body.type === "operation_settled") break;
}
```

`wait()` exists for a Task step or a parent agent that must block; it pins the DO for its
duration, so the interactive pattern is `events()`.

Rules that the types alone do not state:

- While the session is blocked on a request, a queued prompt waits for the reply; an
  interrupt closes every open request as `lost` and settles the operation `aborted`. When
  `requestTimeoutMs` fires, the base writes the reply itself: `permission` becomes
  `deny` with message "timed out", `question` becomes `answers: null`, `tool` becomes
  `isError: true`, and the runtime sees a normal reply.
- `wait()` resolves for every terminal status including `failed` and `declined`; only a
  timeout, an unknown id or a deleted session throws.
- `capabilities` is one open set of strings reported in three places (`Harness`, the
  runtime, `status()`); `status()` is the one a client renders from, because it is the
  one that reaches a browser.
- On a single-session runtime, `session(id)` with any id other than the fixed one throws
  `HarnessSessionNotFoundError`, and `sessions.create()` with a second id throws
  `HarnessCapabilityUnsupportedError("sessions")`. `sessions.list()` returns one entry.
  The catalogue of many container-backed sessions is the hub, not the harness.

The naming decisions, each against the systems that spell it differently:

| Chosen                                                              | Not chosen, and why                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.open(id)` / `session(id)` returns a handle synchronously  | `sessions.get` (OpenCode 2.0, Managed Agents) implies I/O and a not-found; `create` as the only entry (Managed Agents, HarnessV1) does not fit harnesses whose session is implicit                                         |
| `operationId`                                                       | `turnId` is too narrow (compaction is not a turn); `runId` already means an agent-tool run; `submissionId` names the request, not the work                                                                                 |
| `prompt()` never blocks                                             | pi's `prompt` waits, self-modifying's runs attached; Think's `runTurn({mode})` hides three return types behind one name                                                                                                    |
| steer is `prompt(…, { delivery: "steer" })`                         | a separate `steer()` duplicates every field of `prompt` and adds a second admission path; OpenCode 2.0 collapsed five prompt verbs into one with `delivery`                                                                |
| `interrupt()`                                                       | `abort` collides with `AbortSignal` (pi documents `withAbortSignal` vs `requestAbort` for exactly this); OpenCode renamed `abort` to `interrupt` in 2.0                                                                    |
| one `reply(requestId, reply)` over a request union                  | three methods (HarnessV1's `submitToolApproval`/`submitToolResult`/`submitUserMessage`) mean three list calls and three code paths in a client; OpenCode 2.0 gave permissions and questions one shape                      |
| request-id round trip, never a callback in options                  | `canUseTool`/`onElicitation` callbacks die with the isolate; only an id survives a DO eviction                                                                                                                             |
| opaque `cursor: string` plus a per-session `seq`                    | a naked integer cannot span operation logs and cannot be minted for an upstream that numbers events per session or not at all; OpenCode 2.0's list cursor is already opaque                                                |
| `status()` + paged `messages()`                                     | `snapshot()` returning everything: the codex stress run showed a 200-turn transcript cannot be returned in one read                                                                                                        |
| `close()` + `delete()`                                              | `dispose()` is the capability hook's name; HarnessV1's detach/stop/destroy/suspend is an adapter's parking policy, not an app decision                                                                                     |
| typed errors with `toJSON()`                                        | pi's `Result<T, E>` would infect every call site in `agents`                                                                                                                                                               |
| always-present methods that throw, gated by `status().capabilities` | optional-in-type methods cannot be absent per session on one concrete prototype-served class; flags alone lie about per-session variation (OpenCode's `compact` fails per location; Claude's `setModel` is streaming-only) |
| `webSockets()` takes no arguments                                   | codex's `webSockets({ restart })` is the one in-repo arity divergence; host-specific commands are the host's own handlers, not the harness's                                                                               |

The one loosening: `requests()`/`reply()` return `[]` and `accepted: false` on pi, codex
and self-modifying today. They are core anyway, because the two harnesses that would
omit them (Claude Code, OpenCode) are the two this API exists for, and a browser must be
able to poll for unanswered work after a reconnect without knowing which harness it holds.

Not in the core: `steer`, `queue`, `fork`, `rewind`, `compact`, `configure` (each absent
or incompatible in at least two systems), `usage()` as a method (a field of `status()`),
`snapshot()`, and any file access (`workspace` is a flag; the `Workspace` capability owns
the methods).

### The capability

One concrete class. Harnesses differ by runtime, never by subclass.

```ts
// agents/harness
export type HarnessOptions<P extends HarnessProtocol> = {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly runtime: HarnessRuntime<P>;
  /** Numbers and enums only. No callbacks, no adapters, no bindings. */
  readonly policy?: HarnessPolicy;
};

export type HarnessPolicy = {
  /** Stream append batching. Default 100 ms / 64 frames / 256 KiB (pi's measured rule).
   *  `bytes` must stay below Streams' 1 MiB chunk ceiling or append throws. */
  readonly batch?: {
    readonly ms?: number;
    readonly frames?: number;
    readonly bytes?: number;
  };
  /** Settled operations older than this are pruned on wake. Default: never. */
  readonly retainSettledMs?: number;
  /** Max unconsumed inbox rows per session before prompt() throws HarnessBackpressureError. Default 1000. */
  readonly inboxLimit?: number;
  /** Open requests are settled as timed out after this. Default 600_000. */
  readonly requestTimeoutMs?: number;
  /** Driver runs rotate after this many journaled passes (Tasks caps a run at 10_000 steps). Default 4000. */
  readonly rotateAfterPasses?: number;
};

export class Harness<
  P extends HarnessProtocol = HarnessProtocol
> extends LifecycleCapability {
  constructor(options: HarnessOptions<P>);
  readonly capabilities: ReadonlySet<HarnessCapability>; // from the runtime
  readonly sessions: HarnessSessions<P>;
  session(sessionId?: string): HarnessSession<P>;
  webSockets(): WebSocketsOptions;

  onStart(context: CapabilityStartContext): Promise<void>;
  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void>;
  onMemoryLimit(): void;
  dispose(): Promise<void>;
}
```

Siblings it takes and does not take:

| Sibling         | Taken | Why                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Tasks`         | yes   | durable wakes and the step journal; one reserved definition per capability instance                                                                                                                                                                                                                                                                                      |
| `Streams`       | yes   | the only output path; one log per operation plus one per session                                                                                                                                                                                                                                                                                                         |
| `Sessions`      | no    | pi keeps a seven-table store, codex uses `Sessions`, self-modifying invented a table, Claude Code's transcript is a `.jsonl` on a container disk. The **runtime** takes `Sessions` when it has a user-visible transcript to project; `messages()` is served through the runtime port. "One canonical transcript" is satisfied by every runtime, not modelled by the base |
| `Workspace`     | no    | a runtime concern                                                                                                                                                                                                                                                                                                                                                        |
| `WebSockets`    | no    | it returns `WebSocketsOptions`; the host constructs `WebSockets`                                                                                                                                                                                                                                                                                                         |
| bindings, `env` | no    | consistent with `LifecycleServices`; bindings reach the runtime, which the host constructs                                                                                                                                                                                                                                                                               |

The base owns four tables. A runtime adds its own through `onStart` (the container
runtime keeps one singleton row for its secret, launch digest and runtime id).

```sql
-- one row per session. Writes: create, delete, and one watermark copy when an
-- operation log is pruned (never otherwise; the cursor is derived from the logs).
CREATE TABLE IF NOT EXISTS cf_agents_harness_sessions (
  session_id TEXT PRIMARY KEY, title TEXT, parent_id TEXT, config TEXT,
  pruned_seq INTEGER, pruned_wire_seq INTEGER, pruned_runtime_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- write-hot; rows live until consumed; NO INDEX (deliberate: pi's stated rationale)
CREATE TABLE IF NOT EXISTS cf_agents_harness_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, key TEXT NOT NULL,
  operation_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- one row per operation; insert at admission, one UPDATE at settlement
CREATE TABLE IF NOT EXISTS cf_agents_harness_operations (
  operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
  input_hash TEXT NOT NULL, runtime_id TEXT, started_at INTEGER NOT NULL,
  settled_at INTEGER, result TEXT
);
-- open requests only; deleted when answered, timed out, or lost
CREATE TABLE IF NOT EXISTS cf_agents_harness_requests (
  request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
```

Derived, never maintained: session state, `stop_reason`, `pendingRequests`, the stream
id (`harness:${sessionId}:${operationId}`), and the head cursor. Status is three cheap
reads. There is no status column and no counter, because a DO row write costs on the
order of a thousand reads.

`prompt()` is the one write:

```ts
async prompt(input, options = {}) {
  await this.lifecycle.ready();
  const operationId = options.operationId ?? uuidv7();
  const delivery = options.delivery ?? "queue";
  const hash = await sha256(canonical({ input, delivery }));
  const receipt = this.lifecycle.storage.transactionSync(() => {
    const known = this.#operations.get(operationId);
    if (known) {
      if (known.input_hash !== hash) throw new HarnessConflictError(operationId);
      return this.#receiptFor(known, { accepted: false });
    }
    if (this.#inbox.count(sessionId) >= this.#policy.inboxLimit) throw new HarnessBackpressureError();
    this.#operations.insert({ operationId, sessionId, status: "queued", hash });
    this.#inbox.insert({ sessionId, key: operationId, operationId, kind: "prompt",
                         payload: { input, delivery } });
    return this.#receiptFor(operationId, { accepted: true });   // cursor = start of its own log
  });
  if (receipt.accepted) await this.#ensureDriver(sessionId);
  return receipt;
}
```

The receipt's cursor is the position `(harness:${sessionId}:${operationId}, chunk 0)`,
which needs no read. `interrupt()`, `reply()`, `compact()` and `submit()` are the same
write with a different `kind`; `reply` uses `key = requestId` so a redelivered answer is
deduplicated. The base reserves four kinds every runtime must honour, `prompt`,
`interrupt`, `reply` and (when advertised) `compact`; everything else in `P["submit"]`
is the runtime's.

The driver is one Tasks run per session:

```ts
// registered unconditionally in the Harness constructor, once per capability instance
const HARNESS_DRIVER = `__cf_harness@v1:${capabilityId}`;

async #ensureDriver(sessionId: string) {
  await this.#tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
    HARNESS_DRIVER, { sessionId },
    { runId: `harness:${capabilityId}:${sessionId}`, retain: false }
  );
}
```

Facts about Tasks that shape this (verified in `packages/agents/src/tasks/tasks.ts`):

- `register()` accepts only `__cf`-prefixed names, once per name per `Tasks`
  (`tasks.ts:336-356`). One name for the whole SDK would cap a DO at one harness, so
  the name carries the capability id. The host must construct the harness
  unconditionally on every wake, or in-flight driver runs fail with a missing
  definition.
- `enqueue` on a fixed `runId` joins a live run and returns `accepted: false`
  (`tasks.ts:1010-1024`), so no `list()` guard is needed. `retain: false` is
  load-bearing: only a non-retained terminal row is deleted (`tasks.ts:1436`), and a
  retained one would poison the run id forever.
- `onStart` may only push a Lifecycle job that re-ensures drivers; it must not call
  the enqueue aperture, because `ready()` returns during startup before Tasks has
  ensured its tables (`durable-object-lifecycle.ts:409-412`, `tasks.ts:404-414`).
- `step.do` throws past 10 000 steps per run and rejects duplicate step names
  (`replay.ts:46`, `:260-266`, `:344-346`). The base counts passes and ends the run at
  `rotateAfterPasses`, re-ensuring the driver, exactly as pi rotates at 4 000 today.
  Every step result is capped at 1 MiB, which is why wire batches are 128 KiB.
- A long drain is awaited in the handler body, never inside `step.do()`: the default
  step timeout is 5 minutes, and the durable claim heartbeat is `stepTimeout + 30 s`
  (`tasks.ts:268-270`), one alarm and one row write per period while a run is held.

The idle-to-settle race pi carries today (a prompt landing after the driver's last inbox
read but before the run ends is stranded) is closed in the base, not by contract: after
`drive()` resolves, the base re-checks the session's inbox inside a `transactionSync`
and loops back into `drive()` if rows remain; only an empty inbox observed inside that
transaction lets the run settle.

This is still the framework-internal Tasks aperture that `rfc-pi-harness-example.md`
flags as undesigned. It is now used in exactly one place, which makes designing the
public one a smaller problem.

### The runtime port

```ts
// agents/harness
export interface HarnessRuntime<P extends HarnessProtocol = HarnessProtocol> {
  /** Recorded on every operation row. "in-do:pi", "container:claude-code". */
  readonly id: string;
  readonly capabilities: ReadonlySet<HarnessCapability>;

  /** Called inside the session's Tasks run. Returns when there is nothing more this
   *  runtime can do right now. Everything durable goes through `ctx`. */
  drive(ctx: HarnessDriveContext<P>): Promise<void>;

  /** The user-visible transcript, newest-first within a byte budget, from wherever the
   *  runtime keeps it. */
  messages(
    sessionId: string,
    options: HarnessMessagesOptions
  ): Promise<HarnessMessagePage>;

  /** Optional. Inside the capability's onStart, inside blockConcurrencyWhile: create
   *  tables, push jobs. Must not dial anything. */
  onStart?(ctx: HarnessRuntimeStartContext): Promise<void> | void;
  /** Optional. Release live resources on dispose or a memory-limit strike. */
  dispose?(reason: "dispose" | "memory-limit"): Promise<void> | void;
  /** Optional. No-ops for local runtimes; the container runtime parks / destroys. */
  close?(sessionId: string): Promise<void>;
  delete?(sessionId: string): Promise<void>;
  /** Optional extensions; absence means the capability is not advertised. `compact` is an
   *  inbox kind, not a port method, because it produces a receipt. */
  fork?(sessionId: string, options: HarnessForkOptions): Promise<string>;
  rewind?(
    sessionId: string,
    toMessageId: string,
    options: HarnessRewindOptions
  ): Promise<HarnessRewindResult>;
  configure?(
    sessionId: string,
    patch: HarnessConfigPatch
  ): Promise<HarnessConfig>;
  cancelQueued?(sessionId: string, operationId: string): Promise<boolean>;
}

export type HarnessRuntimeStartContext = {
  readonly storage: DurableObjectStorage;
  /** Push a Lifecycle job that will re-enter drive() for this session. */
  wake(sessionId: string, afterMs?: number): void;
};

export type HarnessInboxRow<P extends HarnessProtocol> = {
  readonly seq: number;
  readonly key: string;
  readonly operationId: string | null;
  readonly kind:
    | "prompt"
    | "interrupt"
    | "reply"
    | "compact"
    | P["submit"]["kind"];
  readonly payload: JsonValue;
};

/** Omit distributed over the request union, so every concrete request is expressible. */
export type HarnessRequestDraft<T = HarnessRequest> = T extends unknown
  ? Omit<T, "createdAt" | "expiresAt"> & { readonly expiresAt?: number }
  : never;

export type HarnessSettlement<P extends HarnessProtocol> = {
  readonly status: HarnessResult["status"];
  readonly stopReason: HarnessStopReason;
  readonly error?: HarnessResult["error"];
  readonly usage?: HarnessUsage;
  readonly stillQueued?: readonly string[];
  readonly raw?: P["result"];
};

export type HarnessDriveContext<P extends HarnessProtocol> = {
  readonly sessionId: string;
  readonly step: TaskStep; // journal for the runtime's own idempotent steps
  readonly signal: AbortSignal; // fires on cancel or supersession, not on wall time

  readonly inbox: {
    peek(limit?: number): readonly HarnessInboxRow<P>[];
    take(seq: number): HarnessInboxRow<P> | null; // delete-and-return, in a sync block
  };
  /** Both replay-safe: re-entry on a known state is a no-op. begin() opens the log. */
  begin(operationId: string): Promise<HarnessOperationHandle<P>>;
  settle(operationId: string, outcome: HarnessSettlement<P>): void;

  /** Durable question and answer without a live promise across any boundary. */
  readonly requests: {
    open(request: HarnessRequestDraft): void;
    close(requestId: string, by: "answered" | "timeout" | "lost"): void;
    list(operationId?: string): readonly HarnessRequest[];
  };
  /** Sugar: open a request and resolve when a `reply` row for it arrives in THIS isolate. */
  ask(request: HarnessRequestDraft): Promise<HarnessReply>;

  /** Push a Lifecycle job that re-enters drive() later. Never setInterval. */
  wake(afterMs?: number): void;
  /** The session-scoped log, for frames that belong to no operation. */
  session(): Promise<HarnessOperationHandle<P>>;
  /** True while at least one browser socket is attached to this session. */
  attached(): boolean;
};

export type HarnessFrame<P extends HarnessProtocol> = {
  readonly kind:
    | "begin"
    | "event"
    | "request_opened"
    | "request_closed"
    | "settle"
    | "log";
  readonly payload:
    | HarnessCoreEvent
    | { readonly type: "extension"; readonly body: P["event"] }
    | JsonValue;
  /** Set by a remote runtime: the daemon's wire seq and the generation that minted it. */
  readonly wire?: { readonly seq: number; readonly runtimeId: string };
};

export type HarnessOperationHandle<P extends HarnessProtocol> = {
  readonly streamId: string;
  /** Batched per policy; the flush is the durable write. The base stamps the session seq. */
  append(frame: HarnessFrame<P>): void;
  /** Browser-only. Never persisted, never replayed. Dropped when nobody is attached. */
  preview(preview: HarnessPreview["body"]): void;
  flush(): void;
  /** Settle the stream and write terminal rows in one transaction (Streams' cutover).
   *  `commit` is synchronous and may not append. */
  close(options?: { readonly commit?: () => void }): void;
  error(reason: string, options?: { readonly commit?: () => void }): void;
};
```

Local runtimes (`in-do:pi`, `in-do:codex`, `in-do:self-modifying`) do their work inside
`drive()`; each existing `#driveLane` / `#drive` / `#runTask` body moves there largely
unchanged. The remote runtime does its work by holding a Cap'n Web session for as long
as `drive()` needs it. That is the whole symmetry, and it is why the port has no
`attach`, `detach`, `drain` or `probe`: those are the container runtime's internals.

Streams facts that the handle encodes (verified in `packages/agents/src/streams/streams.ts`
on `origin/main`; the block log landed in #2216):

- one `append()` is exactly one billed row write, whether it grows a block or opens
  the next (`streams.ts:560-584`); blocks roll at 256 Ki **characters**, and a chunk
  over `maxChunkBytes` (1 MiB) throws, so `batch.bytes` stays below it;
- `open()` is async and costs three billed rows; settling costs one; `close({ commit })`
  runs `commit` synchronously inside the settle transaction, after the row is terminal,
  so `commit` cannot append (`streams.ts:664-706`);
- operation streams are settled with `commit` but never `discard`, because the head
  cursor and the wire watermark are read from the newest log's tail (next).

### Events and the cursor

Every frame lands in exactly one of two logs, the operation's or the session's, and
carries a session-monotonic `seq` that the base stamps at flush time from an in-isolate
counter. The counter is seeded once per driver run by reading the tail of the newest log:
`streams.status(streamId)` gives the chunk position and one `readBatches` from the chunk
before it yields the last frame. Streams has no tail primitive today; phase 1 adds
`streams.tail(streamId)` (one row read plus one block parse) or uses that two-call form.

A cursor is an opaque token `{ streamId, chunk, seq? }`. Position comes from the Streams
pair, which is what `readBatches({ from })` takes; `seq` is a dedupe guard when present.
`events({ from })` walks operations in `started_at` order, merges the session log by
`seq`, replays each log with `readBatches`, and tails the newest live one. The head
cursor for `status()` is `streams.status(newestStreamId).cursor`, a read. When
`retainSettledMs` prunes an operation log, the base first copies that log's last `seq`
and wire watermark onto the session row, so the counter and the reconcile below can be
re-seeded from a row when the log is gone.

Token deltas are previews. They travel as `HarnessPreview` only to attached clients that
asked for them, never into Streams. `message_end` carries the full parts, so a client
that reconnects sees settled content and a client that was watching saw tokens. This is
not a write-count argument (batching would absorb deltas at a few dozen appends per turn);
it is the storage rule: a delta is neither settled content, nor effect settlement, nor
something a next request or a reconnecting reader needs.

### The browser link

`webSockets()` returns options for the hibernatable JSON transport all three harnesses
already speak. The wire, in `agents/harness/protocol`:

```ts
export type HarnessClientMessage =
  | {
      readonly type: "snapshot";
      readonly id: string;
      readonly sessionId?: string;
    }
  | {
      readonly type: "subscribe";
      readonly sessionId: string;
      readonly from?: string;
      readonly previews?: boolean;
    }
  | { readonly type: "unsubscribe"; readonly sessionId: string }
  | {
      readonly type: "call";
      readonly id: string;
      readonly sessionId: string;
      readonly method:
        | "prompt"
        | "interrupt"
        | "requests"
        | "reply"
        | "messages"
        | "status"
        | "result"
        | "submit"
        | "compact"
        | "fork"
        | "rewind"
        | "configure"
        | "cancelQueued";
      readonly args: readonly JsonValue[];
    };

export type HarnessServerMessage =
  | {
      readonly type: "snapshot";
      readonly id: string;
      readonly status: HarnessStatus;
      readonly requests: readonly HarnessRequest[];
      readonly messages: HarnessMessagePage;
    }
  | {
      readonly type: "events";
      readonly sessionId: string;
      readonly events: readonly HarnessEvent[];
    }
  | {
      readonly type: "preview";
      readonly sessionId: string;
      readonly preview: HarnessPreview;
    }
  | { readonly type: "up_to_date"; readonly sessionId: string }
  | { readonly type: "result"; readonly id: string; readonly value: JsonValue }
  | { readonly type: "error"; readonly id?: string; readonly error: JsonValue }; // HarnessError.toJSON()
```

`wait`, `events`, `close` and `delete` are not callable over the browser wire: the socket
is the subscription, and lifetime belongs to the host. The snapshot carries a `messages`
page with `asOf`, and the client subscribes from `asOf`, so history and tail meet exactly
once. Authentication is the host's: `WebSockets` handlers run in host context and the
host wraps or rejects the upgrade before the harness sees it.

```ts
// agents/react
export function useHarnessSession<P extends HarnessProtocol>(options: {
  readonly agent: string;
  readonly name: string;
  readonly sessionId?: string;
  readonly previews?: boolean;
}): {
  readonly status: HarnessStatus | null;
  readonly requests: readonly HarnessRequest[];
  readonly messages: readonly SessionMessage[];
  readonly events: readonly HarnessEvent<P>[];
  readonly preview: HarnessPreview["body"] | null;
  prompt(
    input: HarnessInput,
    options?: HarnessPromptOptions
  ): Promise<HarnessReceipt>;
  interrupt(options?: HarnessInterruptOptions): Promise<HarnessInterruptResult>;
  reply(
    requestId: string,
    reply: HarnessReply
  ): Promise<{ readonly accepted: boolean }>;
  submit(submission: P["submit"]): Promise<HarnessReceipt>;
};
```

The hook replaces the three near-copy hooks and keeps pi's three rules: resubscribe from
the last cursor, re-snapshot at operation boundaries, drop previews on reconnect.

Cap'n Web `callables` are not used on this leg by default: a callables session pins the
DO for the life of the tab (`websockets.ts:82-84`), which is fine for one interactive
client and wrong for a thousand idle ones. A host that wants it composes it in; the
session handle is prototype-only so it serves as an `RpcTarget` unchanged.

### The remote runtime and the wire

`ContainerHarnessRuntime` lives in `agents/harness/remote`, the only module that touches
`ctx.container` and `capnweb`. It knows a wire, not a vendor.

```ts
// agents/harness/remote
export type ContainerHarnessRuntimeOptions<P extends HarnessProtocol> = {
  readonly id: string;
  readonly container: Container; // ctx.container
  readonly port: number;
  readonly launch: {
    readonly enableInternet: boolean;
    readonly env?: { readonly [k: string]: string };
  };
  readonly egress:
    | {
        readonly mode: "gateway-url";
        readonly baseUrl: string;
        readonly token: string;
      }
    | {
        readonly mode: "intercept";
        readonly host: string;
        readonly entrypoint: Fetcher;
      };
  readonly doorbell: { readonly url: string; readonly sessionName: string };
  readonly sessions: Sessions; // the runtime projects the transcript
  readonly tools?: { readonly [name: string]: HarnessHostTool };
  readonly engine: HarnessEngineSpec<P>; // from the engine package's factory
  readonly idle?: {
    readonly detachAfterIdleMs?: number; // 20_000
    readonly keepAliveMs?: number; // 900_000, ceiling 6 h
    readonly renewIntervalMs?: number; // 300_000
    readonly stopContainerAfterIdleMs?: number; // 120_000
    readonly resumePolicy?: "on-clean-exit" | "never";
    readonly deferAfterMs?: number; // 0 = off
  };
};
export type HarnessHostTool = {
  readonly description: string;
  readonly inputSchema: JsonValue; // JSON Schema; z.object-shaped, $defs inlined
  run(input: JsonValue): Promise<JsonValue>;
};
export type HarnessEngineSpec<P extends HarnessProtocol> = {
  readonly id: string; // "claude-code"
  readonly options: JsonValue; // opaque to the wire; the engine parses it
  readonly capabilities: ReadonlySet<HarnessCapability>;
  readonly __protocol?: P; // type carrier only
};

export class ContainerHarnessRuntime<
  P extends HarnessProtocol
> implements HarnessRuntime<P> {
  constructor(options: ContainerHarnessRuntimeOptions<P>);
  /** Verifies secret and runtimeId, pushes one drive job. Called by the host's doorbell method. */
  doorbell(request: Request): Promise<Response>;
  info(): Promise<{
    runtimeId: string | null;
    running: boolean;
    engineVersion?: string;
  }>;
  stop(reason: string): Promise<void>; // shutdown() then destroy()
  // ...HarnessRuntime members
}

// Two WorkerEntrypoints the host re-exports. Both take their config as props.
export class HarnessDoorbell extends WorkerEntrypoint<
  Env,
  { readonly namespace: string }
> {}
export class HarnessEgress extends WorkerEntrypoint<
  Env,
  { readonly ai: string; readonly gatewayId: string }
> {}
```

**Topology is forced.** A facet's `ctx.container` is the root actor's single container
(edgeworker `ew_handler.cpp:2497-2504`, resolved at `ew_worker-set.cpp:6436`); a facet
cannot own one, and `wrangler dev` diverges by giving each facet its own (workerd
`server.c++:1299-1370`). So a container-backed session is one top-level Durable Object
whose class is named in `containers[].class_name`, and this topology is never validated
under local dev alone. The runtime advertises no `"sessions"` capability: its one session
id is the DO's name.

**The DO dials the container.** `ctx.container.getTcpPort(port).fetch(upgrade)` performs
a real RFC 6455 handshake over the port tunnel (workerd `api_container.c++:1382-1394`
into kj's `HttpServiceAdapter`); the DO must `accept()` the returned socket, then
`newWebSocketRpcSession<HarnessDaemonApi>(socket)`. cloudflare/computer inverts the dial
to keep a hibernation door open; that door does not exist for either direction, because
capnweb's transport drives off `addEventListener` and no API converts an outbound socket
into a hibernatable one (`actor-state.c++:1233-1237`). We take the simpler direction and
make closing the socket safe instead.

**The DO exports nothing over Cap'n Web.** `newWebSocketRpcSession(socket)` is called
with no `localMain`. Events arrive on a `ReadableStream<HarnessWireBatch>` returned from
`subscribe()`. Verified in capnweb 0.12 by executing it in workerd and in Node: a method
may return a stream of plain objects, the consumer gets a real `ReadableStream`, and
backpressure is a byte window (`INITIAL_WINDOW` 256 KiB at `index-workers.js:2937-2939`,
growing toward the link's bandwidth-delay product) whose acks are gated by the consumer's
reads (`FlowController.onSend`, `:2968-2972`, stall at `:3058`). Consequences: no `.dup()`
discipline, nothing to re-register after a reconnect, and no capability position inside
the DO for a container that runs arbitrary `Bash`. Three rules the same verification
produced: the daemon returns a bare `ReadableStream` (dispatch is on exact prototype
identity), mints a fresh one per `subscribe()` (a pipe is single-consumption), and puts
only plain JSON in batches (a `Map`, `Set` or null-prototype row from `node:sqlite` hangs
the consumer silently). The DO reads under a watchdog and never buffers the stream into
an unbounded queue, because the far side's acks are gated by those reads.

```ts
// agents/harness/protocol  (isomorphic, zero dependencies)
export const HARNESS_PROTOCOL_VERSION = 1;
export const HARNESS_RPC_PATH = "/rpc";
export const HARNESS_HEALTH_PATH = "/healthz";
export const HARNESS_DOORBELL_PATH = "/_harness/doorbell";
export const HARNESS_SECRET_HEADER = "x-cf-harness-secret";
export const HARNESS_MAX_BATCH_BYTES = 131_072; // the container leg is likely capped at kj's 1 MiB
export const HARNESS_CLOSE_REPLACED = 4001; // capnweb's own abort uses 3000
export const HARNESS_CLOSE_SHUTDOWN = 4002;

export type HarnessErrorCode =
  | "E_UNAUTHORIZED"
  | "E_PROTOCOL"
  | "E_RUNTIME_FENCED"
  | "E_SUPERSEDED"
  | "E_OUTBOX_TRUNCATED"
  | "E_UNKNOWN_REQUEST"
  | "E_ALREADY_APPLIED"
  | "E_ENGINE_LOST";

export type HarnessWireFrame = {
  readonly seq: number; // per container generation, monotonic, gap-free
  readonly operationId: string | null;
  readonly kind:
    | "begin"
    | "event"
    | "request_opened"
    | "request_closed"
    | "settle"
    | "log";
  readonly payload: JsonValue;
  readonly part?: { readonly index: number; readonly of: number }; // a split oversize frame
};
export type HarnessWireBatch = {
  readonly frames: readonly HarnessWireFrame[];
  readonly previews: readonly {
    readonly operationId: string | null;
    readonly event: JsonValue;
  }[];
  readonly highWaterSeq: number;
  readonly floorSeq: number; // lowest seq still in the outbox
};

/** Implemented by the daemon. The only capability on the wire. */
export interface HarnessDaemonApi {
  hello(req: {
    readonly protocol: number;
    readonly sessionId: string;
    readonly secret: string;
    readonly expectRuntimeId: string | null;
  }): Promise<{
    readonly runtimeId: string;
    readonly engineId: string;
    readonly engineVersion: string;
    readonly daemonVersion: string;
    readonly capabilities: readonly string[];
    readonly highWaterSeq: number;
    readonly floorSeq: number;
    readonly openRequestIds: readonly string[];
    readonly appliedKeys: readonly string[];
    readonly engineSession: {
      readonly id: string;
      readonly resumed: boolean;
    } | null;
    readonly priorExit: {
      readonly code: number | null;
      readonly reason: string;
    } | null;
  }>;
  /** Replay-then-tail from fromSeq (exclusive). One live subscriber; a second closes the first. */
  subscribe(req: {
    readonly runtimeId: string;
    readonly fromSeq: number;
    readonly previews: boolean;
    readonly maxBatchFrames?: number;
    readonly maxBatchBytes?: number;
  }): Promise<ReadableStream<HarnessWireBatch>>;
  /** One inbox row, verbatim. Idempotent on key. The engine interprets `kind`. */
  deliver(req: {
    readonly runtimeId: string;
    readonly row: {
      readonly seq: number;
      readonly key: string;
      readonly operationId: string | null;
      readonly kind: string;
      readonly payload: JsonValue;
    };
  }): Promise<{
    readonly accepted: boolean;
    readonly seq: number;
    readonly code?: HarnessErrorCode;
  }>;
  ack(req: { readonly runtimeId: string; readonly seq: number }): Promise<void>;
  configure(req: {
    readonly runtimeId: string;
    readonly previews?: boolean;
    readonly remainingBudgetUsd?: number | null;
    readonly requestDeadlines?: readonly {
      readonly requestId: string;
      readonly expiresAt: number;
    }[];
    readonly engineOptions?: JsonValue;
  }): Promise<void>;
  probe(): Promise<{
    readonly runtimeId: string;
    readonly highWaterSeq: number;
    readonly floorSeq: number;
    readonly outboxBytes: number;
    readonly openRequests: number;
    readonly busy: boolean;
  }>;
  shutdown(req: {
    readonly runtimeId: string;
    readonly reason: string;
  }): Promise<void>;
}
```

The wire `seq` is scoped to a container generation, because the outbox that mints it
lives on the container disk. The DO stores each ingested frame's `{ seq, runtimeId }` in
the frame and keeps its own session seq separate. The reconcile watermark is therefore
"the wire seq of the newest ingested frame whose `runtimeId` matches the daemon that just
answered `hello()`, else 0", which is what makes a container replacement start from the
beginning of the new outbox instead of silently dropping everything below the old
generation's high seq.

Delivery guarantees: DO→daemon is at-least-once delivery with exactly-once application
(the daemon records the applied key in the same transaction as the enqueue and answers
`E_ALREADY_APPLIED` on a redelivery); daemon→DO is ordered and gap-free within a
generation (the outbox assigns `seq` inside the payload's own transaction; the DO applies
strictly increasing `seq` per generation); `ack` is advisory; the doorbell is a hint.
Batches are capped at 128 KiB and an oversize frame is split with `part`; a frame that
cannot be split is written to the workspace by the engine and replaced with a pointer.

**Establishment, in order** (`[W]` = a durable write):

1. Single-flight `attach()`.
2. Read the runtime singleton row. If absent, mint a 16-byte secret and a `runtimeId`
   and write both `[W]` before starting anything: a DO can be rebuilt while its
   container keeps running, and container env is immutable on a live container.
3. Adopt or launch. `container.running` with a matching launch digest is adopted;
   a mismatch is destroyed and relaunched. `running === false` is not proof there is
   no container: cloudchamber reports stopped on any recovery failure
   (`cc_binding.go:693-695`), so with a recorded `runtimeId` the runtime retries
   status on backoff before launching, and classifies the platform's transient
   strings (`SIDECAR_IS_BUSY`, `PREWARM_NOT_CLAIMED`, "can't be recovered") as retry.
4. `start({ env: { CF_HARNESS_SESSION_ID, CF_HARNESS_RUNTIME_ID, CF_HARNESS_SECRET,
CF_HARNESS_ENGINE, CF_HARNESS_DOORBELL_URL, ... }, enableInternet })`.
5. **`ctx.container.setInactivityTimeout(idle.keepAliveMs)` immediately.** Without it
   the launcher grants a container 0 to 7 seconds after the DO's capability drops
   (`cc_fcspawn_do.go:667-674`, `:1375`); the 25 s figure in the runtime notes is a
   best-effort re-arm scoped to metal migration. This call is the only reason a
   container survives a DO eviction. It is an absolute deadline written at call time,
   not an idle timer (`cc_binding.go:638-641`); nothing refreshes it and it never stops a
   connected container.
6. `ctx.container.monitor()` under a generation counter keyed in a module-level
   `WeakMap<DurableObjectState, …>`; late settles from superseded generations are dropped.
7. Egress interception, if configured.
8. Health probe `HEAD /healthz` (never auth-gated: a bad secret must look different
   from a dead container), 250 ms doubling to 2 s, on its own `AbortController`.
9. Dial `/rpc` with the secret header, `accept()`, open the session.
10. `hello()`. A protocol mismatch destroys and relaunches once on the deployed image;
    a second mismatch settles the operation `failed { reason: "wire-skew" }`. Image and
    Worker are a matched pair, and a deploy can meet an old image, so we fail loudly.
11. Reconcile (next) before the handle is published: cloudflare/computer's rule.

Fencing runs both ways: every call carries `runtimeId`, every frame carries the daemon's,
and a stale one is rejected (`E_RUNTIME_FENCED`). A second live `subscribe()` closes the
first (`E_SUPERSEDED`). A second DO incarnation claiming the sidecar demotes the first
to read-only in place (`cc_fcspawn_do.go:6096-6114`); the soft-multitenant error that
follows is treated as "fenced out": dispose, do not retry, do not relaunch.

**Reconcile on every attach:**

```
R0  if hello.runtimeId != stored runtimeId:            # a different container answered
      settle every non-terminal operation failed { reason: "runtime_lost",
        resumable: hello.priorExit.code in (0, 143) }  [W]  (stream close + row in one txn)
      close every open request as lost                 [W]
      store the new runtimeId                          [W]
R1  wireCursor = wire.seq of the newest ingested frame stamped with hello.runtimeId
                 (from the newest log's tail, or the session row after a prune), else 0
R2  if wireCursor + 1 < hello.floorSeq: append one visible gap frame to the session log  [W];
    wireCursor = hello.floorSeq - 1   # floorSeq is the lowest seq still held
R3  stream = subscribe({ fromSeq: wireCursor, previews: ctx.attached() })
    for each batch: append frames (batched, stamped with the session seq), apply row
    transitions, until caught up
R4  for each unconsumed inbox row of this session: deliver(); on accepted or
    E_ALREADY_APPLIED, take the row  [W]       # undelivered prompts and answers alike
R5  diff open requests against hello.openRequestIds; a row the daemon no longer knows
    is closed as lost  [W]
R6  configure({ previews, requestDeadlines, remainingBudgetUsd })
R7  ack(wireCursor); setInactivityTimeout(keepAliveMs); wake(renewIntervalMs); publish
```

A clean reconcile with nothing to do costs zero durable writes.

**Idle policy** (all numbers on `idle`):

| Option                     | Default           | Effect                                                                                                                                                                                |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detachAfterIdleMs`        | 20 s              | close the control socket when no browser is attached and nothing is in flight. The DO becomes evictable; the container keeps working                                                  |
| `keepAliveMs`              | 15 min            | `setInactivityTimeout`. Ceiling 6 h                                                                                                                                                   |
| `renewIntervalMs`          | 5 min             | Lifecycle job: re-attach, renew, drain, detach. Worst-case survival after an eviction is `keepAliveMs - renewIntervalMs`, which is why the interval sits well under the keep-alive    |
| `stopContainerAfterIdleMs` | 2 min             | after the last operation settles with nobody attached: `shutdown()` then `destroy()`. The explicit destroy is the mechanism; lowering the keep-alive is decorative                    |
| `resumePolicy`             | `"on-clean-exit"` | auto-resume only after exit code 0 or 143 (SIGTERM); a crash needs an explicit re-submit, because a mid-flight tool does not re-run on resume and a naive re-run double-applies edits |

**The socket closes the moment an operation becomes blocked with no browser attached.**
The daemon's parked promise does not care, the request row is durable on both sides, and
the doorbell wakes the DO when a human answers. A permission wait measured in hours
costs zero resident-DO time.

Reconnection is event-driven or job-driven, never polled: `setInterval` does not fire in
an idle DO isolate. On close, error or `onRpcBroken` (deduplicated): mark detached, reject
in-flight calls with `HarnessDetachedError`, remove listeners before closing, and push a
re-attach job on a 250 ms to 5 s backoff only if a browser is attached, an operation is
running, or a request is open.

**The doorbell** is the only container→DO channel and it carries no frames. The daemon
POSTs `{ sessionId, runtimeId, highWaterSeq, reason }`, all of which the DO re-derives on
reconcile, to a `WorkerEntrypoint` the host re-exports; it verifies the secret in
constant time, checks the `runtimeId`, and pushes one `harness:drive` job. When
`enableInternet` is off, the doorbell host is an intercepted host. Losing every doorbell
costs latency and never correctness, because the renewal job reconciles anyway.

**What pins the DO.** An `accept()`ed socket registers a pending I/O event and keeps the
actor's `IoContext` live. The DO is resident exactly while attached. The keep-alive
countdown starts at capability drop (eviction), not at socket close
(`io_container.capnp:257-266`, `cc_binding.go:519-521`), so detaching is free.

**Tasks interplay** (verified in `tasks.ts`, `job-driver.ts`): the alarm handler returns
at the 5 s dispatch budget and hands the driver to `trackAlarmWork`; the detached drain
then runs on the actor's `IoContext` with no per-request timeout, so the 15-minute alarm
cap never binds it. Three bounds do: the drain is awaited in the handler body, never
inside `step.do()`; the claim heartbeat costs one alarm and one row write every
`stepTimeout + 30 s` while a run is held; and while a handoff is outstanding the
memory-limit breaker never quiesces, so three strikes over a long session seal and fail
the run. The runtime therefore returns between drains whenever nothing is attached and
nothing is running, and the reconcile above is the answer to an unrelated co-tenant
strike aborting a held drain.

### The Claude Code daemon

`@cloudflare/harnessd` is the daemon; `@cloudflare/harnessd-claude-code` is the engine
plus a type-only protocol entry the Workers side imports. The image tag is the Claude
Code version: `ghcr.io/cloudflare/harnessd-claude-code:2.1.227` bundles
`@anthropic-ai/claude-agent-sdk` at the release that bundles Claude Code 2.1.227, the
version the docs attach a "Requires Claude Code v2.1.227 or later" note to for
`ANTHROPIC_CUSTOM_HEADERS` (needed below; whether the note covers the variable or only
its validation is ambiguous, so the pin is the safe side). The SDK version _is_ the
bundled CLI version, so the image is both pin and changelog. `DISABLE_AUTOUPDATER=1` is
baked in.

**Runtime: Node 24, `ws`, `node:sqlite`.** The outbox is a `node:sqlite` database on the
container disk (WAL, `WITHOUT ROWID` on `(session, seq)`, pruned below the ack, capped at
64 MiB by raising `floorSeq`). `node:sqlite` is release-candidate quality from Node
24.15.0 and stopped printing an `ExperimentalWarning` there; the repo's nightly CI already
pins 24.15.0 and a test under `packages/agents/src/channels/__tests__/identity.test.ts:1`
already imports it. The base image is `node:24-slim`, digest-pinned, because
`node:sqlite` is a property of the official build. The Node `ws` + `newWebSocketRpcSession`
server path has one Cloudflare precedent, cloudflare/computer's `computerd`;
`@cloudflare/sandbox`'s daemon is Bun, and Bun's `serve()` drops silent sockets at 255 s,
which a ten-minute silent turn cannot tolerate. Rows from `node:sqlite` are null-prototype
objects and must be re-keyed before they touch the wire; its API is synchronous, so
outbox commits are batched per drain.

**Process model: one long-lived `query()` with streaming input, and the daemon is PID 1.**
`interrupt()`, `setPermissionMode()`, `setModel()` and `applyFlagSettings()` are documented
as streaming-input-only, so anything steerable needs one `query()` fed by an
`AsyncIterable<SDKUserMessage>`. The engine keeps that query for the session's life. PID 1
collapses "the daemon died" and "the container died" into one signal
(`ctx.container.monitor()`) and one fence.

```ts
const q = query({
  prompt: inbox, // AsyncQueue<SDKUserMessage>, fed by deliver()
  options: {
    cwd: "/workspace", // pinned forever: SessionStore's projectKey derives from it
    resume: engineSessionId ?? undefined,
    model: cfg.model,
    permissionMode: cfg.permissionMode ?? "default", // "dontAsk" + an ask policy is refused
    allowedTools: cfg.allowedTools,
    disallowedTools: cfg.disallowedTools,
    canUseTool: onPermission, // does the asking
    hooks: { PreToolUse: [{ hooks: [gate] }] }, // decides whether to ask; audits calls
    mcpServers: { host: hostToolServer(cfg.tools) }, // host tools park the same way
    sessionStore: outboxSessionStore, // the transcript mirror rides the outbox
    maxBudgetUsd: cfg.remainingBudgetUsd, // a cap the DO cannot fail to enforce
    includePartialMessages: previewsEnabled, // toggled by configure()
    env: { ...ALLOWLIST, DISABLE_AUTOUPDATER: "1" } // Options.env replaces, so spread
  }
});
for await (const message of q) project(message); // one outbox transaction per frame
```

**Permissions, end to end.** `PreToolUse` is the gate and `canUseTool` does the asking.
The hook runs on every tool call including auto-approved ones, and a hook deny applies
even under `bypassPermissions`. `canUseTool` does not see auto-approved calls, except
`AskUserQuestion`, MCP tools marked `requiresUserInteraction`, connector tools an
organisation set to `ask`, and critical-path `rm`/`rmdir`, which reach it regardless and
must therefore be answerable over `reply()`. Under `dontAsk` the `canUseTool` step is
skipped and the tool is denied (agent-sdk `permissions.md`, "How permissions are
evaluated", step 6), so a hook `ask` collapses to a deny there; the constructor refuses
`dontAsk`, `permissionPrompts: "none"` and `permissionPromptToolName` alongside an ask
policy. Two documented holes in the audit: `PreToolUse` does not fire for
`EndConversation` or for `@`-referenced file reads. A matching `ask` rule still prompts
even when the hook returned `allow`, so a hook allow is not a guarantee of execution.

A request is a durable frame on the daemon side (`request_opened`, then a parked
promise) and a durable row on the DO side; an answer is an inbox row delivered with
`kind: "reply"`. No promise crosses any boundary, so an eviction during a permission costs
latency only. A pending permission never times out in the SDK, so the deadline is owned
twice: a Lifecycle job in the DO writes the timeout reply into the inbox, and a daemon
timer auto-denies and emits `request_closed { by: "timeout" }` if the DO never returns.
`canUseTool` is idempotent per `requestId` (the applied-key row), because
`Query.reinitialize()` re-delivers pending requests after an SDK transport gap.

`permissionDecision: "defer"` (end the query with `stop_reason: "tool_deferred"`, resume
on the same `session_id`) is available as `deferAfterMs`, off by default, and best-effort:
it only works when the turn made a single tool call, is ignored with a warning otherwise,
ends the query rather than parking it, a resume must re-pass `permissionMode` (a `-p`
resume starts in `default`), and a resumed run whose host MCP server is not yet registered
exits with `tool_deferred_unavailable`. The parked-promise path stays live at all times.

**Host tools** ride the identical path with `type: "tool"`: an in-process SDK MCP server
in the daemon parks, the DO runs `tool.run(input)` against its own bindings, the answer
returns as an inbox row. Same seam as cloudflare/claude-managed-agents'
`defineTool({ run(input, { env }) })`. Tools are a **runtime** option, never a map of
functions on the capability.

**Egress and credentials.** Two modes, neither fully verified, and the honest summary is
that the repo's shipped example uses the second.

- `egress: "gateway-url"` (default): `ANTHROPIC_BASE_URL` at the account's AI Gateway
  Anthropic endpoint, `ANTHROPIC_API_KEY` set to the gateway token, and
  `ANTHROPIC_CUSTOM_HEADERS="cf-aig-authorization: Bearer <token>"`. This is Cloudflare's
  published Claude Code recipe (developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code).
  The Anthropic key lives in the gateway. What enters the container is an **AI Gateway
  API token, which is account-scoped**: `AI Gateway Run` cannot be restricted to one
  gateway (developers.cloudflare.com/ai-gateway/configuration/authentication), so a
  container that runs arbitrary `Bash` holds a credential that can spend through every
  gateway on the account, revocable only account-wide. The daemon removes it from
  `process.env` after passing it to the subprocess via an explicit allowlist, which
  narrows exposure but not blast radius. Two doc conflicts are recorded rather than
  resolved: the Anthropic provider page says a request that sets `x-api-key` fails under
  BYOK or Unified Billing, while the recipe sets `ANTHROPIC_API_KEY`, which Claude Code
  sends as `x-api-key`; and SSE through the gateway is a transparent proxy only when
  Guardrails and DLP response scanning are off, since both buffer the whole response.
  Claude Code aborts a stream silent for 300 s, and fine-grained tool streaming is off
  behind a custom base URL unless `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`.
  Unified Billing is rate-limited at 200 requests per 60 s per gateway. Off
  `api.anthropic.com`, MCP tool search and Remote Control are disabled.
- `egress: "intercept"`: `enableInternet: false` plus
  `interceptOutboundHttps("api.anthropic.com", ctx.exports.HarnessEgress({ props }))`,
  forwarding to `env.AI.gateway(id).run({ provider: "anthropic", endpoint, headers, query: await request.json() })`
  with the placeholder `x-api-key` dropped at the boundary, exactly as
  `examples/sandbox-coding-agent/src/server.ts:43-60` does today. Nothing in the container
  can authenticate to anything. Costs: the image must trust the runtime-injected CA at
  boot (`@cloudflare/sandbox`'s recipe: poll `/etc/cloudflare/certs/`, set
  `NODE_EXTRA_CA_CERTS`, append to the system bundle); `ctx.exports.<WorkerEntrypoint>`
  is the proven interception target and a DO stub is not; and whether SSE survives
  `gateway().run()` is unverified.

The default stays `gateway-url` because it is the documented recipe; `intercept` becomes
the recommended default the moment verification items 3 and 4 pass, and the credential
blast radius above is the reason to run them first.

**Transcript across container restarts.** Three records with three owners:

1. The user-visible transcript is projected into `Sessions` by the runtime: one user
   message per prompt, one assistant message per turn, tool calls and results as parts.
   `SessionMessage.id` is required and `parts` must be an array or the row is silently
   dropped on read (`sessions/core.ts:1345-1358`). `Sessions` has no count-bounded read
   today: `HistoryReadOptions` is `{ leafId?, signal?, newestFirst? }`, so `messages()` is
   served newest-first within `maxBytes` via `getRecentHistory(maxBytes, { leafId })`
   with the oldest returned id as the page cursor, until Sessions grows an
   anchor-resumable read (phase 6). There is no per-operation filter.
2. The engine's private recovery record is the SDK `SessionStore` mirror
   (agent-sdk `session-storage.md`): `append(key, entries)` writes a `log` frame into
   the outbox, so it is durable and replayable, and the DO writes it into the session
   log. Consumers dedupe by `entry.uuid`; the `.jsonl` format is internal and
   version-unstable, and nothing renders it. `sessionStore` is mutually exclusive with
   `persistSession: false` and `enableFileCheckpointing` (the SDK throws at startup),
   so `rewindFiles()` is unavailable and git in the workspace is the revert mechanism.
3. Restore on a fresh container: the DO ships the mirrored entries in `configure()` in
   128 KiB chunks, the daemon writes them under `CLAUDE_CONFIG_DIR` with the pinned
   `cwd`, and only then passes `resume`. A session id alone does not resume; the file
   must exist. Unverified end to end, hence `resumePolicy: "on-clean-exit"` and a failed
   restore degrading to a fresh engine session with the transcript replayed as context.

`snapshotContainer()` is not used: restore is boot-time only and mutually exclusive with
`image`, so a restored session could never take a new Claude Code version.
`snapshotDirectory` is `Unimplemented` on the platform (`cc_binding.go:2622`) and
experimental-gated in workerd.

**Usage.** `usage` on a result is per-turn and main-loop-only; `modelUsage` and
`total_cost_usd` are cumulative for the whole `query()` and restart on `/clear`, `/reset`
and `/new`, which emit `SDKConversationResetMessage`. The ledger is
`total = committed + epoch`, where `epoch` is replaced on every settle and absorbed into
`committed` on a new container generation **or** a `conversation_reset`; an all-zero
result after a non-zero epoch is "no new information" (a crashed worker emits zeros).
All figures are client-side estimates and the type says so. Budget is enforced twice on
purpose: `maxBudgetUsd` in the daemon, set to the remaining budget on every `hello()` and
`configure()`, and at admission in the DO, because an evicted control plane enforces
nothing. Pause, never terminate: raising the cap drains the inbox.

**Interrupt.** `Query.interrupt()` resolves `SDKControlInterruptResponse | undefined`
with `still_queued` (never `cancelled`; `cancel_queued` is a CLI control-protocol feature
the SDK does not expose, so the runtime does not advertise `"queue"`). The daemon
returns it in the `settle` frame as `result.stillQueued` with the documented caveats: an
empty list does not mean nothing else runs, and the list can contain UUIDs the client
never sent.

**Non-root.** The image runs as `agent` (uid 10001). `bypassPermissions` is refused as
root outside "a recognized sandbox"; `IS_SANDBOX=1`, which today's example relies on, is
undocumented on code.claude.com and a shipped capability does not depend on it.
`permissionMode: "default"` plus `allowedTools` plus the `PreToolUse` gate needs no hatch.

### Durability and failure matrix

| Failure                                    | Persisted where                                                                                                               | On wake                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DO evicted mid-turn                        | DO: inbox, operation row, request rows, frames ingested so far. Container: outbox from `floorSeq`, engine `.jsonl`, workspace | nothing at eviction time (the shutdown window is not guaranteed). Next wake runs R0–R7; frames produced while absent arrive in order                                 |
| DO evicted while idle                      | as above; socket was already closed                                                                                           | nothing until the next `prompt()` or renewal job; zero writes                                                                                                        |
| DO never wakes                             | keep-alive expires; platform stops the container (SIGTERM then SIGKILL)                                                       | next `hello()` answers with a new `runtimeId` or no container; R0 settles the operations `runtime_lost` and drops requests. A truthful terminal state, not a spinner |
| container stops or crashes mid-turn        | DO storage; outbox and workspace gone; transcript to the last acked `log` frame                                               | R0 with `resumable = exit in (0, 143)`; only the clean case auto-resumes. R1 restarts the wire cursor at 0 for the new generation                                    |
| socket drops, both sides alive             | nothing changes durably                                                                                                       | event-driven detach, job-driven re-attach, `subscribe(fromSeq)`; undelivered inbox rows replay at R4                                                                 |
| pending permission during eviction         | request row + `request_opened` frame in the DO; applied-key row + deadline in the daemon                                      | R5 diffs, R6 extends the deadline, the human answers into the inbox, R4 delivers. Or the daemon auto-denies at the deadline and records it                           |
| answer written but never delivered         | the inbox row                                                                                                                 | R4 replays it; the daemon answers `E_ALREADY_APPLIED` if it already applied it                                                                                       |
| daemon restarts under a live container     | cannot happen: the daemon is PID 1                                                                                            | collapses into "container crashed"                                                                                                                                   |
| outbox truncated                           | DO holds frames to its cursor; daemon from `floorSeq`                                                                         | R2 writes one labelled gap frame and continues; the engine session and the `Sessions` transcript are unaffected                                                      |
| budget exceeded                            | operation result, runtime spend                                                                                               | settle `budget`; the session stays alive and idle                                                                                                                    |
| Worker deploy meets an old image           | launch record                                                                                                                 | `hello()` protocol mismatch: destroy and relaunch once, then fail loudly                                                                                             |
| memory-limit strike in the DO              | everything durable                                                                                                            | `onMemoryLimit` disposes the runtime, which detaches immediately; the doorbell or the next request re-creates the job                                                |
| a second DO incarnation                    | runtime singleton row                                                                                                         | the daemon fences on `runtimeId` and keeps one live `subscribe` slot; the platform demotes the older incarnation, which treats the error as fenced out               |
| frame larger than the container leg allows | nothing                                                                                                                       | 128 KiB batches; oversize frames split; unsplittable ones become workspace pointers                                                                                  |

Mechanism assignments: `setInactivityTimeout` on every attach and renewal, the only
reason a container survives an eviction; `monitor()` per generation; `exec()` and the
snapshot APIs unused; Tasks memoizes the handshake and each drained-and-acked batch and
never a model or tool effect (the engine's own session is the recovery evidence);
Lifecycle jobs `harness:drive`, `harness:renew` (`recoveryLoop`) and
`harness:request-timeout`, none marked `exclusive`.

### Topology

**One top-level DO per remote session.** Sessions are created and listed by a
`RoutedAgents` hub, whose `create()`, `list()` and `setMetadata()` touch only the hub's
SQLite and wake no target. That needs an upstream change larger than it looks:
`RoutedAgents<TAgent extends Agent>` is bounded at `routed-agents.ts:55` and `:106`,
`delete()`/`dispose()` call `_cf_scheduleDestroy()` (`:225`, `:283`), and `#stub()` goes
through `getAgentByName`, which is itself bounded to `Agent` and RPCs
`__unsafe_ensureInitialized` (`agent-routing.ts:395`, `:410-417`). The proposal: a
`LifecycleObject` host contract of two prototype methods, `ensureStarted()` and
`condemn()`, that `Lifecycle.install()` supplies on any Durable Object; `RoutedAgents`
and `getAgentByName` accept that contract; a container-backed target's `condemn()` also
calls `ctx.container.destroy()`, because condemning the DO does not stop the container.
A plain-DO hub must call `lifecycle.dispose()` in its own teardown to keep the
condemnation cascade that `Agent.destroy()` provides. `getAgentByName`'s signature is
public, so this is a semver-visible change.

**A Think or AIChat parent drives a session as a peer, not a child**, through
`harnessTool()`:

```ts
// agents/harness/tool  (phase 6: depends on the LifecycleObject contract above)
export function harnessTool<TInput>(options: {
  readonly namespace: DurableObjectNamespace;
  readonly description: string;
  readonly inputSchema: StandardSchemaV1<TInput>;
  readonly prompt: (input: TInput) => HarnessInput;
  /** Default `harness:<toolCallId>`: a re-run after a deploy joins the existing operation. */
  readonly sessionName?: (
    input: TInput,
    ctx: { readonly toolCallId: string }
  ) => string;
  /** Default: `{ status, stopReason, summary, filesChanged }`, never the whole transcript. */
  readonly summarize?: (
    result: HarnessResult,
    messages: readonly SessionMessage[]
  ) => JsonValue;
  /** What the parent does when the session raises a request. Default "surface": report it
   *  as progress and keep waiting; a human answers on the session's own socket. */
  readonly onRequest?: "surface" | "deny";
  readonly timeoutMs?: number;
}): Tool<TInput, JsonValue>;
```

`execute` opens the session by name, calls `prompt()` with `operationId = sessionName`
(idempotent), tails `events()` into the parent's `reportProgress`, and returns
`summarize()` on settle. Because the session is independently addressable, a human can
open it and click Allow while the orchestrator waits; with facets, every frame wakes the
root and no human can attach. `agentTool()` cannot be used: it spawns a facet, which
shares the root's container.

Both host shapes compose identically. A plain `DurableObject` is the example below. An
`Agent` host installs `Tasks`, `Streams` and `WebSockets` already; the harness's
`webSockets()` options merge into the Agent's, and native-RPC entry points await
`lifecycle.start()` first.

### Cost

| Scenario                                  | Resident DO                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 300 s unattended run                      | attach ≈ 0.5 s (up to 30 s on the first request after an eviction, while the platform recovers the container) + `detachAfterIdleMs` + one renewal wake + one doorbell wake ≈ 25–30 s |
| interactive session, human present        | pinned while they are there, bounded by `detachAfterIdleMs` after they leave                                                                                                         |
| blocked on a permission, nobody watching  | 0 s                                                                                                                                                                                  |
| blocked on a permission, browser attached | pinned; `deferAfterMs` converts long waits                                                                                                                                           |
| any held drain                            | one alarm and one row write per `stepTimeout + 30 s` (claim heartbeat)                                                                                                               |

Row writes per prompt turn, 400 frames, one permission: inbox insert and delete (2),
operation insert and settle (2), operation stream open and settle (4), session stream open
(3, once per session), frame appends batched at 100 ms / 64 frames / 256 KiB (6–8),
session-log appends for transcript batches (3–6), `Sessions` projection (2), request
insert and delete (2), watermark (0, derived), clean reconcile (0): **about 21–26 per
turn** after the first. The naive shape, a row per frame and a maintained cursor column
with an index, is 400+ writes plus index maintenance on the hottest table.

Container time bills for the whole run. `keepAliveMs` bounds the abandoned tail;
`stopContainerAfterIdleMs` plus an explicit `destroy()` bounds the ordinary one. The
default instance is `standard-2`: Claude Code's documented floor is about 1 GiB RAM,
5 GiB disk and 1 CPU per agent, and memory grows with session length. Cloudflare does not
guarantee any container runs for a set period; `keepAliveMs` is a ceiling on how long
the platform will try, never a floor. Under `gateway-url` egress with Unified Billing,
200 requests per 60 s per gateway caps concurrent sessions.

### Example: `examples/next/harnesses/claude-code`

The hub and `harnessTool()` compile after phase 6; the session class compiles after
phase 5.

```ts
// src/server.ts
import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { RoutedAgents } from "agents/routing";
import { Harness, type HarnessResult } from "agents/harness";
import {
  ContainerHarnessRuntime,
  HARNESS_DOORBELL_PATH
} from "agents/harness/remote";
import {
  claudeCode,
  type ClaudeCodeProtocol
} from "@cloudflare/harnessd-claude-code/protocol";

export { HarnessDoorbell } from "agents/harness/remote"; // add HarnessEgress for egress: "intercept"

/** One Durable Object per coding session. One container per Durable Object. */
export class ClaudeCodeSession extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();

  readonly runtime = new ContainerHarnessRuntime<ClaudeCodeProtocol>({
    id: "container:claude-code",
    container: this.ctx.container!,
    port: 8787,
    launch: { enableInternet: true, env: { CF_HARNESS_ENGINE: "claude-code" } },
    egress: {
      mode: "gateway-url",
      baseUrl: this.env.GATEWAY_URL,
      token: this.env.GATEWAY_TOKEN
    },
    // Sessions are addressed by name through the hub; a session reached by id has none.
    doorbell: {
      url: this.env.DOORBELL_URL,
      sessionName: this.ctx.id.name ?? this.ctx.id.toString()
    },
    sessions: this.sessions,
    tools: {
      deployPreview: {
        description: "Deploy the workspace to a preview URL",
        inputSchema: {
          type: "object",
          properties: { branch: { type: "string" } }
        },
        run: (input) => deploy(this.env, input as { branch: string })
      }
    },
    engine: claudeCode({
      model: "claude-opus-5",
      permissionMode: "default",
      allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
      ask: ["Bash", "WebFetch"],
      setup: [
        "git",
        "clone",
        "--depth",
        "1",
        "https://github.com/example/repo",
        "."
      ],
      budget: { maxUsd: 5 }
    }),
    idle: {
      detachAfterIdleMs: 20_000,
      keepAliveMs: 900_000,
      stopContainerAfterIdleMs: 120_000
    }
  });

  readonly harness = new Harness<ClaudeCodeProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.runtime,
    policy: { requestTimeoutMs: 600_000 }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.webSockets)
    .use(this.harness);

  /** A non-WebSocket entry point: run one task to completion. Native RPC bypasses fetch,
   *  so the lifecycle is started explicitly. */
  async run(text: string): Promise<HarnessResult> {
    await this.lifecycle.start();
    const session = this.harness.session();
    const { operationId } = await session.prompt(text, {
      operationId: `run:${hash(text)}`
    });
    return session.wait(operationId, { timeoutMs: 600_000 });
  }

  async harnessDoorbell(request: Request): Promise<Response> {
    await this.lifecycle.start();
    return this.runtime.doorbell(request);
  }
}

export class SessionHub extends DurableObject<Env> {
  readonly sessions = new RoutedAgents({
    namespace: this.env.ClaudeCodeSession,
    route: "s"
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  /** A plain-DO hub keeps the condemnation cascade only if it disposes explicitly. */
  async destroy(): Promise<void> {
    await this.lifecycle.dispose();
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith(HARNESS_DOORBELL_PATH)) {
      return ctx.exports
        .HarnessDoorbell({ props: { namespace: "ClaudeCodeSession" } })
        .fetch(request);
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

```ts
// @cloudflare/harnessd-claude-code/protocol  (type-only from Workers, plus one pure factory)
export type ClaudeCodeOptions = {
  readonly model: string;
  readonly permissionMode?: "default" | "acceptEdits" | "plan"; // never "dontAsk" with `ask`
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Tools that raise a permission request instead of running. */
  readonly ask?: readonly string[];
  /** Run once in /workspace before the first turn on a fresh container. */
  readonly setup?: readonly string[];
  readonly budget?: { readonly maxUsd: number };
  readonly maxTurns?: number;
};
export function claudeCode(
  options: ClaudeCodeOptions
): HarnessEngineSpec<ClaudeCodeProtocol>;

export type ClaudeCodeEvent =
  | { readonly type: "thinking"; readonly messageId: string } // signal only
  | {
      readonly type: "permission_denied";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: string;
    }
  | {
      readonly type: "compacted";
      readonly trigger: "manual" | "auto";
      readonly preTokens: number;
    }
  | {
      readonly type: "subagent";
      readonly state: "started" | "progress" | "ended";
      readonly toolCallId: string;
    }
  | {
      readonly type: "rate_limit";
      readonly status: string;
      readonly resetsAt?: number;
    }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly errorStatus: number | null;
    }
  | { readonly type: "conversation_reset"; readonly newConversationId: string }
  /** Forward-compat escape hatch: an unrecognised SDKMessage becomes this, never a drop. */
  | {
      readonly type: "engine_raw";
      readonly kind: string;
      readonly subtype: string | null;
      readonly body: JsonValue;
    };

export type ClaudeCodeProtocol = {
  event: ClaudeCodeEvent;
  submit: { kind: "context"; payload: { text: string } }; // shouldQuery:false, merged into the next turn
  result: { reason: string; interrupted?: boolean; error?: string };
};
```

Swapping `ContainerHarnessRuntime` for `PiRuntime` or `CodexRuntime` changes the
constructor line and nothing the caller does. The wrangler config has one `containers[]`
entry for `ClaudeCodeSession` (`instance_type: "standard-2"`), none for the hub, and no
`sleepAfter`: idle is `setInactivityTimeout` plus an explicit `destroy()`. The Dockerfile
is `FROM ghcr.io/cloudflare/harnessd-claude-code:2.1.227` plus the user's toolchain.
The browser uses `useHarnessSession<ClaudeCodeProtocol>()`; permission requests render
from the snapshot's `requests` and from `request_raised` events and are answered with
`reply()`.

The `git clone` in `setup` needs `enableInternet: true`; a locked-down posture bakes the
repo into the image or fetches it through a host tool and uses `egress: "intercept"`.

### Package layout

```
packages/agents/src/harness/            → "agents/harness"        Harness, HarnessRuntime, transport, batching
packages/agents/src/harness/protocol.ts → "agents/harness/protocol"  zero-dependency wire contract
packages/agents/src/harness/remote/     → "agents/harness/remote"   ContainerHarnessRuntime, HarnessEgress, HarnessDoorbell
packages/agents/src/harness/tool.ts     → "agents/harness/tool"     harnessTool()
packages/agents/src/react/use-harness-session.ts → "agents/react"
packages/harnessd/                      → "@cloudflare/harnessd"               Node 24 daemon, PID 1, outbox, engine port
packages/harnessd-claude-code/          → "@cloudflare/harnessd-claude-code"   the Agent SDK engine + type-only protocol
examples/next/harnesses/claude-code/
```

Rules: `agents/harness` imports only Lifecycle, Tasks, Streams and WebSockets types plus
a type-only `agents/sessions` import; never `capnweb`, never a container API, never an
engine. `agents/harness/remote` is the only module that touches `ctx.container` and
`capnweb`, and it must not be reachable from `agents/react` or `agents/client`.
`agents/harness/protocol` imports nothing, so the daemon can depend on it. No vendor name
appears under `agents`; the typed Claude Code layer ships from the engine package as
types plus one pure factory. Bundle isolation is tested in both directions, as
`rfc-harness-model-provider-boundary.md` requires.

### Implementation plan

1. **`agents/harness` with local runtimes.** Port codex and self-modifying. Acceptance:
   their tests pass unchanged; two transports and two hooks are deleted; net line count
   goes down; a bundle test asserts no `capnweb` and no engine in `agents/harness`; the
   write count per turn is asserted in CI; `streams.tail()` or its two-call equivalent
   lands.
2. **pi ported. This is the falsifier.** Acceptance: the eviction test passes against
   `PiRuntime`; `intake.ts` and `cf_agents_pi_submissions` are deleted; abort and steer
   become inbox kinds; lanes become session ids; pi's driver rotation and its
   non-durable `#rejections` map disappear into the base. If pi needs a base concept
   this document does not already have, the intersection is the wrong cut and this RFC
   is re-derived from pi's shape.
3. **The wire without a container.** `agents/harness/remote` and `@cloudflare/harnessd`
   with a fixture engine; `ContainerHarnessRuntime` takes an injectable
   `dial(): Promise<WebSocket>`. A workers-pool test instantiates the daemon root in the
   same isolate over a `WebSocketPair` and runs the whole protocol with no Docker:
   handshake, mismatch, fencing, supersession, replay from every cursor, a generation
   change resetting the wire cursor, duplicate drops, answer and prompt redelivery,
   truncation, timeout auto-deny, budget interrupt, and a drop at an arbitrary `seq`.
   Every row of the failure matrix that does not need Docker is on the PR path.
4. **The Claude engine, Node only.** The `SDKMessage → frame` projection is a pure
   function tested against recorded NDJSON fixtures (text, thinking, tool use and result,
   `stream_event`, `compact_boundary`, `result` with usage and denials, `conversation_reset`,
   `mirror_error`, `task_progress`, and one unrecognised subtype that must become
   `engine_raw` and a test warning). Assertions are semantic, never byte-exact; fixtures
   live beside the pinned SDK version. The daemon's CI opens a `node:sqlite` WAL database
   with a `WITHOUT ROWID` composite key at the pinned image and asserts no warning.
5. **The container, nightly.** Real Docker: launch, adopt versus relaunch, health, egress
   in both modes, one real turn, one HITL round trip, eviction mid-turn, reconnect,
   SIGTERM and SIGKILL, transcript restore, cold start, and the resident-DO time of a
   300 s unattended run under 60 s. `vitest-pool-workers` cannot run Docker.
6. **Topology.** The `LifecycleObject` host contract, the relaxed `RoutedAgents` and
   `getAgentByName` bounds, `harnessTool()`, and a `Sessions` anchor-resumable read.

Before `agents/harness` is a stable export: a public Tasks aperture for capability-owned
drivers, pi's session store moved into `agents/sessions`, and the example eviction tests
promoted into the package.

### Verification plan

Facts the design rests on that only a deployment can settle, each with its test and what
it blocks:

1. `setInactivityTimeout(ms)` keeps a container alive across a DO eviction. Set 600 s,
   write a marker, `ctx.abort()`, wait 90 s, re-enter, read `running` and the marker.
   Blocks the entire detach-on-purpose cost model. Two verified sources disagree on the
   semantics (`io_container.capnp:257-266` vs `cc_binding.go:603-655`); the design
   follows the implementation. Also check the per-account features `useNewRuntime` /
   `useContainerMap` and `KeepAliveOnShutdownDisabled`, which change recovery behaviour.
2. A frame over 1 MiB survives the DO↔container leg. Echo 512 KiB to 8 MiB; record the
   close code. Sets the split threshold only.
3. SSE survives `env.AI.gateway().run()`. Blocks `egress: "intercept"` as the default.
4. One real turn through the gateway URL with the gateway token as `ANTHROPIC_API_KEY`
   against a BYOK or Unified Billing gateway, and the pinned image actually sends
   `cf-aig-authorization`. If it fails, `gateway-url` is not a tokenless mode and
   `intercept` becomes the default.
5. The secret header survives the tunnelled upgrade. Blocks the dial; fallback is the
   secret in the path.
6. A `.jsonl` restored from the mirror resumes in a fresh container. Blocks
   `resumePolicy` beyond `"on-clean-exit"`.
7. A SIGTERM'd turn continues on resume and a SIGKILL'd one does not; `monitor()`
   settles on OOM. Blocks auto-resume being safe.
8. `interceptOutboundHttps` applied by incarnation A still governs after B adopts, and
   re-application is idempotent. Blocks the doorbell under `enableInternet: false`.
9. `/proc/1/environ` is not readable by the `agent` user under `containers_pid_namespace`.
   Blocks "removing the variable suffices"; otherwise the secret arrives as a file the
   daemon unlinks.
10. An installed `monitor()` promise does not keep the DO resident the way an accepted
    socket does. If it does, detaching buys nothing.
11. A doorbell wakes an evicted DO within a second. Blocks latency only.
12. `standard-2` clears Claude Code's floor over a 200-turn session.
13. pi ports with no new base concept (phase 2, in full).
14. `ClaudeCodeProtocol` plus `claudeCode()` fit in 200 lines with zero changes under
    `packages/agents/src/harness`.

## The alternatives

| Alternative                                                           | Why not                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adopt `@ai-sdk/harness` `HarnessAgent` (#1829)                        | Its framework owns no storage; ours must own all of it. Adopting it puts a second durability model beside Tasks, Streams and Sessions, makes a `bridge.mjs` NDJSON log the recovery evidence instead of the DO, exact-pins `ai@7.0.97`, needs `ws` and `node:*` on the host, and its resume ladder ends in "rerun", which double-applies edits. `@ai-sdk/sandbox-cloudflare` also still does not exist |
| Keep three bespoke APIs and add a fourth                              | the user's ask is one way to drive every harness; the matrix shows the common core is real                                                                                                                                                                                                                                                                                                             |
| `@cloudflare/sandbox` as the container layer                          | its own DO class extending `Container` (cannot be a capability on your object), port 3000 reserved, no duplex process I/O (`stdin: "ignore"`), capnweb ^0.8 against our ^0.12, Bun's 255 s idle drop, full-buffer replay with no cursor. No stdin forecloses streaming input, which forecloses interrupt and permissions                                                                               |
| `@cloudflare/containers`' `Container` base class                      | overrides `alarm()` with a self-re-arming loop and keeps private `inflightRequests`/`sleepAfter` bookkeeping; Lifecycle owns the one alarm. Raw `ctx.container` has no conflict                                                                                                                                                                                                                        |
| `ctx.container.exec()` with no daemon                                 | the cheapest option: no server in the image, real duplex streams, pid, kill, PTY. Rejected because the process is `crun exec --detach`ed and unre-attachable after eviction; its pipes SIGPIPE, which is the failure we exist to survive                                                                                                                                                               |
| `spawnClaudeCodeProcess` (SDK in the Worker, binary in the container) | puts the `Query`, pending permissions and the message iterator in the evictable isolate, and wants Node duplex streams across a cross-datacenter hop. Kept as a question: if it works, a smaller image follows                                                                                                                                                                                         |
| The container dials the DO (cloudflare/computer's inversion)          | its payoff is hibernation, which capnweb cannot use in either direction; it costs a `/connect` protocol, an armed-upgrade race, and an upgrade slot reachable from inside the container. Its one real benefit, waking an absent DO, is the doorbell                                                                                                                                                    |
| A capnweb event-sink stub exported by the DO                          | `.dup()` discipline, re-registration on every reconnect, and a live capability into the DO for a container running `Bash`. A returned `ReadableStream` has real flow control and nothing to lose                                                                                                                                                                                                       |
| Persisting token deltas                                               | they are neither settled content, nor effect settlement, nor a next-request need, and a reconnecting reader gets the full parts from `message_end`                                                                                                                                                                                                                                                     |
| Facets, one per session                                               | a facet shares the root's container in production and gets its own in dev                                                                                                                                                                                                                                                                                                                              |
| `agentTool()` for the Think integration                               | spawns a facet                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-turn `claude -p --resume` (today's example)                       | no stdin, so no interrupt, no `canUseTool`, no steering; a killed turn cannot be resumed, only re-run                                                                                                                                                                                                                                                                                                  |
| Hibernating the control socket                                        | no API converts an accepted outbound socket into a hibernatable one; closing it and making closing safe is the honest option                                                                                                                                                                                                                                                                           |
| Shutdown-window heroics on eviction                                   | the window is not guaranteed and a partial write is worse than none; the outbox already makes absence lossless                                                                                                                                                                                                                                                                                         |
| `snapshotContainer()` / `snapshotDirectory`                           | boot-time restore mutually exclusive with `image`; directory snapshots unimplemented                                                                                                                                                                                                                                                                                                                   |
| A typed event union with no extension point                           | erases pi's 21 variants or forces codex to type opaque engine JSON. a tagged `extension` member carrying `P["event"]` keeps uniform rendering for the common cases and full types at the seam                                                                                                                                                                                                          |
| `abort()` / `steer()` as base methods                                 | one durable inbox with reserved kinds gives the same guarantee with none of the methods                                                                                                                                                                                                                                                                                                                |
| Host tools as `Harness` options                                       | a map of functions closing over `env` breaks "options are policy-only"; they belong to the runtime                                                                                                                                                                                                                                                                                                     |
| A versioned profile resource and a profiles hub                       | the repo has no versioned-config resource; `rfc-codex-harness-capability.md` records model transport as a developer choice                                                                                                                                                                                                                                                                             |
| One session-lifetime Streams log with placeholder rewrite             | `StreamWriter` is append-only; a replay reader that consumed the placeholder never sees a rewrite; it also forfeits the `close({ commit })` cutover                                                                                                                                                                                                                                                    |
| `agents/harness/claude-code` (a vendor subpath)                       | the repo's precedent is that harnesses are examples; reversing an export map is breaking. The generic container transport is the reusable brick                                                                                                                                                                                                                                                        |
| `IS_SANDBOX=1` to allow `bypassPermissions` as root                   | undocumented; non-root plus `default` mode plus the `PreToolUse` gate is the documented path                                                                                                                                                                                                                                                                                                           |
| Bun for the daemon                                                    | `Bun.serve` caps `idleTimeout` at 255 s; `node:sqlite` only lands in Bun 1.4; the Node path has computerd as precedent                                                                                                                                                                                                                                                                                 |
| Wire version negotiation                                              | image and DO code ship together; a mismatch is a deploy error. We fail loudly and relaunch once rather than accept lockstep silently                                                                                                                                                                                                                                                                   |

## The decision

Pending discussion. Accepting this RFC decides the following, and each is an explicit ask:

1. `PiHarness`, `CodexHarness` and `SelfModifyingHarness` stop being classes and become
   runtimes behind one `Harness`; the examples are ported, not kept.
2. `rfc-coding-agent.md`'s `HarnessEngine` path (wrapping `@ai-sdk/harness`) is closed;
   a `@cloudflare/coding-agent` package, if it ships, consumes `agents/harness`.
3. `getAgentByName` and `RoutedAgents` accept a `LifecycleObject` contract instead of
   `Agent`. This changes a public signature.
4. Two new `packages/` entries, `@cloudflare/harnessd` and `@cloudflare/harnessd-claude-code`,
   or one package with engines as subpaths.
5. `messages()`, `requests()` and `reply()` stay in the core even for harnesses that
   return one page and an empty list.
6. The default egress mode for the example: `gateway-url` (documented recipe, account-scoped
   token in the container) until verification items 3 and 4 settle it, or `intercept`
   (no credential, unverified streaming) from day one.

A note on the source survey: the OpenCode `2.0` branch is a stale April exploration; the
real 2.0 API lives on `dev` under `/api/*` with `sdk-next` and `protocol`, and that is what
the comparison used. pi has no `dev` branch; the vendored `pi-dev` build at `c4b0e35a` is
the harness API compared, checked against pi `main` (unchanged in the harness) and its
`feat/coding-agent-server-backend` branch, whose `PiSessionRuntime`
(`snapshot/prompt/steer/abort/setModel/subscribe/dispose`) is pi's own most-limited
remote-driving API and agrees with the core above.
