/**
 * The reply pump: everything between "the model returned a stream" and "the
 * reply is stored and the request has its terminal frame", once, for both
 * chat hosts.
 *
 * For one reply it starts the resumable stream, builds the message in a
 * {@link StreamAccumulator}, and for each chunk stores it, sends its frame to
 * sockets and hands it to the caller's sink. It stops on the turn's signal,
 * the stall watchdog, an in-band error or a thrown one. A transient error
 * or a stall is routed to recovery. Otherwise it settles the reply: a
 * cut-off reply's unanswered calls are settled, the reply is stored, stored
 * again while a tool result landed during the write, and only then is the
 * terminal frame sent (#2119).
 *
 * Durable: the stored chunks (see {@link ReplyStreams.store} for when they
 * reach SQLite) and the stored reply, which the host writes in the same
 * transaction that settles the stream. In memory: the accumulator, the
 * held terminal frame, the sink. A crash loses the unflushed deltas at the
 * end of the stream; orphan recovery rebuilds the reply from what is stored.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { UIMessage } from "ai";
import type { ChatResponseResult } from "./lifecycle";
import {
  isReplayChunk,
  lateToolInputForwardChunks,
  settleInterruptedPart,
  type MessagePart,
  type StreamChunkData
} from "./message-builder";
import { takeAtFirstContent } from "./recovery-codec";
import type { StreamInterruptionOutcome } from "./recovery-route";
import { streamErrorText, type ReplySource } from "./reply-source";
import type {
  ReplyFlushState,
  ReplyStreamLog,
  ReplyStreamResult
} from "./reply-stream";
import {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "./stall-watchdog";
import { StreamAccumulator } from "./stream-accumulator";
import {
  crossMessageToolResultUpdate,
  type ToolPartUpdate
} from "./tool-state";
import { isTurnStopped } from "./turn-stop";
import { MessageType, type ChatTurnOutcome } from "./wire-types";

/**
 * The frame the pump sends to sockets for a reply.
 *
 * @internal
 */
export type ReplyFrame = {
  type: MessageType.CF_AGENT_USE_CHAT_RESPONSE;
  /** The request id. */
  id: string;
  body: string;
  done: boolean;
  /** A chunk's replay index (chunk frames). */
  seq?: number;
  error?: true;
  /** How the request ended (terminal frames). */
  outcome?: ChatTurnOutcome;
  continuation?: true;
  /** The message a continuation's chunks go into (chunk frames). */
  messageId?: string;
};

/**
 * A second consumer of the reply besides sockets: `Think.chat()` over RPC
 * gets every chunk and how the reply ended.
 *
 * @internal
 */
export interface ReplySink {
  chunk(body: string): Promise<void>;
  done(): Promise<void>;
  error(message: string): Promise<void>;
  /**
   * Recovery owns the rest of the reply: it was scheduled, or it gave up
   * and delivered its terminal message itself.
   */
  interrupted(): Promise<void>;
}

/**
 * How the host reads an error.
 *
 * @internal
 */
export type ReplyErrorVerdict = "terminal" | "transient" | "overflow";

/**
 * A stall or a transient error, handed to recovery.
 *
 * @internal
 */
export interface ReplyInterruption {
  requestId: string;
  streamId: string;
  /**
   * The error. An in-band one is a {@link TransientChatStreamError} with
   * the provider's error on `original`.
   */
  error: unknown;
  /** Wait with backoff before the retry (transient errors; not stalls). */
  backoff: boolean;
  /** What the reply holds, not settled. */
  partialParts: MessagePart[];
  messageId: string;
  continuation: boolean;
  parentId?: string;
  /** Store the cut-off reply, settled. Resolves to the stored id. */
  keepPartial(): Promise<string | undefined>;
  /** Recovery was told not to keep the partial. */
  dropPartial(): void;
}

/**
 * What recovery did with an interruption: it scheduled the rest of the
 * reply, the turn was stopped meanwhile, recovery gave up (and delivered its
 * terminal message), or the reply ends as its error (`declined`, `failed`).
 *
 * @internal
 */
export type ReplyRouteOutcome = StreamInterruptionOutcome;

/**
 * Why the pump asks the host to store the reply.
 *
 * @internal
 */
