/**
 * The chat module's host contract (design/rfc-slim-hosts.md, "The chat
 * module"): what a host gives the one chat-turn definition. A host supplies
 * `respond` (its model call) and optional hooks; the module owns the turn's
 * run, its stream and its stored reply.
 *
 * @internal Sibling-package support for `@cloudflare/think` and
 * `@cloudflare/ai-chat`, not a public API.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readUIMessageStream } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";
import type { Sessions } from "../sessions/sessions";
import type { Streams } from "../streams/streams";
import type { Tasks } from "../tasks/tasks";
import type {
  TaskCheckpoint,
  TaskJson,
  TaskStep,
  TaskValue
} from "../tasks/types";
import { withFiberStash } from "../fiber-runs";
import type { StreamWriter } from "../streams/types";
import type { Connection } from "agents";
import type { ClientToolSchema } from "./client-tools";
import type {
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryOptions
} from "./lifecycle";
import {
  chatRecoveryBackoffSeconds,
  retryAfterSeconds
} from "./recovery-engine";
import {
  evaluateChatRecoveryIncident,
  resolveChatRecoveryConfig
} from "./recovery-incident";
import type { ChatRecoveryIncident } from "./recovery-incident";
import { TaskSettlement } from "../tasks/settlement";
import {
  continuationWaitsOnClient,
  interruptedToolPartAsError,
  repairTranscriptBeforeTurn
} from "./before-turn";
import {
  replyIsRemovedAsEmpty,
  stripTrailingReasoning
} from "./repair-transcript";
import { isReplayChunk, settleInterruptedPart } from "./message-builder";
import { transcriptEndsInAnswer } from "./continuation-turn";
import { TaskCancellation } from "../tasks/replay";
import { frameText } from "./chat-frames";
import { sendIfOpen } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { responseSource } from "./reply-source";
import { ROW_VALUE_BYTES, utf8Length } from "../internal/platform-limits";
import {
  CHAT_REQUEST_CONTEXT_KEY,
  storableRequestContext
} from "./request-context";
export { CHAT_REQUEST_CONTEXT_KEY, storableRequestContext };
import {
  recordRecentChatTerminal,
  type RecentTerminalsKv
} from "./recent-terminals";

/** The capabilities the chat functions are given. They own every row and job. */
export interface ChatDeps {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly sessions: Sessions;
  /**
   * The tabs the chat's frames go to. Absent for a host that owns no
   * sockets (a harness inside an agent).
   */
  readonly webSockets?: {
    getConnections(): Iterable<Connection>;
    /**
     * Send a turn's frame to every tab but `without`, when the host sends
     * its frames itself (AIChatAgent's `broadcast`, which agent-tool runs
     * observe). Absent: each tab is sent the frame.
     */
    broadcast?(text: string, without: string[]): void;
  };
  /** The Sessions session the chat's transcript is in. */
  readonly session?: string;
  /**
   * The object's synchronous key-value storage (`ctx.storage.kv`). The chat
   * keeps the ends of its last requests there, so a tab that was away when
   * its request ended learns how it ended.
   */
  readonly kv: RecentTerminalsKv;
  /**
   * Publish a `chat:*` observability event where the hosts published it
   * (`chat:transcript:repaired`, `chat:continuation:dropped`). Absent: none.
   */
  readonly emit?: (
    type: `chat:${string}`,
    payload: Record<string, unknown>
  ) => void;
  /**
   * What a host does to a message before it is stored (the hosts'
   * `sanitizeMessageForPersistence`), for a message the chat functions
   * write outside a turn: a tab's tool answer. Absent: stored as it is.
   */
  readonly sanitizeForPersistence?: (message: UIMessage) => UIMessage;
  /**
   * How a turn ended that ended without its handler running again (stopped
   * while it waited to be retried), as `hooks.onResponse` hears of every
   * other end: a turn ends once, and its host is told once.
   */
  readonly turnEnded?: (result: ChatTurnResult) => void | Promise<void>;
}

/**
 * One model call. Built from the task run and the transcript, never from a
 * closure, so a reset can build it again.
 */
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
  /** Aborted by a stop, a clear, a supersede or a cancel of the run. */
  readonly signal: AbortSignal;
  /**
   * Run `fn` once as a durable step of the turn's run: after a reset the
   * journaled result is returned and `fn` does not run again. A server tool
   * call that must not repeat runs here.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * The turn's run checkpoint: state its tools keep across a reset (an
   * agent tool's progress and milestones), one statement per `set`.
   */
  readonly checkpoint: TaskCheckpoint;
}

/**
 * What `respond` returns: a stream of UI message chunks. A `Response` is read
 * as SSE when its content type says so, otherwise as plain text.
 */
export type ChatModelStream =
  | AsyncIterable<UIMessageChunk>
  | ReadableStream<UIMessageChunk>
  | Response
  | { toUIMessageStream(): ReadableStream<UIMessageChunk> };

/** A tool part an interruption cut off, as the repair hook sees it. */
export type InterruptedToolPart = UIMessage["parts"][number] & {
  toolCallId: string;
};

/** The hooks a host may give the chat-turn definition. */
export interface ChatHooks {
  /** After the reply is stored. */
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
  /**
   * Settle a tool part an interruption cut off. `tool.recovery` is the
   * tool's own setting when the host knows it: `"report"` (the default)
   * reports the call to the model as interrupted, `"rerun"` runs it again.
   */
  repairInterruptedToolPart?(
    part: InterruptedToolPart,
    tool?: { recovery?: "report" | "rerun" }
  ): InterruptedToolPart;
}

/** The options a host gives the chat-turn definition. */
export interface ChatOptions {
  /**
   * `false` gives up on an interrupted turn. Otherwise the host's
   * `chatRecovery` budget decides, as it always has: `maxAttempts` attempts
   * without progress (an attempt that streamed more starts the count
   * again), the no-progress window, the work budget, the interrupted
   * attempts, and the app's `shouldKeepRecovering`. A turn past it ends
   * with `terminalMessage` and `onExhausted` is told why. A stream that
   * sends nothing for `stallTimeoutMs` is treated as interrupted.
   */
  readonly recovery?:
    | false
    | (Exclude<ChatRecoveryConfig, true> & {
        readonly stallTimeoutMs?: number;
      });
  /**
   * The most bytes of transcript a model call reads: the newest messages
   * that fit (always at least the latest). Unset reads the whole path.
   */
  readonly hydrationByteBudget?: number;
  /** Keep at most this many messages: the oldest go after each reply. */
  readonly maxPersistedMessages?: number;
}

/** What a host supplies. */
export interface ChatHost {
  respond(call: ChatModelCall): Promise<ChatModelStream | undefined>;
  readonly hooks?: ChatHooks;
  readonly options?: ChatOptions;
}

/**
 * @internal The list a tab is sent: `messages` (the stored transcript),
 * then the messages the waiting turns of chat `session` hold, in lane order,
 * named in `queuedMessageIds` (a tab keeps them apart and draws them last).
 */
export function chatClientView<TMessage extends { id: string }>(
  tasks: Tasks,
  definition: string,
  session: string,
  messages: readonly TMessage[],
  defaultSession = ""
): { messages: TMessage[]; queuedMessageIds?: string[] } {
  const known = new Set(messages.map((message) => message.id));
  const queued: TMessage[] = [];
  for (const run of tasks.peekList({
    definition,
    status: ["pending"],
    results: false,
    order: "oldest"
  })) {
    const input = tasks.inputOf<ChatTurnInput>(run.runId);
    if ((input?.session ?? defaultSession) !== session) continue;
    for (const message of input?.messages ?? []) {
      if (known.has(message.id)) continue;
      known.add(message.id);
      queued.push(message as unknown as TMessage);
    }
  }
  return queued.length > 0
    ? {
        messages: [...messages, ...queued],
        queuedMessageIds: queued.map((message) => message.id)
      }
    : { messages: [...messages] };
}

/** @internal The user messages a client request came from, as its run notes them. */
export function messageIdsOf(
  metadata: Readonly<Record<string, unknown>> | undefined
): string[] | undefined {
  const ids = (metadata?.chat as { messageIds?: unknown } | undefined)
    ?.messageIds;
  return Array.isArray(ids) && ids.length > 0 ? (ids as string[]) : undefined;
}

/** The reason a chat clear cancels its turns with. */
export const CHAT_CLEARED = "chat cleared";

/** @internal A tab waiting for a turn's stream, and the probe it asked with. */
export interface ParkedTab {
  readonly connection: Connection;
  readonly probeId?: string;
  /**
   * It asked to resume (it acks the offer and gets the replay), rather than
   * waiting on a continuation its answer started (it gets the live frames).
   */
  readonly asked?: true;
}

/**
 * Tabs offered a turn's stream (`STREAM_RESUMING`) that have not acked it
 * yet, by connection id, with the turn's request id. They get none of its
 * live frames until the ack's replay: a tab would show them without the
 * chunks streamed before it.
 */
const offeredTabs = new WeakMap<Streams, Map<string, string>>();

/** @internal The tabs offered a stream and not acked yet, in this isolate. */
export function offeredIn(streams: Streams): Map<string, string> {
  let tabs = offeredTabs.get(streams);
  if (!tabs) offeredTabs.set(streams, (tabs = new Map()));
  return tabs;
}

/** Tabs waiting for a turn's stream to start, by chat, in this isolate. */
const parkedTabs = new WeakMap<Streams, Map<string, Map<string, ParkedTab>>>();

/** @internal The tabs waiting for the next stream of chat `session`. */
export function parkedIn(
  streams: Streams,
  session: string
): Map<string, ParkedTab> {
  let chats = parkedTabs.get(streams);
  if (!chats) parkedTabs.set(streams, (chats = new Map()));
  let tabs = chats.get(session);
  if (!tabs) chats.set(session, (tabs = new Map()));
  return tabs;
}

/**
 * @internal Answer every parked tab with `frame`, each with the probe id it
 * asked with, and forget them.
 */
export function releaseParked(
  tabs: Map<string, ParkedTab>,
  frame: Readonly<Record<string, unknown>>
): void {
  for (const { connection, probeId } of tabs.values()) {
    sendIfOpen(
      connection,
      JSON.stringify({ ...frame, ...(probeId && { probeId }) })
    );
  }
  tabs.clear();
}

