/**
 * The inbound half of the chat wire protocol, shared by `AIChatAgent` and
 * `Think`: classify one client message, parse a chat request's body, and
 * route each event to the turn core or to the host.
 *
 * The calls both hosts made the same way (cancel, the waiting-continuation
 * stop, a tool result or approval through the apply chain, the resume
 * handshake) happen here. What differs per host is a method on
 * {@link ChatProtocolHost}: how a request runs, what a clear and a pushed
 * transcript do, how a tool answer is applied, and which continuation it
 * starts.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { UIMessage } from "ai";
import type { Connection } from "agents";
import type {
  ContinuationSource,
  ToolInteractionOutcome
} from "./auto-continuation-controller";
import type { ChatTurns } from "./chat-turns";
import type { ClientToolSchema } from "./client-tools";
import type { ChatFrames } from "./chat-frames";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { parseProtocolMessage, type ChatProtocolEvent } from "./parse-protocol";
import type { ChatRequestContext } from "./request-context";
import type { ResumeHandshake } from "./resume-handshake";

/**
 * A client's chat request, its body parsed.
 *
 * @internal
 */
export type ParsedChatRequest = {
  readonly requestId: string;
  readonly trigger: "submit-message" | "regenerate-message";
  /** The messages the tab sent, as sent. */
  readonly messages: UIMessage[];
  readonly clientTools: ClientToolSchema[] | undefined;
  /** Every other field of the body: the app's custom body. */
  readonly body: Record<string, unknown>;
};

/**
 * A chat request whose body could not be used.
 *
 * @internal
 */
export type RejectedChatRequest = {
  readonly requestId: string;
  readonly reason: "empty-body" | "invalid-json" | "invalid-messages";
  /** The parse error, for `invalid-json`. */
  readonly error?: unknown;
};

/** @internal */
export type ToolResultEvent = Extract<
  ChatProtocolEvent,
  { type: "tool-result" }
>;
/** @internal */
export type ToolApprovalEvent = Extract<
  ChatProtocolEvent,
  { type: "tool-approval" }
>;

/**
 * What a host supplies to {@link dispatchChatProtocol}.
 *
 * @internal
 */
export interface ChatProtocolHost<TConnection extends Connection> {
  readonly turns: ChatTurns<TConnection>;
  readonly requestContext: ChatRequestContext;
  resumeHandshake(): ResumeHandshake;
  /** The observability events every host emits for these messages. */
  emit(
    type: "tool:result" | "tool:approval" | "message:cancel",
    payload: Record<string, unknown>
  ): void;
  /** Run one parsed chat request. */
  chatRequest(
    connection: TConnection,
    request: ParsedChatRequest
  ): Promise<void>;
  /** Where every chat frame leaves the server (and terminals are recorded). */
  readonly frames: Pick<ChatFrames, "send">;
  /**
   * A chat request that will not run. The host reports it
   * (`chat:request:failed`, stage `parse`) and returns the error text the
   * sending tab is shown.
   */
  rejectedChatRequest(
    connection: TConnection,
    rejection: RejectedChatRequest
  ): string;
  clear(connection: TConnection): Promise<void>;
  /** A tab pushed its whole transcript. */
  messages(connection: TConnection, messages: unknown[]): Promise<void>;
  applyToolResult(event: ToolResultEvent): Promise<ToolInteractionOutcome>;
  applyToolApproval(event: ToolApprovalEvent): Promise<ToolInteractionOutcome>;
  /** The continuation a tool answer from `connection` starts. */
  continuation(
    connection: TConnection,
    answer: "tool-result" | "tool-approval"
  ): ContinuationSource<TConnection>;
  /** Serialise one tool answer's apply behind any in flight. */
  enqueueInteraction(run: () => Promise<boolean>): Promise<boolean>;
}

/**
 * Parse a chat request's body. A body that is missing, is not JSON, or has
 * no `messages` array is rejected.
 *
 * @internal
 */