export interface ReplyStoreContext {
  /**
   * `final`: the reply ended, with the cutover when its stream awaits one.
   * `again`: a tool result landed while the reply was being stored.
   * `partial`: recovery keeps the reply of an interrupted stream.
   */
  kind: "final" | "again" | "partial";
  streamId: string;
  /** What the request's record takes (`final`). */
  result: ReplyStreamResult;
  /** The response hook's argument (`final`). */
  response: ChatResponseResult;
}

/**
 * The reply while it streams and while it is stored. A tool result that
 * arrives meanwhile is applied to the accumulator, and sets `dirty` when
 * the reply is being stored so it is stored again.
 *
 * @internal
 */
export class LiveReply {
  storing = false;
  dirty = false;
  /**
   * The stream closed and the reply is being stored: its terminal frame
   * waits for the transcript. A tab that resumes now replays the closed
   * stream and learns the end from the live frame.
   */
  ended = false;
  constructor(
    readonly requestId: string,
    readonly accumulator: StreamAccumulator
  ) {}

  /** Note a change to the accumulator: the reply is stored again. */
  changed(): void {
    if (this.storing) this.dirty = true;
  }
}

/**
 * One stream event for the host's observability.
 *
 * @internal
 */
export type ReplyEvent =
  | { type: "message:error"; error: string }
  | {
      type: "chat:request:failed";
      requestId: string;
      stage: "stream";
      messagesPersisted: true;
      error: string;
    }
  | { type: "chat:stream:stalled"; requestId: string; timeoutMs: number };

/**
 * The part of the turn core (`ChatTurns`) the pump uses.
 *
 * @internal
 */
export interface ReplyTurns {
  /** The reply tool results land on. The pump sets and clears it. */
  liveReply: LiveReply | null;
  /** Whether the chat was reset since this call (`ChatTurns.turnResetGuard`). */
  turnResetGuard(): () => boolean;
  /** Abort the turn as the runtime after a stall (`ChatTurns.stallAbort`). */
  stallAbort(requestId: string): void;
  /** Re-check what waits on a reply that is no longer live. */
  replyFinalized(): void;
}

/** @internal */
export interface ReplyPumpHost {
  readonly streams: ReplyStreamLog;
  readonly turns: ReplyTurns;
  /** Send a frame to sockets. */
  send(frame: ReplyFrame): void;
  /** Send every tab the transcript. */
  broadcastTranscript(): void;
  emit(event: ReplyEvent): void;
  /** No chunk for this long fails the stream as stalled. `0` disables. */
  readonly stallTimeoutMs: number;
  /** Call once per error: an app's classifier may count calls. */
  classify(error: unknown, inBand: boolean): ReplyErrorVerdict;
  /** The text a failed reply reports, from the host's error hook. */
  describeError(error: unknown, inBand: boolean): string;
  /** Rewrite a chunk before it is applied (Think's approval descriptor). */
  transformChunk?(
    chunk: StreamChunkData,
    parts: MessagePart[]
  ): StreamChunkData;
  /** Runs after a chunk was applied. */
  afterApply?(chunk: StreamChunkData, parts: MessagePart[]): void;
  /** Rewrite a chunk's frame body, after it was applied. */
  frameChunk?(chunk: StreamChunkData): StreamChunkData;
  /** A tool result for a call in an earlier message. */
  applyToolUpdate(update: ToolPartUpdate): Promise<unknown>;
  settleInterruptedReply(message: UIMessage): UIMessage;
  /** Store the reply. Resolves to the stored id, `undefined` when nothing was. */
  store(
    message: UIMessage,
    context: ReplyStoreContext
  ): Promise<string | undefined>;
  /**
   * Hand a stall or a transient error to recovery. Without it the pump
   * returns `interrupted` and the caller decides.
   */
  route?(interruption: ReplyInterruption): Promise<ReplyRouteOutcome>;
  /**
   * The reply ended and is stored (or was cut off with nothing to store).
   * Fires the response hook. Not called when recovery took the reply, or
   * when the chat was reset under it.
   */
  settled(response: ChatResponseResult): Promise<void>;
  /**
   * The reply is no longer live, before the turn core re-checks what waits
   * on it. `rearm` is false when recovery took the reply: its retry runs the
   * turn again and re-checks then. Optional: for a host's own finalize work.
   */
  finalized?(rearm: boolean): void;
  /** The pump is reading the model's stream (`true`) or stopped (`false`). */
  reading?(active: boolean): void;
}