/** A turn streaming in this isolate, that a tool answer can join. */
export interface LiveTurn {
  readonly requestId: string;
  /** The id of the reply that streams, once it started. */
  replyId(): string | undefined;
  /** The calls the reply holds with no answer yet, in the order asked. */
  waitingCalls(): string[];
  inject(chunk: UIMessageChunk): void;
  /**
   * Run `fn` once, when the reply's last waiting call is answered: by a
   * tab's answer or by a server tool's output.
   */
  whenAnswered(fn: () => void): void;
}

/**
 * The metadata a turn stopped before it started carries (`Tasks.patchMetadata`,
 * under `chat`): it keeps its place in the lane, and when its turn comes it
 * stores its question and ends without calling the model.
 */
export const STOPPED_METADATA = { key: "chat", field: "stopped" } as const;

/** Replies whose batch an answer asked to continue, once it is answered. */
const continueRequests = new WeakMap<Streams, Set<string>>();

/** @internal The replies of this chat host an answer asked to continue. */
export function continueRequestsOf(streams: Streams): Set<string> {
  let wanted = continueRequests.get(streams);
  if (!wanted) continueRequests.set(streams, (wanted = new Set()));
  return wanted;
}

/**
 * The turns streaming in this isolate, by session: at most one per lane.
 * Kept per Streams capability (one per chat host), in memory only: a turn
 * that a reset cut off is continued from its stream, not from here.
 */
const liveTurns = new WeakMap<Streams, Map<string, LiveTurn>>();

/**
 * The attempt of each session still running in this isolate, as a promise
 * that settles when it has returned. At most one entry per lane.
 */
type Unwinding = { signal: AbortSignal; ended: Promise<void> };
const unwindingAttempts = new WeakMap<Streams, Map<string, Unwinding>>();

function unwindingOf(streams: Streams): Map<string, Unwinding> {
  let attempts = unwindingAttempts.get(streams);
  if (!attempts) unwindingAttempts.set(streams, (attempts = new Map()));
  return attempts;
}

/** @internal The live turns of the chat whose stream log is `streams`. */
export function liveTurnsOf(streams: Streams): Map<string, LiveTurn> {
  let turns = liveTurns.get(streams);
  if (!turns) liveTurns.set(streams, (turns = new Map()));
  return turns;
}

/**
 * Chunks after which the turn waits on work a replay must not repeat,
 * written at once rather than batched: a tool's call and outcome, and the
 * end of a step (the model is called again after it).
 */
const TOOL_EVENTS: ReadonlySet<string> = new Set([
  "tool-input-available",
  "tool-approval-request",
  "tool-output-available",
  "tool-output-error",
  "tool-output-denied",
  "finish-step"
]);

/**
 * When a turn's chunks are written: every 10 chunks or 512 KB, in one row
 * write, into the stream's newest block while it stays under 256 KB. A
 * crash loses at most the 9 chunks still buffered, as the hosts do today.
 */
export const CHUNK_BATCH = {
  maxChunks: 10,
  maxBytes: 512_000,
  fillBlocks: true
} as const;

/** The calls asked in `chunks` with no answer after them, in order. */
function waitingCallsOf(chunks: readonly UIMessageChunk[]): string[] {
  const waiting: string[] = [];
  for (const chunk of chunks) {
    const id = (chunk as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== "string") continue;
    if (chunk.type === "tool-input-available") waiting.push(id);
    if (
      chunk.type === "tool-output-available" ||
      chunk.type === "tool-output-error" ||
      chunk.type === "tool-output-denied"
    ) {
      const at = waiting.indexOf(id);
      if (at >= 0) waiting.splice(at, 1);
    }
  }
  return waiting;
}

/** The tool name of a tool part: its `toolName`, or its `tool-<name>` type. */
function toolNameOf(part: UIMessage["parts"][number]): string | undefined {
  const record = part as { toolName?: unknown; type?: unknown };
  if (typeof record.toolName === "string") return record.toolName;
  return typeof record.type === "string" && record.type.startsWith("tool-")
    ? record.type.slice(5)
    : undefined;
}

/** The run's checkpoint key holding the reply a continuation extends. */
const BASE_CHECKPOINT = "chat:base";
/** The run's checkpoint key counting the stream chunks recovery discarded. */
const DISCARDED_CHECKPOINT = "chat:discarded";
/**
 * The run's checkpoint key for its recovery incident: what the budget
 * counted so far (attempts, progress, interrupted attempts), read by the
 * next attempt that finds this one cut off.
 */
const INCIDENT_CHECKPOINT = "chat:incident";
/** The run's checkpoint key holding the app's latest `stash()` data. */
const STASH_CHECKPOINT = "chat:stash";

/**
 * Whether the turn of `step` ended because its recovery gave up: the budget
 * was spent, or the app chose not to continue. A host that reports such an
 * end differently from a failed reply asks here.
 *
 * @internal
 */
export function chatRecoveryGaveUp(step: TaskStep): boolean {
  const status =
    step.checkpoint.get<ChatRecoveryIncident>(INCIDENT_CHECKPOINT)?.status;
  return status === "exhausted" || status === "skipped";
}
/**
 * The run's checkpoint key for the failure that sent it to be tried again
 * (a provider's transient error, a stalled stream): its text, and how many
 * recovery attempts have ended that way.
 */
const FAILED_CHECKPOINT = "chat:failed";
/**
 * Names this object's instance among a turn's attempts, by its Tasks: a
 * reset makes a new instance, whose attempts count the old one's as
 * interrupted, even when the isolate lives on.
 */
const instanceIds = new WeakMap<Tasks, string>();

function instanceId(tasks: Tasks): string {
  let id = instanceIds.get(tasks);
  if (id === undefined) {
    id = crypto.randomUUID();
    instanceIds.set(tasks, id);
  }
  return id;
}

/** The least time between two writes of a turn's buffer when its model pauses. */
const PAUSE_FLUSH_MS = 50;

/** The run's checkpoint key: its request context was stored. */
const CONTEXT_CHECKPOINT = "chat:context";

/** The run's checkpoint key holding the id of the reply it stored. */
const REPLY_CHECKPOINT = "chat:reply";

/** The model's own error, sent as an `error` chunk in the stream. */
class InBandStreamError extends Error {}

/** A stream that sent nothing for the stall timeout. */
class StreamStalledError extends Error {
  constructor(readonly ms: number) {
    // The released text, which apps show and match on.
    super(
      `Chat stream stalled: no activity for ${ms}ms; the turn was aborted by the stall watchdog.`
    );
    this.name = "StreamStalledError";
  }
}

/**
 * `chunks` until `signal` aborts: then the model's stream is cancelled and
 * this one closes, so a model that ignores its signal cannot hold a stopped
 * turn open.
 */
function untilStopped(
  chunks: ReadableStream<UIMessageChunk>,
  signal: AbortSignal
): ReadableStream<UIMessageChunk> {
  const reader = chunks.getReader();
  let onAbort: (() => void) | undefined;
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      onAbort = () => {
        void reader.cancel(signal.reason).catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed or errored.
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (signal.aborted) return;
        if (next.done) {
          signal.removeEventListener("abort", onAbort!);
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (signal.aborted) return;
        signal.removeEventListener("abort", onAbort!);
        controller.error(error);
      }
    },
    cancel(reason) {
      signal.removeEventListener("abort", onAbort!);
      return reader.cancel(reason);
    }
  });
}

/** `chunks`, erroring with a stall when nothing arrives for `ms`. */
function watchStall(
  chunks: ReadableStream<UIMessageChunk>,
  ms: number | undefined,
  /** Calls already running when the stream starts (approved, continued). */
  alreadyRunning: Iterable<string> = [],
  clientTools: ReadonlySet<string> = new Set()
): ReadableStream<UIMessageChunk> {
  if (!ms || ms <= 0) return chunks;
  const reader = chunks.getReader();
  // Tool calls asked and not answered yet: while one runs, the model is
  // silent by design, and only the model's silence is a stall.
  const running = new Set<string>(alreadyRunning);
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        if (running.size === 0) {
          timer = setTimeout(() => reject(new StreamStalledError(ms)), ms);
        }
      });
      try {
        const next = await Promise.race([reader.read(), stalled]);
        if (next.done) {
          controller.close();
          return;
        }
        const id = (next.value as { toolCallId?: unknown }).toolCallId;
        if (typeof id === "string") {
          // A client tool runs in the tab, after this stream: it holds
          // nothing off.
          if (
            next.value.type === "tool-input-available" &&
            !clientTools.has(
              String((next.value as { toolName?: unknown }).toolName)
            )
          ) {
            running.add(id);
          } else if (
            // Waiting for an approval is not running; a preliminary output
            // (a tool's progress) is not its end.
            next.value.type === "tool-approval-request" ||
            (next.value.type === "tool-output-available" &&
              (next.value as { preliminary?: unknown }).preliminary !== true) ||
            next.value.type === "tool-output-error" ||
            next.value.type === "tool-output-denied"
          ) {
            running.delete(id);
          }
        }
        controller.enqueue(next.value);
      } catch (error) {
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

/** How a chat turn ended. */
export type ChatTurnResult = {
  readonly requestId: string;
  readonly status: "completed" | "error" | "aborted" | "skipped";
  /** The stored reply's id, when one was stored. */
  readonly messageId?: string;
  readonly error?: string;
  /** Why a "continue the last turn" was skipped. */
  readonly reason?: "nothing-to-continue" | "awaiting-client";
};

/** The input of a chat-turn run. */
export interface ChatTurnInput {
  /** `"continue"`: extend the last assistant message instead of answering. */
  readonly mode?: "continue";
  /** The session the turn is in, when one definition serves many. */
  readonly session?: string;
  readonly trigger: ChatModelCall["trigger"];
  readonly questionId?: string;
  readonly clientTools?: readonly ClientToolSchema[];
  readonly body?: Readonly<Record<string, unknown>>;
  /**
   * The messages the request brings that the transcript does not hold yet.
   * The turn stores them when it starts, so a question queued behind a
   * reply follows that reply.
   */
  readonly messages?: readonly UIMessage[];
  /** For a tool answer: the reply holding the answered call, to continue. */
  readonly replyId?: string;
  /** A host turn that stores its tools and body as the request context. */
  readonly storeContext?: true;
}

/**
 * @internal The progress credits a host gave turn `requestId` (run
 * metadata `chat.progressCredit`): an agent-tool child the turn waits on
 * streamed, which counts as the turn's progress, as released.
 */
export function progressCreditOf(deps: ChatDeps, requestId: string): number {
  const credit = (
    deps.tasks.peek(requestId)?.metadata?.chat as
      | { progressCredit?: unknown }
      | undefined
  )?.progressCredit;
  return typeof credit === "number" ? credit : 0;
}

/** The stream id a turn's reply is written under. */
export function chatTurnStreamId(requestId: string): string {
  return `chat-turn:${requestId}`;
}

/** The chunks a stream holds now, without waiting for more. */
async function storedChunks(
  streams: Streams,
  streamId: string
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  // What this isolate buffered is written first.
  streams.__DO_NOT_USE_WILL_BREAK__sync().flush(streamId);
  const stop = new AbortController();
  try {
    for await (const batch of streams.readBatches(streamId, {
      signal: stop.signal,
      onUpToDate: () => stop.abort()
    })) {
      for (const item of batch) {
        chunks.push(item.chunk as unknown as UIMessageChunk);
      }
      if (stop.signal.aborted) break;
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  }
  return chunks;
}

/** The message a list of chunks builds, continuing `message` when given. */
async function messageOf(
  chunks: ReadableStream<UIMessageChunk>,
  message?: UIMessage,
  each?: (snapshot: UIMessage) => void
): Promise<UIMessage | undefined> {
  let last = message;
  let failure: { error: unknown } | undefined;
  // A stream error (and an in-band error chunk) ends the read, and is
  // rethrown here: the caller decides whether the turn recovers.
  const stream = chunks.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "error") {
          failure ??= { error: new InBandStreamError(chunk.errorText) };
        }
        controller.enqueue(chunk);
      }
    })
  );
  try {
    for await (const snapshot of readUIMessageStream({
      stream,
      ...(message && { message }),
      terminateOnError: true,
      onError: (error) => {
        failure ??= { error };
      }
    })) {
      last = snapshot;
      each?.(snapshot);
    }
  } catch (error) {
    // The reader throws the error chunk's text as its own error: the
    // model's error is the one kept.
    throw failure?.error ?? error;
  }
  if (failure) throw failure.error;
  return last;
}

