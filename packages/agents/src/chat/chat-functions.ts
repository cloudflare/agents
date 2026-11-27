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
import {
  chatTurnStreamId,
  liveTurnsOf,
  parkedIn,
  releaseParked,
  type ChatDeps,
  type ChatTurnInput
} from "./chat-host";
import { frameText } from "./chat-frames";
import { mergeUserMessages } from "./merge-user-messages";
import { sendIfOpen } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { parseChatRequest } from "./protocol-dispatch";
import {
  CHAT_REQUEST_CONTEXT_KEY as REQUEST_CONTEXT_KEY,
  storableRequestContext
} from "./chat-turns";
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
  /** How a new message that arrives while turns wait or run joins them. */
  readonly arrival?: ChatArrival;
}

/**
 * How a turn that arrives while others wait or run joins the lane (a host's
 * `messageConcurrency`): `"queue"` waits its turn; `"latest"` and `"merge"`
 * skip the waiting turns that arrived the same way, and answer their
 * questions too (the arriving turn carries their messages); `"drop"` is not
 * started at all; `{ debounceMs }` is `"latest"` that also waits for quiet.
 */
export type ChatArrival =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { readonly debounceMs: number };

/**
 * Start a chat turn: store the messages it brings, then start its run on the
 * lane. Returns the run id, which is the turn's request id.
 */
export async function submitTurn(
  deps: ChatDeps,
  lane: ChatLane,
  input: ChatTurnInput,
  options: {
    requestId?: string;
    idempotencyKey?: string;
    arrival?: ChatArrival;
  } = {}
): Promise<{ requestId: string; dropped?: true }> {
  const session = deps.sessions.session(input.session ?? deps.session ?? "");
  // The turn stores the request's messages when it starts (after the
  // replies queued before it); it carries only those the transcript does not
  // already hold as they are, since a tab sends its whole list.
  const fresh: UIMessage[] = [];
  const arrival = options.arrival ?? "queue";
  const replaced: string[] = [];
  // A turn that replaces the waiting ones answers their questions too: it
  // carries their messages, which they would have stored when they started.
  if (arrival !== "queue" && arrival !== "drop") {
    for (const waiting of deps.tasks.peekList({
      definition: lane.definition,
      lane: lane.lane,
      status: ["pending"],
      results: false,
      order: "oldest"
    })) {
      if (
        waiting.waitReason !== "overlap" &&
        waiting.waitReason !== "debounce"
      ) {
        continue;
      }
      replaced.push(waiting.runId);
      for (const message of deps.tasks.inputOf<ChatTurnInput>(waiting.runId)
        ?.messages ?? []) {
        if (!(input.messages ?? []).some((m) => m.id === message.id)) {
          fresh.push(message);
        }
      }
    }
  }
  for (const message of input.messages ?? []) {
    const stored = await session.getMessage(message.id);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(message)) {
      fresh.push(message);
    }
  }
  // `merge` joins the queued questions into one message, which keeps the
  // newest one's id (as the hosts' merge does).
  if (
    arrival === "merge" &&
    fresh.filter((m) => m.role === "user").length > 1
  ) {
    const users = fresh.filter((m) => m.role === "user");
    const merged = mergeUserMessages(users);
    fresh.splice(
      0,
      fresh.length,
      ...fresh.filter((m) => m.role !== "user"),
      merged
    );
  }
  const { messages: _messages, ...rest } = input;
  const given: ChatTurnInput = fresh.length
    ? { ...rest, messages: fresh }
    : rest;
  // A client's request sets the tools and body later turns that no client
  // sent (a server turn, a tool answer's continuation) run with.
  let run: ChatTurnInput = given;
  if (
    given.trigger === "submit-message" ||
    given.trigger === "regenerate-message"
  ) {
    await session.internal_setConfig(
      REQUEST_CONTEXT_KEY,
      // One past the row budget is not kept (a later server turn runs
      // without it), as the hosts do today.
      storableRequestContext(
        given.clientTools?.length ||
          (given.body && Object.keys(given.body).length)
          ? JSON.stringify({
              ...(given.clientTools?.length && {
                clientTools: given.clientTools
              }),
              ...(given.body && { body: given.body })
            })
          : null
      )
    );
  } else if (given.clientTools === undefined && given.body === undefined) {
    const stored = await session.internal_config(REQUEST_CONTEXT_KEY);
    if (stored) {
      const context = JSON.parse(stored) as Pick<
        ChatTurnInput,
        "clientTools" | "body"
      >;
      run = { ...given, ...context };
    }
  }
  const receipt = await deps.tasks.run(lane.definition, run as never, {
    lane: lane.lane,
    retain: false,
    policy: arrival === "merge" ? "latest" : arrival,
    ...(options.requestId !== undefined && { runId: options.requestId }),
    ...(options.idempotencyKey !== undefined && {
      idempotencyKey: options.idempotencyKey
    })
  });
  const dropped = (receipt as { dropped?: boolean }).dropped === true;
  // The tabs learn that a replaced or dropped request ended without a
  // reply (its turn never runs to say so).
  for (const id of dropped ? [receipt.runId] : replaced) {
    const text = frameText({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id,
      body: "",
      done: true,
      outcome: "skipped"
    } as { type: string });
    if (text === undefined || !deps.webSockets) continue;
    for (const connection of deps.webSockets.getConnections()) {
      sendIfOpen(connection, text);
    }
  }
  return { requestId: receipt.runId, ...(dropped && { dropped: true }) };
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