/** @internal */
export interface ReplyPumpInput {
  requestId: string;
  source: ReplySource;
  /** The turn's signal. A stop ends the reply `aborted`. */
  signal?: AbortSignal;
  /** The id for a reply that extends no message. */
  messageId: string;
  /** The reply continues an earlier turn: frames say so. */
  continuation?: boolean;
  /**
   * The stored message the reply extends: it keeps the id and the parts,
   * cut-off parts closed. Without it a continuation is a message of its own.
   */
  extend?: UIMessage;
  /** The message a regeneration branches from. */
  parentId?: string;
  /**
   * Runs once, before the first chunk with content (`takeAtFirstContent`):
   * a turn that continues the latest reply takes it over from a scheduled
   * recovery there.
   */
  onFirstContent?: () => Promise<void>;
  /** An RPC caller's sink. */
  sink?: ReplySink;
  /**
   * A context overflow returns `overflow_retry` instead of failing, so the
   * host can compact and run the turn again.
   */
  overflowRetry?: boolean;
  /** The turn's structured output, read after a clean end. */
  output?: () => Promise<unknown>;
  /** Runs once the stream is started: from then on the pump reports failures. */
  started?: () => void;
}

/** @internal */
export type ReplyResult =
  | { status: "completed"; messageId?: string; output?: unknown }
  | { status: "aborted"; reason?: "interrupted" }
  | { status: "error"; error: string }
  | { status: "overflow_retry"; error?: string; partial: UIMessage }
  /**
   * A stall or a transient error, with no `route` to hand it to. The stream
   * is closed `recovering` and nothing is stored: the caller owns the rest.
   */
  | {
      status: "interrupted";
      error: unknown;
      streamId: string;
      partial: UIMessage;
    };

/**
 * An in-band error the host called transient, carried to recovery.
 *
 * @internal
 */
export class TransientChatStreamError extends Error {
  constructor(
    message: string,
    /** The provider error the stream reported, when it had one. */
    readonly original: unknown
  ) {
    super(message);
    this.name = "TransientChatStreamError";
  }
}

function metadataObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A continuation's `start` chunk must not overwrite metadata the message it
 * extends already has.
 */
function keepExistingStartMetadata(
  chunk: StreamChunkData,
  existing: Record<string, unknown> | undefined
): StreamChunkData {
  const incoming = metadataObject(chunk.messageMetadata);
  if (chunk.type !== "start" || !existing || !incoming) return chunk;
  return {
    ...chunk,
    messageMetadata: Object.fromEntries(
      Object.entries(incoming).filter(
        ([key]) => !Object.prototype.hasOwnProperty.call(existing, key)
      )
    )
  };
}

/**
 * The `start` chunk names the message the reply is stored under. A new
 * reply's stamps the accumulator's id when the provider sent none, so a
 * tab builds the live message under the id it is stored under. A
 * continuation's carries none: tabs keep the message they continue (#1229).
 */
function alignStart(
  chunk: StreamChunkData,
  messageId: string,
  continuation: boolean
): StreamChunkData {
  if (chunk.type !== "start") return chunk;
  if (continuation) {
    if (!("messageId" in chunk)) return chunk;
    const { messageId: _, ...rest } = chunk;
    return rest as StreamChunkData;
  }
  return chunk.messageId == null ? { ...chunk, messageId } : chunk;
}

/**
 * Pump one reply. See the module comment.
 *
 * @internal
 */
