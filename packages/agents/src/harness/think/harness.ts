import {
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
import { Sessions } from "../../sessions/sessions";
import { Streams } from "../../streams/streams";
import type { MemoryLimitContext } from "../../lifecycle/capability-runner";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../../lifecycle/job-queue";
import { createToolsFromClientSchemas } from "../../chat/client-tools";
import type { StreamChunkData } from "../../chat/message-builder";
import {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "../../chat/stall-watchdog";
import { StreamAccumulator } from "../../chat/stream-accumulator";
import type {
  AgentHarness,
  HarnessInput,
  HarnessSession,
  HarnessSessions,
  SessionEvent,
  SessionState,
  SessionWatch,
  ToolAnswer
} from "../../experimental/channels/harness";
import type { CompactResult } from "../../sessions/compaction-helpers";
import type { Session } from "../../sessions/handle";
import type { SearchResult, SessionMessage } from "../../sessions/types";
import type { StreamJson } from "../../streams/types";
import {
  toResponseChunk,
  toTranscriptMessage
} from "../../experimental/channels/projections/ai-sdk";
import { answerToolCall, type ToolCallAnswer } from "./answers";
import {
  SessionEvents,
  Watcher,
  type ThinkHarnessListener,
  type ThinkSessionEvent,
  type ThinkSessionListener
} from "./events";
import {
  OperationRecords,
  type OperationInput,
  type OperationRecord
} from "./records";
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
  PerSession,
  ThinkErrorClass,
  ThinkHarnessOptions,
  ThinkInFlight,
  ThinkInput,
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

const WAKE_FN = "wake";
const HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;
const MAX_OVERFLOW_RETRIES = 1;
/** Ceiling for one stored segment, under the 2 MB SQLite row limit. */
const STREAM_MAX_CHUNK_BYTES = 1_900_000;
/** Chunks packed into one stored stream segment. */
const SEGMENT_CHUNKS = 10;
/** Raw bytes packed into one stored segment before it is written. */
const SEGMENT_MAX_BYTES = 256_000;
/** Longest a streamed chunk waits in memory before it is written. */
const FLUSH_AFTER_MS = 100;
/** Segments read at a time when rebuilding an interrupted model call. */
const READ_PAGE = 50;

const INTERRUPTED_TOOL_ERROR =
  "The tool call was interrupted before it finished, because the agent restarted. It may or may not have taken effect.";

type WakeTiming = {
  /** Heartbeat of a session's wake job while it runs. Default 30_000. */
  readonly heartbeatMs?: number;
};

let setWakeTiming: (harness: ThinkHarness, timing: WakeTiming) => void;

/**
 * @internal Shorten a harness's heartbeat, so a test suite does not sit on
 * the real one. Not exported from `agents/harness/think`.
 */
export function setWakeTimingForTests(
  harness: ThinkHarness,
  timing: WakeTiming
): void {
  setWakeTiming(harness, timing);
}

/** The operation a session is running in this isolate. */
type LiveRun = {
  readonly operationId: string;
  readonly abort: AbortController;
  /** Chunks of the model call in progress. */
  partial: UIMessageChunk[];
  /** Whether that call continues a message already persisted. */
  continues: boolean;
};

/** What an operation's run asks of the drive when it stops early. */
type RunOutcome = { readonly retryAt?: number };

/** A durable write: put messages and update operations, in one transaction. */
type Put = (
  message: UIMessage,
  options?: {
    readonly parentId?: string;
    readonly source?: "client" | "server";
  }
) => void;

function wakeJobId(session: ThinkSessionId): string {
  return `think-wake:${session}`;
}

function sessionOfJob(payload: unknown): ThinkSessionId | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    "session" in payload &&
    typeof payload.session === "string"
    ? payload.session
    : undefined;
}

async function resolve<T>(
  value: PerSession<T> | undefined,
  session: ThinkSessionId
): Promise<T | undefined> {
  if (typeof value === "function") {
    // SAFETY: PerSession<T> is T or a function of the session context, and
    // no T the harness takes (a model, a system prompt, a tool set) is a
    // function, so a function here is the per-session form.
    const compute = value as (context: {
      session: ThinkSessionId;
    }) => T | Promise<T>;
    return compute({ session });
  }
  return value;
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
    return { kind: "answer", answer: input, autoContinue };
  }
  if (isUIMessage(input)) return { kind: "messages", messages: [input] };
  // SAFETY: the remaining ThinkInput is the shared HarnessInput.
  const harnessInput = input as HarnessInput;
  return {
    kind: "messages",
    messages: [harnessInputMessage(harnessInput, operationId)]
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
 * a Streams capability, both owned by the harness, and the harness's queue
 * of operations in its own table. The harness runs every server tool call itself, so after an
 * eviction it knows exactly which call was cut short and applies that
 * tool's recovery policy.
 *
 * Durability is the Lifecycle's job queue, used directly: one wake job per
 * session. A submission is written, then the session's wake is scheduled.
 * While a session has work, the wake job reschedules itself as a heartbeat,
 * so an eviction leaves it due and its alarm restarts the object. Each step
 * of a turn reads only durable state, so the restarted object continues
 * where the last write left off.
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
  readonly #drives = new Map<ThinkSessionId, Promise<void>>();
  readonly #live = new Map<ThinkSessionId, LiveRun>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #configured = new Set<ThinkSessionId>();
  /**
   * In-flight model output. Only the harness reads it, so the harness owns
   * it rather than asking the host to install a Streams capability. It
   * shares the `cf_agents_streams` tables with any Streams the host has.
   */
  readonly #streams = new Streams({ maxChunkBytes: STREAM_MAX_CHUNK_BYTES });
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
  #heartbeatMs = HEARTBEAT_MS;
  #records: OperationRecords | undefined;

  static {
    setWakeTiming = (harness, timing) => harness.#setWakeTiming(timing);
  }

  /**
   * @param options - The model, tools and hooks.
   */
  constructor(options: ThinkHarnessOptions<TOOLS>) {
    super("think-harness");
    this.#options = options;
    this.#sessions = new Sessions({
      ...(options.reservedMetadataKeys && {
        reservedMetadataKeys: options.reservedMetadataKeys
      })
    });
    this.sessions = new ThinkSessions(this);
  }

  #setWakeTiming(timing: WakeTiming): void {
    const heartbeat = timing.heartbeatMs;
    if (heartbeat !== undefined) {
      if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
        throw new Error("ThinkHarness heartbeatMs must be a positive number");
      }
      this.#heartbeatMs = heartbeat;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Create the harness's tables and wake every session with open work. */
  override async onStart(): Promise<void> {
    this.#bindOwned();
    await this.#sessions.onStart();
    await this.#streams.onStart();
    const store = this.#tables();
    store.ensureSession(ROOT_SESSION);
    const sessions = new Set(store.open().map((op) => op.session));
    for (const session of sessions) {
      // A wake already set for later is a recovery backoff or the alarm
      // memory-limit breaker's delay; replacing it with one due now would
      // skip that wait.
      const wake = this.lifecycle.jobs.get(wakeJobId(session));
      if (wake && wake.time > Date.now()) continue;
      await this.#wake(session);
    }
  }

  /**
   * The alarm memory-limit breaker sealed: the work it stopped would only
   * run out of memory again. Mark the running operations to be settled
   * `unanswered` with reason `"out_of_memory"` rather than run again.
   * Queued operations behind them still run. Runs after the isolate's
   * work unwound, so it keeps to small synchronous writes.
   */
  onMemoryLimit(context: MemoryLimitContext): void {
    if (!context.sealed) return;
    // Only mark them: rebuilding a partial answer here could run out of
    // memory again. The next drive settles each marked operation through
    // the usual path, which keeps the partial and tells clients.
    const store = this.#tables();
    for (const op of store.open()) {
      if (op.status !== "running") continue;
      store.update(op.session, op.operationId, {
        abandonReason: "out_of_memory"
      });
    }
  }

  /** Run a session's wake job. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== WAKE_FN) return;
    const session = sessionOfJob(context.job.payload);
    if (session !== undefined) return this.#wakeStep(session);
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
    return this.#tables()
      .open(session)
      .map((op) => ({
        operationId: op.operationId,
        session: op.session,
        status: op.status === "queued" ? "queued" : "running"
      }));
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
    const operationId = options.operationId ?? crypto.randomUUID();
    const store = this.#tables();
    let accepted = false;
    this.lifecycle.storage.transactionSync(() => {
      store.ensureSession(session);
      if (options.clientTools !== undefined) {
        store.setClientTools(session, options.clientTools);
      }
      accepted = store.insert(
        session,
        operationId,
        input,
        options.source ?? "server"
      );
    });
    if (accepted) {
      this.#events.emit(session, {
        type: "operation",
        status: { operationId, status: "queued" }
      });
    }
    // The wake first, so a job is due before anything runs; then run now
    // rather than waiting for the alarm.
    await this.#wake(session);
    this.#ensureDrive(session);
    return { operationId, session, accepted };
  }

  /** @internal Stop one operation, or everything open in a session. */
  async abort(session: ThinkSessionId, operationId?: string): Promise<boolean> {
    await this.lifecycle.ready();
    const store = this.#tables();
    const targets =
      operationId === undefined
        ? store.open(session)
        : [store.get(session, operationId)].filter(
            (op): op is OperationRecord =>
              op !== undefined &&
              (op.status === "queued" || op.status === "running")
          );
    for (const op of targets) {
      const live = this.#live.get(session);
      if (live?.operationId === op.operationId) {
        live.abort.abort();
      } else if (op.status === "queued") {
        store.settle(session, op.operationId, {
          status: "unanswered",
          reason: "withdrawn"
        });
        await this.#settled(session, op.operationId);
      } else {
        // Running, but not in this isolate: an eviction left it for the wake.
        await this.#abandon(op, "aborted");
      }
    }
    return targets.length > 0;
  }

  /** @internal Wait for an operation to settle. */
  async wait(
    session: ThinkSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<ThinkOperationResult> {
    await this.lifecycle.ready();
    for (;;) {
      const op = this.#tables().get(session, operationId);
      if (!op) {
        return {
          operationId,
          session,
          status: "unanswered",
          reason: "not_found"
        };
      }
      if (op.status === "done" || op.status === "unanswered") {
        return this.#result(op);
      }
      await new Promise<void>((resolveWait, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const key = waiterKey(session, operationId);
        const waiters = this.#waiters.get(key) ?? new Set();
        this.#waiters.set(key, waiters);
        const done = () => {
          signal?.removeEventListener("abort", aborted);
          resolveWait();
        };
        const aborted = () => {
          waiters.delete(done);
          reject(signal?.reason);
        };
        waiters.add(done);
        signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  }

  /** @internal */
  async inspect(
    session: ThinkSessionId,
    operationId: string
  ): Promise<ThinkOperationStatus | undefined> {
    await this.lifecycle.ready();
    const op = this.#tables().get(session, operationId);
    if (!op) return undefined;
    switch (op.status) {
      case "queued":
      case "running":
        return { operationId, session, status: op.status };
      case "done":
      case "unanswered":
        return this.#result(op);
    }
  }

  /** @internal The active transcript of a session. */
  async messages(session: ThinkSessionId): Promise<UIMessage[]> {
    return asUIMessages(await this.#handle(session).getHistory());
  }

  /** @internal Abort everything in a session and clear its transcript. */
  async reset(session: ThinkSessionId, handoff?: string): Promise<void> {
    await this.abort(session);
    await this.#drives.get(session);
    const handle = this.#handle(session);
    this.#ownClears.set(session, (this.#ownClears.get(session) ?? 0) + 1);
    try {
      await handle.clearMessages();
    } finally {
      const left = (this.#ownClears.get(session) ?? 1) - 1;
      if (left === 0) this.#ownClears.delete(session);
      else this.#ownClears.set(session, left);
    }
    this.#tables().deleteSettled(session);
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
    const unsubscribe = this.#events.subscribe(session, (event) => {
      const events = toSessionEvents(event);
      if (watcher) watcher.push(events);
      else early.push(events);
    });
    const live = this.#live.get(session);
    const partial = live ? [...live.partial] : this.#recoverableChunks(session);
    const messages = await this.messages(session);
    const open = this.#tables().open(session);
    const running = open.find((op) => op.status === "running");
    const state: SessionState = {
      messages: messages.map((message) => toTranscriptMessage(message)),
      pending: open.map((op) => ({
        operationId: op.operationId,
        status: op.status === "queued" ? "queued" : "placed"
      })),
      ...(running && {
        run: {
          operations: [running.operationId],
          ...(partial.length > 0 && {
            partial: partial.flatMap((chunk) => {
              const converted = toResponseChunk(chunk, {});
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
    const running = this.#tables()
      .open(session)
      .find((op) => op.status === "running");
    if (!running) return undefined;
    const live = this.#live.get(session);
    if (live?.operationId === running.operationId) {
      return {
        operationId: running.operationId,
        continuation: live.continues,
        chunks: [...live.partial]
      };
    }
    // Left by an eviction: the stream holds what was durable.
    return {
      operationId: running.operationId,
      continuation: (await this.#message(running)) !== undefined,
      chunks: running.streamId ? this.#streamChunks(running.streamId) : []
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
    this.#tables().ensureSession(id, parent);
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
    return fork;
  }

  /** @internal */
  async listSessions(): Promise<ThinkSessionInfo[]> {
    await this.lifecycle.ready();
    const store = this.#tables();
    const busy = new Set(store.open().map((op) => op.session));
    return store.sessions().map((record) => ({
      id: record.id,
      ...(record.parent !== undefined && { parent: record.parent }),
      busy: busy.has(record.id)
    }));
  }

  // ── The wake ─────────────────────────────────────────────────────────────

  /** Schedule the session's wake job, now or at `time`. */
  #wake(session: ThinkSessionId, time = Date.now()): Promise<unknown> {
    // A push made while the job is dispatching supersedes that dispatch's
    // outcome, so a submit is never lost to a wake that is completing.
    return this.lifecycle.jobs.push({
      id: wakeJobId(session),
      fn: WAKE_FN,
      time,
      payload: { session },
      singleflight: true,
      recoveryLoop: true
    });
  }

  /**
   * One run of a session's wake job. With work open, it makes sure a drive
   * is running and keeps a heartbeat; with none, it completes.
   */
  #wakeStep(session: ThinkSessionId): LifecycleJobOutcome {
    const heartbeat = { rescheduleAt: Date.now() + this.#heartbeatMs };
    if (this.#drives.has(session)) return heartbeat;
    if (this.#tables().open(session).length === 0) return undefined;
    const drive = this.#ensureDrive(session);
    // The drive runs past this dispatch, inside the alarm's work, so a
    // memory-limit reset during it counts against the job's breaker.
    this.lifecycle.trackAlarmWork(drive);
    return heartbeat;
  }

  /** Run the session's open operations in order, unless already running. */
  #ensureDrive(session: ThinkSessionId): Promise<void> {
    const running = this.#drives.get(session);
    if (running) return running;
    let wakeAt: number | undefined;
    const drive = (async () => {
      try {
        await this.lifecycle.runInHostContext(async () => {
          for (;;) {
            const op = this.#tables().open(session)[0];
            if (!op) return;
            const outcome = await this.#run(op);
            if (outcome.retryAt !== undefined) {
              wakeAt = outcome.retryAt;
              return;
            }
          }
        });
      } catch (error) {
        // The harness's own storage failed. The heartbeat tries again.
        console.error("ThinkHarness drive failed", error);
        wakeAt = Date.now() + this.#heartbeatMs;
      } finally {
        this.#drives.delete(session);
      }
      // Re-check now (or at the backoff), so the job completes as soon as
      // the session has nothing left.
      await this.#wake(session, wakeAt);
    })();
    this.#drives.set(session, drive);
    return drive;
  }

  // ── Running one operation ────────────────────────────────────────────────

  async #run(first: OperationRecord): Promise<RunOutcome> {
    const { session, operationId } = first;
    const live: LiveRun = {
      operationId,
      abort: new AbortController(),
      partial: [],
      continues: false
    };
    this.#live.set(session, live);
    try {
      let op: OperationRecord | undefined = first;
      if (op.status === "queued") {
        op = await this.#place(op);
        if (!op) return {};
      }
      const continuation = (await this.#message(op)) !== undefined;
      this.#events.emit(session, {
        type: "run-start",
        operationId,
        continuation
      });
      try {
        return await this.#steps(session, operationId, live);
      } finally {
        this.#events.emit(session, { type: "run-end", operationId });
      }
    } catch (error) {
      console.error(`ThinkHarness operation ${operationId} failed`, error);
      const op = this.#tables().get(session, operationId);
      if (op && (op.status === "running" || op.status === "queued")) {
        await this.#abandon(op, errorText(error));
      }
      return {};
    } finally {
      this.#live.delete(session);
    }
  }

  async #steps(
    session: ThinkSessionId,
    operationId: string,
    live: LiveRun
  ): Promise<RunOutcome> {
    const maxSteps = this.#options.maxSteps ?? DEFAULT_MAX_STEPS;
    for (;;) {
      const op = this.#tables().get(session, operationId);
      if (!op || op.status !== "running") return {};
      if (live.abort.signal.aborted) {
        await this.#abandon(op, "aborted");
        return {};
      }
      if (op.abandonReason !== undefined) {
        await this.#abandon(op, op.abandonReason);
        return {};
      }
      const message = await this.#message(op);
      const tools = await this.#tools(session);
      const action = nextAction(
        op,
        message,
        (name) => isServerTool(tools, name),
        maxSteps
      );
      switch (action._tag) {
        case "recover-model": {
          const outcome = await this.#recoverModel(op, message);
          if (outcome) return outcome;
          break;
        }
        case "call-model": {
          const outcome = await this.#callModel(op, message, tools, live);
          if (outcome) return outcome;
          break;
        }
        case "run-tools":
          if (!message) return {};
          await this.#runTools(op, message, action.calls, tools, live);
          break;
        case "await-input":
        case "end":
          await this.#commit(session, undefined, () => {
            this.#tables().settle(session, operationId, {
              status: "done",
              text: textOf(message)
            });
          });
          await this.#settled(session, operationId, message);
          return {};
      }
    }
  }

  /**
   * Place a queued operation: write what it brings to the transcript and
   * mark it running, in one transaction. Returns the running operation, or
   * undefined when placing settled it.
   */
  async #place(op: OperationRecord): Promise<OperationRecord | undefined> {
    const { session, operationId } = op;
    const store = this.#tables();
    const handle = this.#handle(session);
    const input = op.input;
    const placed: UIMessage[] = [];
    let settledText: string | undefined;
    let unanswered: string | undefined;

    const running = (change: {
      readonly parentId?: string;
      readonly messageId: string;
    }) =>
      store.start(session, operationId, {
        parentId: change.parentId ?? null,
        messageId: change.messageId,
        pendingModel: true
      });

    switch (input.kind) {
      case "messages": {
        let messages = input.messages;
        if (op.source === "client") {
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
        await this.#commit(session, undefined, (put) => {
          let parentId: string | undefined;
          for (const message of messages) {
            put(message, { parentId, source: op.source });
            parentId = message.id;
            placed.push(message);
          }
          running({ parentId: last.id, messageId: crypto.randomUUID() });
        });
        break;
      }
      case "answer": {
        const history = asUIMessages(await handle.getHistory());
        const tools = await this.#tools(session);
        const answer = input.answer;
        if (answer.type === "tool-result" && op.source === "client") {
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
            (name) => isServerTool(tools, name),
            Number.POSITIVE_INFINITY
          )._tag !== "await-input";
        await this.#commit(session, undefined, (put) => {
          put(answered);
          placed.push(answered);
          if (continues) running({ messageId: answered.id });
          else {
            store.settle(session, operationId, {
              status: "done",
              text: textOf(answered)
            });
          }
        });
        if (!continues) settledText = textOf(answered);
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
        await this.#commit(session, undefined, () =>
          running({ parentId: target, messageId: crypto.randomUUID() })
        );
        break;
      }
      case "continue": {
        const latest = await handle.getLatestLeaf();
        if (!latest) {
          unanswered = "not_found";
          break;
        }
        await this.#commit(session, undefined, () =>
          latest.role === "assistant"
            ? running({ messageId: latest.id })
            : running({ parentId: latest.id, messageId: crypto.randomUUID() })
        );
        break;
      }
    }

    for (const message of placed) {
      this.#events.emit(session, { type: "message", message, operationId });
    }
    if (unanswered !== undefined) {
      store.settle(session, operationId, {
        status: "unanswered",
        reason: unanswered
      });
      await this.#settled(session, operationId);
      return undefined;
    }
    if (settledText !== undefined) {
      await this.#settled(session, operationId);
      return undefined;
    }
    this.#events.emit(session, {
      type: "operation",
      status: { operationId, status: "placed" }
    });
    return store.get(session, operationId);
  }

  // ── Model calls ──────────────────────────────────────────────────────────

  /**
   * One model call. Its chunks go to a stream as they arrive; when it ends,
   * the message is persisted and the stream discarded in one transaction.
   * Returns an outcome only when the operation must wait.
   */
  async #callModel(
    op: OperationRecord,
    existing: UIMessage | undefined,
    tools: ToolSet,
    live: LiveRun
  ): Promise<RunOutcome | undefined> {
    const { session, operationId } = op;
    const messageId = op.messageId ?? crypto.randomUUID();
    const hooks = this.#options.hooks;
    const handle = this.#handle(session);
    const history = asUIMessages(
      await handle.getHistory({ leafId: existing ? existing.id : op.parentId })
    );
    const system = await resolve(this.#options.system, session);
    const config =
      (await hooks?.beforeTurn?.({
        session,
        operationId,
        step: op.steps,
        continuation: existing !== undefined,
        messages: history,
        system,
        tools: Object.keys(tools)
      })) ?? {};
    const model = config.model ?? (await resolve(this.#options.model, session));
    if (model === undefined) throw new Error("ThinkHarness has no model");
    const offered = modelTools(tools, config.activeTools);
    const effectiveSystem = config.system ?? system;
    const messages: ModelMessage[] =
      config.messages ??
      (await convertToModelMessages(history, {
        tools,
        ignoreIncompleteToolCalls: true
      }));

    // The stream id is durable before the stream exists, so an eviction at
    // any point leaves evidence the next wake recovers from.
    const streamId = `think:${crypto.randomUUID()}`;
    this.#tables().update(session, operationId, { streamId, messageId });
    const writer = await this.#streams.open(streamId, {
      tag: streamTag(session, operationId),
      metadata: { session, operationId, messageId }
    });

    const stall = new AbortController();
    const signal = AbortSignal.any([live.abort.signal, stall.signal]);
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
      if (segment.length === 0) return;
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
        live.abort.signal
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

    const message = final ?? accumulate(messageId, existing, live.partial);
    const partial = message ? settledPartial(message) : undefined;
    const keep = partial && hasContent(partial) ? partial : undefined;
    const stalled =
      caught instanceof ChatStreamStalledError || stall.signal.aborted;
    const failure = stalled ? undefined : (modelError ?? caught);

    if (live.abort.signal.aborted) {
      await this.#commit(session, streamId, (put) => {
        if (keep) put(keep, { parentId: op.parentId });
        this.#tables().settle(
          session,
          operationId,
          { status: "unanswered", reason: "aborted" },
          { streamId: null }
        );
      });
      await this.#settled(session, operationId, keep);
      return {};
    }

    if (stalled || failure !== undefined) {
      if (failure !== undefined) {
        try {
          await hooks?.onError?.(failure, { session, operationId });
        } catch (error) {
          console.error("ThinkHarness onError hook failed", error);
        }
      }
      const kind = stalled
        ? "retry"
        : (hooks?.classifyError?.(failure) ?? "fail");
      if (
        kind === "context-overflow" &&
        op.overflowRetries < MAX_OVERFLOW_RETRIES
      ) {
        await this.#commit(session, streamId, (put) => {
          if (keep) put(keep, { parentId: op.parentId });
          this.#tables().update(session, operationId, {
            streamId: null,
            overflowRetries: op.overflowRetries + 1
          });
        });
        try {
          await handle.compact();
        } catch (error) {
          console.warn("ThinkHarness could not compact the session", error);
        }
        return undefined;
      }
      if (kind === "retry") {
        return this.#interrupted(op, streamId, keep);
      }
      await this.#commit(session, streamId, (put) => {
        if (keep) put(keep, { parentId: op.parentId });
        this.#tables().settle(
          session,
          operationId,
          { status: "unanswered", reason: errorText(failure) },
          { streamId: null }
        );
      });
      await this.#settled(session, operationId, keep);
      return {};
    }

    if (!message) throw new Error("The model call produced no message");
    const toolCalls = lastStep(message).some(
      (part) => isToolCallPart(part) && !part.providerExecuted
    );
    await this.#commit(session, streamId, (put) => {
      put(message, { parentId: op.parentId });
      this.#tables().update(session, operationId, {
        streamId: null,
        steps: op.steps + 1,
        interruptions: 0,
        pendingModel: toolCalls
      });
    });
    live.partial = [];
    live.continues = true;
    this.#events.emit(session, { type: "message", message, operationId });
    await hooks?.onStepFinish?.({
      session,
      operationId,
      step: op.steps,
      message,
      finishReason
    });
    return undefined;
  }

  /**
   * A model call an eviction cut short: keep what it produced, then call
   * the model again to continue the same message, within the budget.
   */
  async #recoverModel(
    op: OperationRecord,
    existing: UIMessage | undefined
  ): Promise<RunOutcome | undefined> {
    const streamId = op.streamId;
    if (streamId === undefined) return undefined;
    const chunks = this.#streamChunks(streamId);
    const rebuilt =
      chunks.length > 0
        ? accumulate(op.messageId ?? crypto.randomUUID(), existing, chunks)
        : undefined;
    const partial = rebuilt ? settledPartial(rebuilt) : undefined;
    const keep = partial && hasContent(partial) ? partial : undefined;
    return this.#interrupted(op, streamId, keep);
  }

  /** Count an interruption, keep the partial, and decide whether to go on. */
  async #interrupted(
    op: OperationRecord,
    streamId: string,
    partial: UIMessage | undefined
  ): Promise<RunOutcome | undefined> {
    const { session, operationId } = op;
    const recovery = this.#options.recovery;
    const attempt = op.interruptions + 1;
    const maxAttempts = recovery?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let decision: "continue" | "abandon" =
      attempt > maxAttempts ? "abandon" : "continue";
    if (decision === "continue" && this.#options.hooks?.onRecovery) {
      decision = await this.#options.hooks.onRecovery({
        session,
        operationId,
        attempt,
        partial
      });
    }
    await this.#commit(session, streamId, (put) => {
      if (partial) put(partial, { parentId: op.parentId });
      const progress = { streamId: null, interruptions: attempt };
      if (decision === "abandon") {
        this.#tables().settle(
          session,
          operationId,
          { status: "unanswered", reason: "interrupted" },
          progress
        );
      } else {
        this.#tables().update(session, operationId, progress);
      }
    });
    if (partial) {
      this.#events.emit(session, {
        type: "message",
        message: partial,
        operationId
      });
    }
    if (decision === "abandon") {
      await this.#settled(session, operationId, partial);
      return {};
    }
    const delay = backoff(attempt, recovery?.backoffMs ?? DEFAULT_BACKOFF_MS);
    return delay > 0 ? { retryAt: Date.now() + delay } : undefined;
  }

  // ── Tool calls ───────────────────────────────────────────────────────────

  async #runTools(
    op: OperationRecord,
    message: UIMessage,
    calls: readonly ToolCallPart[],
    tools: ToolSet,
    live: LiveRun
  ): Promise<void> {
    const { session, operationId } = op;
    const store = this.#tables();
    const hooks = this.#options.hooks;
    const history = asUIMessages(
      await this.#handle(session).getHistory({ leafId: message.id })
    );
    const modelMessages = await convertToModelMessages(history.slice(0, -1), {
      tools,
      ignoreIncompleteToolCalls: true
    });
    // The drive owns this message while it runs tools; every completion
    // updates this copy and persists it whole.
    let current = message;

    const toRun: ToolCallPart[] = [];
    const approvals: string[] = [];
    for (const call of calls) {
      const toolName = toolNameOf(call);
      const tool = tools[toolName];
      if (!tool) continue;
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
      await this.#commit(session, undefined, (put) => put(snapshot));
      this.#events.emit(session, {
        type: "message",
        message: snapshot,
        operationId
      });
    }

    await Promise.all(
      toRun.map(async (call) => {
        const toolName = toolNameOf(call);
        const tool = tools[toolName];
        if (!tool) return;
        const { toolCallId } = call;
        const started = store.toolCall(session, toolCallId);
        let outcome: ToolOutcome | undefined;
        if (started) {
          // Started before, with no result in the transcript: an eviction
          // cut it short.
          const policy = toolRecovery(tool);
          const maxAttempts =
            this.#options.recovery?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
          if (policy === "report" || started.attempts >= maxAttempts) {
            outcome = { ok: false, errorText: INTERRUPTED_TOOL_ERROR };
          }
        }
        let attempt = started?.attempts ?? 0;
        let input: unknown = call.input;
        if (!outcome) {
          attempt = store.startToolCall(session, toolCallId, operationId);
          const decision = await hooks?.beforeToolCall?.({
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
            if (decision?.action === "run" && decision.input !== undefined) {
              input = decision.input;
            }
            outcome = await executeTool(tool, input, {
              toolCallId,
              messages: modelMessages,
              abortSignal: live.abort.signal,
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
        const settled = outcome;
        await hooks?.afterToolCall?.({
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
        await this.#commit(session, undefined, (put) => {
          put(snapshot);
          store.finishToolCall(session, toolCallId);
          store.update(session, operationId, { interruptions: 0 });
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
      })
    );
  }

  // ── Settling ─────────────────────────────────────────────────────────────

  /**
   * End an operation that cannot run on: keep what its interrupted model
   * call produced, mark any tool call it left open as failed, and settle
   * it `unanswered`.
   */
  async #abandon(op: OperationRecord, reason: string): Promise<void> {
    const { session, operationId } = op;
    const existing = await this.#message(op);
    let message = existing;
    const chunks =
      op.streamId === undefined ? [] : this.#streamChunks(op.streamId);
    if (chunks.length > 0) {
      const rebuilt = accumulate(
        op.messageId ?? crypto.randomUUID(),
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
    await this.#commit(session, op.streamId, (put) => {
      if (keep) put(keep, { parentId: op.parentId });
      this.#tables().settle(
        session,
        operationId,
        { status: "unanswered", reason },
        { streamId: null }
      );
    });
    if (keep) {
      this.#events.emit(session, {
        type: "message",
        message: keep,
        operationId
      });
    }
    await this.#settled(session, operationId, keep ?? existing);
  }

  /** Tell everyone an operation settled. Its row is already written. */
  async #settled(
    session: ThinkSessionId,
    operationId: string,
    message?: UIMessage
  ): Promise<void> {
    const op = this.#tables().get(session, operationId);
    if (!op) return;
    const result = this.#result(op);
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
    const key = waiterKey(session, operationId);
    for (const waiter of this.#waiters.get(key) ?? []) waiter();
    this.#waiters.delete(key);
    try {
      await this.#options.hooks?.onTurnEnd?.({
        ...result,
        ...(message && { message })
      });
    } catch (error) {
      console.error("ThinkHarness onTurnEnd hook failed", error);
    }
  }

  #result(op: OperationRecord): ThinkOperationResult {
    const { operationId, session } = op;
    return op.status === "done"
      ? {
          operationId,
          session,
          status: "done",
          text: op.text ?? "",
          ...(op.messageId !== undefined && { messageId: op.messageId })
        }
      : {
          operationId,
          session,
          status: "unanswered",
          ...(op.reason !== undefined && { reason: op.reason })
        };
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  #tables(): OperationRecords {
    this.#records ??= new OperationRecords(this.lifecycle.storage);
    return this.#records;
  }

  /** The Sessions handle for a session, configured on first use. */
  /**
   * Give the Sessions and Streams the harness owns this capability's
   * Lifecycle services. Done on first use, not only in `onStart`, because an
   * RPC can read a transcript before startup (the read itself then waits
   * for startup).
   */
  #bindOwned(): void {
    if (this.#bound) return;
    bindLifecycleCapability(this.#sessions, this.lifecycle);
    bindLifecycleCapability(this.#streams, this.lifecycle);
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
          this.#events.emit(session, {
            type: "message",
            message: asUIMessage(change.message)
          });
          return;
        case "clear":
          if ((this.#ownClears.get(session) ?? 0) > 0) return;
          this.#events.emit(session, { type: "reset" });
          return;
        case "delete":
        case "compact":
        case "compaction":
          // No one message describes these: the active path changed.
          this.#events.emit(session, { type: "transcript" });
          return;
      }
    });
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

  #handle(session: ThinkSessionId): Session {
    this.#bindOwned();
    const handle = this.#sessions.session(session);
    if (!this.#configured.has(session)) {
      this.#configured.add(session);
      this.#options.configureSession?.(handle, session);
    }
    return handle;
  }

  async #message(op: OperationRecord): Promise<UIMessage | undefined> {
    if (op.messageId === undefined) return undefined;
    const message = await this.#handle(op.session).getMessage(op.messageId);
    return message ? asUIMessages([message])[0] : undefined;
  }

  async #tools(session: ThinkSessionId): Promise<ToolSet> {
    const tools = (await resolve(this.#options.tools, session)) ?? {};
    const client = createToolsFromClientSchemas(
      this.#tables().clientTools(session)
    );
    // A client cannot replace a server tool: the server's definition, its
    // execute and its approval policy win on a name clash.
    for (const name of Object.keys(client)) {
      if (Object.hasOwn(tools, name)) {
        console.warn(
          `ThinkHarness ignored a client tool named "${name}": a server tool has that name`
        );
      }
    }
    return { ...client, ...tools };
  }

  /**
   * Persist messages and operation changes in one transaction; with a
   * stream id, the transaction also settles and discards that stream (the
   * cutover), so an eviction leaves either the stream or the message.
   */
  async #commit(
    session: ThinkSessionId,
    streamId: string | undefined,
    writes: (put: Put) => void
  ): Promise<void> {
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

  /** Every chunk a stream holds, without waiting for more. */
  #streamChunks(streamId: string): UIMessageChunk[] {
    const streams = this.#streams.__DO_NOT_USE_WILL_BREAK__sync();
    if (!streams.getStream(streamId)) return [];
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

  /** Chunks an evicted model call left in its stream, for a late watcher. */
  #recoverableChunks(session: ThinkSessionId): UIMessageChunk[] {
    const running = this.#tables()
      .open(session)
      .find((op) => op.status === "running");
    return running?.streamId ? this.#streamChunks(running.streamId) : [];
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
function toolRecovery(tool: object): ToolRecovery {
  return "recovery" in tool && tool.recovery === "rerun" ? "rerun" : "report";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function backoff(attempt: number, baseMs: number): number {
  if (attempt <= 1) return 0;
  return Math.min(baseMs * 2 ** (attempt - 2), MAX_BACKOFF_MS);
}

function streamTag(session: ThinkSessionId, operationId: string): string {
  return `think:${JSON.stringify([session, operationId])}`;
}

function waiterKey(session: ThinkSessionId, operationId: string): string {
  return JSON.stringify([session, operationId]);
}

/** Project a session event onto the shared harness interface's events. */
function toSessionEvents(event: ThinkSessionEvent): SessionEvent[] {
  switch (event.type) {
    case "operation":
      return [{ type: "operation", status: event.status }];
    case "run-start":
      return [{ type: "run-start", operations: [event.operationId] }];
    case "run-end":
      return [{ type: "run-end", operations: [event.operationId] }];
    case "chunk": {
      const chunk = toResponseChunk(event.chunk, {});
      return chunk ? [{ type: "chunk", chunk }] : [];
    }
    case "message":
      return [{ type: "message", message: toTranscriptMessage(event.message) }];
    case "reset":
      return [{ type: "reset" }];
    case "transcript":
      // The shared interface has no "re-read" event; a watch sees the
      // change in its next state.
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
  submit(
    input: ThinkInput,
    options: ThinkSubmitOptions = {}
  ): Promise<ThinkReceipt> {
    const operationId = options.operationId ?? crypto.randomUUID();
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
    const operationId = options.operationId ?? crypto.randomUUID();
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
