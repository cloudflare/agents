/**
 * What a host's public methods and socket handler call, as functions over
 * the chat's capabilities (design/rfc-slim-hosts.md, "The chat module"):
 * start a turn, cancel one, clear the chat, answer a tool, and dispatch a
 * chat protocol frame. Each is a few lines over Tasks and Sessions; the turn
 * itself is the run of `chatTurnDefinition`.
 *
 * @internal Sibling-package support, not a public API.
 */

import type { Connection } from "agents";
import type { UIMessage } from "ai";
import type { ChatDeps, ChatTurnInput } from "./chat-host";
import { parseChatRequest } from "./protocol-dispatch";
import { parseProtocolMessage } from "./parse-protocol";
import {
  applyToolUpdate,
  toolApprovalUpdate,
  toolResultUpdate,
  type ToolPartUpdate
} from "./tool-state";

/** Where a host runs its chat turns: its definition's name and its lane. */
export interface ChatLane {
  readonly definition: string;
  readonly lane: string;
}

/**
 * Start a chat turn: store the messages it brings, then start its run on the
 * lane. Returns the run id, which is the turn's request id.
 */
export async function submitTurn(
  deps: ChatDeps,
  lane: ChatLane,
  input: ChatTurnInput & { messages?: readonly UIMessage[] },
  options: { requestId?: string } = {}
): Promise<{ requestId: string }> {
  const session = deps.sessions.session(deps.session ?? "");
  for (const message of input.messages ?? []) {
    await session.upsertMessage(message as never);
  }
  const { messages: _messages, ...run } = input;
  const receipt = await deps.tasks.run(lane.definition, run as never, {
    lane: lane.lane,
    retain: false,
    ...(options.requestId !== undefined && { runId: options.requestId })
  });
  return { requestId: receipt.runId };
}

/** Stop the turn `requestId`, waiting or running. */
export function cancelTurn(
  deps: ChatDeps,
  requestId: string
): Promise<boolean> {
  return deps.tasks.cancel(requestId, "chat turn cancelled");
}

/** Clear the chat: no waiting or running turn goes on, and the transcript is emptied. */
export async function clearChat(deps: ChatDeps, lane: ChatLane): Promise<void> {
  await deps.tasks.clear(lane.lane, "chat cleared");
  await deps.sessions.session(deps.session ?? "").clearMessages();
}

/** A client's answer to a tool call. */
export type ToolAnswer =
  | {
      kind: "result";
      toolCallId: string;
      output: unknown;
      state?: string;
      errorText?: string;
    }
  | {
      kind: "approval";
      toolCallId: string;
      approved: boolean;
      approvalId?: string;
    };

/**
 * Store a client's tool answer in the message that holds the call. With
 * `autoContinue`, a turn continues the reply once its last call is
 * answered. Returns whether the call was found and changed.
 */
export async function answerTool(
  deps: ChatDeps,
  lane: ChatLane,
  answer: ToolAnswer,
  options: { autoContinue?: boolean } = {}
): Promise<boolean> {
  const update: ToolPartUpdate =
    answer.kind === "result"
      ? toolResultUpdate(
          answer.toolCallId,
          answer.output,
          answer.state === "output-error" ? "output-error" : undefined,
          answer.errorText
        )
      : toolApprovalUpdate(
          answer.toolCallId,
          answer.approved,
          answer.approvalId
        );
  const session = deps.sessions.session(deps.session ?? "");
  const history = (await session.getHistory()) as unknown as UIMessage[];
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    const applied = applyToolUpdate(
      message.parts as unknown as Array<Record<string, unknown>>,
      update
    );
    if (!applied) continue;
    if (!applied.changed) return false;
    const next = {
      ...message,
      parts: applied.parts as unknown as UIMessage["parts"]
    };
    await session.upsertMessage(next as never);
    if (options.autoContinue && !waitsOnAnswer(next)) {
      await submitTurn(deps, lane, { trigger: "tool-answer" });
    }
    return true;
  }
  return false;
}

/** Whether a message still holds a tool call no answer settled. */
function waitsOnAnswer(message: UIMessage): boolean {
  return message.parts.some((part) => {
    const state = (part as { state?: unknown }).state;
    return (
      "toolCallId" in part &&
      (state === "input-available" || state === "approval-requested")
    );
  });
}

/**
 * Handle one inbound WebSocket message if it is a chat protocol frame that
 * starts, stops, clears or answers a turn.
 *
 * @returns `false` when it is not one of those: the host handles it.
 */
export async function chatDispatch(
  deps: ChatDeps,
  lane: ChatLane,
  _connection: Connection,
  message: unknown
): Promise<boolean> {
  if (typeof message !== "string") return false;
  const event = parseProtocolMessage(message);
  if (!event) return false;
  switch (event.type) {
    case "chat-request": {
      const request = parseChatRequest(event.id, event.init.body);
      if (!("messages" in request)) return true;
      const question = [...request.messages]
        .reverse()
        .find((m) => m.role === "user");
      await submitTurn(
        deps,
        lane,
        {
          trigger: request.trigger,
          messages: request.messages,
          ...(question && { questionId: question.id }),
          ...(request.clientTools && { clientTools: request.clientTools }),
          body: request.body
        },
        { requestId: request.requestId }
      );
      return true;
    }
    case "cancel":
      await cancelTurn(deps, event.id);
      return true;
    case "clear":
      await clearChat(deps, lane);
      return true;
    case "tool-result":
      await answerTool(
        deps,
        lane,
        {
          kind: "result",
          toolCallId: event.toolCallId,
          output: event.output,
          ...(event.state !== undefined && { state: event.state }),
          ...(event.errorText !== undefined && { errorText: event.errorText })
        },
        { autoContinue: event.autoContinue === true }
      );
      return true;
    case "tool-approval":
      await answerTool(
        deps,
        lane,
        {
          kind: "approval",
          toolCallId: event.toolCallId,
          approved: event.approved,
          ...(event.approvalId !== undefined && {
            approvalId: event.approvalId
          })
        },
        { autoContinue: event.autoContinue === true }
      );
      return true;
    default:
      return false;
  }
}