/** A tool part whose call the interruption cut off before its output. */
function isCutOffTool(part: UIMessage["parts"][number]): boolean {
  const type = (part as { type?: unknown }).type;
  const state = (part as { state?: unknown }).state;
  return (
    typeof type === "string" &&
    (type.startsWith("tool-") || type === "dynamic-tool") &&
    (state === "input-streaming" ||
      state === "input-available" ||
      // Only progress, no result: the tool had not finished.
      (state === "output-available" &&
        (part as { preliminary?: unknown }).preliminary === true) ||
      // Approved: it ran, or was about to, in the turn that was cut off.
      (state === "approval-responded" &&
        (part as { approval?: { approved?: unknown } }).approval?.approved ===
          true))
  );
}

/**
 * Settle each tool part the interruption cut off: through the host's hook,
 * or reported to the model as interrupted.
 */
function repairCutOffTools(
  message: UIMessage,
  hooks: ChatHooks | undefined,
  clientTools: readonly ClientToolSchema[]
): UIMessage {
  const answeredByClient = new Set(clientTools.map((tool) => tool.name));
  return {
    ...message,
    parts: message.parts.map((part) => {
      // Text or reasoning the cut left mid-stream is finished as it is.
      if (
        (part.type === "text" || part.type === "reasoning") &&
        (part as { state?: unknown }).state === "streaming"
      ) {
        return { ...part, state: "done" } as typeof part;
      }
      if (!isCutOffTool(part)) return part;
      // A client tool call with its whole input waits for the tab's answer;
      // one cut off mid-input can never be answered, so it is settled.
      const name = toolNameOf(part);
      if (
        name !== undefined &&
        answeredByClient.has(name) &&
        // An approved client tool waits for the tab's result too.
        ((part as { state?: unknown }).state === "input-available" ||
          (part as { state?: unknown }).state === "approval-responded")
      ) {
        return part;
      }
      const toolPart = part as InterruptedToolPart;
      return (
        hooks?.repairInterruptedToolPart?.(toolPart) ??
        ({
          ...toolPart,
          state: "output-error",
          errorText: "The tool call was interrupted before it finished."
        } as InterruptedToolPart)
      );
    })
  };
}

/** The reason a stop carries: Tasks' cancellation, an Error, or a string. */
function cancelReason(reason: unknown): string {
  if (reason instanceof TaskCancellation) return reason.reason ?? "";
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/**
 * @internal A turn waiting out its retry backoff, read before a cancel or a
 * clear: its handler does not run again, so whoever ends it settles its
 * stream. A stop keeps what it streamed as a stored reply, as a stop while
 * streaming does (`keep`, before the run ends, so the reply is stored in
 * its place before the next turn stores its question); a clear keeps
 * nothing. `undefined` for any other turn.
 */
export function retryingTurn(
  deps: ChatDeps,
  requestId: string
):
  | {
      keep(): Promise<string | undefined>;
      settle(keep: boolean): Promise<void>;
    }
  | undefined {
  const record = deps.tasks.peek(requestId);
  if (record?.status !== "pending" || record.waitReason !== "retry") {
    return undefined;
  }
  const base = deps.tasks.checkpointOf<{ id: string; parts: number }>(
    requestId,
    BASE_CHECKPOINT
  );
  const discarded =
    deps.tasks.checkpointOf<number>(requestId, DISCARDED_CHECKPOINT) ?? 0;
  const input = deps.tasks.inputOf<ChatTurnInput>(requestId);
  const streamId = chatTurnStreamId(requestId);
  const session = deps.sessions.session(input?.session ?? deps.session ?? "");
  // What the turn streamed, as its stored reply.
  // The id of the reply it stored, if it stored one.
  const keep = async (): Promise<string | undefined> => {
    if ((await deps.streams.status(streamId))?.state !== "streaming") {
      return undefined;
    }
    const stored = (await storedChunks(deps.streams, streamId))
      .slice(discarded)
      .filter((chunk) => chunk.type !== "error");
    const baseMessage = base
      ? ((await session.getMessage(base.id)) as unknown as UIMessage | null)
      : null;
    const built = await messageOf(
      new ReadableStream({
        start(controller) {
          for (const chunk of stored) controller.enqueue(chunk);
          controller.close();
        }
      }),
      baseMessage && base
        ? { ...baseMessage, parts: baseMessage.parts.slice(0, base.parts) }
        : undefined
    ).catch(() => undefined);
    if (!built || built.parts.length === 0) return undefined;
    await session.upsertMessage(
      repairCutOffTools(built, undefined, input?.clientTools ?? []) as never,
      input?.trigger === "regenerate-message" && input.questionId !== undefined
        ? { parentId: input.questionId }
        : {}
    );
    return built.id;
  };
  return {
    keep,
    async settle(kept) {
      if ((await deps.streams.status(streamId))?.state !== "streaming") return;
      if (kept) await keep();
      const out = await deps.streams.open(streamId, { tag: requestId });
      out.close({ discard: true });
    }
  };
}

/**
 * `chunks`, with the start of a text or reasoning part a model's deltas came
 * without (some send `text-delta` alone, or with no id) put in front of its
 * first delta, as the hosts' message builder accepted them.
 */
function withPartStarts(
  chunks: ReadableStream<UIMessageChunk>,
  requestId: string
): ReadableStream<UIMessageChunk> {
  const open = new Set<string>();
  return chunks.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        const kind =
          chunk.type === "text-start" ||
          chunk.type === "text-delta" ||
          chunk.type === "text-end"
            ? "text"
            : chunk.type === "reasoning-start" ||
                chunk.type === "reasoning-delta" ||
                chunk.type === "reasoning-end"
              ? "reasoning"
              : undefined;
        if (kind === undefined) {
          controller.enqueue(chunk);
          return;
        }
        const given = (chunk as { id?: unknown }).id;
        const id = typeof given === "string" ? given : `${requestId}-${kind}`;
        const key = `${kind}:${id}`;
        const next = (
          given === id ? chunk : { ...chunk, id }
        ) as UIMessageChunk;
        if (chunk.type === `${kind}-start`) open.add(key);
        else if (!open.has(key)) {
          if (chunk.type === `${kind}-end`) return;
          open.add(key);
          controller.enqueue({ type: `${kind}-start`, id } as UIMessageChunk);
        }
        if (chunk.type === `${kind}-end`) open.delete(key);
        controller.enqueue(next);
      }
    })
  );
}

/** Read what `respond` returned as UI message chunks. */
function chunksOf(
  source: ChatModelStream,
  requestId: string
): ReadableStream<UIMessageChunk> {
  if (source instanceof ReadableStream) return source;
  if ("toUIMessageStream" in source) return source.toUIMessageStream();
  // A `text/event-stream` body is a UI message stream; any other body is
  // plain text, one text part.
  const response =
    source instanceof Response && source.body
      ? responseSource(source, source.body, requestId)
      : undefined;
  const iterable: AsyncIterable<UIMessageChunk> = response
    ? (response.chunks as AsyncIterable<UIMessageChunk>)
    : source instanceof Response
      ? (async function* () {})()
      : source;
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      // A body read that is waiting holds the generator: the body itself is
      // cancelled, which ends that read.
      response?.cancel?.();
      await iterator.return?.();
    }
  });
}

/** The turn whose `respond` the caller runs inside, by request id. */
const runningTurn = new AsyncLocalStorage<string>();

/**
 * Run `fn` as part of the turn of `step`: `runningChatTurn()` names it, and
 * the app's `stash()` keeps its data in the run's checkpoint, for the
 * recovery of an attempt that is cut off. Data that cannot be kept is
 * skipped, and never fails the turn.
 */
