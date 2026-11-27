/**
 * The chat module's host contract (design/rfc-slim-hosts.md, "The chat
 * module"): what a host gives the one chat-turn definition. A host supplies
 * `respond` (its model call) and optional hooks; the module owns the turn's
 * run, its stream and its stored reply.
 *
 * @internal Sibling-package support for `@cloudflare/think` and
 * `@cloudflare/ai-chat`, not a public API.
 */

import { readUIMessageStream } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";
import type { Sessions } from "../sessions/sessions";
import type { Streams } from "../streams/streams";
import type { Tasks } from "../tasks/tasks";
import type { TaskStep, TaskValue } from "../tasks/types";
import type { StreamWriter } from "../streams/types";
import type { WebSockets } from "../websockets/websockets";
import type { Connection } from "agents";
import type { ClientToolSchema } from "./client-tools";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "./lifecycle";
import { chatRecoveryBackoffSeconds } from "./recovery-engine";
import { TaskSettlement } from "../tasks/settlement";
import { TaskCancellation } from "../tasks/replay";
import { frameText } from "./chat-frames";
import { sendIfOpen } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { responseSource } from "./reply-source";

/** The capabilities the chat functions are given. They own every row and job. */
export interface ChatDeps {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly sessions: Sessions;
  /** Absent for a host that owns no sockets (a harness inside an agent). */
  readonly webSockets?: WebSockets;
  /** The Sessions session the chat's transcript is in. */
  readonly session?: string;
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
   * `false` gives up on an interrupted turn. Otherwise a turn is attempted
   * up to `maxAttempts` times (default 3), with a backoff between attempts,
   * and a stream that sends nothing for `stallTimeoutMs` is treated as
   * interrupted.
   */
  readonly recovery?:
    | false
    | { readonly maxAttempts?: number; readonly stallTimeoutMs?: number };
}

/** What a host supplies. */
export interface ChatHost {
  respond(call: ChatModelCall): Promise<ChatModelStream | undefined>;
  readonly hooks?: ChatHooks;
  readonly options?: ChatOptions;
}

/** The reason a chat clear cancels its turns with. */
export const CHAT_CLEARED = "chat cleared";

/** @internal A tab waiting for a turn's stream, and the probe it asked with. */
export interface ParkedTab {
  readonly connection: Connection;
  readonly probeId?: string;
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
}

/**
 * The turns streaming in this isolate, by session: at most one per lane.
 * Kept per Streams capability (one per chat host), in memory only: a turn
 * that a reset cut off is continued from its stream, not from here.
 */
const liveTurns = new WeakMap<Streams, Map<string, LiveTurn>>();

/** @internal The live turns of the chat whose stream log is `streams`. */
export function liveTurnsOf(streams: Streams): Map<string, LiveTurn> {
  let turns = liveTurns.get(streams);
  if (!turns) liveTurns.set(streams, (turns = new Map()));
  return turns;
}

/** The run's checkpoint key holding the reply a continuation extends. */
const BASE_CHECKPOINT = "chat:base";
/** The run's checkpoint key counting the stream chunks recovery discarded. */
const DISCARDED_CHECKPOINT = "chat:discarded";

/** The run's checkpoint key holding the id of the reply it stored. */
const REPLY_CHECKPOINT = "chat:reply";

/** The default number of attempts of an interrupted turn. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** The model's own error, sent as an `error` chunk in the stream. */
class InBandStreamError extends Error {}

/** A stream that sent nothing for the stall timeout. */
class StreamStalledError extends Error {
  constructor(ms: number) {
    super(`The model stream sent nothing for ${ms} ms.`);
    this.name = "StreamStalledError";
  }
}