export function parseChatRequest(
  requestId: string,
  body: unknown
): ParsedChatRequest | RejectedChatRequest {
  if (typeof body !== "string" || body === "") {
    return { requestId, reason: "empty-body" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { requestId, reason: "invalid-json", error };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { requestId, reason: "invalid-messages" };
  }
  const { messages, clientTools, trigger, ...rest } = parsed as Record<
    string,
    unknown
  >;
  if (!Array.isArray(messages)) {
    return { requestId, reason: "invalid-messages" };
  }
  return {
    requestId,
    trigger:
      trigger === "regenerate-message"
        ? "regenerate-message"
        : "submit-message",
    messages: messages as UIMessage[],
    clientTools: Array.isArray(clientTools)
      ? (clientTools as ClientToolSchema[])
      : undefined,
    body: rest
  };
}

/**
 * Handle one inbound WebSocket message if it is a chat protocol message.
 *
 * @returns `false` when it is not one (not a string, not JSON, or not a
 *   chat message type): the host forwards it to the app's `onMessage`.
 *
 * @internal
 */
export async function dispatchChatProtocol<TConnection extends Connection>(
  connection: TConnection,
  message: unknown,
  host: ChatProtocolHost<TConnection>
): Promise<boolean> {
  if (typeof message !== "string") return false;
  const event = parseProtocolMessage(message);
  if (!event) return false;

  switch (event.type) {
    case "chat-request": {
      // A chat request other than a POST is a protocol message nobody
      // sends; it is dropped, not handed to the app.
      if (event.init.method !== "POST") return true;
      const request = parseChatRequest(event.id, event.init.body);
      if ("reason" in request) {
        const body = host.rejectedChatRequest(connection, request);
        // The tab waits for this request's terminal frame. It goes to the
        // sender, and is recorded like every terminal (D111) so a tab whose
        // socket dropped before it landed gets it when it resumes by id.
        host.frames.send(connection, {
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          id: request.requestId,
          body,
          done: true,
          error: true
        });
        return true;
      }
      await host.chatRequest(connection, request);
      return true;
    }

    case "clear":
      await host.clear(connection);
      return true;

    case "messages":
      await host.messages(connection, event.messages);
      return true;

    case "cancel":
      // Aborts the request's turn, queued or running, a recovery attempt
      // running for it, and the continuations waiting on it.
      await host.turns.cancel(event.id);
      host.emit("message:cancel", { requestId: event.id });
      return true;

    case "cancel-continuation":
      // A stop from a tab that waits for a tool continuation to start. It
      // has no request id for it yet, so it names itself.
      host.turns.cancelWaitingContinuation(connection.id);
      return true;

    case "stream-resume-request":
      // Sent once the tab's handler is registered, so a resume notice sent
      // from onConnect cannot arrive before the tab can read it.
      await host
        .resumeHandshake()
        .handleResumeRequest(connection, event.probeId, event.requestIds);
      return true;

    case "stream-resume-ack":
      await host.resumeHandshake().handleResumeAck(connection, event.id);
      return true;

    case "tool-result":
      host.emit("tool:result", {
        toolCallId: event.toolCallId,
        toolName: event.toolName
      });
      // Only a result that settled its call continues, targeted at that
      // call's message; without autoContinue it re-arms a batch a sibling
      // opted in for (#1650). A result that settled its call and lists
      // client tools replaces the stored ones, so its continuation runs
      // with the latest schemas. A duplicate or a result for a call that
      // is gone changes nothing.
      void host.turns.applyInteraction(
        host.requestContext.applyingToolResult(event.clientTools, () =>
          host.applyToolResult(event)
        ),
        event.autoContinue === true,
        () => host.continuation(connection, "tool-result"),
        (run) => host.enqueueInteraction(run),
        connection.id
      );
      return true;

    case "tool-approval":
      host.emit("tool:approval", {
        toolCallId: event.toolCallId,
        approved: event.approved
      });
      void host.turns.applyInteraction(
        () => host.applyToolApproval(event),
        event.autoContinue === true,
        () => host.continuation(connection, "tool-approval"),
        (run) => host.enqueueInteraction(run),
        connection.id
      );
      return true;
  }
}

/**
 * What a closing connection releases: a resume it was offered, the
 * continuation it waited on, and an accepted turn it was parked behind.
 *
 * @internal
 */
export function releaseChatConnection<TConnection extends Connection>(
  turns: ChatTurns<TConnection>,
  pendingResume: Set<string>,
  connectionId: string
): void {
  pendingResume.delete(connectionId);
  turns.continuation.releaseConnection(connectionId);
  turns.preStream.release(connectionId);
}

/**
 * The error text a rejected chat request is reported with.
 *
 * @internal
 */
export function rejectionMessage(rejection: RejectedChatRequest): string {
  if (rejection.reason === "invalid-json") {
    return rejection.error instanceof Error
      ? rejection.error.message
      : String(rejection.error);
  }
  return rejection.reason === "empty-body"
    ? "Chat request has no body"
    : "Chat request body has no messages array";
}