function inTurn<T>(requestId: string, step: TaskStep, fn: () => T): T {
  return runningTurn.run(requestId, () =>
    withFiberStash(
      {
        id: requestId,
        signal: step.signal,
        stash: (data) => {
          try {
            // SAFETY: stash data is JSON, as it always was; the write throws
            // on anything else. `stash(undefined)` clears it.
            step.checkpoint.set(STASH_CHECKPOINT, (data ?? null) as TaskJson);
          } catch (error) {
            console.warn("[chat] turn stash data not kept:", error);
          }
        }
      },
      fn
    )
  );
}

/**
 * `chunks`, read inside the turn's context: a host that produces its reply
 * as it is read (its hooks and tools run then) runs that code there too.
 */
function insideTurn(
  requestId: string,
  step: TaskStep,
  chunks: ReadableStream<UIMessageChunk>
): ReadableStream<UIMessageChunk> {
  const reader = chunks.getReader();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const next = await inTurn(requestId, step, () => reader.read());
      if (!next.done) return controller.enqueue(next.value);
      // Read to its end: the host's stream is not left locked.
      reader.releaseLock();
      controller.close();
    },
    cancel: (reason) => inTurn(requestId, step, () => reader.cancel(reason))
  });
}

/**
 * The request id of the chat turn the caller runs inside: set while the
 * turn definition calls the host's `respond`, and seen by everything that
 * call starts. `undefined` anywhere else. A host uses it to refuse what
 * would wait on the turn from inside it.
 *
 * @internal
 */
export function runningChatTurn(): string | undefined {
  return runningTurn.getStore();
}

/**
 * The one chat-turn task handler. The host registers it on its Tasks under
 * the name it chooses, and starts runs on the lane it chooses. A run builds
 * its model call from its input and the session's transcript, calls the
 * host's `respond`, writes every chunk to the run's stream and stores the
 * reply in the session.
 *
 * @param options.name - The definition's name, for the host's own records.
 */
