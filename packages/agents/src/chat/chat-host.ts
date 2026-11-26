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
import type { ClientToolSchema } from "./client-tools";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "./lifecycle";
import { chatRecoveryBackoffSeconds } from "./recovery-engine";
import { TaskSettlement } from "../tasks/settlement";
import { frameText } from "./chat-frames";
import { sendIfOpen } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";

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
  ms: number | undefined
): ReadableStream<UIMessageChunk> {
  if (!ms || ms <= 0) return chunks;
  const reader = chunks.getReader();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamStalledError(ms)), ms);
      });
      try {
        const next = await Promise.race([reader.read(), stalled]);
        if (next.done) controller.close();
        else controller.enqueue(next.value);
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
  readonly trigger: ChatModelCall["trigger"];
  readonly questionId?: string;
  readonly clientTools?: readonly ClientToolSchema[];
  readonly body?: Readonly<Record<string, unknown>>;
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
    (state === "input-streaming" || state === "input-available")
  );
}

/**
 * Settle each tool part the interruption cut off: through the host's hook,
 * or reported to the model as interrupted.
 */
function repairCutOffTools(message: UIMessage, hooks?: ChatHooks): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!isCutOffTool(part)) return part;
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

/** Read what `respond` returned as UI message chunks. */
function chunksOf(source: ChatModelStream): ReadableStream<UIMessageChunk> {
  if (source instanceof ReadableStream) return source;
  if (source instanceof Response) {
    throw new Error(
      "chatTurnDefinition: a Response from respond() is not read yet"
    );
  }
  if ("toUIMessageStream" in source) return source.toUIMessageStream();
  const iterator = source[Symbol.asyncIterator]();
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
    const sessionId = deps.session ?? "";
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
    const report = async (result: ChatTurnResult) => {
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
    const earlier = await deps.streams.status(streamId);
    if (earlier && earlier.state !== "streaming") {
      return report({
        requestId,
        status: earlier.state === "completed" ? "completed" : "error"
      });
    }
    let partial: UIMessage | undefined;
    if (earlier) {
      const stored = await storedChunks(deps.streams, streamId);
      const built = await messageOf(
        new ReadableStream({
          start(controller) {
            for (const chunk of stored) controller.enqueue(chunk);
            controller.close();
          }
        })
      );
      if (built && built.parts.length > 0) {
        partial = repairCutOffTools(built, host.hooks);
        await session.upsertMessage(partial as never);
      }
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
        // Given up: what was streamed stays stored (unless the app said
        // not to keep it), and the turn ends as an error.
        if (partial && decision?.persist === false) {
          await session.deleteMessages([partial.id]);
        }
        const writer = await deps.streams.open(streamId, { tag: requestId });
        writer.error("interrupted");
        return report({
          requestId,
          status: "error",
          error: "The turn was interrupted and not continued."
        });
      }
    }

    const messages = (await session.getHistory()) as unknown as UIMessage[];
    // A tool answer continues the reply that asked for it.
    if (!partial && run.trigger === "tool-answer") {
      const last = messages.at(-1);
      if (last?.role === "assistant") partial = last;
    }
    const call: ChatModelCall = {
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
      const recorded = watchStall(
        chunksOf(source),
        recovery === false ? undefined : recovery?.stallTimeoutMs
      ).pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            // A continuation keeps the reply's id.
            const own =
              continuing && chunk.type === "start"
                ? ({ ...chunk, messageId: continuing.id } as UIMessageChunk)
                : chunk;
            const next = host.hooks?.transformChunk?.(own, parts) ?? own;
            out.append(next as never);
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
        break;
      } catch (error) {
        if (step.signal.aborted) {
          out.error("aborted");
          return report({ requestId, status: "aborted" });
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
          // Room was made: ask the model again, once.
          overflowTried = true;
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

    // The cutover: the reply is stored and the stream settled and its rows
    // dropped in one transaction, so a crash leaves the live stream or the
    // stored reply, never neither.
    if (reply && reply.parts.length > 0) {
      const stored = host.hooks?.sanitizeForPersistence?.(reply) ?? reply;
      reply = stored;
      const sync = session.__DO_NOT_USE_WILL_BREAK__sync();
      let after: (() => Promise<void>) | undefined;
      try {
        writer.close({
          discard: true,
          commit: () => {
            after = sync.upsert(stored as never).after;
          }
        });
      } catch (error) {
        sync.abandon();
        throw error;
      }
      // Settled by another path first: the reply still lands.
      if (after) await after();
      else await session.upsertMessage(stored as never);
    } else {
      writer.close({ discard: true });
    }
    return report({
      requestId,
      status: "completed",
      ...(reply && reply.parts.length > 0 && { messageId: reply.id })
    });
  };
}