/** Tool answers being applied now, by chat, in this isolate. */
const answering = new WeakMap<object, Map<string, number>>();

function answeringIn(deps: ChatDeps): Map<string, number> {
  let counts = answering.get(deps.streams);
  if (!counts) answering.set(deps.streams, (counts = new Map()));
  return counts;
}

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
  const counts = answeringIn(deps);
  const key = deps.session ?? "";
  counts.set(key, (counts.get(key) ?? 0) + 1);
  try {
    return await applyAnswer(deps, lane, answer, options);
  } finally {
    const left = (counts.get(key) ?? 1) - 1;
    if (left > 0) counts.set(key, left);
    else {
      counts.delete(key);
      // A tab that waited on this answer, which started no turn, learns
      // there is nothing to resume; a turn it started answers it instead.
      const parked = parkedIn(deps.streams, key);
      if (
        parked.size > 0 &&
        deps.tasks.peekList({
          definition: lane.definition,
          lane: lane.lane,
          status: ["pending", "running"],
          results: false
        }).length === 0
      ) {
        releaseParked(parked, { type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE });
      }
    }
  }
}

async function applyAnswer(
  deps: ChatDeps,
  lane: ChatLane,
  answer: ToolAnswer,
  options: { autoContinue?: boolean }
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
  // The call is in the reply streaming now: the answer joins that stream.
  const live = liveTurnsOf(deps.streams).get(deps.session ?? "");
  if (live && answer.kind === "result") {
    if (live.waitsOn(answer.toolCallId)) {
      live.inject(
        (answer.state === "output-error"
          ? {
              type: "tool-output-error",
              toolCallId: answer.toolCallId,
              errorText: answer.errorText ?? "The tool failed."
            }
          : {
              type: "tool-output-available",
              toolCallId: answer.toolCallId,
              output: answer.output
            }) as never
      );
      // The continuation waits behind the streaming turn in the lane.
      if (options.autoContinue) {
        await submitTurn(deps, lane, { trigger: "tool-answer" });
      }
      return true;
    }
  }
  const session = deps.sessions.session(deps.session ?? "");
  // The call is almost always in the latest reply: read the whole path only
  // when it is not there.
  const leaf = (await session.getLatestLeaf()) as unknown as UIMessage | null;
  const history =
    leaf &&
    applyToolUpdate(
      leaf.parts as unknown as Array<Record<string, unknown>>,
      update
    )
      ? [leaf]
      : ((await session.getHistory()) as unknown as UIMessage[]);
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
    // One continuation per answered batch, however many answers race to
    // complete it.
    if (options.autoContinue && !waitsOnAnswer(next)) {
      await submitTurn(
        deps,
        lane,
        { trigger: "tool-answer", replyId: next.id },
        { idempotencyKey: `continue:${next.id}:${answeredCalls(next)}` }
      );
    }
    return true;
  }
  return false;
}

