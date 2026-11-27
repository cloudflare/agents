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
import type { TaskJson } from "../tasks/types";
import {
  chatTurnStreamId,
  continueRequestsOf,
  STOPPED_METADATA,
  liveTurnsOf,
  offeredIn,
  parkedIn,
  releaseParked,
  retryingTurn,
  type ChatDeps,
  type ChatTurnInput
} from "./chat-host";
import { frameText } from "./chat-frames";
import {
  clearRecentChatTerminals,
  recentChatTerminal,
  recordRecentChatTerminal,
  type ChatRecentTerminal
} from "./recent-terminals";
import { mergeUserMessages } from "./merge-user-messages";
import { originMessageIds } from "./origin-message-ids";
import { messageIdsOf } from "./chat-host";
import { sendIfOpen } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { parseChatRequest } from "./protocol-dispatch";
import {
  CHAT_REQUEST_CONTEXT_KEY as REQUEST_CONTEXT_KEY,
  storableRequestContext
} from "./chat-host";
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
    /** Store this turn's tools and body as the chat's request context. */
    storeContext?: boolean;
    /** Stops the turn, waiting or running, when it aborts. */
    signal?: AbortSignal;
    /** Keep the run after it settles, for a caller that reads it later. */
    retain?: boolean;
    /** The run's metadata (the core's own is under its `chat` key). */
    metadata?: Record<string, TaskJson>;
  } = {}
): Promise<{ requestId: string; dropped?: true }> {
  const session = deps.sessions.session(input.session ?? deps.session ?? "");
  // The turn stores the request's messages when it starts (after the
  // replies queued before it); it carries only those the transcript does not
  // already hold as they are, since a tab sends its whole list.
  const fresh: UIMessage[] = [];
  const arrival = options.arrival ?? "queue";
  const replaced: Array<{
    id: string;
    metadata: Readonly<Record<string, unknown>> | undefined;
  }> = [];
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
      replaced.push({
        id: waiting.runId,
        metadata: deps.tasks.peek(waiting.runId)?.metadata
      });
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
  // The tools and body: a client's request stores them as the chat's
  // request context when its turn starts, and a turn that brings none reads
  // them then (`storeContext` makes a host turn store its own).
  const run: ChatTurnInput = options.storeContext
    ? { ...given, storeContext: true }
    : given;
  // A regenerate notes the questions the chat held when it arrived: one sent
  // after it makes it skip.
  // A client's request notes the user messages it came from: its end
  // frames echo them (`messageIds`), so the tab can tell which send ended.
  const origins =
    given.trigger === "submit-message" || given.trigger === "regenerate-message"
      ? originMessageIds(input.messages)
      : undefined;
  const chat: Record<string, TaskJson> = {
    ...((options.metadata?.chat as Record<string, TaskJson>) ?? {}),
    ...(origins && { messageIds: origins }),
    ...(given.trigger === "regenerate-message" && {
      questions: ((await session.getHistory()) as UIMessage[])
        .filter((message) => message.role === "user")
        .map((message) => message.id)
    })
  };
  const metadata =
    Object.keys(chat).length > 0
      ? { ...options.metadata, chat }
      : options.metadata;
  const receipt = await deps.tasks.run(lane.definition, run as never, {
    lane: lane.lane,
    retain: options.retain ?? false,
    ...(metadata !== undefined && { metadata }),
    policy: arrival === "merge" ? "latest" : arrival,
    ...(options.requestId !== undefined && { runId: options.requestId }),
    ...(options.idempotencyKey !== undefined && {
      idempotencyKey: options.idempotencyKey
    })
  });
  const dropped = (receipt as { dropped?: boolean }).dropped === true;
  if (options.signal && !dropped) {
    const signal = options.signal;
    const stop = () => void cancelTurn(deps, receipt.runId);
    if (signal.aborted) stop();
    else {
      signal.addEventListener("abort", stop, { once: true });
      // A long-lived signal outlives many turns: each one's listener goes
      // when its turn ends.
      void deps.tasks
        .wait(receipt.runId)
        .finally(() => signal.removeEventListener("abort", stop));
    }
  }
  // The tab that sent a replaced or dropped request learns it ended
  // without a reply (its turn never runs to say so).
  if (dropped) {
    endUnstarted(deps, receipt.runId, "skipped", metadata);
    // The tab put the dropped messages in its list: the stored one, sent
    // back, takes them out again.
    const origin = originOf(metadata);
    if (origin !== undefined && deps.webSockets) {
      const text = frameText({
        type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
        messages: await session.getHistory()
      } as { type: string });
      for (const connection of deps.webSockets.getConnections()) {
        if (connection.id === origin && text !== undefined) {
          sendIfOpen(connection, text);
        }
      }
    }
  } else {
    for (const run of replaced) {
      endUnstarted(deps, run.id, "skipped", run.metadata);
    }
  }
  return { requestId: receipt.runId, ...(dropped && { dropped: true }) };
}

