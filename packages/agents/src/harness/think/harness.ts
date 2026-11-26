import {
  asSchema,
  convertToModelMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk
} from "ai";
// Imported from their modules, not "../../lifecycle", which loads
// cloudflare:workers.
import {
  bindLifecycleCapability,
  LifecycleCapability
} from "../../lifecycle/capability";
import { capabilitySchema } from "../../lifecycle/schema";
import { REPLAY_ITEM_BYTES } from "../../internal/platform-limits";
import { Sessions } from "../../sessions/sessions";
import { Streams } from "../../streams/streams";
import { backoffDelay, isPlatformFailure } from "../../retries";
import {
  AttemptSupersededError,
  isTaskCancellation,
  isTaskSuspension
} from "../../tasks/replay";
import { Tasks } from "../../tasks/tasks";
import { hasTable } from "../../lifecycle/schema";
import type {
  TaskJson,
  TaskRecord,
  TaskStatus,
  TaskStep
} from "../../tasks/types";
import {
  createToolsFromClientSchemas,
  type ClientToolSchema
} from "../../chat/client-tools";
import type { StreamChunkData } from "../../chat/message-builder";
import {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "../../chat/stall-watchdog";
import { StreamAccumulator } from "../../chat/stream-accumulator";
import type {
  AgentHarness,
  HarnessInput,
  HarnessInputFrom,
  HarnessSession,
  HarnessSessions,
  SessionEvent,
  SessionState,
  SessionWatch,
  ToolAnswer
} from "../../experimental/channels/harness";
import type { CompactResult } from "../../sessions/compaction-helpers";
import type { Session } from "../../sessions/handle";
import {
  CONTEXT_RECORD_KIND,
  type Context,
  type PreparedTurn
} from "../../context/context";
import type { SearchResult, SessionMessage } from "../../sessions/types";
import type { StreamJson } from "../../streams/types";
import {
  answeredMessage,
  answerToolCall,
  toResponseChunk,
  toTranscriptMessage,
  type ToolCallAnswer
} from "../../experimental/channels/ai-sdk-conversion";
import {
  SessionEvents,
  Watcher,
  type ThinkHarnessListener,
  type PrefixChangeCause,
  type ThinkSessionEvent,
  type ThinkSessionListener
} from "./events";
import { harnessHookRules } from "./extensions/hooks";
import {
  ExtensionManager,
  type ExtensionBuild,
  type RemindSection
} from "./extensions/manager";
import { contextExtension, optionsExtension, resolve } from "./extensions/own";
import { loadInProcess } from "./extensions/in-process";
import { ReleasedRecords, type OperationInput } from "./records";
import {
  executeTool,
  isServerTool,
  modelTools,
  toolNeedsApproval,
  type ToolOutcome
} from "./tools";
import {
  hasContent,
  isToolCallPart,
  lastStep,
  nextAction,
  settledPartial,
  textOf,
  toolNameOf,
  type ToolCallPart
} from "./turn";
import type {
  ThinkErrorClass,
  ThinkHarnessOptions,
  ThinkInFlight,
  ThinkInput,
  ThinkOperationInspection,
  ThinkOperationStatus,
  ThinkStreamCallback,
  ThinkOperationResult,
  ThinkPendingOperation,
  ThinkPromptResponse,
  ThinkReceipt,
  ThinkSessionId,
  ThinkSessionInfo,
  ThinkSubmitOptions,
  ToolRecovery
} from "./types";

/**
 * Thrown by `submit()` when asked to steer a running turn, which
 * ThinkHarness does not support. Submit without `whenBusy` to queue the
 * input behind the running turn instead.
 *
 * @experimental
 */
export class SteerNotSupportedError extends Error {
  /** Stable tag for matching without `instanceof`. */
  readonly _tag = "SteerNotSupportedError" as const;

  /** @param session - The session the submission was for. */
  constructor(readonly session: ThinkSessionId) {
    super(
      'ThinkHarness does not support whenBusy: "steer". Submit without it to queue the input behind the running turn.'
    );
    this.name = "SteerNotSupportedError";
  }
}

/** The root session's id: the Sessions capability's default session. */
export const ROOT_SESSION: ThinkSessionId = "";

/** The Tasks definition every operation is a run of. */
const OPERATION_DEFINITION = "__cf_think_harness_operation";
/**
 * An operation submitted as a submission (internal `submission` option):
 * the same handler and lane, a definition of its own so submissions can be
 * listed and deleted apart from other operations, and kept across a reset.
 */
const SUBMISSION_DEFINITION = "__cf_think_harness_submission";
const DEFINITIONS = [OPERATION_DEFINITION, SUBMISSION_DEFINITION] as const;
/**
 * The session value (Sessions config) that records a session the harness
 * knows of: `{ parent?, createdAt }`. Not a `transcript:` key, so a reset
 * keeps it.
 */
const SESSION_KEY = "think-harness:session";
/** The session value holding the client tools its client last declared. */
const CLIENT_TOOLS_KEY = "think-harness:client-tools";
/** Open operations carried forward from the harness store at a time. */
const CARRY_BATCH = 50;
/** The checkpoint key a placed operation's progress is kept under. */
const TURN_KEY = "turn";
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;
const MAX_OVERFLOW_RETRIES = 1;
/** Chunks packed into one stored stream segment. */
const SEGMENT_CHUNKS = 10;
/** Raw bytes packed into one stored segment before it is written. */
const SEGMENT_MAX_BYTES = 256_000;
/** Longest a streamed chunk waits in memory before it is written. */
const FLUSH_AFTER_MS = 100;
/** Segments read at a time when rebuilding an interrupted model call. */
const READ_PAGE = 50;
/**
 * A server tool call's step: never retried by Tasks (the harness's tool
 * recovery decides what an interrupted call does), and never timed out
 * (the longest timer the runtime takes).
 */
const TOOL_STEP = { retries: { limit: 1 }, timeout: 2 ** 31 - 1 } as const;

const INTERRUPTED_TOOL_ERROR =
  "The tool call was interrupted before it finished, because the agent restarted. It may or may not have taken effect.";

/** The operation a session is running in this isolate. */
/** A session's tools, its client's included, and its options' prompt. */
type SessionBuild = {
  readonly tools: ToolSet;
  readonly system: string | undefined;
  readonly remind: readonly RemindSection[];
  readonly allSections: string | undefined;
};

type LiveRun = {
  readonly operationId: string;
  /** Chunks of the model call in progress. */
  partial: UIMessageChunk[];
  /** Whether that call continues a message already persisted. */
  continues: boolean;
  /** The tools this run resolved, which decide which calls are a client's. */
  tools?: ToolSet;
  /**
   * The build an answer placed in this attempt made, which the attempt's
   * model loop uses rather than building again.
   */
  built?: SessionBuild;
  /**
   * The run was cancelled and its terminal report finished it from
   * `partial`: the attempt, still unwinding, writes nothing more.
   */
  taken?: boolean;
};

/** An operation's input, as its run keeps it. */
type OperationRunInput = {
  readonly input: OperationInput;
  readonly source: "client" | "server";
};

/**
 * How an operation's run ended when its handler ended it. The other ends
 * (cancelled, failed, sealed by the memory-limit breaker) are the run's.
 */
type OperationOutcome =
  | {
      readonly status: "done";
      readonly text: string;
      readonly messageId?: string;
    }
  | {
      readonly status: "unanswered";
      readonly reason: string;
      readonly messageId?: string;
    };

/**
 * A placed operation's progress, the run's `turn` checkpoint. Written in
 * the transaction of the transcript or stream write it goes with, so a
 * reset leaves the two in step.
 */
type TurnState = {
  /** The message a new assistant message is a child of. */
  readonly parentId: string | null;
  /** This operation's assistant message, once it has one. */
  readonly messageId: string | null;
  /** The stream of the model call in progress, if one is. */
  readonly streamId: string | null;
  /** Whether the model has to be called before the turn can end. */
  readonly pendingModel: boolean;
  /** Model calls made so far. */
  readonly steps: number;
  /** Interruptions since the turn last made progress. */
  readonly interruptions: number;
  /** Context-overflow retries spent. */
  readonly overflowRetries: number;
  /**
   * Set with the transcript write that ends the turn: a reset before the
   * run settles ends it the same way (`reason` unanswered, else done).
   */
  readonly ended?: { readonly reason?: string };
  /** Tool calls an earlier version started for it and did not finish. */
  readonly started?: string[];
  /**
   * Why an earlier version's memory-limit breaker sealed it: the next
   * attempt finishes it as abandoned, with this reason.
   */
  readonly abandon?: string;
};

/** A change to a turn's progress; a field left out is unchanged. */
type TurnChange = Partial<TurnState>;

/** A placed operation: its run's input and progress. */
type Turn = TurnState & {
  readonly session: ThinkSessionId;
  readonly operationId: string;
  readonly input: OperationInput;
  readonly source: "client" | "server";
};

/** A durable write: put messages and update operations, in one transaction. */
type Put = (
  message: UIMessage,
  options?: {
    readonly parentId?: string;
    readonly source?: "client" | "server";
  }
) => void;

/** An operation's run id: unique per session and operation id. */
function runIdOf(session: ThinkSessionId, operationId: string): string {
  return JSON.stringify([session, operationId]);
}

/** The session and operation id a run id names. */
/** A session's idempotency key as Tasks stores it: `[session, key]`. */
function keyOf(session: ThinkSessionId, key: string): string {
  return JSON.stringify([session, key]);
}
/** The caller's key from a stored one. */
function callerKeyOf(stored: string): string {
  // SAFETY: written only by keyOf, as a [session, key] pair.
  return (JSON.parse(stored) as [string, string])[1];
}

function operationOf(runId: string): [ThinkSessionId, string] {
  // SAFETY: every run of the operation definition is named by runIdOf.
  return JSON.parse(runId) as [ThinkSessionId, string];
}

/** A session's lane: its operations run one at a time, in order. */
function laneOf(session: ThinkSessionId): string {
  return `think:${session}`;
}

/** A queued operation: accepted, never started. */
function isQueued(record: TaskRecord): boolean {
  return record.status === "pending" && record.attempt === 0;
}

const TERMINAL: readonly TaskStatus[] = [
  "completed",
  "error",
  "aborted",
  "skipped"
];

/**
 * Whether an error ends the attempt rather than the operation: the run was
 * cancelled or superseded, it sleeps, or the platform failed under it.
 */
function endsAttempt(error: unknown, run: TaskStep): boolean {
  return (
    run.signal.aborted ||
    isTaskSuspension(error) ||
    isTaskCancellation(error) ||
    error instanceof AttemptSupersededError ||
    isPlatformFailure(error)
  );
}

function turnOf(
  session: ThinkSessionId,
  operationId: string,
  stored: OperationRunInput,
  state: TurnState
): Turn {
  return { ...state, session, operationId, ...stored };
}

function stateOf(turn: Turn): TurnState {
  const {
    session: _session,
    operationId: _operationId,
    input: _input,
    source: _source,
    ...state
  } = turn;
  return state;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isToolAnswer(input: ThinkInput): input is ToolAnswer {
  return (
    typeof input === "object" &&
    !Array.isArray(input) &&
    "type" in input &&
    (input.type === "approval" || input.type === "tool-result")
  );
}

function isUIMessage(input: ThinkInput): input is UIMessage {
  return (
    typeof input === "object" &&
    !Array.isArray(input) &&
    "role" in input &&
    "parts" in input
  );
}

/**
 * The participant whose client runs a message's client tools, from the
 * message metadata the turn that wrote it started with.
 */
function ownerOf(metadata: unknown): string | undefined {
  return isRecord(metadata) && typeof metadata.owner === "string"
    ? metadata.owner
    : undefined;
}

function harnessInputMessage(input: HarnessInput, id: string): UIMessage {
  return {
    id: input.messageId ?? id,
    role: "user",
    parts: input.parts.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "file",
            mediaType: part.mediaType,
            url: part.url,
            ...(part.filename !== undefined && { filename: part.filename })
          }
    )
  };
}