/** The answered tool calls of a message, as a stable key. */
function answeredCalls(message: UIMessage): string {
  return message.parts
    .map((part) => (part as { toolCallId?: unknown }).toolCallId)
    .filter((id): id is string => typeof id === "string")
    .sort()
    .join(",");
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

/** The turn of `lane` that is running now, and whose stream is open, if any. */
async function streamingTurn(
  deps: ChatDeps,
  lane: ChatLane
): Promise<string | null> {
  const [running] = deps.tasks.peekList({
    definition: lane.definition,
    lane: lane.lane,
    status: ["running"],
    results: false
  });
  if (!running) return null;
  const status = await deps.streams.status(chatTurnStreamId(running.runId));
  return status?.state === "streaming" ? running.runId : null;
}

/**
 * Answer a tab's resume request: offer it the turn that is streaming now
 * (`STREAM_RESUMING`), or tell it nothing streams (`STREAM_RESUME_NONE`).
 */
export async function resumeChat(
  deps: ChatDeps,
  lane: ChatLane,
  connection: Connection,
  probeId?: string
): Promise<void> {
  const requestId = await streamingTurn(deps, lane);
  if (requestId) {
    sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: requestId,
        ...(probeId && { probeId })
      })
    );
    return;
  }
  // A turn is accepted and has not streamed yet, or a tool answer is being
  // applied: the tab keeps waiting (#1784), and is offered the stream when
  // it starts or told there is none when the turn ends without one.
  const [waiting] = deps.tasks.peekList({
    definition: lane.definition,
    lane: lane.lane,
    status: ["pending", "running"],
    results: false,
    order: "oldest"
  });
  if (waiting || (answeringIn(deps).get(deps.session ?? "") ?? 0) > 0) {
    const parked = parkedIn(deps.streams, deps.session ?? "");
    // A tab whose socket closed while it waited is dropped here; the rest
    // are answered when the turn streams or ends, or the answer is applied.
    for (const [id, tab] of parked) {
      if ((tab.connection as { readyState?: number }).readyState === 3) {
        parked.delete(id);
      }
    }
    parked.set(connection.id, { connection, ...(probeId && { probeId }) });
    sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_PENDING,
        ...(waiting && { id: waiting.runId }),
        ...(probeId && { probeId })
      })
    );
    return;
  }
  sendIfOpen(
    connection,
    JSON.stringify({
      type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE,
      ...(probeId && { probeId })
    })
  );
}

/**
 * The tab acknowledged the offer: replay what the turn `requestId` has
 * streamed so far. Its later chunks reach the tab as they are sent.
 */
export async function replayTurn(
  deps: ChatDeps,
  connection: Connection,
  requestId: string
): Promise<void> {
  const streamId = chatTurnStreamId(requestId);
  if ((await deps.streams.status(streamId))?.state !== "streaming") return;
  const stop = new AbortController();
  try {
    for await (const batch of deps.streams.readBatches(streamId, {
      signal: stop.signal,
      onUpToDate: () => stop.abort()
    })) {
      for (const item of batch) {
        const text = frameText({
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          id: requestId,
          body: JSON.stringify(item.chunk),
          done: false,
          replay: true
        } as { type: string });
        if (text !== undefined) sendIfOpen(connection, text);
      }
      if (stop.signal.aborted) break;
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  }
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
  connection: Connection,
  message: unknown
): Promise<boolean> {
  if (typeof message !== "string") return false;
  const event = parseProtocolMessage(message);
  if (!event) return false;
  switch (event.type) {
    case "chat-request": {
      const request = parseChatRequest(event.id, event.init.body);
      if (!("messages" in request)) {
        // A request that cannot run ends at once, with the reason.
        const text = frameText({
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          id: event.id,
          body: `Ignoring chat request ${event.id}: ${request.reason}`,
          done: true,
          error: true
        } as { type: string });
        if (text !== undefined) sendIfOpen(connection, text);
        return true;
      }
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
        {
          requestId: request.requestId,
          ...(request.trigger === "submit-message" &&
            lane.arrival && { arrival: lane.arrival })
        }
      );
      return true;
    }
    case "cancel":
      await cancelTurn(deps, event.id);
      return true;
    case "cancel-continuation": {
      // A stop from a tab that waits for a tool continuation: the
      // continuation turns of the lane stop, waiting or running.
      for (const run of deps.tasks.peekList({
        definition: lane.definition,
        lane: lane.lane,
        status: ["pending", "running"],
        results: false
      })) {
        const input = deps.tasks.inputOf<ChatTurnInput>(run.runId);
        if (input?.trigger === "tool-answer") await cancelTurn(deps, run.runId);
      }
      return true;
    }
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
    case "stream-resume-request":
      await resumeChat(deps, lane, connection, event.probeId);
      return true;
    case "stream-resume-ack":
      await replayTurn(deps, connection, event.id);
      return true;
    // A tab pushing its whole transcript is the host's to handle (or
    // ignore): the core stores messages only with a turn.
    default:
      return false;
  }
}