/** The tab that sent a request, as its run's metadata records it. */
function originOf(
  metadata: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const origin = (metadata?.chat as { origin?: unknown } | undefined)?.origin;
  return typeof origin === "string" ? origin : undefined;
}

/**
 * A request that ends without its turn running (stopped, replaced or
 * dropped before it started): its end goes to the tab that sent it (to every
 * tab when no tab sent it), and is kept for a tab that comes back.
 */
function endUnstarted(
  deps: ChatDeps,
  requestId: string,
  outcome: "skipped" | "aborted",
  metadata: Readonly<Record<string, unknown>> | undefined
): void {
  const origin = originOf(metadata);
  const messageIds = messageIdsOf(metadata);
  const frame = {
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: requestId,
    body: "",
    done: true,
    outcome,
    ...(messageIds && { messageIds })
  };
  recordRecentChatTerminal(deps.kv, frame);
  const text = frameText(frame as { type: string });
  if (text === undefined || !deps.webSockets) return;
  for (const connection of deps.webSockets.getConnections()) {
    if (origin === undefined || connection.id === origin) {
      sendIfOpen(connection, text);
    }
  }
}

/** Stop the turn `requestId`, waiting or running. */
export async function cancelTurn(
  deps: ChatDeps,
  requestId: string,
  reason = "chat turn cancelled"
): Promise<boolean> {
  // A turn stopped before it started keeps its place in the lane: when its
  // turn comes it stores its question, unanswered, and ends (the mark is on
  // its run, so a reset keeps it).
  // Its tab learns at once that it ended.
  const record = deps.tasks.peek(requestId);
  if (record?.status === "pending" && record.attempt === 0) {
    const marked = deps.tasks.patchMetadata(requestId, STOPPED_METADATA.key, {
      [STOPPED_METADATA.field]: true
    });
    if (marked) {
      endUnstarted(deps, requestId, "aborted", record.metadata);
    }
    return marked;
  }
  const retrying = retryingTurn(deps, requestId);
  const cancelled = await deps.tasks.cancel(requestId, reason);
  if (cancelled && retrying) await retrying.settle(true);
  return cancelled;
}

/**
 * Stop every turn of the chat, waiting or running, and drop the
 * continuations tool answers asked for that have not started.
 */
export async function stopAllTurns(
  deps: ChatDeps,
  lane: ChatLane,
  reason?: string
): Promise<void> {
  const wanted = continueRequestsOf(deps.streams);
  if (wanted.size > 0) {
    wanted.clear();
    deps.emit?.("chat:continuation:dropped", {
      requestId: null,
      reason: "stopped"
    });
  }
  for (const run of deps.tasks.peekList({
    definition: lane.definition,
    lane: lane.lane,
    status: ["pending", "running"],
    results: false,
    order: "oldest"
  })) {
    const continuation =
      run.status === "pending" &&
      deps.tasks.inputOf<ChatTurnInput>(run.runId)?.trigger === "tool-answer";
    await cancelTurn(deps, run.runId, reason);
    if (continuation) {
      deps.emit?.("chat:continuation:dropped", {
        requestId: run.runId,
        reason: "stopped"
      });
    }
  }
}