/** The stored form of an input. */
function operationInput(
  input: ThinkInput,
  operationId: string,
  autoContinue: boolean
): OperationInput {
  if (typeof input === "string") {
    return {
      kind: "messages",
      messages: [
        {
          id: operationId,
          role: "user",
          parts: [{ type: "text", text: input }]
        }
      ]
    };
  }
  if (Array.isArray(input)) {
    // SAFETY: the only array a ThinkInput can be is readonly UIMessage[].
    return { kind: "messages", messages: input as readonly UIMessage[] };
  }
  if (isToolAnswer(input)) {
    const { from, ...answer } = input;
    return {
      kind: "answer",
      answer,
      autoContinue,
      ...(from && { from: from.participantId })
    };
  }
  if (isUIMessage(input)) return { kind: "messages", messages: [input] };
  // SAFETY: the remaining ThinkInput is the shared HarnessInput.
  const harnessInput = input as HarnessInput & HarnessInputFrom;
  return {
    kind: "messages",
    messages: [harnessInputMessage(harnessInput, operationId)],
    ...(harnessInput.from && { owner: harnessInput.from.participantId })
  };
}

function toolCallAnswer(answer: ToolAnswer): ToolCallAnswer {
  return answer.type === "approval"
    ? {
        type: "approval-response",
        approvalId: answer.approvalId,
        approved: answer.approved,
        ...(answer.reason !== undefined && { reason: answer.reason })
      }
    : {
        type: "tool-result",
        toolCallId: answer.toolCallId,
        result: answer.result
      };
}

/** Replace one tool call part of a message. */
function withToolPart(
  message: UIMessage,
  toolCallId: string,
  update: (part: ToolCallPart) => ToolCallPart
): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      isToolCallPart(part) && part.toolCallId === toolCallId
        ? update(part)
        : part
    )
  };
}

function withOutcome(part: ToolCallPart, outcome: ToolOutcome): ToolCallPart {
  // SAFETY: the new state is set with exactly the fields it requires.
  return (
    outcome.ok
      ? {
          ...part,
          state: "output-available",
          output: outcome.output,
          preliminary: undefined
        }
      : { ...part, state: "output-error", errorText: outcome.errorText }
  ) as ToolCallPart;
}

function asUIMessages(messages: readonly SessionMessage[]): UIMessage[] {
  // SAFETY: every message in a ThinkHarness session was written by the
  // harness from a UIMessage, and Sessions returns what was written.
  return messages as unknown as UIMessage[];
}

function asUIMessage(message: SessionMessage): UIMessage {
  // SAFETY: as for asUIMessages, one message at a time.
  return message as unknown as UIMessage;
}

function asSessionMessage(message: UIMessage): SessionMessage {
  // SAFETY: SessionMessage is the structural subset of UIMessage that
  // Sessions reads; a UIMessage is accepted as is.
  return message as unknown as SessionMessage;
}

/**
 * Think's agent loop hosted in a Durable Object, behind the same small
 * harness interface as `PiHarness`: `harness.prompt()`, `harness.sessions`,
 * `harness.session(id)`. It implements the shared `AgentHarness`
 * interface, so a Channels host can serve its sessions.
 *
 * Transcripts live in a Sessions capability and in-flight model output in
 * a Streams capability. Operations are runs on a Tasks capability the
 * harness composes, one lane per session, so a session's operations run
 * one at a time in the order they were submitted. The harness runs every
 * server tool call itself, as a step of its operation's run, so after an
 * eviction it knows exactly which call was cut short and applies that
 * tool's recovery policy. Each step of a turn reads only durable state, so
 * the run's next attempt continues where the last write left off.
 *
 * @experimental The API may change between releases.
 */