export async function pumpReply(
  input: ReplyPumpInput,
  host: ReplyPumpHost
): Promise<ReplyResult> {
  const { requestId, signal, source, sink } = input;
  const continuation = input.continuation ?? false;
  const extend = input.extend;
  const extendMetadata = metadataObject(extend?.metadata);
  const contentGate = takeAtFirstContent(input.onFirstContent);
  const streams = host.streams;

  let streamId: string;
  try {
    streamId = streams.start(requestId, {
      messageId: extend?.id ?? input.messageId,
      continuation,
      ...(extend && { basePartCount: extend.parts.length }),
      ...(input.parentId !== undefined && { parentMessageId: input.parentId })
    });
  } catch (error) {
    source.release?.();
    throw error;
  }
  const accumulator = new StreamAccumulator({
    messageId: extend?.id ?? input.messageId,
    continuation: extend !== undefined,
    // A copy: chunks mutate the parts they apply to, and the extended
    // message's parts are the host's stored transcript.
    existingParts: extend
      ? structuredClone(extend.parts).map(settleInterruptedPart)
      : undefined,
    existingMetadata: extendMetadata
  });
  const { turns } = host;
  const isReset = turns.turnResetGuard();
  const live = new LiveReply(requestId, accumulator);
  turns.liveReply = live;
  // Only this reply's own slot: a reset may have started another reply.
  const release = () => {
    if (turns.liveReply === live) turns.liveReply = null;
  };
  const finalized = (rearm: boolean) => {
    host.finalized?.(rearm);
    if (rearm) turns.replyFinalized();
  };
  input.started?.();

  const frame = (fields: Omit<ReplyFrame, "type" | "id">): ReplyFrame => ({
    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
    id: requestId,
    ...fields,
    ...(continuation && { continuation: true })
  });
  // A continuation's chunks name the message they go into (D70).
  const chunkMessageId = continuation ? accumulator.messageId : undefined;
  const flush: ReplyFlushState = {
    chunksSinceFlush: 0,
    hasFlushedContent: false
  };
  const emitChunk = async (chunk: StreamChunkData) => {
    const body = JSON.stringify(host.frameChunk?.(chunk) ?? chunk);
    const seq = streams.store(streamId, chunk, body, flush);
    host.send(
      frame({
        body,
        done: false,
        ...(seq !== undefined && { seq }),
        ...(chunkMessageId !== undefined && { messageId: chunkMessageId })
      })
    );
    await sink?.chunk(body);
  };

  // Terminal frames (the in-band error frame included: clients read it as
  // terminal) wait until the reply is stored and the transcript sent.
  const held: ReplyFrame[] = [];
  const sendHeld = () => {
    for (const f of held.splice(0)) host.send(f);
  };

  let aborted = false;
  let streamError: string | undefined;
  let overflow = false;
  let dropped = false;
  // Why the reply failed, until the host describes it (`describeFailure`).
  let failure: { cause: unknown; inBand: boolean } | undefined;
  let errorFrame: ReplyFrame | undefined;
  let partialStored: { id: string; message: UIMessage } | undefined;
  const approvalRequests = new Map<string, StreamChunkData>();
  // A stream that was stopped or failed is cut off: settle the calls it
  // left unanswered before the reply is stored.
  const cutOff = () => streamError !== undefined || aborted;
  const buildReply = (cut = cutOff()) =>
    cut
      ? host.settleInterruptedReply(accumulator.toMessage())
      : accumulator.toMessage();

  /** Store the reply, and again while tool results landed during a write. */
  const storeLive = async (
    context: Omit<ReplyStoreContext, "streamId" | "response"> & {
      response?: ChatResponseResult;
    },
    cut = cutOff()
  ): Promise<{ id: string | undefined; message: UIMessage }> => {
    live.storing = true;
    live.dirty = false;
    try {
      let message = buildReply(cut);
      const response = context.response ?? responseFor(message);
      const id = await host.store(message, {
        ...context,
        streamId,
        response: { ...response, message }
      });
      while (id !== undefined && live.dirty && !isReset()) {
        live.dirty = false;
        message = buildReply(cut);
        await host.store(message, {
          kind: "again",
          streamId,
          result: context.result,
          response: { ...response, message }
        });
      }
      return { id, message };
    } finally {
      live.storing = false;
    }
  };
  const status = (): ChatResponseResult["status"] =>
    streamError !== undefined ? "error" : aborted ? "aborted" : "completed";
  const responseFor = (message: UIMessage): ChatResponseResult => ({
    message,
    requestId,
    continuation,
    status: status(),
    ...(streamError !== undefined && { error: streamError })
  });

  const routed = async (error: unknown): Promise<ReplyResult | undefined> => {
    const stalled = error instanceof ChatStreamStalledError;
    if (
      !stalled &&
      !(error instanceof TransientChatStreamError) &&
      (signal?.aborted || host.classify(error, false) !== "transient")
    ) {
      return undefined;
    }
    if (!host.route) {
      streams.complete(streamId, "recovering");
      release();
      finalized(false);
      return {
        status: "interrupted",
        error,
        streamId,
        partial: accumulator.toMessage()
      };
    }
    const outcome = await host.route({
      requestId,
      streamId,
      error,
      backoff: !stalled,
      partialParts: accumulator.toMessage().parts,
      messageId: accumulator.messageId,
      continuation,
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      keepPartial: async () => {
        if (isReset() || accumulator.parts.length === 0) return undefined;
        const { id, message } = await storeLive(
          { kind: "partial", result: { status: "aborted" } },
          true
        );
        if (id !== undefined) partialStored = { id, message };
        return id;
      },
      dropPartial: () => {
        dropped = true;
      }
    });
    switch (outcome) {
      case "scheduled":
        // The retry owns the reply's end. Close this stream cleanly.
        streams.complete(streamId, "recovering");
        host.send(frame({ body: "", done: true, outcome: "recovering" }));
        release();
        finalized(false);
        await sink?.interrupted();
        return { status: "aborted", reason: "interrupted" };
      case "stopped":
        // Stopped while routed: the partial is stored, so no cutover follows.
        streams.completeStopped(streamId, requestId);
        host.send(frame({ body: "", done: true, outcome: "aborted" }));
        release();
        if (!isReset()) {
          await host.settled({
            ...responseFor(buildReply(true)),
            status: "aborted"
          });
        }
        finalized(true);
        return { status: "aborted" };
      case "exhausted":
        // Recovery delivered the terminal message itself.
        streams.error(streamId, requestId);
        release();
        finalized(false);
        await sink?.interrupted();
        return { status: "aborted", reason: "interrupted" };
      default:
        return undefined;
    }
  };

  let readToEnd = false;
  const onAbort = () => source.cancel?.();
  if (source.cancel && signal && !signal.aborted) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    try {
      host.reading?.(true);
      const chunks = iterateWithStallWatchdog(
        source.chunks,
        host.stallTimeoutMs,
        () => {
          source.cancel?.();
          host.emit({
            type: "chat:stream:stalled",
            requestId,
            timeoutMs: host.stallTimeoutMs
          });
          turns.stallAbort(requestId);
        }
      );
      // Stopped before the first read: a source that ignores the signal
      // would otherwise hold the turn until it sends a chunk.
      if (signal?.aborted) {
        aborted = true;
        source.cancel?.();
      }
      for await (const raw of aborted ? [] : chunks) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        await contentGate(raw.type);

        let chunk = host.transformChunk?.(raw, accumulator.parts) ?? raw;
        if (extend) chunk = keepExistingStartMetadata(chunk, extendMetadata);
        chunk = alignStart(chunk, accumulator.messageId, continuation);
        // A provider that replays an earlier tool round trip (#1404)
        // re-sends chunks for calls the reply holds. Applying them is safe;
        // sending them would move a settled part back on the client.
        const replay = isReplayChunk(accumulator.parts, chunk);
        if (chunk.type === "tool-approval-request" && !replay) {
          approvalRequests.set(chunk.toolCallId ?? "", chunk);
        }
        const { action } = accumulator.applyChunk(chunk);
        host.afterApply?.(chunk, accumulator.parts);
        if (replay) {
          // A late tool input still reaches clients, with the approval
          // request again so the approval stays open.
          for (const forwarded of lateToolInputForwardChunks(
            accumulator.parts,
            chunk,
            approvalRequests.get(chunk.toolCallId ?? "")
          )) {
            await emitChunk(forwarded);
          }
          continue;
        }

        // An approved call runs in a continuation, and its part lives in an
        // earlier message: store its result there.
        if (action?.type === "cross-message-tool-update") {
          await host.applyToolUpdate(
            crossMessageToolResultUpdate(
              action.toolCallId,
              action.updateType,
              action.output,
              action.errorText,
              action.preliminary
            )
          );
        }

        if (action?.type === "error") {
          const cause = source.errorCause?.() ?? action.error;
          const verdict = host.classify(cause, true);
          if (verdict === "overflow" && input.overflowRetry) {
            streamError = action.error;
            overflow = true;
            break;
          }
          if (verdict === "transient") {
            throw new TransientChatStreamError(action.error, cause);
          }
          streamError = action.error;
          failure = { cause, inBand: true };
          errorFrame = frame({ body: streamError, done: false, error: true });
          held.push(errorFrame);
          break;
        }

        await emitChunk(chunk);
      }
      readToEnd = !(aborted || overflow || streamError !== undefined);
      // A stopped source can end as if it finished.
      if (readToEnd && signal?.aborted) aborted = true;
    } catch (error) {
      // What a stopped turn throws is the stop, not an error.
      if (!isTurnStopped(signal)) throw error;
      aborted = true;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      host.reading?.(false);
      if (!readToEnd) source.release?.();
    }

    if (overflow) {
      // The host runs the turn again from compacted history and the retry
      // owns the end: no terminal frame, nothing stored (a stored partial
      // would sit beside the retry's answer).
      streams.completeForRetry(streamId, requestId);
      release();
      finalized(false);
      return {
        status: "overflow_retry",
        error: streamError,
        partial: accumulator.toMessage()
      };
    }

    if (streamError !== undefined) streams.error(streamId, requestId);
    else streams.finish(streamId, aborted ? "aborted" : "completed");
    live.ended = true;
  } catch (error) {
    const result = await routed(error);
    if (result) return result;
    const cause =
      error instanceof TransientChatStreamError
        ? (error.original ?? error)
        : error;
    streamError = streamErrorText(cause);
    failure = { cause, inBand: false };
    streams.error(streamId, requestId);
    live.ended = true;
  }

  let output: unknown;
  if (input.output && streamError === undefined && !aborted) {
    try {
      output = await input.output();
    } catch (error) {
      streamError =
        error instanceof Error ? error.message : "Structured output error";
      failure = { cause: error, inBand: false };
      streams.error(streamId, requestId);
    }
  }

  // The app's error hook runs once the partial reply is stored, so it reads
  // the transcript with the reply in it. The frames wait for it.
  const describeFailure = () => {
    if (!failure) return;
    streamError = host.describeError(failure.cause, failure.inBand);
    failure = undefined;
    if (errorFrame) errorFrame.body = streamError;
    host.emit({ type: "message:error", error: streamError });
    host.emit({
      type: "chat:request:failed",
      requestId,
      stage: "stream",
      messagesPersisted: true,
      error: streamError
    });
  };

  // One error frame per failed reply: an in-band error already sent its
  // own, and the terminal frame after it only says how the request ended.
  const terminal = (): ReplyFrame => {
    const errorFrame =
      streamError !== undefined && !held.some((f) => f.error === true);
    return frame({
      body: errorFrame ? (streamError ?? "") : "",
      done: true,
      outcome: status(),
      ...(errorFrame && { error: true })
    });
  };

  const result: ReplyStreamResult = aborted
    ? { status: "aborted" }
    : { status: "completed", output };
  let storedId: string | undefined;
  let reset = isReset();
  let response = responseFor(buildReply());
  try {
    if (!reset) {
      const message = buildReply();
      if (
        partialStored !== undefined &&
        JSON.stringify(partialStored.message) === JSON.stringify(message)
      ) {
        // Recovery kept the partial and declined to continue: it is stored
        // as it is.
        storedId = partialStored.id;
        response = { ...response, message };
      } else if (accumulator.parts.length > 0 && !dropped) {
        const stored = await storeLive({ kind: "final", result, response });
        storedId = stored.id;
        response = { ...response, message: stored.message };
      }
      reset = isReset() && storedId === undefined;
    }
    describeFailure();
    response = responseFor(response.message);
    held.push(terminal());
  } catch (error) {
    console.error("Failed to persist assistant message:", error);
    streams.error(streamId, requestId);
    // A reply that already failed keeps its error and its error frame.
    if (failure) {
      describeFailure();
    } else if (streamError === undefined) {
      failure = { cause: error, inBand: false };
      describeFailure();
      held.splice(0);
    }
    held.push(terminal());
    response = { ...responseFor(buildReply()), status: "error" };
  } finally {
    // Every write of the reply is done: the terminal frame goes out.
    streams.settlePending(requestId, result);
    release();
    sendHeld();
  }
  // The reply held nothing and was not stored, but tabs drew what streamed.
  // A transcript sent before the terminal frame is merged with the stream a
  // tab still reads, so this one comes after it.
  if (
    !reset &&
    !dropped &&
    storedId === undefined &&
    accumulator.parts.length > 0
  ) {
    host.broadcastTranscript();
  }
  // A reply the chat was cleared under before it was stored did not
  // complete. One stored first did, whatever came after.
  const completed = streamError === undefined && !aborted && !reset;
  try {
    // An RPC caller learns the reply is done before the response hook runs,
    // and of a failure after it.
    try {
      if (completed) await sink?.done();
    } finally {
      // A clear kept the reply out: no hook.
      if (!reset) await host.settled(response);
    }
  } finally {
    finalized(true);
  }

  if (streamError !== undefined) {
    await sink?.error(streamError);
    return { status: "error", error: streamError };
  }
  if (!completed) return { status: "aborted" };
  return {
    status: "completed",
    ...(storedId !== undefined && { messageId: storedId }),
    ...(output !== undefined && { output })
  };
}