/** Clear the chat: no waiting or running turn goes on, and the transcript is emptied. */
export async function clearChat(deps: ChatDeps, lane: ChatLane): Promise<void> {
  const waiting = deps.tasks.peekList({
    definition: lane.definition,
    lane: lane.lane,
    status: ["pending"],
    results: false
  });
  const retrying = waiting.flatMap(
    (run) => retryingTurn(deps, run.runId) ?? []
  );
  // The turns that had not started end skipped, and their tabs are told.
  const unstarted = waiting
    .filter((run) => (deps.tasks.peek(run.runId)?.attempt ?? 0) === 0)
    .map((run) => ({
      id: run.runId,
      metadata: deps.tasks.peek(run.runId)?.metadata
    }));
  // A tab waiting for a stream learns at once that none is coming (the
  // clear waits for a running turn to stop, which can take a while).
  const parked = parkedIn(deps.streams, deps.session ?? "");
  if (parked.size > 0) {
    releaseParked(parked, { type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE });
  }
  await deps.tasks.clear(lane.lane, "chat cleared");
  for (const run of unstarted) {
    endUnstarted(deps, run.id, "skipped", run.metadata);
  }

  for (const turn of retrying) await turn.settle(false);
  await deps.sessions.session(deps.session ?? "").clearMessages();
  continueRequestsOf(deps.streams).clear();
  clearRecentChatTerminals(deps.kv);
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

function continueWanted(deps: ChatDeps): Set<string> {
  return continueRequestsOf(deps.streams);
}

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
  options: {
    autoContinue?: boolean;
    /**
     * The tools the answering tab runs. When the answer settles its call and
     * lists some, they replace the stored ones, so its continuation runs
     * with the latest schemas.
     */
    clientTools?: unknown;
    /**
     * The tab that answered. Asking to continue, it waits for the
     * continuation's stream: offered it when it starts, or told there is
     * none.
     */
    connection?: Connection;
  } = {}
): Promise<boolean> {
  const counts = answeringIn(deps);
  const key = deps.session ?? "";
  if (options.autoContinue && options.connection) {
    parkedIn(deps.streams, key).set(options.connection.id, {
      connection: options.connection
    });
  }
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
  options: {
    autoContinue?: boolean;
    clientTools?: unknown;
    connection?: Connection;
  }
): Promise<boolean> {
  // The continuation's run names the tab that answered, as a request's
  // names the tab that sent it.
  const answeredFrom = options.connection
    ? { metadata: { chat: { origin: options.connection.id } } }
    : {};
  const storeTools = async () => {
    if (!Array.isArray(options.clientTools) || !options.clientTools.length)
      return;
    const session = deps.sessions.session(deps.session ?? "");
    const stored = await session.internal_config(REQUEST_CONTEXT_KEY);
    const context = stored
      ? (JSON.parse(stored) as Pick<ChatTurnInput, "body">)
      : {};
    await session.internal_setConfig(
      REQUEST_CONTEXT_KEY,
      storableRequestContext(
        JSON.stringify({ ...context, clientTools: options.clientTools })
      )
    );
  };
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
    if (live.waitingCalls().includes(answer.toolCallId)) {
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
      await storeTools();
      // An answer that asks to continue is remembered for its batch: once
      // the batch is answered (by any answer, or a server tool's output),
      // one continuation of that reply waits behind the streaming turn.
      const replyId = live.replyId();
      const wanted = continueWanted(deps);
      if (options.autoContinue && replyId !== undefined) wanted.add(replyId);
      if (replyId !== undefined && wanted.has(replyId)) {
        live.whenAnswered(() => {
          if (!wanted.delete(replyId)) return;
          submitTurn(
            deps,
            lane,
            { trigger: "tool-answer", replyId },
            { idempotencyKey: `continue:${live.requestId}`, ...answeredFrom }
          ).catch((error: unknown) => {
            console.error(
              "[chat] could not continue after a tool answer:",
              error
            );
          });
        });
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
    // The newest message that holds the call decides: an answer it no
    // longer takes (a repeated decision) does not land on an older one.
    // A decision that names its approval goes on to the request it names.
    if (!applied) {
      if (
        !(answer.kind === "approval" && answer.approvalId !== undefined) &&
        message.parts.some(
          (part) =>
            (part as { toolCallId?: unknown }).toolCallId === answer.toolCallId
        )
      ) {
        return false;
      }
      continue;
    }
    if (!applied.changed) return false;
    const next = {
      ...message,
      parts: applied.parts as unknown as UIMessage["parts"]
    };
    await session.upsertMessage(next as never);
    await storeTools();
    // Only the latest reply continues: once a later message moved the chat
    // on, an answer for an older call is stored and nothing more.
    if (i !== history.length - 1) {
      if (options.autoContinue || continueWanted(deps).delete(next.id)) {
        deps.emit?.("chat:continuation:dropped", {
          requestId: null,
          reason: "moved_on"
        });
      }
      return true;
    }
    // One continuation per answered batch, however many answers race to
    // complete it; an earlier answer of the batch may have asked for it.
    const wanted = continueWanted(deps);
    if (options.autoContinue && waitsOnAnswer(next)) wanted.add(next.id);
    if (!waitsOnAnswer(next) && (options.autoContinue || wanted.has(next.id))) {
      wanted.delete(next.id);
      await submitTurn(
        deps,
        lane,
        { trigger: "tool-answer", replyId: next.id },
        {
          idempotencyKey: `continue:${next.id}:${answeredCalls(next)}`,
          ...answeredFrom
        }
      );
    }
    return true;
  }
  return false;
}

/** The answered tool calls of a message, as a stable key. */
function answeredCalls(message: UIMessage): string {
  return message.parts
    .filter((part) => {
      const state = (part as { state?: unknown }).state;
      return (
        state === "output-available" ||
        state === "output-error" ||
        state === "output-denied"
      );
    })
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
  probeId?: string,
  /** The request ids the tab still waits on, newest last. */
  requestIds: readonly string[] = []
): Promise<void> {
  const requestId = await streamingTurn(deps, lane);
  // Requests the tab waits on that ended while it was away are ended first,
  // except the one announced below, whose end follows the ack.
  const endOthers = (except?: string) => {
    for (const id of requestIds) {
      if (id === except || id === requestId) continue;
      const ended = recentChatTerminal(deps.kv, [id]);
      if (ended && ended.outcome !== "recovering") {
        sendIfOpen(connection, endedFrame(ended));
      }
    }
  };
  if (requestId) {
    endOthers();
    offeredIn(deps.streams).set(connection.id, requestId);
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
  // A continuation is the answering tab's to wait on: another tab stays on
  // the live frames every tab gets, and is told there is nothing to resume.
  const parkedNow = parkedIn(deps.streams, deps.session ?? "");
  const continuationOnly =
    waiting !== undefined &&
    deps.tasks.inputOf<ChatTurnInput>(waiting.runId)?.trigger ===
      "tool-answer" &&
    !parkedNow.has(connection.id);
  if (continuationOnly) {
    endOthers();
    sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE,
        ...(probeId && { probeId })
      })
    );
    return;
  }
  if (waiting || (answeringIn(deps).get(deps.session ?? "") ?? 0) > 0) {
    endOthers();
    const parked = parkedNow;
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
  // The newest request the tab waits on that ended while it was away is
  // offered as a stream: its end follows the ack, the only frame a tab
  // surfaces as the request's outcome.
  const ended = recentChatTerminal(deps.kv, requestIds);
  if (ended && ended.outcome !== "recovering") {
    endOthers(ended.requestId);
    sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: ended.requestId,
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

/** The frame that tells a tab how a request that ended while it was away ended. */
function endedFrame(ended: ChatRecentTerminal): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: ended.requestId,
    body: ended.body,
    done: true,
    replay: true,
    ...(ended.error && { error: true }),
    ...(ended.outcome !== undefined && { outcome: ended.outcome }),
    ...(ended.continuation && { continuation: true }),
    ...(ended.messageIds && { messageIds: ended.messageIds })
  });
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
  const offered = offeredIn(deps.streams);
  // Its live frames reach the tab again from here (or, if it acked another
  // stream, it waits on nothing).
  const release = () => {
    if (offered.get(connection.id) === requestId) offered.delete(connection.id);
  };
  if ((await deps.streams.status(streamId))?.state !== "streaming") {
    // It ended while the tab was away: its recorded end.
    release();
    const ended = recentChatTerminal(deps.kv, [requestId]);
    if (ended) sendIfOpen(connection, endedFrame(ended));
    return;
  }
  // What this isolate buffered is written first.
  deps.streams.__DO_NOT_USE_WILL_BREAK__sync().flush(streamId);
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
  } finally {
    release();
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
        // A request that cannot run ends at once, with the reason; its end
        // is kept for the tab if it resumes by the request's id, and the
        // failure is published.
        const frame = {
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          id: event.id,
          body: `Ignoring chat request ${event.id}: ${request.reason}`,
          done: true,
          error: true
        };
        recordRecentChatTerminal(deps.kv, frame);
        deps.emit?.("chat:request:failed", {
          requestId: event.id,
          stage: "parse",
          messagesPersisted: false,
          error: request.reason
        });
        const text = frameText(frame as { type: string });
        if (text !== undefined) sendIfOpen(connection, text);
        return true;
      }
      const question = [...request.messages]
        .reverse()
        .find((m) => m.role === "user");
      try {
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
            // The tab that sent it, for an end its turn never sends.
            metadata: { chat: { origin: connection.id } },
            ...(request.trigger === "submit-message" &&
              lane.arrival && { arrival: lane.arrival })
          }
        );
      } catch (error) {
        // A request that cannot be accepted (its record cannot be written)
        // ends at once on its tab, with the reason.
        const text = frameText({
          type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
          id: event.id,
          body: error instanceof Error ? error.message : String(error),
          done: true,
          error: true
        } as { type: string });
        if (text !== undefined) sendIfOpen(connection, text);
      }
      return true;
    }
    case "cancel": {
      // A stop of the turn that streams drops what its answers asked to
      // continue; other replies keep theirs.
      const live = liveTurnsOf(deps.streams).get(deps.session ?? "");
      // The reply the stopped turn extends: the one it streams, or, for a
      // continuation that has not streamed yet, the one it continues.
      const replyId =
        (live?.requestId === event.id ? live.replyId() : undefined) ??
        deps.tasks.inputOf<ChatTurnInput>(event.id)?.replyId;
      if (
        replyId !== undefined &&
        continueRequestsOf(deps.streams).delete(replyId)
      ) {
        deps.emit?.("chat:continuation:dropped", {
          requestId: null,
          reason: "stopped",
          stoppedRequestId: event.id
        });
      }
      // A continuation an answer already started for that reply, waiting
      // behind it, goes too.
      if (replyId !== undefined) {
        for (const run of deps.tasks.peekList({
          definition: lane.definition,
          lane: lane.lane,
          status: ["pending"],
          results: false
        })) {
          const input = deps.tasks.inputOf<ChatTurnInput>(run.runId);
          if (input?.trigger !== "tool-answer" || input.replyId !== replyId) {
            continue;
          }
          await cancelTurn(deps, run.runId);
          deps.emit?.("chat:continuation:dropped", {
            requestId: run.runId,
            reason: "stopped",
            stoppedRequestId: event.id
          });
        }
      }
      await cancelTurn(deps, event.id);
      return true;
    }
    case "cancel-continuation": {
      continueRequestsOf(deps.streams).clear();
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
        {
          autoContinue: event.autoContinue === true,
          clientTools: event.clientTools,
          connection
        }
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
        { autoContinue: event.autoContinue === true, connection }
      );
      return true;
    case "stream-resume-request":
      await resumeChat(deps, lane, connection, event.probeId, event.requestIds);
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