export class ThinkHarness<TOOLS extends ToolSet = ToolSet>
  extends LifecycleCapability
  implements AgentHarness
{
  /** Every session in this object. */
  readonly sessions: ThinkSessions;
  readonly #options: ThinkHarnessOptions<TOOLS>;
  readonly #events = new SessionEvents();
  /**
   * Per session, how history was rewritten since its last model call, for
   * that call's `prefix-changed` event. The next call removes the entry;
   * each holds at most three operations.
   */
  readonly #rewrites = new Map<
    ThinkSessionId,
    Set<"compaction" | "edit" | "delete">
  >();
  readonly #live = new Map<ThinkSessionId, LiveRun>();
  readonly #configured = new Set<ThinkSessionId>();
  /** Each session's context, from the `context` option, built on first use. */
  readonly #contexts = new Map<ThinkSessionId, Context | undefined>();
  /**
   * The latest text of each extension remind section, per context, which
   * its block reads. Keyed by the context object, so a context made anew
   * (after a reset) gets its blocks again, and the entry goes with it.
   */
  readonly #remindTexts = new WeakMap<Context, Map<string, string>>();
  /**
   * What builds each session's tools and prompt, and receives the hooks:
   * the session context's tools, then the options.
   */
  readonly #extensions = new ExtensionManager(harnessHookRules);
  /**
   * The operations: one run each, on the harness's own Tasks unless the
   * host gave it one (`options.tasks`).
   */
  readonly #tasks: Tasks;
  /**
   * In-flight model output, on a Streams instance the harness composes: its
   * own tables, apart from any Streams the host has.
   */
  readonly #streams: Streams;
  /**
   * The default Streams over the shared tables, bound only to move a
   * stream an earlier version left there (`#adoptStream`).
   */
  #sharedStreams: Streams | undefined;
  /**
   * The transcripts. The harness writes every message, and its operations
   * point at them, so it owns the Sessions capability too; a second one
   * writing the same tables would leave this one's caches stale. A
   * session's branches, search and compaction are on `ThinkSession`.
   */
  readonly #sessions: Sessions;
  #bound = false;
  /**
   * Messages the harness is writing, per session, by id, so the change feed
   * skips their events (the harness emits its own) without also skipping a
   * direct write that lands meanwhile.
   */
  readonly #ownMessages = new Map<ThinkSessionId, Map<string, number>>();
  /** Clears of the harness's own in progress, per session. */
  readonly #ownClears = new Map<ThinkSessionId, number>();

  /**
   * @param options - The model, tools and hooks.
   */
  constructor(options: ThinkHarnessOptions<TOOLS>) {
    super("think-harness");
    this.#options = options;
    const shipped = options.extensions ?? [];
    for (const { name, extension } of shipped.filter((e) => !e.after)) {
      this.#extensions.load(name, loadInProcess(name, extension));
    }
    this.#extensions.load(
      "context",
      loadInProcess(
        "context",
        contextExtension((session) => this.#context(session))
      )
    );
    this.#extensions.load(
      "options",
      loadInProcess("options", optionsExtension(options))
    );
    for (const { name, extension } of shipped.filter((e) => e.after)) {
      this.#extensions.load(name, loadInProcess(name, extension));
    }
    this.#sessions = new Sessions({
      ...(options.reservedMetadataKeys && {
        reservedMetadataKeys: options.reservedMetadataKeys
      })
    });
    this.sessions = new ThinkSessions(this);
    this.#tasks =
      options.tasks ?? this.compose(new Tasks({ name: this.composedName }));
    this.#streams = this.compose(
      new Streams({ name: this.composedName, maxChunkBytes: REPLAY_ITEM_BYTES })
    );
    for (const definition of DEFINITIONS) {
      this.#tasks.register(
        definition,
        // SAFETY: every run of these definitions was accepted by `enqueue`
        // or carried forward by `onStart`, both with an OperationRunInput.
        (input, run) => this.#operate(input as OperationRunInput, run),
        {
          onStatus: (record) => this.#onStatus(record),
          // The terminal report of a run that ended outside its handler (an
          // abort, the memory-limit breaker) finishes it from its progress.
          keepCheckpoint: true
        }
      );
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the transcripts and streams, and carry forward what a released
   * version kept in the harness store.
   */
  override async onStart(): Promise<void> {
    this.#bindOwned();
    await this.#sessions.onStart();
    await this.lifecycle.schema.migrate({
      version: 1,
      steps: { 1: () => this.#carryReleased() }
    });
    await this.#ensureSession(ROOT_SESSION);
  }

  /**
   * Move what a released version kept in the harness store into Tasks and
   * Sessions, then drop the store's tables. Idempotent, as a schema step
   * must be: a reset part way runs it again.
   */
  async #carryReleased(): Promise<void> {
    const released = ReleasedRecords.open(
      this.lifecycle.storage,
      this.lifecycle.routes.source !== undefined
    );
    if (!released) return;
    await this.#carryForward(released);
    for (let offset = 0; ; offset += CARRY_BATCH) {
      const sessions = released.sessions(offset, CARRY_BATCH);
      for (const session of sessions) {
        // The Sessions handle, not `#handle`: carrying a session forward is
        // not the host's first use of it, so `configureSession` waits.
        const handle = this.#sessions.session(session.id);
        await handle.internal_setConfig(
          SESSION_KEY,
          sessionValue(session.parent, session.createdAt)
        );
        if (session.clientTools.length > 0) {
          await handle.internal_setConfig(
            CLIENT_TOOLS_KEY,
            JSON.stringify(session.clientTools)
          );
        }
      }
      if (sessions.length < CARRY_BATCH) break;
    }
    released.drop();
  }

  /**
   * Make each open operation a released version left in the store a run,
   * in the order it was submitted: a queued one waits its turn, a running
   * one is interrupted and runs again from its progress. Settled ones are
   * dropped: their answers are in the transcript.
   */
  async #carryForward(store: ReleasedRecords): Promise<void> {
    // In batches, each forgotten once its runs are written, so a long
    // queue is never held in memory whole.
    for (;;) {
      const left = store.leftOperations(CARRY_BATCH);
      if (left.length === 0) break;
      for (const op of left) {
        const {
          session,
          operationId,
          input,
          source,
          status,
          abandonReason,
          startedToolCalls,
          createdAt,
          ...progress
        } = op;
        const runId = runIdOf(session, operationId);
        // A version rolled back to before this one may have reused the id of
        // a settled run: the open operation is the newer.
        const existing = this.#tasks.peek(runId);
        if (existing && TERMINAL.includes(existing.status)) {
          this.#tasks.deleteRun(runId);
        }
        const state: TurnState = {
          ...progress,
          ...(abandonReason !== null && { abandon: abandonReason }),
          ...(startedToolCalls.length > 0 && { started: startedToolCalls })
        };
        await this.#tasks.importRun({
          runId,
          definition: OPERATION_DEFINITION,
          status: status === "running" ? "running" : "pending",
          attempt: status === "running" ? 1 : 0,
          // SAFETY: as for enqueue's input.
          input: { input, source } as unknown as TaskJson,
          lane: laneOf(session),
          createdAt,
          ...(status === "running" && {
            startedAt: createdAt,
            checkpoint: { [TURN_KEY]: state }
          })
        });
      }
      store.dropOperations(left);
    }
  }

  /** Record a session, unless the harness knows it already. */
  async #ensureSession(id: ThinkSessionId, parent?: ThinkSessionId) {
    const handle = this.#handle(id);
    if ((await handle.internal_config(SESSION_KEY)) !== null) return;
    await handle.internal_setConfig(
      SESSION_KEY,
      sessionValue(parent, Date.now())
    );
  }

  // ── The harness interface ────────────────────────────────────────────────

  /**
   * A handle on one session. No I/O until you call it.
   *
   * @param id - The session. Default: the root session.
   */
  session(id: ThinkSessionId = ROOT_SESSION): ThinkSession {
    return new ThinkSession(this, id);
  }

  /** Submit to the root session and wait for the answer. */
  prompt(
    input: ThinkInput,
    options: ThinkSubmitOptions = {}
  ): Promise<ThinkPromptResponse> {
    return this.session().prompt(input, options);
  }

  /** Durably submit to the root session. Resolves before the model runs. */
  submit(
    input: ThinkInput,
    options: ThinkSubmitOptions = {}
  ): Promise<ThinkReceipt> {
    return this.session().submit(input, options);
  }

  /** Operations not settled yet, oldest first, in one session or all. */
  async pending(session?: ThinkSessionId): Promise<ThinkPendingOperation[]> {
    await this.lifecycle.ready();
    return this.#open(session).map((record) => {
      const [id, operationId] = operationOf(record.runId);
      return {
        operationId,
        session: id,
        status: isQueued(record) ? "queued" : "running"
      };
    });
  }

  // ── Used by ThinkSession and ThinkSessions ───────────────────────────────

  /** @internal */
  async enqueue(
    session: ThinkSessionId,
    input: OperationInput,
    options: ThinkSubmitOptions
  ): Promise<ThinkReceipt> {
    // The shared harness interface lets a caller ask to steer. Refuse it
    // rather than queue it as a follow-up, which is not what was asked.
    const whenBusy: unknown = options.whenBusy;
    if (whenBusy === "steer") throw new SteerNotSupportedError(session);
    await this.lifecycle.ready();
    // A key names an operation in its own session only.
    // An empty key is no key, as on Think.
    const key = options.idempotencyKey
      ? keyOf(session, options.idempotencyKey)
      : undefined;
    const byKey =
      key === undefined ? undefined : this.#tasks.peekByIdempotencyKey(key);
    const operationId = options.operationId ?? crypto.randomUUID();
    const runId = runIdOf(session, operationId);
    const byId = this.#tasks.peek(runId);
    if (
      (byKey && byKey.runId !== runId) ||
      (key !== undefined &&
        byId?.idempotencyKey !== undefined &&
        byId.idempotencyKey !== key)
    ) {
      throw new Error(
        "operationId and idempotencyKey refer to different operations"
      );
    }
    await this.#ensureSession(session);
    if (options.clientTools !== undefined) {
      await this.#handle(session).internal_setConfig(
        CLIENT_TOOLS_KEY,
        JSON.stringify(options.clientTools)
      );
    }
    const stored: OperationRunInput = {
      input,
      source: options.source ?? "server"
    };
    const receipt = await this.#tasks.run(
      options.submission ? SUBMISSION_DEFINITION : OPERATION_DEFINITION,
      // SAFETY: an OperationRunInput is plain JSON: UI messages and tool
      // answers as clients send them.
      stored as unknown as TaskJson,
      {
        runId,
        lane: laneOf(session),
        // An existing run is found by its id; a key it was not given
        // would not match its row.
        ...(key !== undefined && !byId && { idempotencyKey: key }),
        ...(options.metadata !== undefined && { metadata: options.metadata })
      }
    );
    // Two first submissions of one key can race past the checks above;
    // Tasks dedupes them, and its receipt names the operation that won.
    return {
      operationId: operationOf(receipt.runId)[1],
      session,
      accepted: receipt.accepted
    };
  }

  /** @internal The operation an idempotency key started in a session. */
  async keyedOperation(
    session: ThinkSessionId,
    idempotencyKey: string
  ): Promise<string | undefined> {
    await this.lifecycle.ready();
    const record = this.#tasks.peekByIdempotencyKey(
      keyOf(session, idempotencyKey)
    );
    return record && operationOf(record.runId)[1];
  }

  /**
   * @internal A session's submissions (operations submitted with the
   * internal `submission` option), newest first unless asked: at most
   * `limit`, each read with its result, as `inspect` reads one.
   */
  async submissions(
    session: ThinkSessionId,
    options: {
      status?: readonly TaskStatus[];
      order?: "oldest" | "newest";
      /**
       * Only submissions after this one in `order`: a page's last, as the
       * page returned it, so it holds even after that one is deleted.
       */
      after?: { readonly operationId: string; readonly createdAt: number };
      limit: number;
    }
  ): Promise<ThinkOperationInspection[]> {
    await this.lifecycle.ready();
    const after = options.after;
    return this.#tasks
      .peekList({
        definition: SUBMISSION_DEFINITION,
        lane: laneOf(session),
        ...(options.status && { status: options.status }),
        order: options.order ?? "newest",
        ...(after && {
          after: {
            createdAt: after.createdAt,
            runId: runIdOf(session, after.operationId)
          }
        }),
        limit: options.limit
      })
      .map((record) => this.#inspection(record));
  }

  /**
   * @internal Delete one settled submission. False when there is none by
   * that id, or it is still open.
   */
  async deleteSubmission(
    session: ThinkSessionId,
    operationId: string
  ): Promise<boolean> {
    await this.lifecycle.ready();
    const record = this.#tasks.peek(runIdOf(session, operationId));
    if (
      !record ||
      record.definition !== SUBMISSION_DEFINITION ||
      !TERMINAL.includes(record.status)
    ) {
      return false;
    }
    return this.#tasks.deleteRun(record.runId);
  }

  /** @internal Stop one operation, or everything open in a session. */
  async abort(session: ThinkSessionId, operationId?: string): Promise<boolean> {
    await this.lifecycle.ready();
    const targets =
      operationId === undefined
        ? this.#open(session)
        : [this.#tasks.peek(runIdOf(session, operationId))].filter(
            (record): record is TaskRecord =>
              record !== undefined && !TERMINAL.includes(record.status)
          );
    if (targets.length === 0) return false;
    // Held while the cancelled runs finish, so the next operation starts
    // after the partial answer of the one before it is in the transcript.
    const lane = laneOf(session);
    this.#tasks.holdLane(lane);
    try {
      for (const record of targets) {
        await this.#tasks.cancel(
          record.runId,
          isQueued(record) ? "withdrawn" : "aborted"
        );
      }
    } finally {
      await this.#tasks.releaseLane(lane);
    }
    return true;
  }

  /** @internal Wait for an operation to settle. */
  async wait(
    session: ThinkSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<ThinkOperationResult> {
    await this.lifecycle.ready();
    signal?.throwIfAborted();
    const record = await this.#tasks.wait(runIdOf(session, operationId), {
      ...(signal && { signal })
    });
    signal?.throwIfAborted();
    return record
      ? this.#result(record)
      : { operationId, session, status: "unanswered", reason: "not_found" };
  }

  /** @internal */
  async inspect(
    session: ThinkSessionId,
    operationId: string
  ): Promise<ThinkOperationStatus | undefined> {
    await this.lifecycle.ready();
    const record = this.#tasks.peek(runIdOf(session, operationId));
    return record && this.#status(record);
  }

  /**
   * @internal An operation's status with its run's times, key and
   * metadata, for the harness-backed Think's submissions.
   */
  async inspection(
    session: ThinkSessionId,
    operationId: string
  ): Promise<ThinkOperationInspection | undefined> {
    await this.lifecycle.ready();
    const record = this.#tasks.peek(runIdOf(session, operationId));
    return record && this.#inspection(record);
  }

  /** A run's status. */
  #status(record: TaskRecord): ThinkOperationStatus {
    const [session, operationId] = operationOf(record.runId);
    return TERMINAL.includes(record.status)
      ? this.#result(record)
      : {
          operationId,
          session,
          status: isQueued(record) ? "queued" : "running"
        };
  }

  /** A run's status, with its times, key and metadata. */
  #inspection(record: TaskRecord): ThinkOperationInspection {
    return {
      ...this.#status(record),
      createdAt: record.createdAt,
      ...(record.startedAt !== undefined && { startedAt: record.startedAt }),
      ...(record.settledAt !== undefined && { settledAt: record.settledAt }),
      ...(record.idempotencyKey !== undefined && {
        idempotencyKey: callerKeyOf(record.idempotencyKey)
      }),
      ...(record.metadata !== undefined && { metadata: record.metadata })
    };
  }

  /** @internal The active transcript of a session. */
  async messages(session: ThinkSessionId): Promise<UIMessage[]> {
    return asUIMessages(await this.#handle(session).getHistory());
  }

  /** @internal Which of `ids` a session already stores (key probes). */
  async storedIds(
    session: ThinkSessionId,
    ids: readonly string[]
  ): Promise<Set<string>> {
    return this.#handle(session).internal_existingIds(ids);
  }

  /**
   * @internal The approval id a tool call carries, from the newest message
   * back: a turn's approval sits near the end, so the read stops early.
   */
  async approvalId(
    session: ThinkSessionId,
    toolCallId: string
  ): Promise<string | undefined> {
    for await (const message of this.#handle(session).history({
      newestFirst: true
    })) {
      for (const part of message.parts) {
        const record = part as {
          toolCallId?: unknown;
          approval?: { id?: unknown };
        };
        if (
          record.toolCallId === toolCallId &&
          typeof record.approval?.id === "string"
        ) {
          return record.approval.id;
        }
      }
    }
    return undefined;
  }

  /** @internal Abort everything in a session and clear its transcript. */
  async reset(session: ThinkSessionId, handoff?: string): Promise<void> {
    await this.abort(session);
    const handle = this.#handle(session);
    this.#ownClears.set(session, (this.#ownClears.get(session) ?? 0) + 1);
    try {
      await handle.clearMessages();
    } finally {
      const left = (this.#ownClears.get(session) ?? 1) - 1;
      if (left === 0) this.#ownClears.delete(session);
      else this.#ownClears.set(session, left);
    }
    // The settled operations answered the transcript just cleared.
    for (;;) {
      const settled = this.#tasks.peekList({
        definition: OPERATION_DEFINITION,
        lane: laneOf(session),
        status: TERMINAL,
        results: false
      });
      for (const record of settled) this.#tasks.deleteRun(record.runId);
      if (settled.length === 0) break;
    }
    // The session's context read records of the messages just cleared.
    this.#contexts.delete(session);
    this.#events.emit(session, { type: "reset" });
    if (handoff) {
      const note: UIMessage = {
        id: crypto.randomUUID(),
        role: "system",
        parts: [{ type: "text", text: handoff }]
      };
      const release = this.#markOwn(session, [note.id]);
      try {
        await handle.appendMessage(asSessionMessage(note));
      } finally {
        release();
      }
      this.#events.emit(session, { type: "message", message: note });
    }
  }

  /** @internal */
  subscribe(session: ThinkSessionId, listener: ThinkSessionListener) {
    return this.#events.subscribe(session, listener);
  }

  /** @internal The shared harness interface's watch. */
  async watch(session: ThinkSessionId): Promise<SessionWatch> {
    await this.lifecycle.ready();
    let watcher: Watcher | undefined;
    const early: SessionEvent[][] = [];
    // Listen before reading, so nothing that happens during the read is
    // lost; a message read and then re-sent only replaces itself.
    // Client tool calls carry the participant whose client runs them.
    const { tools } = await this.#build(session);
    let owner: string | undefined;
    const unsubscribe = this.#events.subscribe(session, (event) => {
      if (event.type === "chunk" && event.chunk.type === "start") {
        owner = ownerOf(event.chunk.messageMetadata);
      }
      // A run resolves the session's tools again; its calls follow those.
      const events = toSessionEvents(
        event,
        this.#live.get(session)?.tools ?? tools,
        owner
      );
      if (watcher) watcher.push(events);
      else early.push(events);
    });
    const open = this.#open(session);
    const running = open.find((record) => !isQueued(record));
    const live = this.#live.get(session);
    const partial = live
      ? [...live.partial]
      : running
        ? this.#streamChunks(this.#state(running.runId)?.streamId)
        : [];
    // The call in progress started with its owner.
    const started = partial.find((chunk) => chunk.type === "start");
    if (started?.type === "start") owner = ownerOf(started.messageMetadata);
    const messages = await this.messages(session);
    const state: SessionState = {
      messages: messages.map((message) => transcriptOf(message, tools)),
      pending: open.map((record) => ({
        operationId: operationOf(record.runId)[1],
        status: isQueued(record) ? "queued" : "placed"
      })),
      ...(running && {
        run: {
          operations: [operationOf(running.runId)[1]],
          ...(partial.length > 0 && {
            partial: partial.flatMap((chunk) => {
              const converted = toResponseChunk(chunk, {
                tools: live?.tools ?? tools,
                owner
              });
              return converted ? [converted] : [];
            })
          })
        }
      })
    };
    watcher = new Watcher(state, unsubscribe);
    for (const events of early) watcher.push(events);
    return watcher;
  }

  /** @internal The running operation and its model call's chunks so far. */
  async inFlight(session: ThinkSessionId): Promise<ThinkInFlight | undefined> {
    await this.lifecycle.ready();
    const running = this.#open(session).find((record) => !isQueued(record));
    if (!running) return undefined;
    const operationId = operationOf(running.runId)[1];
    const live = this.#live.get(session);
    if (live?.operationId === operationId) {
      return {
        operationId,
        continuation: live.continues,
        chunks: [...live.partial]
      };
    }
    // Left by an eviction: the stream holds what was durable.
    const state = this.#state(running.runId);
    return {
      operationId,
      continuation:
        state?.messageId != null &&
        (await this.#handle(session).getMessage(state.messageId)) !== null,
      chunks: this.#streamChunks(state?.streamId)
    };
  }

  /**
   * Listen to every session's events, for a host that serves several
   * sessions over one set of connections. Returns the unsubscribe.
   */
  observe(listener: ThinkHarnessListener): () => void {
    return this.#events.observe(listener);
  }

  /** @internal */
  async createSession(parent?: ThinkSessionId): Promise<ThinkSession> {
    await this.lifecycle.ready();
    const id = crypto.randomUUID();
    await this.#ensureSession(id, parent);
    return this.session(id);
  }

  /** @internal Copy a session's active path into a new session. */
  async fork(from: ThinkSessionId): Promise<ThinkSession> {
    const source = this.#handle(from);
    const rows = await source.getHistoryRowStats();
    const fork = await this.createSession(from);
    const target = this.#handle(fork.id);
    let parentId: string | null = null;
    for (const row of rows) {
      const message = await source.getMessage(row.id);
      if (!message) continue;
      await target.appendMessage(message, { parentId });
      parentId = message.id;
    }
    // The copied turns keep the context they were sent with, so the fork's
    // next request opens with the same prompt as the session it came from.
    const records = await source.internal_annotations(
      CONTEXT_RECORD_KIND,
      rows.map((row) => row.id)
    );
    for (const [messageId, value] of records) {
      await target.internal_setAnnotation(
        CONTEXT_RECORD_KIND,
        messageId,
        value
      );
    }
    return fork;
  }

  /** @internal */
  async listSessions(): Promise<ThinkSessionInfo[]> {
    await this.lifecycle.ready();
    const busy = new Set(
      this.#open().map((record) => operationOf(record.runId)[0])
    );
    return (await this.#sessions.internal_configs(SESSION_KEY))
      .map(({ sessionId, value }) => ({
        id: sessionId,
        // SAFETY: written only by sessionValue.
        ...(JSON.parse(value) as { parent?: string; createdAt: number })
      }))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map(({ id, parent }) => ({
        id,
        ...(parent !== undefined && { parent }),
        busy: busy.has(id)
      }));
  }

  // ── Running one operation ────────────────────────────────────────────────

  /**
   * One attempt of an operation's run: place it if it is not yet, then
   * take steps until the turn ends or waits. A later attempt, after a
   * reset, picks up from the progress the last one wrote.
   */
  async #operate(
    stored: OperationRunInput,
    run: TaskStep
  ): Promise<OperationOutcome> {
    const [session, operationId] = operationOf(run.id);
    const live: LiveRun = { operationId, partial: [], continues: false };
    this.#live.set(session, live);
    const state = run.checkpoint.get<TurnState>(TURN_KEY);
    let turn = state && turnOf(session, operationId, stored, state);
    try {
      if (turn?.ended) {
        return outcomeOf(turn.ended, await this.#message(turn));
      }
      if (turn?.abandon !== undefined) {
        return this.#giveUp(run, turn, turn.abandon);
      }
      if (!turn) {
        const placed = await this.#place(run, session, operationId, stored);
        if ("status" in placed) return placed;
        turn = placed;
      }
      const continuation = (await this.#message(turn)) !== undefined;
      this.#events.emit(session, {
        type: "run-start",
        operationId,
        continuation
      });
      try {
        return await this.#steps(run, turn, live);
      } finally {
        this.#events.emit(session, { type: "run-end", operationId });
      }
    } catch (error) {
      if (endsAttempt(error, run)) throw error;
      console.error(`ThinkHarness operation ${operationId} failed`, error);
      const current = run.checkpoint.get<TurnState>(TURN_KEY);
      return this.#giveUp(
        run,
        current && turnOf(session, operationId, stored, current),
        errorText(error)
      );
    } finally {
      if (this.#live.get(session) === live) this.#live.delete(session);
    }
  }

  /**
   * End the operation from inside its run: keep the partial answer, fail
   * the tool calls it left open, and mark it ended with `reason`.
   */
  async #giveUp(
    run: TaskStep,
    turn: Turn | undefined,
    reason: string
  ): Promise<OperationOutcome> {
    const kept =
      turn &&
      (await this.#abandon(
        turn.session,
        stateOf(turn),
        this.#streamChunks(turn.streamId),
        reason,
        run,
        (change) => this.#write(run, turn, change)
      ));
    return {
      status: "unanswered",
      reason,
      ...(kept && { messageId: kept.id })
    };
  }

  async #steps(
    run: TaskStep,
    first: Turn,
    live: LiveRun
  ): Promise<OperationOutcome> {
    let turn = first;
    // One build per attempt: every model call and tool call of it sees the
    // same tools and prompt. A change to them applies from the next turn.
    const built = live.built ?? (await this.#build(first.session));
    const tools = built.tools;
    live.tools = tools;
    for (;;) {
      if (run.signal.aborted) throw run.signal.reason;
      const message = await this.#message(turn);
      // Read at every step, so a host that sets it from a turn's own
      // configuration (a `beforeTurn` before the first model call) holds.
      const maxSteps = this.#options.maxSteps ?? DEFAULT_MAX_STEPS;
      const action = nextAction(
        {
          streamId: turn.streamId ?? undefined,
          pendingModel: turn.pendingModel,
          steps: turn.steps
        },
        message,
        (name, part) => answersHere(tools, name, part),
        maxSteps
      );
      let next: Turn | OperationOutcome;
      switch (action._tag) {
        case "recover-model":
          next = await this.#recoverModel(run, turn, message);
          break;
        case "call-model":
          next = await this.#callModel(run, turn, message, tools, built, live);
          break;
        case "run-tools":
          if (!message) return outcomeOf({}, message);
          next = await this.#runTools(run, turn, message, action.calls, tools);
          break;
        case "await-input":
        case "end":
          return outcomeOf({}, message);
      }
      if ("status" in next) return next;
      turn = next;
    }
  }

  /**
   * Place an operation: write what it brings to the transcript and its
   * progress, in one transaction. Returns the placed turn, or how the
   * operation ended when placing ended it.
   */
  async #place(
    run: TaskStep,
    session: ThinkSessionId,
    operationId: string,
    stored: OperationRunInput
  ): Promise<Turn | OperationOutcome> {
    const handle = this.#handle(session);
    const { input, source } = stored;
    const placed: UIMessage[] = [];
    let turn: Turn | undefined;
    let unanswered: string | undefined;

    const progress = (change: TurnChange) => {
      turn = this.#write(
        run,
        turnOf(session, operationId, stored, {
          parentId: null,
          messageId: null,
          streamId: null,
          pendingModel: true,
          steps: 0,
          interruptions: 0,
          overflowRetries: 0
        }),
        change
      );
    };

    switch (input.kind) {
      case "messages": {
        let messages = input.messages;
        if (source === "client") {
          // Untrusted input may only add user messages. It may not rewrite
          // a stored message, even one off the active path, by reusing its
          // id: those are dropped.
          if (messages.some((message) => message.role !== "user")) {
            unanswered = "client_role";
            break;
          }
          const fresh: UIMessage[] = [];
          for (const message of messages) {
            if (!(await handle.getMessage(message.id))) fresh.push(message);
          }
          messages = fresh;
        }
        const last = messages.at(-1);
        if (!last) {
          unanswered = "empty";
          break;
        }
        await this.#commit(run, session, undefined, (put) => {
          let parentId: string | undefined;
          for (const message of messages) {
            put(message, { parentId, source });
            parentId = message.id;
            placed.push(message);
          }
          progress({ parentId: last.id, messageId: crypto.randomUUID() });
        });
        break;
      }
      case "answer": {
        const history = asUIMessages(await handle.getHistory());
        const built = await this.#build(session);
        const { tools } = built;
        // The answered message is published before the model loop runs, if
        // it runs at all: watches read its client tools from these. The
        // loop uses this build too.
        // Only this operation's own run: one cancelled while it built must
        // not hand its build to the next turn.
        const live = this.#live.get(session);
        if (live?.operationId === operationId) {
          live.tools = tools;
          live.built = built;
        }
        const answer = input.answer;
        if (answer.type === "tool-result" && source === "client") {
          // A client answers only its own tools. A server tool's result
          // comes from running it, under its approval policy.
          const call = history
            .flatMap((message) => message.parts)
            .find(
              (part): part is ToolCallPart =>
                isToolCallPart(part) && part.toolCallId === answer.toolCallId
            );
          if (call && isServerTool(tools, toolNameOf(call))) {
            unanswered = "not_client_tool";
            break;
          }
        }
        if (answer.type === "tool-result" && input.from !== undefined) {
          // Only the client of the participant who started the turn runs
          // a client tool.
          // The call this answer settles, as answerToolCall finds it: a
          // provider may reuse a tool-call id across replies.
          const owner = ownerOf(
            answeredMessage(history, toolCallAnswer(answer))?.metadata
          );
          if (owner !== undefined && owner !== input.from) {
            unanswered = "not_owner";
            break;
          }
        }
        const answered = answerToolCall(history, toolCallAnswer(answer));
        if (!answered) {
          unanswered = "not_waiting";
          break;
        }
        const latest = history.at(-1);
        const continues =
          input.autoContinue &&
          latest?.id === answered.id &&
          nextAction(
            { streamId: undefined, pendingModel: true, steps: 0 },
            answered,
            (name, part) => answersHere(tools, name, part),
            Number.POSITIVE_INFINITY
          )._tag !== "await-input";
        await this.#commit(run, session, undefined, (put) => {
          put(answered);
          placed.push(answered);
          // An answer that does not continue the turn ends the operation
          // with the answered message.
          progress(
            continues
              ? { messageId: answered.id }
              : { messageId: answered.id, pendingModel: false, ended: {} }
          );
        });
        break;
      }
      case "regenerate": {
        const history = asUIMessages(await handle.getHistory());
        const target =
          input.messageId ??
          [...history].reverse().find((message) => message.role === "user")?.id;
        if (!target || !(await handle.getMessage(target))) {
          unanswered = "not_found";
          break;
        }
        await this.#commit(run, session, undefined, () =>
          progress({ parentId: target, messageId: crypto.randomUUID() })
        );
        break;
      }
      case "continue": {
        const latest = await handle.getLatestLeaf();
        if (!latest) {
          unanswered = "not_found";
          break;
        }
        await this.#commit(run, session, undefined, () =>
          latest.role === "assistant"
            ? progress({ messageId: latest.id })
            : progress({
                parentId: latest.id,
                messageId: crypto.randomUUID()
              })
        );
        break;
      }
    }

    for (const message of placed) {
      this.#events.emit(session, { type: "message", message, operationId });
    }
    if (unanswered !== undefined || !turn) {
      return { status: "unanswered", reason: unanswered ?? "not_found" };
    }
    if (turn.ended) return outcomeOf(turn.ended, placed.at(-1));
    this.#events.emit(session, {
      type: "operation",
      status: { operationId, status: "placed" }
    });
    return turn;
  }

  // ── Model calls ──────────────────────────────────────────────────────────

  /**
   * One model call. Its chunks go to a stream as they arrive; when it ends,
   * the message is persisted and the stream discarded in one transaction.
   * Returns the turn to go on with, or how the operation ended.
   */
  async #callModel(
    run: TaskStep,
    start: Turn,
    existing: UIMessage | undefined,
    tools: ToolSet,
    prompt: Pick<ExtensionBuild, "system" | "remind" | "allSections">,
    live: LiveRun
  ): Promise<Turn | OperationOutcome> {
    const { session, operationId } = start;
    const messageId = start.messageId ?? crypto.randomUUID();
    const owner = existing
      ? ownerOf(existing.metadata)
      : start.input.kind === "messages"
        ? start.input.owner
        : undefined;
    const hooks = this.#options.hooks;
    const handle = this.#handle(session);
    const parentId = start.parentId ?? undefined;
    const history = asUIMessages(
      await handle.getHistory({ leafId: existing ? existing.id : parentId })
    );
    // Every call prepares the session's context. The call that starts a
    // turn records on its user message the prompt it is sent with and any
    // remind block that changed; every call sends the transcript as a
    // projection of those records, so earlier turns go out unchanged. A
    // change that cannot be recorded (a continuation, or a regeneration
    // from an answered message) rides on this request alone.
    const context = this.#context(session);
    let contextSystem = "";
    let recordSent: PreparedTurn["recordSent"] | undefined;
    let blockReminder: string | null = null;
    let request = history;
    let optionsSystem = prompt.system;
    if (context) {
      await this.#remindBlocks(context, prompt.remind);
      const prepared = await context.prepareTurn({
        messages: history,
        // A call after an interruption is sent as the first attempt was.
        retry: start.interruptions > 0
      });
      contextSystem = prepared.system;
      recordSent = prepared.recordSent;
      blockReminder = prepared.reminder;
      request = withReminder(
        asUIMessages(await context.project(history)),
        prepared.reminder
      );
    }
    if (!context) {
      // Without a context a remind section has nowhere to be recorded, so
      // it is system text like the others, in its place.
      optionsSystem = prompt.allSections;
    }
    const system = joinSystem(optionsSystem, contextSystem);
    const config =
      (await hooks?.beforeTurn?.({
        session,
        operationId,
        step: start.steps,
        continuation: existing !== undefined,
        messages: request,
        system,
        tools: Object.keys(tools),
        // A copy: a hook that edits it does not change what is offered.
        toolSet: { ...tools }
      })) ?? {};
    const model = config.model ?? (await resolve(this.#options.model, session));
    if (model === undefined) throw new Error("ThinkHarness has no model");
    const offered = modelTools(tools, config.activeTools);
    const effectiveSystem = config.system ?? system;
    const causes: PrefixChangeCause[] = [];
    if (context && recordSent) {
      // What this request sends, now that `beforeTurn` chose it: a change
      // in the tools from the last turn's reaches the model once, as a
      // notice after the user message. The blocks were prepared above.
      const tooled = await recordSent(
        await toolFingerprint(tools, Object.keys(offered)),
        await textHash(effectiveSystem ?? "")
      );
      if (tooled.changed) {
        request = withReminder(
          asUIMessages(await context.project(history)),
          [blockReminder, tooled.reminder].filter(Boolean).join("\n\n") || null
        );
        causes.push({ kind: "tools", ...tooled.changed });
      }
      if (tooled.system) causes.push({ kind: "system" });
    }
    const rewrites = this.#rewrites.get(session);
    if (rewrites) {
      this.#rewrites.delete(session);
      for (const operation of rewrites) {
        causes.push({ kind: "messages", operation });
      }
    }
    if (causes.length > 0) {
      this.#events.emit(session, {
        type: "prefix-changed",
        operationId,
        causes
      });
    }
    const messages: ModelMessage[] =
      config.messages ??
      (await convertToModelMessages(request, {
        tools,
        ignoreIncompleteToolCalls: true
      }));

    // A message a hook appended after the turn's parent, before the reply
    // began (an extension's `sendMessage`), comes before the reply.
    const replyParentId =
      existing || parentId === undefined
        ? parentId
        : ((await appendedAfter(handle, parentId)) ?? parentId);

    // The stream id is durable before the stream exists, so an eviction at
    // any point leaves evidence the next attempt recovers from.
    const streamId = `think:${crypto.randomUUID()}`;
    const turn = this.#write(run, start, {
      streamId,
      messageId,
      ...(replyParentId !== parentId && { parentId: replyParentId ?? null })
    });
    const writer = await this.#streams.open(streamId, {
      tag: streamTag(session, operationId),
      metadata: { session, operationId, messageId }
    });

    const stall = new AbortController();
    const signal = AbortSignal.any([run.signal, stall.signal]);
    let modelError: unknown;
    let final: UIMessage | undefined;
    let finishReason: string | undefined;
    let caught: unknown;
    live.partial = [];
    live.continues = existing !== undefined;
    let segment: UIMessageChunk[] = [];
    let segmentBytes = 0;
    // Chunks are written in segments, for fewer storage writes, but never
    // held longer than FLUSH_AFTER_MS: what a client has seen should be
    // what recovery finds after an eviction.
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      // An abort's report took the chunks from memory and closed the stream.
      if (segment.length === 0 || live.taken) return;
      // SAFETY: UI message chunks are JSON by the AI SDK's contract.
      writer.append(segment as unknown as StreamJson);
      segment = [];
      segmentBytes = 0;
    };

    try {
      const result = streamText({
        model,
        ...(effectiveSystem !== undefined && { system: effectiveSystem }),
        messages,
        tools: offered,
        ...(config.toolChoice !== undefined && {
          toolChoice: config.toolChoice
        }),
        ...(config.providerOptions !== undefined && {
          providerOptions: config.providerOptions
        }),
        ...(config.maxOutputTokens !== undefined && {
          maxOutputTokens: config.maxOutputTokens
        }),
        ...(config.temperature !== undefined && {
          temperature: config.temperature
        }),
        stopWhen: stepCountIs(1),
        abortSignal: signal,
        onError: ({ error }) => {
          modelError ??= error;
        }
      });
      const stream = toUIMessageStream({
        stream: result.stream,
        tools: offered,
        // Only a continuation passes the transcript: the AI SDK continues
        // the last message when it is the assistant's, which a new answer
        // must not do (the last message may be a compaction summary).
        originalMessages: existing ? history : [],
        generateMessageId: () => messageId,
        // The participant who started the turn runs its client tools.
        messageMetadata: ({ part }) =>
          part.type === "start" && owner !== undefined ? { owner } : undefined,
        onEnd: ({ responseMessage }) => {
          final = responseMessage;
        }
      });
      const stallTimeoutMs =
        this.#options.recovery?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      for await (const chunk of untilAborted(
        iterateWithStallWatchdog(stream, stallTimeoutMs, () =>
          stall.abort(new ChatStreamStalledError("Model stream stalled"))
        ),
        run.signal
      )) {
        if (chunk.type === "finish") finishReason = chunk.finishReason;
        live.partial.push(chunk);
        segment.push(chunk);
        segmentBytes += JSON.stringify(chunk).length;
        if (
          segment.length >= SEGMENT_CHUNKS ||
          segmentBytes >= SEGMENT_MAX_BYTES
        ) {
          flush();
        } else {
          flushTimer ??= setTimeout(flush, FLUSH_AFTER_MS);
        }
        this.#events.emit(session, { type: "chunk", operationId, chunk });
        if (hooks?.onChunk) {
          try {
            hooks.onChunk({ session, operationId, chunk });
          } catch (error) {
            console.error("ThinkHarness onChunk hook failed", error);
          }
        }
      }
    } catch (error) {
      caught = error;
    }
    flush();
    // Cancelled: the run's terminal report keeps the partial answer.
    if (run.signal.aborted) throw run.signal.reason;

    const message = final ?? accumulate(messageId, existing, live.partial);
    const partial = message ? settledPartial(message) : undefined;
    const keep = partial && hasContent(partial) ? partial : undefined;
    const stalled =
      caught instanceof ChatStreamStalledError || stall.signal.aborted;
    const failure = stalled ? undefined : (modelError ?? caught);

    if (stalled || failure !== undefined) {
      if (failure !== undefined) {
        try {
          await this.#extensions.hook("onError", {
            error: failure,
            session,
            operationId
          });
        } catch (error) {
          console.error("ThinkHarness onError hook failed", error);
        }
      }
      const kind = stalled
        ? "retry"
        : ((await this.#extensions.hook("classifyError", {
            error: failure
          })) ?? "fail");
      if (
        kind === "context-overflow" &&
        turn.overflowRetries < MAX_OVERFLOW_RETRIES
      ) {
        let next = turn;
        await this.#commit(run, session, streamId, (put) => {
          if (keep) put(keep, { parentId: replyParentId });
          next = this.#write(run, turn, {
            streamId: null,
            overflowRetries: turn.overflowRetries + 1
          });
        });
        try {
          await handle.compact();
        } catch (error) {
          console.warn("ThinkHarness could not compact the session", error);
        }
        return next;
      }
      if (kind === "retry") {
        return this.#interrupted(run, turn, streamId, keep);
      }
      const reason = errorText(failure);
      await this.#commit(run, session, streamId, (put) => {
        if (keep) put(keep, { parentId: replyParentId });
        this.#write(run, turn, { streamId: null, ended: { reason } });
      });
      return {
        status: "unanswered",
        reason,
        ...(keep && { messageId: keep.id })
      };
    }

    if (!message) throw new Error("The model call produced no message");
    const toolCalls = lastStep(message).some(
      (part) => isToolCallPart(part) && !part.providerExecuted
    );
    let next = turn;
    await this.#commit(run, session, streamId, (put) => {
      put(message, { parentId: replyParentId });
      next = this.#write(run, turn, {
        streamId: null,
        steps: turn.steps + 1,
        interruptions: 0,
        pendingModel: toolCalls
      });
    });
    live.partial = [];
    live.continues = true;
    this.#events.emit(session, { type: "message", message, operationId });
    await this.#extensions.hook("onStepFinish", {
      session,
      operationId,
      step: turn.steps,
      message,
      finishReason
    });
    return next;
  }

  /**
   * A model call an eviction cut short: keep what it produced, then call
   * the model again to continue the same message, within the budget.
   */
  async #recoverModel(
    run: TaskStep,
    turn: Turn,
    existing: UIMessage | undefined
  ): Promise<Turn | OperationOutcome> {
    const streamId = turn.streamId;
    if (streamId === null) return turn;
    const chunks = this.#streamChunks(streamId);
    const rebuilt =
      chunks.length > 0
        ? accumulate(turn.messageId ?? crypto.randomUUID(), existing, chunks)
        : undefined;
    const partial = rebuilt ? settledPartial(rebuilt) : undefined;
    const keep = partial && hasContent(partial) ? partial : undefined;
    return this.#interrupted(run, turn, streamId, keep);
  }

  /**
   * Count an interruption, keep the partial, and decide whether to go on.
   * A second interruption in a row waits out a backoff first, as a sleep
   * of the run, which keeps the session's lane.
   */
  async #interrupted(
    run: TaskStep,
    turn: Turn,
    streamId: string,
    partial: UIMessage | undefined
  ): Promise<Turn | OperationOutcome> {
    const { session, operationId } = turn;
    const recovery = this.#options.recovery;
    const attempt = turn.interruptions + 1;
    const maxAttempts = recovery?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let decision: "continue" | "abandon" =
      attempt > maxAttempts ? "abandon" : "continue";
    if (decision === "continue") {
      decision =
        (await this.#extensions.hook("onRecovery", {
          session,
          operationId,
          attempt,
          partial
        })) ?? "continue";
    }
    let next = turn;
    await this.#commit(run, session, streamId, (put) => {
      if (partial) put(partial, { parentId: turn.parentId ?? undefined });
      next = this.#write(run, turn, {
        streamId: null,
        interruptions: attempt,
        ...(decision === "abandon" && { ended: { reason: "interrupted" } })
      });
    });
    if (partial) {
      this.#events.emit(session, {
        type: "message",
        message: partial,
        operationId
      });
    }
    if (decision === "abandon") {
      return {
        status: "unanswered",
        reason: "interrupted",
        ...(next.messageId !== null && { messageId: next.messageId })
      };
    }
    if (attempt > 1) {
      await run.sleep(
        `backoff:${turn.steps}:${attempt}`,
        backoffDelay(attempt - 1, {
          baseMs: recovery?.backoffMs ?? DEFAULT_BACKOFF_MS,
          maxMs: MAX_BACKOFF_MS
        })
      );
    }
    return next;
  }

  // ── Tool calls ───────────────────────────────────────────────────────────

  /**
   * Run a model step's server tool calls, each as a step of the run: the
   * step runs the tool and writes its result to the transcript, so a call
   * whose step was started before and has no result was cut short.
   */
  async #runTools(
    run: TaskStep,
    start: Turn,
    message: UIMessage,
    calls: readonly ToolCallPart[],
    tools: ToolSet
  ): Promise<Turn> {
    const { session, operationId } = start;
    const history = asUIMessages(
      await this.#handle(session).getHistory({ leafId: message.id })
    );
    const modelMessages = await convertToModelMessages(history.slice(0, -1), {
      tools,
      ignoreIncompleteToolCalls: true
    });
    // The run owns this message while it runs tools; every completion
    // updates this copy and persists it whole.
    let current = message;
    let turn = start;

    const toRun: ToolCallPart[] = [];
    const approvals: string[] = [];
    for (const call of calls) {
      const toolName = toolNameOf(call);
      const tool = Object.hasOwn(tools, toolName) ? tools[toolName] : undefined;
      if (!tool) {
        toRun.push(call);
        continue;
      }
      if (call.state === "input-available") {
        const needsApproval =
          (await this.#options.toolApproval?.({
            session,
            toolName,
            toolCallId: call.toolCallId,
            input: call.input
          })) ||
          (await toolNeedsApproval(tool, call.input, {
            toolCallId: call.toolCallId,
            messages: modelMessages
          }));
        if (needsApproval) {
          approvals.push(call.toolCallId);
          continue;
        }
      }
      toRun.push(call);
    }
    if (approvals.length > 0) {
      for (const toolCallId of approvals) {
        current = withToolPart(
          current,
          toolCallId,
          (part) =>
            // SAFETY: the new state is set with exactly the fields it requires.
            ({
              ...part,
              state: "approval-requested",
              approval: { id: `approval:${toolCallId}` }
            }) as ToolCallPart
        );
      }
      const snapshot = current;
      await this.#commit(run, session, undefined, (put) => put(snapshot));
      this.#events.emit(session, {
        type: "message",
        message: snapshot,
        operationId
      });
    }

    const maxAttempts =
      this.#options.recovery?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    await Promise.all(
      toRun.map((call) => {
        const toolName = toolNameOf(call);
        const tool = Object.hasOwn(tools, toolName)
          ? tools[toolName]
          : undefined;
        const { toolCallId } = call;
        // A provider may reuse a tool-call id in a later model step.
        return run.do(
          `tool:${start.steps}:${toolCallId}`,
          TOOL_STEP,
          async ({ attempt: stepAttempt, signal }) => {
            // Starts before this one, including one an earlier version
            // recorded before the call became a step.
            const attempt =
              stepAttempt + (start.started?.includes(toolCallId) ? 1 : 0);
            // Removed since the model was offered it, or never offered.
            const unavailable: ToolOutcome = {
              ok: false,
              errorText: `Tool "${toolName}" is no longer available.`
            };
            let outcome: ToolOutcome | undefined;
            if (!tool) {
              outcome = unavailable;
            } else if (
              attempt > 1 &&
              (toolRecovery(tool) === "report" || attempt - 1 >= maxAttempts)
            ) {
              // Started before, with no result in the transcript: an
              // eviction cut it short.
              outcome = { ok: false, errorText: INTERRUPTED_TOOL_ERROR };
            }
            let input: unknown = call.input;
            if (!outcome && tool) {
              const decision = await this.#extensions.hook("beforeToolCall", {
                session,
                operationId,
                toolCallId,
                toolName,
                input,
                attempt
              });
              if (decision?.action === "block") {
                outcome = { ok: false, errorText: decision.reason };
              } else if (decision?.action === "substitute") {
                outcome = { ok: true, output: decision.output };
              } else {
                if (
                  decision?.action === "run" &&
                  decision.input !== undefined
                ) {
                  input = decision.input;
                }
                outcome = await executeTool(tool, input, {
                  toolCallId,
                  messages: modelMessages,
                  abortSignal: signal,
                  onPreliminary: (output) =>
                    this.#events.emit(session, {
                      type: "chunk",
                      operationId,
                      chunk: {
                        type: "tool-output-available",
                        toolCallId,
                        output,
                        preliminary: true
                      }
                    })
                });
              }
            }
            // Aborted while it ran: the run's report settles the call.
            if (signal.aborted) return;
            const settled = outcome ?? unavailable;
            await this.#extensions.hook("afterToolCall", {
              session,
              operationId,
              toolCallId,
              toolName,
              input,
              attempt,
              ...settled
            });
            current = withToolPart(current, toolCallId, (part) =>
              withOutcome(part, settled)
            );
            const snapshot = current;
            await this.#commit(run, session, undefined, (put) => {
              put(snapshot);
              turn = this.#write(run, turn, { interruptions: 0 });
            });
            this.#events.emit(session, {
              type: "chunk",
              operationId,
              chunk: settled.ok
                ? {
                    type: "tool-output-available",
                    toolCallId,
                    output: settled.output
                  }
                : {
                    type: "tool-output-error",
                    toolCallId,
                    errorText: settled.errorText
                  }
            });
            this.#events.emit(session, {
              type: "message",
              message: snapshot,
              operationId
            });
          }
        );
      })
    );
    return turn;
  }

  // ── Settling ─────────────────────────────────────────────────────────────

  /**
   * Finish an operation that cannot run on: keep what its interrupted
   * model call produced (`chunks`), mark any tool call it left open as
   * failed, and discard its stream. `progress` joins the write, for an
   * attempt that ends the operation itself. Returns the operation's
   * message as it is left.
   */
  async #abandon(
    session: ThinkSessionId,
    state: TurnState | undefined,
    chunks: readonly UIMessageChunk[],
    reason: string,
    run?: TaskStep,
    progress?: (change: TurnChange) => void
  ): Promise<UIMessage | undefined> {
    if (!state) return undefined;
    const stored =
      state.messageId === null
        ? null
        : await this.#handle(session).getMessage(state.messageId);
    const existing = stored ? asUIMessage(stored) : undefined;
    let message = existing;
    if (chunks.length > 0) {
      const rebuilt = accumulate(
        state.messageId ?? crypto.randomUUID(),
        existing,
        chunks
      );
      if (rebuilt) message = settledPartial(rebuilt);
    }
    if (message) {
      for (const part of lastStep(message)) {
        if (
          isToolCallPart(part) &&
          !part.providerExecuted &&
          (part.state === "input-available" ||
            part.state === "approval-responded")
        ) {
          message = withToolPart(message, part.toolCallId, (call) =>
            withOutcome(call, { ok: false, errorText: reason })
          );
        }
      }
    }
    const keep =
      message && hasContent(message) && message !== existing
        ? message
        : undefined;
    await this.#commit(run, session, state.streamId ?? undefined, (put) => {
      if (keep) put(keep, { parentId: state.parentId ?? undefined });
      progress?.({ streamId: null, ended: { reason } });
    });
    if (keep) this.#events.emit(session, { type: "message", message: keep });
    return keep ?? existing;
  }

  /**
   * An operation's run changed status. When it ended, finish it if its
   * handler did not (an abort, the memory-limit breaker), then tell
   * everyone. Tasks calls this at least once per end, and `wait()`
   * resolves after it returned.
   */
  async #onStatus(record: TaskRecord): Promise<void> {
    const [session, operationId] = operationOf(record.runId);
    if (isQueued(record)) {
      this.#events.emit(session, {
        type: "operation",
        status: { operationId, status: "queued" }
      });
      return;
    }
    if (!TERMINAL.includes(record.status)) return;
    const result = this.#result(record);
    let message: UIMessage | undefined;
    if (record.status === "completed") {
      const outcome = record.result as OperationOutcome | undefined;
      const stored = outcome?.messageId
        ? await this.#handle(session).getMessage(outcome.messageId)
        : null;
      if (stored) message = asUIMessage(stored);
    } else {
      const state = this.#state(record.runId);
      // An attempt still unwinding here has the chunks it has not written.
      const live = this.#live.get(session);
      let chunks: readonly UIMessageChunk[];
      if (live?.operationId === operationId) {
        live.taken = true;
        chunks = live.partial;
      } else {
        chunks = this.#streamChunks(state?.streamId);
      }
      message = await this.#abandon(
        session,
        state,
        chunks,
        result.status === "unanswered"
          ? (result.reason ?? "unanswered")
          : "unanswered"
      );
    }
    this.#events.emit(session, {
      type: "operation",
      status:
        result.status === "done"
          ? {
              operationId,
              status: "done",
              ...(result.text !== undefined && { text: result.text })
            }
          : {
              operationId,
              status: "unanswered",
              ...(result.reason !== undefined && { reason: result.reason })
            }
    });
    try {
      await this.#extensions.hook("onTurnEnd", {
        ...result,
        ...(message && { message })
      });
    } catch (error) {
      console.error("ThinkHarness onTurnEnd hook failed", error);
    }
  }

  /** A settled operation's result, from its run. */
  #result(record: TaskRecord): ThinkOperationResult {
    const [session, operationId] = operationOf(record.runId);
    const unanswered = (reason: string | undefined): ThinkOperationResult => ({
      operationId,
      session,
      status: "unanswered",
      ...(reason !== undefined && { reason })
    });
    switch (record.status) {
      case "completed": {
        // SAFETY: the handler's result is an OperationOutcome.
        const outcome = record.result as OperationOutcome;
        return outcome.status === "done"
          ? {
              operationId,
              session,
              status: "done",
              text: outcome.text,
              ...(outcome.messageId !== undefined && {
                messageId: outcome.messageId
              })
            }
          : unanswered(outcome.reason);
      }
      case "error":
        return unanswered(
          record.error?.name === "TaskMemoryLimitSealed"
            ? "out_of_memory"
            : record.error?.message
        );
      default:
        return unanswered(record.reason ?? "aborted");
    }
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  /**
   * Every open operation, oldest first, in one session's lane or in all.
   * Open operations are what callers submitted and have not settled, so
   * the list has no cap of its own.
   */
  #open(session?: ThinkSessionId): TaskRecord[] {
    const [operations, submissions] = DEFINITIONS.map((definition) =>
      this.#tasks.peekList({
        definition,
        ...(session !== undefined && { lane: laneOf(session) }),
        status: ["pending", "running"],
        results: false,
        order: "oldest",
        limit: Number.MAX_SAFE_INTEGER
      })
    );
    if (submissions.length === 0) return operations;
    if (operations.length === 0) return submissions;
    // Both lists are oldest first: merge them by acceptance time.
    const merged: TaskRecord[] = [];
    let i = 0;
    let j = 0;
    while (i < operations.length || j < submissions.length) {
      const next =
        j >= submissions.length ||
        (i < operations.length &&
          operations[i].createdAt <= submissions[j].createdAt)
          ? operations[i++]
          : submissions[j++];
      merged.push(next);
    }
    return merged;
  }

  /** A placed operation's progress, read from outside its attempt. */
  #state(runId: string): TurnState | undefined {
    return this.#tasks.checkpointOf<TurnState>(runId, TURN_KEY);
  }

  /**
   * Write a turn's progress to its run's checkpoint: synchronous, so it
   * joins the transaction a transcript write or stream cutover runs in.
   */
  #write(run: TaskStep, turn: Turn, change: TurnChange): Turn {
    const next = { ...turn, ...change };
    run.checkpoint.set(TURN_KEY, stateOf(next));
    return next;
  }

  /** The Sessions handle for a session, configured on first use. */
  /**
   * Give the Sessions the harness owns this capability's Lifecycle
   * services. Done on first use, not only in `onStart`, because an
   * RPC can read a transcript before startup (the read itself then waits
   * for startup).
   */
  #bindOwned(): void {
    if (this.#bound) return;
    // The harness's services, but Sessions' own schema handle: its version
    // is Sessions' (`sessions`), not the harness's carry-forward step.
    // A Proxy, not a spread: a spread calls every getter now, and `name`
    // throws on an object addressed without a name until startup has loaded
    // the stored one. Everything but `schema` is read when used.
    const services = this.lifecycle;
    const schema = capabilitySchema(services, this.#sessions.capabilityId);
    bindLifecycleCapability(
      this.#sessions,
      // An empty target: the services are frozen, and a Proxy of a frozen
      // object must return its own `schema`.
      new Proxy({} as typeof services, {
        get: (_target, key) =>
          key === "schema" ? schema : Reflect.get(services, key)
      })
    );
    this.#bound = true;
    // Writes made on a session's Sessions handle (from `configureSession`)
    // go around the harness; pass them on as events, so listeners and chat
    // clients see them too. The harness's own writes already emitted theirs.
    this.#sessions.subscribe((change) => {
      const session = change.sessionId;
      switch (change.type) {
        case "append":
        case "update":
        case "import":
          if (this.#takeOwn(session, change.message.id)) return;
          // A message changed outside a turn: what earlier requests sent.
          if (change.type === "update") this.#rewrote(session, "edit");
          this.#events.emit(session, {
            type: "message",
            message: asUIMessage(change.message)
          });
          return;
        case "clear":
          if ((this.#ownClears.get(session) ?? 0) > 0) return;
          this.#events.emit(session, { type: "reset" });
          return;
        case "compact":
        case "compaction":
          // Any compaction, the harness's own or Sessions' automatic one:
          // the prefix is gone and the summary hides the turns that wrote
          // the blocks, so the next turn rebuilds the context from them.
          // (Built here if this object has not used it yet.)
          void this.#context(session)
            ?.refreshSystemPrompt()
            .catch((error: unknown) =>
              console.warn("ThinkHarness could not refresh the context", error)
            );
          this.#rewrote(session, "compaction");
          this.#events.emit(session, { type: "transcript" });
          return;
        case "delete":
          this.#rewrote(session, "delete");
          // No one message describes these: the active path changed.
          this.#events.emit(session, { type: "transcript" });
          return;
      }
    });
  }

  #rewrote(
    session: ThinkSessionId,
    operation: "compaction" | "edit" | "delete"
  ): void {
    let rewrites = this.#rewrites.get(session);
    if (!rewrites) {
      rewrites = new Set();
      this.#rewrites.set(session, rewrites);
    }
    rewrites.add(operation);
  }

  /** Note messages the harness is about to write; returns the release. */
  #markOwn(session: ThinkSessionId, ids: readonly string[]): () => void {
    let own = this.#ownMessages.get(session);
    if (!own) {
      own = new Map();
      this.#ownMessages.set(session, own);
    }
    for (const id of ids) own.set(id, (own.get(id) ?? 0) + 1);
    return () => {
      const current = this.#ownMessages.get(session);
      if (!current) return;
      for (const id of ids) {
        const left = (current.get(id) ?? 1) - 1;
        if (left <= 0) current.delete(id);
        else current.set(id, left);
      }
      if (current.size === 0) this.#ownMessages.delete(session);
    };
  }

  /** Whether a change is one of the harness's own writes; consumes the mark. */
  #takeOwn(session: ThinkSessionId, id: string): boolean {
    const own = this.#ownMessages.get(session);
    const count = own?.get(id);
    if (!own || count === undefined) return false;
    if (count <= 1) own.delete(id);
    else own.set(id, count - 1);
    if (own.size === 0) this.#ownMessages.delete(session);
    return true;
  }

  /** @internal The answers to a message: its children in the tree. */
  async branches(
    session: ThinkSessionId,
    messageId: string
  ): Promise<UIMessage[]> {
    return asUIMessages(await this.#handle(session).getBranches(messageId));
  }

  /** @internal Full-text search over a session's messages. */
  search(
    session: ThinkSessionId,
    query: string,
    options?: { readonly limit?: number }
  ): Promise<SearchResult[]> {
    return this.#handle(session).search(
      query,
      options?.limit === undefined ? undefined : { limit: options.limit }
    );
  }

  /** @internal Compact a session with its compaction function. */
  async compact(session: ThinkSessionId): Promise<CompactResult | null> {
    // The change feed reports the compaction as a transcript event.
    return this.#handle(session).compact();
  }

  /** A session's context, from the `context` option. */
  #context(session: ThinkSessionId): Context | undefined {
    if (!this.#contexts.has(session)) {
      this.#contexts.set(
        session,
        this.#options.context?.(this.#handle(session), session)
      );
    }
    return this.#contexts.get(session);
  }

  #handle(session: ThinkSessionId): Session {
    this.#bindOwned();
    const handle = this.#sessions.session(session);
    if (!this.#configured.has(session)) {
      this.#configured.add(session);
      this.#options.configureSession?.(handle, session);
    }
    return handle;
  }

  /** A turn's assistant message, once it has one. */
  async #message(turn: Turn): Promise<UIMessage | undefined> {
    if (turn.messageId === null) return undefined;
    const message = await this.#handle(turn.session).getMessage(turn.messageId);
    return message ? asUIMessage(message) : undefined;
  }

  /**
   * The extensions' remind sections as remind blocks of the session's
   * context: added the first time a label is built, and reading the
   * latest build's text, so a change reaches the model once as a reminder.
   */
  async #remindBlocks(
    context: Context,
    sections: readonly RemindSection[]
  ): Promise<void> {
    let texts = this.#remindTexts.get(context);
    if (!texts) {
      if (sections.length === 0) return;
      texts = new Map();
      this.#remindTexts.set(context, texts);
    }
    const current = texts;
    const built = new Set(sections.map(({ label }) => label));
    // A section the build no longer has leaves the context with it.
    for (const label of [...current.keys()]) {
      if (built.has(label)) continue;
      current.delete(label);
      context.removeBlock(label);
    }
    for (const { label, text, description, maxTokens } of sections) {
      if (current.has(label)) {
        current.set(label, text);
        continue;
      }
      // A block the context already has under this label (the app's own)
      // stays as it is: the section is left out, with a warning, rather
      // than failing the turn. It is tried again on the next build.
      current.set(label, text);
      try {
        await context.addBlock({
          label,
          ...(description !== undefined && { description }),
          ...(maxTokens !== undefined && { maxTokens }),
          whenChanged: "remind",
          provider: { get: async () => current.get(label) ?? null }
        });
      } catch (error) {
        current.delete(label);
        console.warn(
          `ThinkHarness left out the extension prompt section "${label}": the session's context already has a block with that label`,
          error
        );
      }
    }
  }

  /** A session's tools, its client's included, and its options' prompt. */
  async #build(session: ThinkSessionId): Promise<SessionBuild> {
    const { tools, system, remind, allSections } =
      await this.#extensions.build(session);
    const declared =
      await this.#handle(session).internal_config(CLIENT_TOOLS_KEY);
    // A client's declaration that is not a list declares nothing.
    const parsed: unknown = declared === null ? [] : JSON.parse(declared);
    const client = createToolsFromClientSchemas(
      // SAFETY: the list a client declared, as `enqueue` stored it; before
      // this value existed the harness store read it the same way.
      Array.isArray(parsed) ? (parsed as ClientToolSchema[]) : []
    );
    // Client tools go last, as in Think. A client cannot replace a server
    // tool: the server's definition, its execute and its approval policy
    // win on a name clash.
    const merged: ToolSet = { ...tools };
    for (const [name, tool] of Object.entries(client)) {
      if (Object.hasOwn(tools, name)) {
        console.warn(
          `ThinkHarness ignored a client tool named "${name}": a server tool has that name`
        );
        continue;
      }
      merged[name] = tool;
    }
    return { tools: merged, system, remind, allSections };
  }

  /**
   * Persist messages and operation changes in one transaction; with a
   * stream id, the transaction also settles and discards that stream (the
   * cutover), so an eviction leaves either the stream or the message.
   */
  async #commit(
    run: TaskStep | undefined,
    session: ThinkSessionId,
    streamId: string | undefined,
    writes: (put: Put) => void
  ): Promise<void> {
    // A cancelled attempt may still be unwinding (a hook it awaited, a tool
    // that ignores its signal); it writes nothing more. Checked in the same
    // synchronous block as the write, so nothing lands between the two.
    if (run?.signal.aborted) throw run.signal.reason;
    const sync = this.#handle(session).__DO_NOT_USE_WILL_BREAK__sync();
    const afters: (() => Promise<void>)[] = [];
    const ids: string[] = [];
    const commit = () => {
      afters.length = 0;
      ids.length = 0;
      writes((message, options = {}) => {
        ids.push(message.id);
        afters.push(
          sync.upsert(asSessionMessage(message), {
            ...(options.parentId !== undefined && {
              parentId: options.parentId
            }),
            source: options.source ?? "server"
          }).after
        );
      });
    };
    try {
      const settled =
        streamId !== undefined &&
        this.#streams
          .__DO_NOT_USE_WILL_BREAK__sync()
          .settle(streamId, "completed", null, { commit, discard: true });
      if (!settled) this.lifecycle.storage.transactionSync(commit);
    } catch (error) {
      // The transaction rolled back, but the session's caches counted it.
      sync.abandon();
      throw error;
    }
    const release = this.#markOwn(session, ids);
    try {
      for (const after of afters) await after();
    } finally {
      release();
    }
  }

  /**
   * Move stream `streamId` out of the default Streams tables into the
   * harness's own, in one transaction: its row and its chunks as they are
   * (times included), then deleted there. Through the default instance's
   * synchronous operations only: it is never started here, so it records
   * no schema under the harness's id.
   *
   * @returns Whether there was such a stream.
   */
  #adoptStream(streamId: string): boolean {
    if (!hasTable(this.lifecycle.storage.sql, "cf_agents_streams")) {
      return false;
    }
    if (!this.#sharedStreams) {
      this.#sharedStreams = new Streams({ maxChunkBytes: REPLAY_ITEM_BYTES });
      bindLifecycleCapability(this.#sharedStreams, this.lifecycle);
    }
    const from = this.#sharedStreams.__DO_NOT_USE_WILL_BREAK__sync();
    const row = from.getStream(streamId);
    if (!row) return false;
    const to = this.#streams.__DO_NOT_USE_WILL_BREAK__sync();
    this.lifecycle.storage.transactionSync(() => {
      to.importStream({
        streamId,
        state: row.state,
        tag: row.tag,
        // SAFETY: stream metadata is JSON the harness wrote.
        metadata:
          row.metadata === null
            ? undefined
            : (JSON.parse(row.metadata) as Record<string, StreamJson>),
        chunkCount: row.chunk_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at
      });
      for (let seq = 0; ;) {
        const rows = from.readChunks(streamId, seq, READ_PAGE);
        for (const chunk of rows) {
          // SAFETY: each stored chunk is a segment the harness wrote.
          to.importChunk(
            streamId,
            JSON.parse(chunk.chunk) as StreamJson,
            chunk.created_at
          );
        }
        if (rows.length < READ_PAGE) break;
        seq = (rows.at(-1)?.seq ?? seq) + 1;
      }
      from.deleteUnchecked(streamId);
    });
    return true;
  }

  /**
   * Every chunk a run's stream holds, without waiting for more. A stream
   * the harness's own instance lacks may be in the default Streams tables,
   * where earlier versions kept it (and still do after a rollback): it is
   * moved here first.
   */
  #streamChunks(streamId: string | null | undefined): UIMessageChunk[] {
    if (streamId == null) return [];
    const streams = this.#streams.__DO_NOT_USE_WILL_BREAK__sync();
    if (!streams.getStream(streamId) && !this.#adoptStream(streamId)) {
      return [];
    }
    const chunks: UIMessageChunk[] = [];
    let from = 0;
    for (;;) {
      const rows = streams.readChunks(streamId, from, READ_PAGE);
      for (const row of rows) {
        // SAFETY: the harness writes each segment as UIMessageChunk[].
        const segment = JSON.parse(row.chunk) as UIMessageChunk[];
        chunks.push(...segment);
      }
      if (rows.length < READ_PAGE) return chunks;
      from = (rows.at(-1)?.seq ?? from) + 1;
    }
  }
}