/** `chunks`, erroring with a stall when nothing arrives for `ms`. */
function watchStall(
  chunks: ReadableStream<UIMessageChunk>,
  ms: number | undefined,
  /** Calls already running when the stream starts (approved, continued). */
  alreadyRunning: Iterable<string> = []
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
          if (next.value.type === "tool-input-available") running.add(id);
          else if (
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
};

/** The input of a chat-turn run. */
export interface ChatTurnInput {
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
      const name =
        (part as { toolName?: unknown }).toolName ??
        ((part as { type: string }).type.startsWith("tool-")
          ? (part as { type: string }).type.slice(5)
          : undefined);
      if (
        typeof name === "string" &&
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

/** Read what `respond` returned as UI message chunks. */
function chunksOf(
  source: ChatModelStream,
  requestId: string
): ReadableStream<UIMessageChunk> {
  if (source instanceof ReadableStream) return source;
  if ("toUIMessageStream" in source) return source.toUIMessageStream();
  // A `text/event-stream` body is a UI message stream; any other body is
  // plain text, one text part.
  const iterable: AsyncIterable<UIMessageChunk> =
    source instanceof Response
      ? source.body
        ? (responseSource(source, source.body, requestId)
            .chunks as AsyncIterable<UIMessageChunk>)
        : (async function* () {})()
      : source;
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    }
  });
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
  void options;
  return async (input, step) => {
    const run = (input ?? {}) as ChatTurnInput;
    const requestId = step.id;
    const sessionId = run.session ?? deps.session ?? "";
    const session = deps.sessions.session(sessionId);
    const streamId = chatTurnStreamId(requestId);
    // Every tab sees the reply as it streams, and how it ended.
    const send = (fields: Record<string, unknown>) => {
      if (!deps.webSockets) return;
      const frame = {
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: requestId,
        ...fields
      };
      const text = frameText(frame);
      if (text === undefined) return;
      for (const connection of deps.webSockets.getConnections()) {
        sendIfOpen(connection, text);
      }
    };
    // A regenerated reply is a new branch under its question.
    const placement =
      run.trigger === "regenerate-message" && run.questionId !== undefined
        ? { parentId: run.questionId }
        : {};
    // Tabs that asked to resume before this turn streamed.
    const parked = parkedIn(deps.streams, sessionId);
    const offerStream = () => {
      if (parked.size === 0) return;
      releaseParked(parked, {
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: requestId
      });
    };
    const report = async (result: ChatTurnResult) => {
      // A tab still waiting learns there is no stream to resume.
      if (parked.size > 0) {
        releaseParked(parked, { type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE });
      }
      if (result.status !== "completed" && result.status !== "skipped") {
        send({
          body: result.error ?? "",
          done: true,
          error: result.status === "error",
          outcome: result.status
        });
      } else {
        send({ body: "", done: true, outcome: result.status });
      }
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
      const sync = session.__DO_NOT_USE_WILL_BREAK__sync();
      let after: (() => Promise<void>) | undefined;
      try {
        out.close({
          discard: true,
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
    const maxAttempts =
      recovery === false ? 1 : (recovery?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    // An interruption this attempt can't finish: the stream stays open and
    // the next attempt continues it after a backoff, within the budget.
    const interrupted = () =>
      TaskSettlement.retry(
        Date.now() + chatRecoveryBackoffSeconds(step.attempt) * 1000
      );

    // An earlier attempt of this run was cut off: what it streamed is the
    // reply this attempt continues.
    // This run already stored its reply (a reset came after the cutover,
    // before the run returned): it is done.
    const storedReply = step.checkpoint.get<string>(REPLY_CHECKPOINT);
    if (storedReply !== undefined) {
      return report({ requestId, status: "completed", messageId: storedReply });
    }
    // The request's messages go in now, after every reply queued before it.
    // A reply a tab sent back is a snapshot from before it finished: the
    // stored one stands.
    for (const message of run.messages ?? []) {
      if (
        message.role === "assistant" &&
        (await session.getMessage(message.id)) !== null
      ) {
        continue;
      }
      await session.upsertMessage(message as never);
    }
    const earlier = await deps.streams.status(streamId);
    if (earlier && earlier.state !== "streaming") {
      return report({
        requestId,
        status: earlier.state === "completed" ? "completed" : "error"
      });
    }
    let partial: UIMessage | undefined;
    if (earlier) {
      // Chunks an earlier attempt streamed and recovery discarded are not
      // part of the reply.
      const stored = (await storedChunks(deps.streams, streamId)).slice(
        step.checkpoint.get<number>(DISCARDED_CHECKPOINT) ?? 0
      );
      const streamedCount =
        (step.checkpoint.get<number>(DISCARDED_CHECKPOINT) ?? 0) +
        stored.length;
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
      let decision: ChatRecoveryOptions | void = undefined;
      if (recovery !== false && step.attempt <= maxAttempts) {
        decision = await host.hooks?.onRecovery?.({
          incidentId: requestId,
          recoveryRootRequestId: requestId,
          attempt: step.attempt,
          maxAttempts,
          recoveryKind: partial ? "continue" : "retry",
          streamId,
          requestId,
          partialText: (partial?.parts ?? [])
            .map((part) => ("text" in part ? String(part.text) : ""))
            .join(""),
          partialParts,
          recoveryData: null,
          messages: (await session.getHistory()) as unknown as UIMessage[],
          createdAt: step.createdAt
        });
      }
      if (
        recovery === false ||
        step.attempt > maxAttempts ||
        decision?.continue === false
      ) {
        // falls through below
      } else if (decision?.persist === false) {
        // Continue without what was streamed: the question is answered
        // again.
        await dropPartial();
        partial = undefined;
      }
      if (
        recovery === false ||
        step.attempt > maxAttempts ||
        decision?.continue === false
      ) {
        // Given up: what was streamed stays stored (unless the app said
        // not to keep it), and the turn ends as an error.
        if (decision?.persist === false) await dropPartial();
        const writer = await deps.streams.open(streamId, { tag: requestId });
        writer.error("interrupted");
        return report({
          requestId,
          status: "error",
          error: "The turn was interrupted and not continued."
        });
      }
    }

    // The transcript up to this turn's question (a regenerate of an older
    // question sees nothing after it), or to the reply it continues.
    const history = async () =>
      (await session.getHistory(
        run.trigger === "tool-answer" && run.replyId !== undefined
          ? { leafId: run.replyId }
          : run.questionId !== undefined &&
              !partial &&
              run.trigger !== "tool-answer"
            ? { leafId: run.questionId }
            : {}
      )) as unknown as UIMessage[];
    const messages = await history();
    // A tool answer continues the reply that asked for it (named, or the
    // latest).
    if (!partial && run.trigger === "tool-answer") {
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
        step.do(name, () => fn() as Promise<TaskValue>) as Promise<T>
    };
    const fallbackId = `${requestId}-reply`;
    let writer: StreamWriter | undefined;
    let parts: UIMessage["parts"] = partial?.parts ?? [];
    let reply: UIMessage | undefined;
    let overflowTried = false;
    for (;;) {
      const source = await host.respond(call);
      if (!source) {
        writer?.close({ discard: true });
        return report({ requestId, status: "skipped" });
      }
      const out = (writer ??= await deps.streams.open(streamId, {
        tag: requestId
      }));
      const continuing = partial;
      let started = false;
      const liveKey = sessionId;
      const live = liveTurnsOf(deps.streams);
      const recorded = watchStall(
        chunksOf(source, requestId),
        recovery === false ? undefined : recovery?.stallTimeoutMs,
        // An approved call of the reply continued runs with no new input.
        (continuing?.parts ?? []).flatMap((part) => {
          const record = part as {
            toolCallId?: unknown;
            state?: unknown;
            approval?: { approved?: unknown };
          };
          return typeof record.toolCallId === "string" &&
            record.state === "approval-responded" &&
            record.approval?.approved === true
            ? [record.toolCallId]
            : [];
        })
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
              waitingCalls: () => {
                const waiting: string[] = [];
                for (const chunk of seen) {
                  const id = (chunk as { toolCallId?: unknown }).toolCallId;
                  if (typeof id !== "string") continue;
                  if (chunk.type === "tool-input-available") waiting.push(id);
                  if (
                    chunk.type === "tool-output-available" ||
                    chunk.type === "tool-output-error"
                  ) {
                    const at = waiting.indexOf(id);
                    if (at >= 0) waiting.splice(at, 1);
                  }
                }
                return waiting;
              },
              // Stored and sent like the model's chunks, through the host's
              // chunk hook.
              inject: (chunk) => {
                const next =
                  host.hooks?.transformChunk?.(chunk, parts) ?? chunk;
                out.append(next as never);
                seen.push(next);
                send({
                  body: JSON.stringify(next),
                  done: false,
                  ...(continuing && { continuation: true })
                });
                controller.enqueue(next);
              }
            });
          },
          flush() {
            if (live.get(liveKey)?.requestId === requestId)
              live.delete(liveKey);
          },
          transform(chunk, controller) {
            // Every reply has an id: a continuation keeps the reply's, a new
            // reply keeps the model's or gets one from the run.
            if (!started) offerStream();
            if (!started && chunk.type !== "start") {
              started = true;
              const start = {
                type: "start",
                messageId: continuing?.id ?? fallbackId
              } as UIMessageChunk;
              out.append(start as never);
              seen.push(start);
              send({
                body: JSON.stringify(start),
                done: false,
                ...(continuing && { continuation: true })
              });
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
            const next = host.hooks?.transformChunk?.(own, parts) ?? own;
            // An in-band error is stored only if it ends the turn.
            if (next.type !== "error") {
              out.append(next as never);
              seen.push(next);
            }
            send({
              body: JSON.stringify(next),
              done: false,
              ...(continuing && { continuation: true })
            });
            controller.enqueue(next);
          }
        })
      );
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
          if (cancelReason(step.signal.reason) === CHAT_CLEARED) {
            out.close({ discard: true });
            return report({ requestId, status: "aborted" });
          }
          // A stopped turn keeps what it streamed, as a stored reply.
          const soFar = await messageOf(streamOf(seen), continuing).catch(
            () => continuing
          );
          const kept = await storeReply(
            out,
            soFar && repairCutOffTools(soFar, host.hooks, run.clientTools ?? [])
          );
          return report({
            requestId,
            status: "aborted",
            ...(kept && { messageId: kept })
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
          if (step.attempt < maxAttempts) return interrupted();
        }
        const text = error instanceof Error ? error.message : String(error);
        out.error(text);
        return report({ requestId, status: "error", error: text });
      }
    }

    const storedId =
      reply && reply.parts.length > 0
        ? await storeReply(writer as StreamWriter, reply)
        : (writer?.close({ discard: true }), undefined);
    return report({
      requestId,
      status: "completed",
      ...(storedId && { messageId: storedId })
    });
  };
}
