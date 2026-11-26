/**
 * The chat module's host contract (design/rfc-slim-hosts.md, "The chat
 * module"): what a host gives the one chat-turn definition. A host supplies
 * `respond` (its model call) and optional hooks; the module owns the turn's
 * run, its stream and its stored reply.
 *
 * @internal Sibling-package support for `@cloudflare/think` and
 * `@cloudflare/ai-chat`, not a public API.
 */

import type { UIMessage, UIMessageChunk } from "ai";
import type { Sessions } from "../sessions/sessions";
import type { Streams } from "../streams/streams";
import type { Tasks } from "../tasks/tasks";
import type { WebSockets } from "../websockets/websockets";
import type { ClientToolSchema } from "./client-tools";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "./lifecycle";

/** The capabilities the chat functions are given. They own every row and job. */
export interface ChatDeps {
  readonly tasks: Tasks;
  readonly streams: Streams;
  readonly sessions: Sessions;
  readonly webSockets: WebSockets;
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

/** What a host supplies. */
export interface ChatHost {
  respond(call: ChatModelCall): Promise<ChatModelStream | undefined>;
  readonly hooks?: ChatHooks;
}

/** How a chat turn ended. */
export interface ChatTurnResult {
  readonly requestId: string;
  readonly status: "completed" | "error" | "aborted" | "skipped";
  /** The stored reply's id, when one was stored. */
  readonly messageId?: string;
  readonly error?: string;
}

/** The input of a chat-turn run. */
export interface ChatTurnInput {
  readonly trigger: ChatModelCall["trigger"];
  readonly questionId?: string;
  readonly clientTools?: readonly ClientToolSchema[];
  readonly body?: Readonly<Record<string, unknown>>;
}