/**
 * Rebuild a message from the chunks of a model call, applied on top of the
 * message as it was before the call.
 */
function accumulate(
  messageId: string,
  existing: UIMessage | undefined,
  chunks: readonly UIMessageChunk[]
): UIMessage | undefined {
  if (chunks.length === 0) return existing;
  const accumulator = new StreamAccumulator({
    messageId: existing?.id ?? messageId,
    continuation: existing !== undefined,
    ...(existing && {
      existingParts: existing.parts,
      ...(isRecord(existing.metadata) && {
        existingMetadata: existing.metadata
      })
    })
  });
  for (const chunk of chunks) {
    // SAFETY: StreamChunkData is the loose JSON view of a UI message chunk.
    accumulator.applyChunk(chunk as unknown as StreamChunkData);
  }
  const message = accumulator.toMessage();
  return { ...message, role: "assistant" };
}

/**
 * Stop iterating as soon as `signal` aborts, even if the source never
 * notices: a model stream that ignores its abort signal must not hold an
 * aborted turn open.
 */
async function* untilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  const aborted = new Promise<"aborted">((resolveAbort) => {
    onAbort = () => resolveAbort("aborted");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next === "aborted") {
        // Release the source without waiting on it.
        void iterator.return?.().catch(() => {});
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Classify the context-window overflow errors of common providers
 * (Anthropic, OpenAI, Google, Bedrock, Mistral and others) as
 * `"context-overflow"`, and everything else as `"fail"`. Pass it as
 * `hooks.classifyError`, or call it from your own classifier.
 *
 * @param error - The model call's error.
 * @returns `"context-overflow"` or `"fail"`.
 * @experimental
 */
export function classifyContextOverflow(error: unknown): ThinkErrorClass {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === "string") text = error;
  else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return CONTEXT_OVERFLOW_PATTERN.test(text) ? "context-overflow" : "fail";
}

const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the maximum number of tokens|input token count|reduce the length of|input is too long|too many (?:input )?tokens|context window/i;

/** A tool's own recovery field, or the default. */
/**
 * Whether the harness answers this call: a server tool's, or a call still
 * waiting to run whose tool this build does not have (removed while the
 * call was cut off), which is answered as no longer available. An approved
 * call to a tool the build does not have waits, as in Think: it may be a
 * client's tool the client did not declare again with the answer.
 */
function answersHere(
  tools: ToolSet,
  name: string,
  part: ToolCallPart
): boolean {
  return (
    isServerTool(tools, name) ||
    (!Object.hasOwn(tools, name) && part.state === "input-available")
  );
}

/**
 * The latest message, when only user messages follow `parentId` up to it:
 * what a hook appended after the turn's parent. Otherwise nothing.
 */
async function appendedAfter(
  handle: Session,
  parentId: string
): Promise<string | undefined> {
  const leaf = await handle.getLatestLeaf();
  if (!leaf || leaf.id === parentId) return undefined;
  const path = await handle.getHistory({ leafId: leaf.id });
  const at = path.findIndex((message) => message.id === parentId);
  if (at === -1) return undefined;
  const after = path.slice(at + 1);
  return after.length > 0 && after.every((message) => message.role === "user")
    ? leaf.id
    : undefined;
}

/** Each tool's hash, made once per tool object. */
const toolHashes = new WeakMap<object, Promise<string>>();

/**
 * The tools `names` names in `tools`, the ones a request sends, each with
 * a hash of its definition as the model sees it (description, input
 * schema, input examples, provider fields).
 */
function toolFingerprint(
  tools: ToolSet,
  names: readonly string[]
): Promise<readonly { readonly name: string; readonly hash: string }[]> {
  return Promise.all(
    names.map(async (name) => ({ name, hash: await toolHash(tools[name]) }))
  );
}

/** The first 8 bytes of a text's SHA-256, as hex. */
async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toolHash(tool: ToolSet[string] | undefined): Promise<string> {
  if (!tool) return Promise.resolve("");
  let made = toolHashes.get(tool);
  if (!made) {
    made = (async () => {
      const definition = JSON.stringify({
        type: tool.type,
        description:
          typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        id: "id" in tool ? tool.id : undefined,
        args: "args" in tool ? tool.args : undefined,
        providerOptions: tool.providerOptions,
        strict: "strict" in tool ? tool.strict : undefined,
        inputExamples: "inputExamples" in tool ? tool.inputExamples : undefined
      });
      return textHash(definition);
    })();
    toolHashes.set(tool, made);
  }
  return made;
}

function toolRecovery(tool: object): ToolRecovery {
  return "recovery" in tool && tool.recovery === "rerun" ? "rerun" : "report";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function streamTag(session: ThinkSessionId, operationId: string): string {
  return `think:${JSON.stringify([session, operationId])}`;
}

/** A session's `SESSION_KEY` value. */
function sessionValue(
  parent: ThinkSessionId | undefined,
  createdAt: number
): string {
  return JSON.stringify({ ...(parent !== undefined && { parent }), createdAt });
}

/** How a turn ended, from its `ended` mark and its message. */
function outcomeOf(
  ended: { readonly reason?: string },
  message: UIMessage | undefined
): OperationOutcome {
  const messageId = message && { messageId: message.id };
  return ended.reason === undefined
    ? { status: "done", text: textOf(message), ...messageId }
    : { status: "unanswered", reason: ended.reason, ...messageId };
}

/** A message as the shared harness interface carries it. */
function transcriptOf(message: UIMessage, tools: ToolSet) {
  return toTranscriptMessage(message, {
    tools,
    owner: ownerOf(message.metadata)
  });
}

/**
 * Project a session event onto the shared harness interface's events.
 * `owner` is the participant who started the run the event belongs to.
 */
function toSessionEvents(
  event: ThinkSessionEvent,
  tools: ToolSet,
  owner: string | undefined
): SessionEvent[] {
  switch (event.type) {
    case "operation":
      return [{ type: "operation", status: event.status }];
    case "run-start":
      return [{ type: "run-start", operations: [event.operationId] }];
    case "run-end":
      return [{ type: "run-end", operations: [event.operationId] }];
    case "chunk": {
      const chunk = toResponseChunk(event.chunk, { tools, owner });
      return chunk ? [{ type: "chunk", chunk }] : [];
    }
    case "message":
      return [{ type: "message", message: transcriptOf(event.message, tools) }];
    case "reset":
      return [{ type: "reset" }];
    case "transcript":
      // The shared interface has no "re-read" event; a watch sees the
      // change in its next state.
      return [];
    case "prefix-changed":
      // Observability, not part of the conversation.
      return [];
  }
}

/**
 * One session, addressed through the harness.
 *
 * @experimental
 */
export class ThinkSession implements HarnessSession {
  readonly #harness: ThinkHarness;
  /** The session's id. */
  readonly id: ThinkSessionId;

  /**
   * @param harness - The harness that owns the session.
   * @param id - The session's id.
   */
  constructor(harness: ThinkHarness, id: ThinkSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  /** Durably submit input. Resolves before the model runs. */
  async submit(
    input: ThinkInput,
    options: ThinkSubmitOptions = {}
  ): Promise<ThinkReceipt> {
    // A repeated key with no id names the operation the key started.
    const operationId =
      options.operationId ??
      (options.idempotencyKey
        ? await this.#harness.keyedOperation(this.id, options.idempotencyKey)
        : undefined) ??
      crypto.randomUUID();
    return this.#harness.enqueue(
      this.id,
      operationInput(input, operationId, options.autoContinue ?? true),
      { ...options, operationId }
    );
  }

  /** Submit and wait for the answer and the updated transcript. */
  async prompt(
    input: ThinkInput,
    options: ThinkSubmitOptions = {}
  ): Promise<ThinkPromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /**
   * Answer a user message again. The new answer is a branch beside the
   * earlier ones, which `Session.getBranches()` still reads.
   *
   * @param messageId - The user message. Default: the latest one.
   */
  regenerate(
    messageId?: string,
    options: Pick<ThinkSubmitOptions, "operationId"> = {}
  ): Promise<ThinkReceipt> {
    return this.#harness.enqueue(
      this.id,
      { kind: "regenerate", ...(messageId !== undefined && { messageId }) },
      options
    );
  }

  /** Call the model again to continue the latest message. */
  continue(
    options: Pick<ThinkSubmitOptions, "operationId"> = {}
  ): Promise<ThinkReceipt> {
    return this.#harness.enqueue(this.id, { kind: "continue" }, options);
  }

  /** Wait for an operation to settle. Aborting `signal` stops only the wait. */
  wait(
    operationId: string,
    signal?: AbortSignal
  ): Promise<ThinkOperationResult> {
    return this.#harness.wait(this.id, operationId, signal);
  }

  /**
   * Withdraw one queued operation or abort it while it runs; with no id,
   * everything open in the session.
   */
  abort(operationId?: string): Promise<boolean> {
    return this.#harness.abort(this.id, operationId);
  }

  /** Abort everything and clear the transcript, optionally leaving a note. */
  reset(handoff?: string): Promise<void> {
    return this.#harness.reset(this.id, handoff);
  }

  /** The active transcript. */
  messages(): Promise<UIMessage[]> {
    return this.#harness.messages(this.id);
  }

  /** Operations not settled yet, oldest first. */
  pending(): Promise<ThinkPendingOperation[]> {
    return this.#harness.pending(this.id);
  }

  /**
   * The running operation, with the chunks its model call has streamed so
   * far, including those an eviction left behind. Send them, then
   * `subscribe()`'s chunk events, to a client that joins mid-turn.
   */
  inFlight(): Promise<ThinkInFlight | undefined> {
    return this.#harness.inFlight(this.id);
  }

  /**
   * The answers to a message: its children in the transcript tree. A
   * regenerated answer is a branch beside the earlier ones.
   *
   * @param messageId - The message, usually a user message.
   */
  branches(messageId: string): Promise<UIMessage[]> {
    return this.#harness.branches(this.id, messageId);
  }

  /** Full-text search over this session's messages. */
  search(
    query: string,
    options?: { readonly limit?: number }
  ): Promise<SearchResult[]> {
    return this.#harness.search(this.id, query, options);
  }

  /**
   * Summarize older messages with the compaction function set in
   * `configureSession`. Resolves to null when there was nothing to compact.
   */
  compact(): Promise<CompactResult | null> {
    return this.#harness.compact(this.id);
  }

  /** Listen to the session's events in the AI SDK's vocabulary. */
  subscribe(listener: ThinkSessionListener): () => void {
    return this.#harness.subscribe(this.id, listener);
  }

  /** The shared harness interface's watch: the state, then every change. */
  watch(): Promise<SessionWatch> {
    return this.#harness.watch(this.id);
  }

  /**
   * Submit input and stream its answer to `callback`, as Think's `chat()`
   * does: `onStart`, then `onEvent` with each UI chunk as JSON, then
   * `onDone` or `onError`. Works over RPC with an `RpcTarget` callback.
   *
   * The callback lives in memory. If the object is evicted mid-turn the
   * turn still finishes, but the callback is gone; a caller that must not
   * lose the answer should `wait()` on the receipt as well.
   */
  async chat(
    input: ThinkInput,
    callback: ThinkStreamCallback,
    options: ThinkSubmitOptions = {}
  ): Promise<ThinkOperationResult> {
    // The operation the chunks belong to: the receipt's, once known, which
    // a repeated idempotency key makes an earlier one.
    let operationId =
      options.operationId ??
      (options.idempotencyKey
        ? await this.#harness.keyedOperation(this.id, options.idempotencyKey)
        : undefined) ??
      crypto.randomUUID();
    let delivered = Promise.resolve();
    const deliver = (fn: () => void | Promise<void>) => {
      delivered = delivered.then(fn).catch((error: unknown) => {
        console.error("ThinkHarness chat callback failed", error);
      });
    };
    const unsubscribe = this.subscribe((event) => {
      if (event.type === "chunk" && event.operationId === operationId) {
        deliver(() => callback.onEvent(JSON.stringify(event.chunk)));
      }
    });
    try {
      const receipt = await this.submit(input, { ...options, operationId });
      operationId = receipt.operationId;
      deliver(() => callback.onStart?.({ operationId: receipt.operationId }));
      const result = await this.wait(receipt.operationId);
      unsubscribe();
      await delivered;
      if (result.status === "done") await callback.onDone();
      else await callback.onError(result.reason ?? "unanswered");
      return result;
    } finally {
      unsubscribe();
    }
  }

  /** One operation's status, or undefined when the id is unknown. */
  inspect(operationId: string): Promise<ThinkOperationStatus | undefined> {
    return this.#harness.inspect(this.id, operationId);
  }

  /** Whether the session has open work. */
  async busy(): Promise<boolean> {
    return (await this.pending()).length > 0;
  }
}

/**
 * Every session in this object.
 *
 * @experimental
 */
export class ThinkSessions implements HarnessSessions {
  readonly #harness: ThinkHarness;

  /** @param harness - The harness that owns the sessions. */
  constructor(harness: ThinkHarness) {
    this.#harness = harness;
  }

  /** A handle on one session. */
  get(id: ThinkSessionId): ThinkSession {
    return this.#harness.session(id);
  }

  /** A new, empty session. */
  create(): Promise<ThinkSession> {
    return this.#harness.createSession();
  }

  /** A new session that starts with `from`'s active transcript. */
  fork(from: ThinkSessionId): Promise<ThinkSession> {
    return this.#harness.fork(from);
  }

  /** Every session, with whether it has open work. */
  list(): Promise<ThinkSessionInfo[]> {
    return this.#harness.listSessions();
  }
}

/** The `system` option and the context prompt, either of which may be empty. */
function joinSystem(
  system: string | undefined,
  context: string
): string | undefined {
  if (!context) return system;
  return system ? `${system}\n\n${context}` : context;
}

/**
 * Carry a reminder that was not recorded on this request only: after the
 * last user message's own content, or as a user message of its own after
 * an assistant message.
 */
function withReminder(
  messages: UIMessage[],
  reminder: string | null
): UIMessage[] {
  if (!reminder) return messages;
  const part = { type: "text" as const, text: reminder };
  const last = messages.at(-1);
  if (last?.role === "user") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts, part] }
    ];
  }
  return [
    ...messages,
    { id: "cf_agents_context_reminder", role: "user", parts: [part] }
  ];
}