export function chatTurnDefinition(
  deps: ChatDeps,
  host: ChatHost,
  options: { name?: string } = {}
): (
  input: unknown,
  step: TaskStep
) => Promise<ChatTurnResult | TaskSettlement> {
  const attempt = async (
    input: unknown,
    step: TaskStep
  ): Promise<ChatTurnResult | TaskSettlement> => {
    const given = (input ?? {}) as ChatTurnInput;
    const requestId = step.id;
    const sessionId = given.session ?? deps.session ?? "";
    const session = deps.sessions.session(sessionId);
    const client =
      given.trigger === "submit-message" ||
      given.trigger === "regenerate-message";
    // A regenerate a question sent after it overtook has nothing to answer:
    // it never runs, and leaves the stored tools and body alone.
    if (
      given.trigger === "regenerate-message" &&
      step.checkpoint.get(CONTEXT_CHECKPOINT) === undefined
    ) {
      const noted = (
        deps.tasks.peek(requestId)?.metadata?.chat as
          | { questions?: unknown }
          | undefined
      )?.questions;
      if (Array.isArray(noted)) {
        const known = new Set([
          ...(noted as string[]),
          ...(given.messages ?? []).map((message) => message.id)
        ]);
        const overtaken = ((await session.getHistory()) as UIMessage[]).some(
          (message) => message.role === "user" && !known.has(message.id)
        );
        if (overtaken) {
          const frame = {
            type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
            id: requestId,
            body: "",
            done: true,
            outcome: "skipped",
            ...(messageIdsOf(deps.tasks.peek(requestId)?.metadata) && {
              messageIds: messageIdsOf(deps.tasks.peek(requestId)?.metadata)
            })
          };
          const text = frameText(frame);
          if (deps.webSockets && text !== undefined) {
            for (const connection of deps.webSockets.getConnections()) {
              sendIfOpen(connection, text);
            }
          }
          recordRecentChatTerminal(deps.kv, frame);
          const skipped = { requestId, status: "skipped" } as const;
          await host.hooks?.onResponse?.(skipped);
          return skipped;
        }
      }
    }
    // The request context, once per turn: a client's request (or a host
    // turn told to) stores its tools and body; a turn that brings none
    // runs with the stored ones, read now.
    // A turn stopped before it started never ran: it leaves the context.
    const stoppedEarly =
      (
        deps.tasks.peek(requestId)?.metadata?.[STOPPED_METADATA.key] as
          | Record<string, unknown>
          | undefined
      )?.[STOPPED_METADATA.field] === true;
    // A host turn fills what it does not bring from the stored context
    // first (it stores the result when told to); a client's request runs
    // with exactly what it sent.
    let run = given;
    if (
      !client &&
      (given.clientTools === undefined || given.body === undefined)
    ) {
      const stored = await session.internal_config(CHAT_REQUEST_CONTEXT_KEY);
      if (stored) {
        const context = JSON.parse(stored) as Pick<
          ChatTurnInput,
          "clientTools" | "body"
        >;
        const clientTools = given.clientTools ?? context.clientTools;
        const body = given.body ?? context.body;
        run = {
          ...given,
          ...(clientTools !== undefined && { clientTools }),
          ...(body !== undefined && { body })
        };
      }
    }
    const storeContext = async () => {
      if (stoppedEarly || step.checkpoint.get(CONTEXT_CHECKPOINT) !== undefined)
        return;
      await session.internal_setConfig(
        CHAT_REQUEST_CONTEXT_KEY,
        // One past the row budget is not kept (a later server turn runs
        // without it), as the hosts do today.
        storableRequestContext(
          run.clientTools?.length || (run.body && Object.keys(run.body).length)
            ? JSON.stringify({
                ...(run.clientTools?.length && {
                  clientTools: run.clientTools
                }),
                ...(run.body && { body: run.body })
              })
            : null
        )
      );
      step.checkpoint.set(CONTEXT_CHECKPOINT, true);
    };
    // A client's request stores its context when it starts; a host turn
    // told to stores it once it is sure to run (a "continue" with nothing
    // to continue leaves it alone).
    if (client) await storeContext();
    const streamId = chatTurnStreamId(requestId);
    // Every tab sees the reply as it streams, and how it ended.
    const send = (fields: Record<string, unknown>) => {
      const frame = {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: requestId,
        ...fields
      };
      const sockets = deps.webSockets;
      const text = sockets ? frameText(frame) : undefined;
      if (sockets && text !== undefined) {
        const offered = offeredIn(deps.streams);
        // A tab offered this stream gets it from the ack's replay.
        const without = [...offered]
          .filter(([, id]) => id === requestId)
          .map(([tab]) => tab);
        if (sockets.broadcast) sockets.broadcast(text, without);
        else {
          for (const connection of sockets.getConnections()) {
            if (!without.includes(connection.id)) sendIfOpen(connection, text);
          }
        }
      }
      // An end is kept, after it is sent, for a tab that is away now.
      if (fields.done === true) recordRecentChatTerminal(deps.kv, frame);
    };
    // A regenerated reply is a new branch under its question.
    // So is the reply to a question a tab sent again with the replies after
    // it taken off (a truncated list): the stored replies stay on the
    // branch the transcript leaves.
    const resent =
      run.trigger === "submit-message" &&
      run.questionId !== undefined &&
      !(run.messages ?? []).some((m) => m.id === run.questionId) &&
      ((await session.getLatestLeaf()) as { id?: string } | null)?.id !==
        run.questionId &&
      (await session.getMessage(run.questionId)) !== null;
    const placement =
      (run.trigger === "regenerate-message" || resent) &&
      run.questionId !== undefined
        ? { parentId: run.questionId }
        : {};
    // Tabs that asked to resume before this turn streamed.
    const parked = parkedIn(deps.streams, sessionId);
    const offerStream = () => {
      if (parked.size === 0) return;
      for (const [id, tab] of parked) {
        if (tab.asked) offeredIn(deps.streams).set(id, requestId);
      }
      releaseParked(parked, {
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: requestId
      });
    };
    // The reply this turn stored, when it stored one.
    let finalReply: UIMessage | undefined;
    // The transcript the turn read (repaired), once it read it.
    let turnTranscript: UIMessage[] | undefined;
    const report = async (
      result: ChatTurnResult,
      /** The model's own error chunk ended it: sent as an error frame. */
      inBand = false
    ) => {
      // A settled turn is not recovered: what it stashed for that goes.
      if (step.checkpoint.get(STASH_CHECKPOINT) != null) {
        step.checkpoint.set(STASH_CHECKPOINT, null);
      }
      // A stored reply that waits on no call has no batch left to continue.
      if (
        result.messageId !== undefined &&
        finalReply !== undefined &&
        !finalReply.parts.some((part) => {
          const state = (part as { state?: unknown }).state;
          return state === "input-available" || state === "approval-requested";
        })
      ) {
        continueRequestsOf(deps.streams).delete(result.messageId);
      }
      // A tab still waiting learns there is no stream to resume.
      if (parked.size > 0) {
        releaseParked(parked, { type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE });
      }
      // A continuation's end says so, as its other frames do; a client
      // request's end names the messages it came from.
      const continuation =
        run.trigger === "tool-answer" || run.mode === "continue";
      const messageIds = messageIdsOf(deps.tasks.peek(requestId)?.metadata);
      // The tabs get the stored transcript with the reply: before the end
      // frame for a reply that finished (the other tabs; the one that asked
      // read it from the stream), after it for a stop, so what the stream
      // showed and the transcript did not keep is dropped, not merged with
      // the stream a tab still reads.
      const origin = (
        deps.tasks.peek(requestId)?.metadata?.chat as
          | { origin?: unknown }
          | undefined
      )?.origin;
      const sendTranscript = async (exceptOrigin: boolean) => {
        const sockets = deps.webSockets;
        if (!sockets) return;
        // The transcript the turn read, with its stored reply: read again
        // only when the turn ended before it read one.
        const history = turnTranscript
          ? finalReply
            ? [
                ...turnTranscript.filter((m) => m.id !== finalReply?.id),
                finalReply
              ]
            : turnTranscript
          : ((await session.getHistory()) as UIMessage[]);
        // With the messages the waiting requests hold, named as queued.
        const text = frameText({
          type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
          ...(options.name
            ? chatClientView(
                deps.tasks,
                options.name,
                sessionId,
                history,
                deps.session ?? ""
              )
            : { messages: history })
        } as { type: string });
        if (text === undefined) return;
        for (const connection of sockets.getConnections()) {
          if (exceptOrigin && connection.id === origin) continue;
          sendIfOpen(connection, text);
        }
      };
      // A recovered reply is sent to the tab that asked too: what the chat
      // stored (repaired parts, sanitised, or not kept) need not be what the
      // tab put together from the attempts' streams.
      const recovered =
        step.attempt > 1 ||
        step.checkpoint.get(FAILED_CHECKPOINT) !== undefined;
      if (result.messageId !== undefined && result.status !== "aborted") {
        // A continuation's tab gets it too: it answered, it did not send
        // the reply's question.
        await sendTranscript(client && !recovered);
      }
      if (inBand && result.error !== undefined) {
        send({
          body: result.error,
          done: false,
          error: true,
          ...(continuation && { continuation: true })
        });
      }
      if (result.status !== "completed" && result.status !== "skipped") {
        // One error frame per failed reply: the model's own error was it.
        send({
          body: inBand ? "" : (result.error ?? ""),
          done: true,
          error: result.status === "error" && !inBand,
          outcome: result.status,
          ...(continuation && { continuation: true }),
          ...(messageIds && { messageIds })
        });
      } else {
        send({
          body: "",
          done: true,
          outcome: result.status,
          ...(continuation && { continuation: true }),
          ...(messageIds && { messageIds })
        });
      }
      // A tab away when the model's own error ended it learns that error:
      // the end is kept with it (the live end frame does not repeat it).
      if (inBand && result.error !== undefined) {
        recordRecentChatTerminal(deps.kv, {
          id: requestId,
          done: true,
          error: true,
          body: result.error,
          outcome: result.status,
          ...(continuation && { continuation: true }),
          ...(messageIds && { messageIds })
        });
      }
      if (result.status === "aborted") await sendTranscript(false);
      await host.hooks?.onResponse?.(result);
      return result;
    };
    /**
     * The cutover: the reply is stored, the stream settled and its rows
     * dropped, and the run marked as having stored it, in one transaction,
     * so a crash leaves the live stream or the stored reply, never neither,
     * and a replay after it does not answer again.
     */
    const storeReply = async (
      out: StreamWriter,
      message: UIMessage | undefined
    ): Promise<string | undefined> => {
      if (!message || message.parts.length === 0) {
        out.close({ discard: true });
        return undefined;
      }
      const stored = host.hooks?.sanitizeForPersistence?.(message) ?? message;
      finalReply = stored;
      const sync = session.__DO_NOT_USE_WILL_BREAK__sync();
      let after: (() => Promise<void>) | undefined;
      // A turn whose stream a reader replays after it ended (an agent-tool
      // run's parent, run metadata `chat.keepStream`) keeps it, completed.
      const keepStream =
        (
          deps.tasks.peek(requestId)?.metadata?.chat as
            | { keepStream?: unknown }
            | undefined
        )?.keepStream === true;
      try {
        out.close({
          discard: !keepStream,
          commit: () => {
            after = sync.upsert(stored as never, placement).after;
            step.checkpoint.set(REPLY_CHECKPOINT, stored.id);
          }
        });
      } catch (error) {
        sync.abandon();
        throw error;
      }
      // Settled by another path first: the reply still lands.
      if (after) await after();
      else {
        await session.upsertMessage(stored as never, placement);
        step.checkpoint.set(REPLY_CHECKPOINT, stored.id);
      }
      const max = host.options?.maxPersistedMessages;
      if (max !== undefined && max > 0) {
        const kept = await session.getHistory();
        if (kept.length > max) {
          await session.deleteMessages(
            kept.slice(0, kept.length - max).map((m) => m.id)
          );
        }
      }
      return stored.id;
    };
    // The chunks this attempt stored, to rebuild what it streamed if it
    // is stopped.
    const seen: UIMessageChunk[] = [];
    const streamOf = (chunks: readonly UIMessageChunk[]) =>
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      });
    const recovery = host.options?.recovery;
    const budget = resolveChatRecoveryConfig(
      recovery === false ? undefined : recovery
    );
    const maxAttempts = recovery === false ? 1 : budget.maxAttempts;
    // A failure worth another attempt: the stream stays open, and the next
    // attempt continues it after a backoff, asking the app and the budget. A recovery attempt that fails this way counts against
    // `maxAttempts`, however little time passed.
    const tryAgainAfter = async (error: unknown) => {
      const before = step.checkpoint.get<{ failures: number; retries: number }>(
        FAILED_CHECKPOINT
      );
      const failures = (before?.failures ?? 0) + 1;
      // A turn that has streamed nothing is not seen by the next attempt's
      // budget (it reads the stream): it is given up here once it has
      // failed `maxAttempts` times, so it cannot hold the lane for good.
      if (failures >= maxAttempts && !(await deps.streams.status(streamId))) {
        const reason = "max_attempts_exceeded";
        const ended = {
          incidentId: requestId,
          requestId,
          attempt: failures,
          maxAttempts,
          recoveryKind: "retry" as const
        };
        deps.emit?.("chat:recovery:failed", { ...ended, reason });
        try {
          await budget.onExhausted?.({
            ...ended,
            recoveryRootRequestId: requestId,
            streamId,
            createdAt: step.createdAt,
            partialText: "",
            partialParts: [],
            reason,
            terminalMessage: budget.terminalMessage
          });
        } catch (failure) {
          console.error(
            "[agents/chat] chatRecovery onExhausted hook threw",
            failure
          );
        }
        return report({
          requestId,
          status: "error",
          error: budget.terminalMessage
        });
      }
      step.checkpoint.set(FAILED_CHECKPOINT, {
        text: error instanceof Error ? error.message : String(error),
        // Until the next attempt has looked: this one ended itself.
        live: true,
        failures,
        retries:
          (before?.retries ?? 0) +
          (step.checkpoint.get(INCIDENT_CHECKPOINT) === undefined ? 0 : 1)
      });
      // The turn is being recovered from here on: its next attempt is
      // scheduled.
      deps.emit?.("chat:recovery:scheduled", {
        incidentId: requestId,
        requestId,
        attempt: failures,
        maxAttempts,
        recoveryKind: "continue"
      });
      // A provider that says how long to wait is believed, up to the cap.
      return TaskSettlement.retry(
        Date.now() +
          chatRecoveryBackoffSeconds(failures, retryAfterSeconds(error)) * 1000
      );
    };

    // An earlier attempt of this run was cut off: what it streamed is the
    // reply this attempt continues.
    // This run already stored its reply (a reset came after the cutover,
    // before the run returned): it is done.
    const storedReply = step.checkpoint.get<string>(REPLY_CHECKPOINT);
    if (storedReply !== undefined) {
      return report({ requestId, status: "completed", messageId: storedReply });
    }
    // The request's messages go in now, after every reply queued before it.
    // Stopped before it started: it stores its question in its place in
    // the lane, and ends without calling the model.
    const stopped =
      step.attempt === 1 &&
      (
        deps.tasks.peek(requestId)?.metadata?.[STOPPED_METADATA.key] as
          | Record<string, unknown>
          | undefined
      )?.[STOPPED_METADATA.field] === true;
    // A reply a tab sent back is a snapshot from before it finished: the
    // stored one stands.
    for (const message of run.messages ?? []) {
      // A stopped client request still stores its question (the tab sent
      // it); a stopped server turn stores nothing.
      if (stopped && (message.role !== "user" || run.trigger === "server")) {
        continue;
      }
      if (
        message.role === "assistant" &&
        (await session.getMessage(message.id)) !== null
      ) {
        continue;
      }
      await session.upsertMessage(message as never);
    }
    // The run ends aborted, as a stop of a running turn does.
    // Its tab was told it ended when it was stopped.
    if (stopped) {
      // A tab waiting for its stream learns there is none.
      const waiting = parkedIn(deps.streams, sessionId);
      if (waiting.size > 0) {
        releaseParked(waiting, { type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE });
      }
      await host.hooks?.onResponse?.({ requestId, status: "aborted" });
      return TaskSettlement.aborted("chat turn cancelled");
    }
    const earlier = await deps.streams.status(streamId);
    if (earlier && earlier.state !== "streaming") {
      return report({
        requestId,
        status: earlier.state === "completed" ? "completed" : "error"
      });
    }
    let partial: UIMessage | undefined;
    // The cut-off reply holds a tool's result: the tool ran, so the reply
    // is kept even when the app says not to keep it (#1631).
    let settledWork = false;
    if (earlier) {
      // Chunks an earlier attempt streamed and recovery discarded are not
      // part of the reply.
      const stored = (await storedChunks(deps.streams, streamId)).slice(
        step.checkpoint.get<number>(DISCARDED_CHECKPOINT) ?? 0
      );
      const streamedCount =
        (step.checkpoint.get<number>(DISCARDED_CHECKPOINT) ?? 0) +
        stored.length;
      // What this run streamed, not the reply it extends: a tool's result.
      settledWork = stored.some(
        (chunk) =>
          chunk.type === "tool-output-available" ||
          chunk.type === "tool-output-error" ||
          chunk.type === "tool-output-denied"
      );
      // A reply this run continues (a tool answer's) is the base the stream
      // extends: its first `parts` parts as they were when the run began.
      const base = step.checkpoint.get<{ id: string; parts: number }>(
        BASE_CHECKPOINT
      );
      const baseMessage = base
        ? ((await session.getMessage(base.id)) as unknown as UIMessage | null)
        : null;
      const built = await messageOf(
        new ReadableStream({
          start(controller) {
            // An error the model sent is not part of the reply.
            for (const chunk of stored) {
              if (chunk.type !== "error") controller.enqueue(chunk);
            }
            controller.close();
          }
        }),
        baseMessage && base
          ? { ...baseMessage, parts: baseMessage.parts.slice(0, base.parts) }
          : undefined
      );
      if (built && built.parts.length > 0) {
        partial = repairCutOffTools(built, host.hooks, run.clientTools ?? []);
        await session.upsertMessage(partial as never, placement);
      }
      // Drop what this run streamed: a reply it continues goes back to how
      // it was when the run began; a new reply is removed.
      const dropPartial = async () => {
        step.checkpoint.set(DISCARDED_CHECKPOINT, streamedCount);
        if (!partial) return;
        if (baseMessage && base) {
          await session.upsertMessage({
            ...baseMessage,
            parts: baseMessage.parts.slice(0, base.parts)
          } as never);
        } else {
          await session.deleteMessages([partial.id]);
        }
      };
      const partialParts = (partial?.parts ?? []) as never[];
      const partialText = (partial?.parts ?? [])
        .map((part) => ("text" in part ? String(part.text) : ""))
        .join("");
      // The budget over this turn's attempts, as the host's `chatRecovery`
      // sets it. What it counted is kept with the run.
      const counted =
        step.checkpoint.get<ChatRecoveryIncident>(INCIDENT_CHECKPOINT);
      const failed = step.checkpoint.get<{
        text: string;
        failures: number;
        retries: number;
        live?: boolean;
      }>(FAILED_CHECKPOINT);
      const thisAttempt = {
        isolate: instanceId(deps.tasks),
        token: crypto.randomUUID()
      };
      // A reply that waits on the client (a client tool's result, an
      // approval) is not stuck: the budget cannot give it up while it
      // waits. The app is still asked, since it may choose to drop it.
      const awaitsClient =
        partial !== undefined &&
        continuationWaitsOnClient(
          [partial],
          new Set((run.clientTools ?? []).map((tool) => tool.name))
        );
      const evaluated =
        recovery === false
          ? undefined
          : await evaluateChatRecoveryIncident({
              identity: {
                requestId,
                recoveryKind: partial ? "continue" : "retry"
              },
              // An attempt that ended itself to be tried again (a stall, a
              // transient failure) did not die: it is not an interrupted
              // attempt.
              trigger: failed?.live
                ? { kind: "stalled" }
                : { kind: "interrupted", attempt: thisAttempt },
              // Work is counted as released, one unit for ten chunks: the
              // budget is scaled to chunks here, and the app's hook is
              // told units.
              config: {
                ...budget,
                maxRecoveryWork: budget.maxRecoveryWork * CHUNK_BATCH.maxChunks,
                ...(budget.shouldKeepRecovering && {
                  shouldKeepRecovering: (context) =>
                    budget.shouldKeepRecovering?.({
                      ...context,
                      work: Math.ceil(context.work / CHUNK_BATCH.maxChunks)
                    }) ?? true
                })
              },
              existing: counted
                ? {
                    ...counted,
                    ...(failed &&
                      failed.retries > 0 && {
                        transientRetries: failed.retries
                      })
                  }
                : null,
              // Progress is every chunk streamed, so a little more counts,
              // and every credit the host gave the turn (an agent-tool
              // child it waits on streamed, run metadata
              // `chat.progressCredit`).
              currentProgress:
                streamedCount + progressCreditOf(deps, requestId),
              awaitingClientInteraction: awaitsClient,
              now: Date.now(),
              onShouldKeepRecoveringError: (error) =>
                console.error(
                  "[agents/chat] chatRecovery shouldKeepRecovering hook threw",
                  error
                )
            });
      if (evaluated) {
        // This attempt is in flight either way: if its isolate dies, the
        // next one counts it.
        const inFlight = failed?.live
          ? [
              ...(evaluated.incident.attemptsInFlight ?? []).filter(
                (attempt) => attempt.isolate === thisAttempt.isolate
              ),
              thisAttempt
            ]
          : evaluated.incident.attemptsInFlight;
        step.checkpoint.set(INCIDENT_CHECKPOINT, {
          ...evaluated.incident,
          ...(inFlight &&
            !evaluated.exhausted && { attemptsInFlight: inFlight })
        } as never);
        if (failed?.live) {
          step.checkpoint.set(FAILED_CHECKPOINT, { ...failed, live: false });
        }
        for (const { type, ...event } of evaluated.events) {
          deps.emit?.(type, event);
        }
      }
      const exhausted = recovery === false || evaluated?.exhausted === true;
      const attempt = evaluated?.incident.attempt ?? step.attempt;
      let decision: ChatRecoveryOptions | void = undefined;
      if (!exhausted) {
        try {
          decision = await host.hooks?.onRecovery?.({
            incidentId: requestId,
            recoveryRootRequestId: requestId,
            attempt,
            maxAttempts,
            recoveryKind: partial ? "continue" : "retry",
            streamId,
            requestId,
            partialText,
            partialParts,
            // What the turn stashed, and the request it was sent with.
            recoveryData: step.checkpoint.get(STASH_CHECKPOINT) ?? null,
            ...(run.body !== undefined && { lastBody: { ...run.body } }),
            ...(run.clientTools !== undefined &&
              run.clientTools.length > 0 && {
                lastClientTools: [...run.clientTools]
              }),
            messages: (await session.getHistory()) as unknown as UIMessage[],
            createdAt: step.createdAt
          });
        } catch (error) {
          // The app's hook failed: the turn is given up, as released
          // (`recovery_error`): nothing continues past a hook that did not
          // say to, and the tab gets the app's terminal message. What was
          // streamed stays stored.
          const text = error instanceof Error ? error.message : String(error);
          console.error("[agents/chat] onRecovery hook threw", error);
          const writer = await deps.streams.open(streamId, { tag: requestId });
          writer.error(text);
          const ended = {
            incidentId: requestId,
            requestId,
            attempt,
            maxAttempts,
            recoveryKind: partial ? ("continue" as const) : ("retry" as const)
          };
          deps.emit?.("chat:recovery:failed", {
            ...ended,
            reason: "recovery_error"
          });
          try {
            await budget.onExhausted?.({
              ...ended,
              recoveryRootRequestId: requestId,
              streamId,
              createdAt: step.createdAt,
              partialText,
              partialParts,
              reason: "recovery_error",
              terminalMessage: budget.terminalMessage
            });
          } catch (failure) {
            console.error(
              "[agents/chat] chatRecovery onExhausted hook threw",
              failure
            );
          }
          return report({
            requestId,
            status: "error",
            error: budget.terminalMessage
          });
        }
      }
      if (exhausted || decision?.continue === false) {
        // falls through below
      } else if (decision?.persist === false && !settledWork) {
        // Continue without what was streamed: the question is answered
        // again.
        await dropPartial();
        partial = undefined;
      }
      if (exhausted || decision?.continue === false) {
        // Given up: what was streamed stays stored (unless the app said
        // not to keep it), and the turn ends as an error.
        if (decision?.persist === false && !settledWork) await dropPartial();
        const writer = await deps.streams.open(streamId, { tag: requestId });
        writer.error("interrupted");
        const ended = {
          incidentId: requestId,
          requestId,
          attempt,
          maxAttempts,
          recoveryKind: partial ? "continue" : "retry"
        };
        if (!evaluated?.exhausted) {
          deps.emit?.("chat:recovery:skipped", {
            ...ended,
            reason: "continue_disabled"
          });
          if (evaluated) {
            step.checkpoint.set(INCIDENT_CHECKPOINT, {
              ...evaluated.incident,
              status: "skipped"
            } as never);
          }
          return report({
            requestId,
            status: "error",
            // The failure the app chose not to recover from, when there
            // was one.
            error: failed?.text ?? "The turn was interrupted and not continued."
          });
        }
        // The budget is spent: the app is told why, and the client gets the
        // message the app chose for it.
        deps.emit?.("chat:recovery:failed", {
          ...ended,
          reason: evaluated.incident.reason ?? "max_attempts_exceeded"
        });
        try {
          await budget.onExhausted?.({
            incidentId: requestId,
            requestId,
            recoveryRootRequestId: requestId,
            attempt,
            maxAttempts,
            recoveryKind: partial ? "continue" : "retry",
            streamId,
            createdAt: step.createdAt,
            partialText,
            partialParts,
            reason: evaluated.incident.reason ?? "max_attempts_exceeded",
            terminalMessage: budget.terminalMessage
          });
        } catch (error) {
          console.error(
            "[agents/chat] chatRecovery onExhausted hook threw",
            error
          );
        }
        return report({
          requestId,
          status: "error",
          error: budget.terminalMessage
        });
      }
    }

    // The transcript up to this turn's question (a regenerate of an older
    // question sees nothing after it), or to the reply it continues.
    const history = async (): Promise<UIMessage[]> => {
      const leaf =
        run.trigger === "tool-answer" && run.replyId !== undefined
          ? { leafId: run.replyId }
          : run.questionId !== undefined &&
              !partial &&
              run.trigger !== "tool-answer" &&
              run.mode !== "continue"
            ? { leafId: run.questionId }
            : {};
      // A byte budget reads only the newest messages that fit it.
      const budget = host.options?.hydrationByteBudget;
      // Zero, a negative or no finite budget reads the whole path, as the
      // hosts' hydration does.
      if (budget !== undefined && Number.isFinite(budget) && budget > 0) {
        return (await session.getRecentHistory(budget, leaf))
          .messages as unknown as UIMessage[];
      }
      return (await session.getHistory(leaf)) as unknown as UIMessage[];
    };
    const messages = await history();
    turnTranscript = messages;
    // "Continue the last turn", decided before anything is stored: with no
    // reply, or a reply still waiting on the client, there is nothing to
    // continue; a reply that holds nothing is removed and its question is
    // answered again.
    let answerAgain = false;
    if (
      !partial &&
      run.mode === "continue" &&
      run.trigger !== "tool-answer" &&
      step.checkpoint.get(BASE_CHECKPOINT) === undefined
    ) {
      const last = messages.at(-1);
      if (last?.role !== "assistant") {
        return report({
          requestId,
          status: "skipped",
          reason: "nothing-to-continue"
        });
      }
      if (
        continuationWaitsOnClient(
          messages,
          new Set((run.clientTools ?? []).map((tool) => tool.name))
        )
      ) {
        return report({
          requestId,
          status: "skipped",
          reason: "awaiting-client"
        });
      }
      if (replyIsRemovedAsEmpty(last)) {
        await session.deleteMessages([last.id]);
        messages.pop();
        answerAgain = true;
      }
    }
    // A tool answer's continuation has nothing to answer when the chat
    // moved on past its reply, when its reply already went on to the
    // model's answer, or when the reply still waits on a client. The answer
    // is stored either way, and the next turn's call reads it.
    if (
      !partial &&
      run.trigger === "tool-answer" &&
      step.checkpoint.get(BASE_CHECKPOINT) === undefined
    ) {
      // The chat's latest message, not the end of the path read up to the
      // reply.
      const latest = (await session.getLatestLeaf()) as { id?: string } | null;
      const dropped =
        run.replyId !== undefined && latest?.id !== run.replyId
          ? "moved_on"
          : transcriptEndsInAnswer(messages)
            ? "answered"
            : continuationWaitsOnClient(
                  messages,
                  new Set((run.clientTools ?? []).map((tool) => tool.name))
                )
              ? "awaiting_client"
              : undefined;
      if (dropped !== undefined) {
        deps.emit?.("chat:continuation:dropped", {
          requestId,
          reason: dropped
        });
        return report({
          requestId,
          status: "skipped",
          ...(dropped === "awaiting_client" && {
            reason: "awaiting-client" as const
          })
        });
      }
    }
    if (!client && run.storeContext) await storeContext();
    // A tool answer continues the reply that asked for it (named, or the
    // latest); a host's "continue the last turn" does the same.
    if (
      !partial &&
      !answerAgain &&
      (run.trigger === "tool-answer" || run.mode === "continue")
    ) {
      const last = messages.at(-1);
      if (last?.role === "assistant") {
        partial = last;
        if (step.checkpoint.get(BASE_CHECKPOINT) === undefined) {
          step.checkpoint.set(BASE_CHECKPOINT, {
            id: last.id,
            parts: last.parts.length
          });
        }
      }
    }
    // Before the model is asked: a call the transcript leaves unanswered
    // that nothing will answer in time is settled (a provider rejects a
    // request holding a call with no result), and a reply that holds
    // nothing is removed. The repaired transcript is stored, and the call
    // sees it. A stored reply that ends in reasoning is kept as it is (it
    // may have completed that way): the host leaves that reasoning out of
    // the request it builds ({@link requestMessages}).
    const clientToolNames = new Set(
      (run.clientTools ?? []).map((tool) => tool.name)
    );
    const before = [...messages];
    const repaired = repairTranscriptBeforeTurn(before, {
      continuation: partial !== undefined,
      clientToolNames,
      repairPart: (part) =>
        (host.hooks?.repairInterruptedToolPart?.(
          part as never
        ) as UIMessage["parts"][number]) ??
        interruptedToolPartAsError(part, { clientToolNames })
    });
    if (partial !== undefined && repaired.keptToolCallIds.length > 0) {
      // A continuation whose reply still waits on a client: its answer
      // starts the continuation.
      return report({
        requestId,
        status: "skipped",
        reason: "awaiting-client"
      });
    }
    const emptied = new Set(repaired.emptyReplyIds);
    if (
      repaired.removedToolCalls > 0 ||
      repaired.normalizedInputs > 0 ||
      repaired.removedReasoningParts > 0 ||
      emptied.size > 0
    ) {
      deps.emit?.("chat:transcript:repaired", {
        requestId,
        removedToolCalls: repaired.removedToolCalls,
        normalizedInputs: repaired.normalizedInputs,
        toolCallIds: repaired.toolCallIds,
        ...(repaired.removedReasoningParts > 0 && {
          removedReasoningParts: repaired.removedReasoningParts
        }),
        // As stored, reasoning included, so an app can keep its own copy.
        ...(emptied.size > 0 && {
          removedMessages: messages.filter((message) => emptied.has(message.id))
        })
      });
    }
    for (let i = 0; i < repaired.messages.length; i++) {
      const next = repaired.messages[i];
      if (emptied.has(next.id)) continue;
      if (next !== messages[i]) await session.upsertMessage(next as never);
    }
    if (emptied.size > 0) await session.deleteMessages([...emptied]);
    messages.splice(
      0,
      messages.length,
      ...repaired.messages.filter((message) => !emptied.has(message.id))
    );
    // The reply a continuation extends, as the repair left it (only when
    // the repair changed it).
    if (partial !== undefined) {
      const index = repaired.messages.findIndex((m) => m.id === partial?.id);
      if (index !== -1 && repaired.messages[index] !== before[index]) {
        partial = repaired.messages[index];
      }
    }
    let call: ChatModelCall = {
      session: sessionId,
      requestId,
      attempt: step.attempt,
      mode: partial ? "continue" : "answer",
      trigger: run.trigger ?? "submit-message",
      ...(run.questionId !== undefined && { questionId: run.questionId }),
      ...(partial && { replyId: partial.id }),
      messages,
      clientTools: run.clientTools ?? [],
      ...(run.body !== undefined && { body: run.body }),
      signal: step.signal,
      step: <T>(name: string, fn: () => Promise<T>) =>
        step.do(name, () => fn() as Promise<TaskValue>) as Promise<T>,
      checkpoint: step.checkpoint
    };
    const fallbackId = `${requestId}-reply`;
    let writer: StreamWriter | undefined;
    let parts: UIMessage["parts"] = partial?.parts ?? [];
    let reply: UIMessage | undefined;
    let overflowTried = false;
    for (;;) {
      let source: ChatModelStream | undefined;
      let modelChunks: ReadableStream<UIMessageChunk> | undefined;
      try {
        source = await inTurn(requestId, step, () => host.respond(call));
        // A reply that cannot be read (a body already taken) fails here,
        // before anything streamed, as a `respond` that throws does.
        if (source && !(step.signal.aborted && !writer)) {
          modelChunks = inTurn(requestId, step, () =>
            chunksOf(source as ChatModelStream, requestId)
          );
        }
      } catch (error) {
        // `respond` failed before anything streamed: a stop ends the turn
        // stopped, a transient failure retries, anything else ends it as
        // an error with the failure's message.
        if (step.signal.aborted) {
          writer?.close({ discard: true });
          return report({ requestId, status: "aborted" });
        }
        const verdict = host.hooks?.classifyError?.(error, false) ?? "terminal";
        if (verdict === "transient" && recovery !== false) {
          return tryAgainAfter(error);
        }
        const text = error instanceof Error ? error.message : String(error);
        if (writer) writer.error(text);
        return report({ requestId, status: "error", error: text });
      }
      if (!source) {
        writer?.close({ discard: true });
        return report({ requestId, status: "skipped" });
      }
      // Stopped or cleared while the model was asked: nothing it sends is
      // the turn's (a model that ignores its signal answers anyway).
      if (step.signal.aborted && !writer) {
        void Promise.resolve(source)
          .then((value) =>
            value instanceof Response
              ? value.body?.cancel()
              : (value as ReadableStream).cancel?.()
          )
          .catch(() => {});
        return report({ requestId, status: "aborted" });
      }
      const out = (writer ??= await deps.streams.open(streamId, {
        tag: requestId
      }));
      // A text or reasoning part the reply was cut off in is closed: the
      // continuation writes a part of its own after it.
      // The reply's parts before this stream, which the reader mutates.
      const continuingBefore: UIMessage["parts"] = structuredClone(
        partial?.parts ?? []
      );
      const continuing = partial && {
        ...partial,
        parts: partial.parts.map(
          (part) => settleInterruptedPart(part as never) as typeof part
        )
      };
      let started = false;
      // Chunks are written in batches (`CHUNK_BATCH`), as the hosts' reply
      // streams do; a reader flushes first.
      const sync = deps.streams.__DO_NOT_USE_WILL_BREAK__sync();
      const deltaParts = new Set<string>();
      // The batch is also written when the model pauses (at the end of a
      // burst), so a reset while it is quiet keeps what it sent; but at most
      // once per `PAUSE_FLUSH_MS`, so a model that streams a chunk every few
      // milliseconds does not write each chunk as its own row.
      let pauseTimer: ReturnType<typeof setTimeout> | undefined;
      let lastPauseFlush = 0;
      const flushWhenQuiet = () => {
        if (pauseTimer !== undefined) return;
        pauseTimer = setTimeout(
          () => {
            pauseTimer = undefined;
            lastPauseFlush = Date.now();
            try {
              sync.flush(streamId);
            } catch {
              // The stream settled meanwhile: nothing is left to write.
            }
          },
          Math.max(0, lastPauseFlush + PAUSE_FLUSH_MS - Date.now())
        );
      };
      /** Store `chunk`; its seq goes on the frame the tabs get (#1951). */
      const record = (chunk: UIMessageChunk): number => {
        const json = JSON.stringify(chunk);
        const bytes = utf8Length(json);
        let seq: number;
        // One past the capability's chunk limit goes through the writer,
        // which refuses it as it always has.
        if (bytes > Math.min(sync.maxChunkBytes, ROW_VALUE_BYTES)) {
          seq = out.append(chunk as never);
        } else {
          seq = sync.appendJson(streamId, json, bytes, CHUNK_BATCH);
          flushWhenQuiet();
        }
        // A tool call's input and its outcome are written at once: a tool
        // runs for as long as it takes, and a reset while it runs must find
        // the call stored (or the tool would run again).
        // A preliminary output (progress) waits for the batch. The first
        // delta of a text or reasoning part is written at once, as the
        // hosts' reply streams do: a short reply cut off is kept.
        const partId = (chunk as { id?: unknown }).id;
        const firstDelta =
          (chunk.type === "text-delta" || chunk.type === "reasoning-delta") &&
          typeof partId === "string" &&
          !deltaParts.has(partId);
        if (firstDelta) deltaParts.add(partId);
        // A part's id may come back in a later step: its next first delta
        // is written at once too.
        if (
          (chunk.type === "text-end" || chunk.type === "reasoning-end") &&
          typeof partId === "string"
        ) {
          deltaParts.delete(partId);
        }
        if (
          firstDelta ||
          (TOOL_EVENTS.has(chunk.type) &&
            (chunk as { preliminary?: unknown }).preliminary !== true)
        ) {
          sync.flush(streamId);
        }
        return seq;
      };
      const liveKey = sessionId;
      const live = liveTurnsOf(deps.streams);
      const answered: Array<() => void> = [];
      const waitingCalls = () => waitingCallsOf(seen);
      const checkAnswered = () => {
        if (answered.length > 0 && waitingCalls().length === 0) {
          for (const fn of answered.splice(0)) fn();
        }
      };
      const clientToolNames = new Set(
        (run.clientTools ?? []).map((tool) => tool.name)
      );
      const recorded = watchStall(
        untilStopped(
          withPartStarts(
            // Read inside the turn's context, as the reply's hooks run.
            insideTurn(
              requestId,
              step,
              modelChunks ??
                inTurn(requestId, step, () =>
                  chunksOf(source as ChatModelStream, requestId)
                )
            ),
            requestId
          ),
          step.signal
        ),
        recovery === false ? undefined : recovery?.stallTimeoutMs,
        // An approved call of the reply continued runs with no new input.
        (continuing?.parts ?? []).flatMap((part) => {
          const record = part as {
            toolCallId?: unknown;
            state?: unknown;
            approval?: { approved?: unknown };
          };
          const name = toolNameOf(part);
          // An approved client tool runs in the tab, not here.
          return typeof record.toolCallId === "string" &&
            record.state === "approval-responded" &&
            record.approval?.approved === true &&
            !(name !== undefined && clientToolNames.has(name))
            ? [record.toolCallId]
            : [];
        }),
        clientToolNames
      ).pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          start(controller) {
            // A tool answer that arrives while this reply streams joins it
            // as a chunk, stored and sent like the model's.
            live.set(liveKey, {
              requestId,
              replyId: () => {
                const start = seen.find((chunk) => chunk.type === "start");
                return (start as { messageId?: string } | undefined)?.messageId;
              },
              waitingCalls,
              whenAnswered: (fn) => {
                answered.push(fn);
                checkAnswered();
              },
              // Stored and sent like the model's chunks, through the host's
              // chunk hook.
              inject: (chunk) => {
                const next =
                  host.hooks?.transformChunk?.(chunk, parts) ?? chunk;
                record(next);
                // An answer the tab gave is durable before it is acted on.
                sync.flush(streamId);
                seen.push(next);
                send({
                  body: JSON.stringify(next),
                  done: false,
                  ...(continuing && { continuation: true })
                });
                controller.enqueue(next);
                checkAnswered();
              }
            });
          },
          flush() {
            if (live.get(liveKey)?.requestId === requestId)
              live.delete(liveKey);
          },
          transform(chunk, controller) {
            // After a stop or a clear, what the model still sends is dropped.
            if (step.signal.aborted) return;
            // Every reply has an id: a continuation keeps the reply's, a new
            // reply keeps the model's or gets one from the run.
            if (!started) offerStream();
            // A continuation's start goes to the tabs without its message
            // id: a tab that gets one starts a second assistant message
            // instead of extending the reply (#1229).
            const replyBefore = continuingBefore;
            const forTabs = (c: UIMessageChunk): UIMessageChunk => {
              if (!continuing || c.type !== "start") return c;
              const { messageId: _id, ...rest } = c as { messageId?: string };
              return rest as UIMessageChunk;
            };
            if (!started && chunk.type !== "start") {
              started = true;
              const synthetic = {
                type: "start",
                messageId: continuing?.id ?? fallbackId
              } as UIMessageChunk;
              // Through the chunk hook like every other chunk, so a host
              // that mirrors the reply (ThinkHarness's live partial) holds
              // what the stream stores, in the same order.
              const start =
                inTurn(requestId, step, () =>
                  host.hooks?.transformChunk?.(synthetic, parts)
                ) ?? synthetic;
              const startSeq = record(start);
              seen.push(start);
              // A new reply the model began with no start reaches the tabs as
              // the model sent it (a plain-text reply starts at its text);
              // a continuation's start marks it as one.
              if (continuing) {
                send({
                  body: JSON.stringify(forTabs(start)),
                  done: false,
                  seq: startSeq,
                  continuation: true,
                  messageId: continuing.id
                });
              }
              controller.enqueue(start);
            }
            started = true;
            const own =
              chunk.type === "start" && (continuing || !chunk.messageId)
                ? ({
                    ...chunk,
                    messageId: continuing?.id ?? fallbackId
                  } as UIMessageChunk)
                : chunk;
            // In the turn's context, as the reply's other hooks run: a
            // chunk hook may stash.
            const next =
              inTurn(requestId, step, () =>
                host.hooks?.transformChunk?.(own, parts)
              ) ?? own;
            // An in-band error is stored only if it ends the turn, and the
            // tabs get it as an error frame when the turn ends.
            if (next.type === "error") {
              controller.enqueue(next);
              return;
            }
            // A call's input that arrives after its approval request is
            // followed by the request again: a tab moves the part to
            // `input-available` on the input, and would lose the approval.
            const asked =
              next.type === "tool-input-available"
                ? seen.find(
                    (c) =>
                      c.type === "tool-approval-request" &&
                      (c as { toolCallId?: unknown }).toolCallId ===
                        (next as { toolCallId?: unknown }).toolCallId
                  )
                : undefined;
            // A provider that replays an earlier tool round trip (#1404)
            // re-sends chunks for calls the reply holds: they are dropped,
            // neither sent (they move a settled part back on a tab) nor
            // stored (the reader would reopen the settled part). Judged
            // against the reply as it was before this stream.
            if (!asked && isReplayChunk(replyBefore as never, next as never)) {
              return;
            }
            for (const out of asked ? [next, asked] : [next]) {
              const seq = record(out);
              seen.push(out);
              checkAnswered();
              // A continuation's chunks name the message they go into (D70).
              send({
                body: JSON.stringify(forTabs(out)),
                done: false,
                seq,
                ...(continuing && {
                  continuation: true,
                  messageId: continuing.id
                })
              });
              controller.enqueue(out);
            }
          }
        })
      );
      // What the reply streamed so far, stored as it ends cut off (a stop or
      // a failure): an open text part closed, reasoning it ends in dropped
      // (no provider takes a reply that ends that way), nothing stored when
      // it then holds nothing.
      const keepSoFar = async (
        failed?: string
      ): Promise<string | undefined> => {
        // From the reply as it was before this stream: the reader has
        // already put what this stream sent into `continuing`.
        const base = partial && {
          ...partial,
          parts: structuredClone(continuingBefore).map(
            (part) => settleInterruptedPart(part as never) as typeof part
          )
        };
        const soFar = await messageOf(streamOf(seen), base).catch(() => base);
        const settled =
          soFar &&
          stripTrailingReasoning({
            ...soFar,
            parts: soFar.parts.map(
              (part) => settleInterruptedPart(part as never) as typeof part
            )
          });
        const keep =
          settled && !replyIsRemovedAsEmpty(settled)
            ? repairCutOffTools(settled, host.hooks, run.clientTools ?? [])
            : undefined;
        // A failure with nothing to keep leaves its stream errored.
        if (!keep && failed !== undefined) {
          out.error(failed);
          return undefined;
        }
        return storeReply(out, keep);
      };
      try {
        reply = await messageOf(recorded, continuing, (snapshot) => {
          parts = snapshot.parts;
        });
        // A model stream that closed when the turn was stopped did not
        // finish: the turn ends stopped, as a thrown stop does.
        if (step.signal.aborted)
          throw step.signal.reason ?? new Error("stopped");
        break;
      } catch (error) {
        if (live.get(liveKey)?.requestId === requestId) live.delete(liveKey);
        if (step.signal.aborted) {
          // A cleared chat keeps nothing of the turn.
          // It ends `skipped`, as a turn a clear reaches before it starts.
          if (cancelReason(step.signal.reason) === CHAT_CLEARED) {
            out.close({ discard: true });
            return report({ requestId, status: "skipped" });
          }
          // A stopped turn keeps what it streamed, as a stored reply.
          const kept = await keepSoFar();
          return report({
            requestId,
            status: "aborted",
            ...(kept && { messageId: kept })
          });
        }
        if (error instanceof StreamStalledError) {
          deps.emit?.("chat:stream:stalled", {
            requestId,
            timeoutMs: error.ms
          });
        }
        const verdict =
          error instanceof StreamStalledError
            ? "transient"
            : (host.hooks?.classifyError?.(
                error,
                error instanceof InBandStreamError
              ) ?? "terminal");
        if (
          verdict === "overflow" &&
          !overflowTried &&
          (await host.hooks?.onContextOverflow?.(call))
        ) {
          // Room was made: ask the model again, once, with the transcript
          // as it is now.
          overflowTried = true;
          call = { ...call, messages: await history() };
          continue;
        }
        if (verdict === "transient" && recovery !== false) {
          return tryAgainAfter(error);
        }
        const text = error instanceof Error ? error.message : String(error);
        // A failed reply keeps what it streamed too, and the tabs see it
        // stored before the error frame.
        const kept = await keepSoFar(text);
        return report(
          {
            requestId,
            status: "error",
            error: text,
            ...(kept && { messageId: kept })
          },
          error instanceof InBandStreamError
        );
      }
    }

    const storedId =
      reply && reply.parts.length > 0
        ? await storeReply(writer as StreamWriter, reply)
        : (writer?.close({ discard: true }), undefined);
    // A turn that was recovered on the way says so, as it always has.
    const recovered =
      step.checkpoint.get<ChatRecoveryIncident>(INCIDENT_CHECKPOINT);
    if (recovered) {
      deps.emit?.("chat:recovery:completed", {
        incidentId: requestId,
        requestId,
        attempt: recovered.attempt,
        maxAttempts: recovered.maxAttempts,
        recoveryKind: recovered.recoveryKind
      });
    }
    return report({
      requestId,
      status: "completed",
      ...(storedId && { messageId: storedId })
    });
  };
  return (input, step) => {
    const sessionId =
      ((input ?? {}) as ChatTurnInput).session ?? deps.session ?? "";
    // A stop ends a run at once, while its attempt is still storing what it
    // streamed: the next turn's attempt starts after that, so its question
    // follows that reply. Only a stopped attempt is waited for: it ends as
    // soon as it has stored its reply.
    const unwinding = unwindingOf(deps.streams);
    const earlier = unwinding.get(sessionId);
    const mine = earlier?.signal.aborted
      ? earlier.ended.then(() => attempt(input, step))
      : attempt(input, step);
    const entry: Unwinding = {
      signal: step.signal,
      ended: mine.then(
        () => {},
        () => {}
      )
    };
    unwinding.set(sessionId, entry);
    void entry.ended.then(() => {
      if (unwinding.get(sessionId) === entry) unwinding.delete(sessionId);
    });
    return mine;
  };
}
