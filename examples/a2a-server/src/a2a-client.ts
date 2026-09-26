import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  StreamResponse,
  Task,
  TaskState,
  parseSseStream
} from "@a2a-js/sdk";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";

const STOPPING_STATES = new Set([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED
]);
const MAX_AGENT_CARD_BYTES = 64 * 1024;
const MAX_TASK_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_TASK_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 128;
const MAX_RECONNECTS = 3;
const DEADLINE_MS = 30_000;

type Fetcher = typeof fetch;

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: "SendStreamingMessage" | "SubscribeToTask" | "GetTask";
  params: Record<string, unknown>;
}

interface ClientState {
  current?: Task;
  events: number;
  fallbackUsed: boolean;
  subscribeSequence: number;
}

export interface StreamTransition {
  key: string;
  message: string;
  task: Task;
}

export interface StreamingTaskOptions {
  currentTask?: Task;
  endpoint: string;
  fetcher?: Fetcher;
  message: {
    contextId: string;
    messageId: string;
    taskId?: string;
    text: string;
  };
  onTransition?: (transition: StreamTransition) => Promise<void>;
  requestId: string;
  token: string;
}

export interface SpecialistConversationResult {
  answer: string;
  continuationResponse: string;
  contextId: string;
  question: string;
  taskId: string;
}

export interface SpecialistConversationOptions {
  cardUrl: string;
  contextId: string;
  draft: string;
  parentTaskId: string;
  prompt: string;
  token: string;
}

export interface SpecialistConversationStart {
  endpoint: string;
  question: string;
  task: Task;
}

interface SpecialistConversationDependencies {
  fetcher?: Fetcher;
  onTransition?: StreamingTaskOptions["onTransition"];
}

/** Discovers the JSON-RPC endpoint from an Agent Card with a bounded body read. */
export async function discoverAgent(
  cardUrl: string,
  fetcher: Fetcher = fetch
): Promise<{ card: AgentCard; endpoint: string }> {
  const response = await fetcher(cardUrl, {
    headers: { "A2A-Version": A2A_PROTOCOL_VERSION },
    signal: AbortSignal.timeout(DEADLINE_MS)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Agent Card discovery returned HTTP ${response.status}.`);
  }
  const raw = await readResponseWithLimit(response, MAX_AGENT_CARD_BYTES);
  const card = AgentCard.fromJSON(parseJson(raw, "Agent Card is not JSON."));
  const endpoint = card.supportedInterfaces.find(
    (item) =>
      item.protocolBinding === "JSONRPC" &&
      item.protocolVersion === A2A_PROTOCOL_VERSION
  )?.url;
  if (!endpoint) {
    throw new Error(
      `Agent Card has no JSON-RPC interface for A2A ${A2A_PROTOCOL_VERSION}.`
    );
  }
  return { card, endpoint };
}

/**
 * Runs the deterministic two-turn specialist exchange over discovered A2A HTTP
 * routes. The second message keeps task/context identity and uses a fresh ID.
 */
export async function runSpecialistConversation(
  options: SpecialistConversationOptions,
  dependencies: SpecialistConversationDependencies = {}
): Promise<SpecialistConversationResult> {
  const start = await startSpecialistConversation(options, dependencies);
  return continueSpecialistConversation(
    {
      endpoint: start.endpoint,
      parentTaskId: options.parentTaskId,
      question: start.question,
      task: start.task,
      token: options.token
    },
    dependencies
  );
}

/** Runs and validates the first specialist turn, stopping at INPUT_REQUIRED. */
export async function startSpecialistConversation(
  options: SpecialistConversationOptions,
  dependencies: SpecialistConversationDependencies = {}
): Promise<SpecialistConversationStart> {
  const fetcher = dependencies.fetcher ?? fetch;
  const { endpoint } = await discoverAgent(options.cardUrl, fetcher);
  const first = await sendStreamingTask({
    endpoint,
    fetcher,
    requestId: `${options.parentTaskId}.specialist.turn-1.rpc`,
    token: options.token,
    onTransition: dependencies.onTransition,
    message: {
      contextId: options.contextId,
      messageId: `${options.parentTaskId}.specialist.turn-1.message`,
      text: `Original request:\n${options.prompt}\n\nCoordinator draft:\n${options.draft}`
    }
  });
  if (first.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
    throw new Error(
      `Specialist turn 1 ended in ${stateName(first)} instead of INPUT_REQUIRED.`
    );
  }
  const question = taskMessage(first);
  if (!question) {
    throw new Error("Specialist entered INPUT_REQUIRED without a question.");
  }
  await dependencies.onTransition?.({
    key: `${options.parentTaskId}:specialist:question`,
    message: `Specialist requested continuation: ${question}`,
    task: first
  });
  return { endpoint, question, task: first };
}

/** Continues the same specialist task and validates its terminal response. */
export async function continueSpecialistConversation(
  options: {
    endpoint: string;
    parentTaskId: string;
    question: string;
    task: Task;
    token: string;
  },
  dependencies: SpecialistConversationDependencies = {}
): Promise<SpecialistConversationResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const followUp =
    "Prioritize correctness and verify the core assumption before optimizing.";
  const completed = await sendStreamingTask({
    currentTask: options.task,
    endpoint: options.endpoint,
    fetcher,
    requestId: `${options.parentTaskId}.specialist.turn-2.rpc`,
    token: options.token,
    onTransition: dependencies.onTransition,
    message: {
      contextId: options.task.contextId,
      messageId: `${options.parentTaskId}.specialist.turn-2.message`,
      taskId: options.task.id,
      text: followUp
    }
  });
  if (
    completed.id !== options.task.id ||
    completed.contextId !== options.task.contextId
  ) {
    throw new Error("Specialist continuation changed task identity.");
  }
  if (completed.status?.state !== TaskState.TASK_STATE_COMPLETED) {
    throw new Error(
      `Specialist turn 2 ended in ${stateName(completed)} instead of COMPLETED.`
    );
  }
  const answer =
    artifactText(completed, "joint-response") || taskMessage(completed);
  if (!answer) throw new Error("Specialist completed without an answer.");
  return {
    answer,
    continuationResponse: followUp,
    contextId: completed.contextId,
    question: options.question,
    taskId: completed.id
  };
}

/** Sends one streaming turn with bounded replay, resubscription, and GetTask fallback. */
export async function sendStreamingTask(
  options: StreamingTaskOptions
): Promise<Task> {
  const fetcher = options.fetcher ?? fetch;
  const now = Date.now;
  const deadline = now() + DEADLINE_MS;
  const state: ClientState = {
    current: options.currentTask,
    events: 0,
    fallbackUsed: false,
    subscribeSequence: 0
  };
  const request: RpcRequest = {
    jsonrpc: "2.0",
    id: options.requestId,
    method: "SendStreamingMessage",
    params: {
      message: {
        messageId: options.message.messageId,
        contextId: options.message.contextId,
        ...(options.message.taskId ? { taskId: options.message.taskId } : {}),
        role: "ROLE_USER",
        parts: [{ text: options.message.text }]
      }
    }
  };

  let reconnects = 0;
  let requestAccepted = false;
  let thrown: unknown;
  while (true) {
    try {
      await consumeStream(
        request,
        state,
        options.message.contextId,
        options.endpoint,
        options.token,
        fetcher,
        deadline,
        now,
        options.onTransition,
        () => {
          requestAccepted = true;
        }
      );
      thrown = undefined;
      break;
    } catch (error) {
      thrown = error;
      if (!(error instanceof RecoverableStreamError)) throw error;
      if (requestAccepted) break;
      if (reconnects++ >= MAX_RECONNECTS) throw error;
      // Replay the exact request and messageId until acceptance is observed.
    }
  }
  if (thrown && !requestAccepted) throw thrown;
  if (!requestAccepted || !state.current) {
    throw new Error("SendStreamingMessage did not return a task snapshot.");
  }

  while (!isStopping(state.current) && reconnects < MAX_RECONNECTS) {
    reconnects += 1;
    const subscribe: RpcRequest = {
      jsonrpc: "2.0",
      id: `${request.id}.subscribe-${++state.subscribeSequence}`,
      method: "SubscribeToTask",
      params: { id: state.current.id }
    };
    try {
      await consumeStream(
        subscribe,
        state,
        state.current.contextId,
        options.endpoint,
        options.token,
        fetcher,
        deadline,
        now,
        options.onTransition
      );
    } catch (error) {
      if (error instanceof RecoverableStreamError) continue;
      if (
        !(error instanceof RpcError) ||
        error.code !== A2A_ERROR_CODE.UNSUPPORTED_OPERATION ||
        state.fallbackUsed
      ) {
        throw error;
      }
      // A terminal transition may win immediately before subscription starts.
      state.fallbackUsed = true;
      state.current = await getTask(
        state.current.id,
        state,
        options.endpoint,
        options.token,
        fetcher,
        deadline,
        now,
        options.onTransition
      );
    }
  }
  if (!isStopping(state.current)) {
    state.current = await getTask(
      state.current.id,
      state,
      options.endpoint,
      options.token,
      fetcher,
      deadline,
      now,
      options.onTransition
    );
  }
  if (!isStopping(state.current)) {
    throw new Error("A2A stream disconnected before a stopping state.");
  }
  return state.current;
}

async function consumeStream(
  request: RpcRequest,
  state: ClientState,
  expectedContextId: string,
  endpoint: string,
  token: string,
  fetcher: Fetcher,
  deadline: number,
  now: () => number,
  onTransition?: StreamingTaskOptions["onTransition"],
  onAccepted: () => void = () => undefined
): Promise<void> {
  let response: Response;
  try {
    response = await call(request, token, fetcher, deadline, now, endpoint);
  } catch (error) {
    throw new RecoverableStreamError(error);
  }
  if (
    !response.ok ||
    !response.headers.get("Content-Type")?.includes("text/event-stream")
  ) {
    const body = parseJson(
      await readResponseWithLimit(response, MAX_TASK_RESPONSE_BYTES),
      "A2A endpoint returned invalid JSON."
    );
    const envelope = validateEnvelope(body, request.id);
    if (envelope.error !== undefined) throw rpcError(envelope.error);
    throw new Error(
      `A2A endpoint returned HTTP ${response.status} instead of SSE.`
    );
  }

  const iterator = parseSseStream(response, MAX_TASK_EVENT_BYTES)[
    Symbol.asyncIterator
  ]();
  let sawTaskSnapshot = false;
  try {
    while (true) {
      let next: IteratorResult<{ data: string }, void>;
      try {
        next = await iterator.next();
      } catch (error) {
        if (isSseLimitError(error)) throw error;
        throw new RecoverableStreamError(error);
      }
      if (next.done) {
        if (!sawTaskSnapshot) {
          throw new RecoverableStreamError(
            new Error("A2A stream ended before its task snapshot.")
          );
        }
        return;
      }
      if (++state.events > MAX_EVENTS) {
        throw new Error("A2A endpoint returned too many SSE events.");
      }
      const envelope = validateEnvelope(
        parseJson(next.value.data, "A2A SSE event contains invalid JSON."),
        request.id
      );
      if (envelope.error !== undefined) throw rpcError(envelope.error);
      const update = StreamResponse.fromJSON(envelope.result);
      state.current = applyUpdate(
        state.current,
        update,
        expectedContextId,
        request.method === "SendStreamingMessage"
      );
      if (update.payload?.$case === "task") {
        sawTaskSnapshot = true;
        onAccepted();
      }
      await notifyTransition(request, update, state.current, onTransition);
      if (isStopping(state.current)) return;
    }
  } finally {
    await closeIterator(iterator);
  }
}

async function getTask(
  taskId: string,
  state: ClientState,
  endpoint: string,
  token: string,
  fetcher: Fetcher,
  deadline: number,
  now: () => number,
  onTransition?: StreamingTaskOptions["onTransition"]
): Promise<Task> {
  const request: RpcRequest = {
    jsonrpc: "2.0",
    id: `${taskId}.terminal-fallback`,
    method: "GetTask",
    params: { id: taskId }
  };
  const response = await call(request, token, fetcher, deadline, now, endpoint);
  const envelope = validateEnvelope(
    parseJson(
      await readResponseWithLimit(response, MAX_TASK_RESPONSE_BYTES),
      "GetTask returned invalid JSON."
    ),
    request.id
  );
  if (!response.ok || envelope.error !== undefined)
    throw rpcError(envelope.error);
  const task = Task.fromJSON(envelope.result);
  assertIdentity(state.current, task.id, task.contextId);
  await onTransition?.({
    key: `${request.id}:task:${task.status?.state ?? 0}`,
    message: `GetTask fallback: ${stateName(task)}`,
    task
  });
  return task;
}

function call(
  request: RpcRequest,
  token: string,
  fetcher: Fetcher,
  deadline: number,
  now: () => number,
  endpoint?: string
): Promise<Response> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("A2A conversation deadline exceeded.");
  if (!endpoint) throw new Error("A2A request endpoint is missing.");
  return fetcher(endpoint, {
    method: "POST",
    headers: {
      "A2A-Version": A2A_PROTOCOL_VERSION,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(remaining)
  });
}

function applyUpdate(
  current: Task | undefined,
  update: StreamResponse,
  expectedContextId: string,
  allowInitial: boolean
): Task {
  if (update.payload?.$case === "task") {
    const task = update.payload.value;
    if (current) assertIdentity(current, task.id, task.contextId);
    else if (!allowInitial || task.contextId !== expectedContextId) {
      throw new Error(
        "A2A endpoint returned an unexpected initial task identity."
      );
    }
    return task;
  }
  if (!current)
    throw new Error("A2A stream did not begin with a task snapshot.");
  if (update.payload?.$case === "statusUpdate") {
    const event = update.payload.value;
    assertIdentity(current, event.taskId, event.contextId);
    current.status = event.status;
  }
  if (update.payload?.$case === "artifactUpdate") {
    const event = update.payload.value;
    assertIdentity(current, event.taskId, event.contextId);
    if (!event.artifact)
      throw new Error("A2A endpoint returned an empty Artifact event.");
    const index = current.artifacts.findIndex(
      (item) => item.artifactId === event.artifact?.artifactId
    );
    if (index < 0) current.artifacts.push(event.artifact);
    else if (event.append) {
      current.artifacts[index] = {
        ...current.artifacts[index],
        ...event.artifact,
        parts: [...current.artifacts[index]!.parts, ...event.artifact.parts]
      };
    } else current.artifacts[index] = event.artifact;
  }
  return current;
}

async function notifyTransition(
  request: RpcRequest,
  update: StreamResponse,
  task: Task,
  observer?: StreamingTaskOptions["onTransition"]
): Promise<void> {
  if (!observer) return;
  const payload = update.payload;
  if (!payload) return;
  if (payload.$case === "artifactUpdate") {
    const artifactId = payload.value.artifact?.artifactId ?? "unknown";
    await observer({
      key: `${request.id}:artifact:${artifactId}`,
      message: `Specialist artifact: ${artifactId}`,
      task
    });
    return;
  }
  const state =
    payload.$case === "task"
      ? payload.value.status?.state
      : payload.$case === "statusUpdate"
        ? payload.value.status?.state
        : undefined;
  await observer({
    key: `${request.id}:${payload.$case}:${state ?? 0}`,
    message: `Specialist ${payload.$case}: ${stateName(task)}`,
    task
  });
}

interface RpcEnvelope {
  error?: unknown;
  result?: unknown;
}

function validateEnvelope(value: unknown, id: string): RpcEnvelope {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    value.id !== id ||
    (value.result === undefined && value.error === undefined)
  ) {
    throw new Error("A2A endpoint returned an invalid JSON-RPC envelope.");
  }
  return value;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function rpcError(value: unknown): RpcError {
  if (!isRecord(value) || typeof value.code !== "number") {
    return new RpcError(-32603, "A2A endpoint returned an invalid error.");
  }
  return new RpcError(
    value.code,
    typeof value.message === "string" ? value.message : "A2A call failed."
  );
}

function assertIdentity(
  task: Task | undefined,
  taskId: string,
  contextId: string
): void {
  if (!task || task.id !== taskId || task.contextId !== contextId) {
    throw new Error("A2A stream changed task identity.");
  }
}

function isStopping(task: Task): boolean {
  return (
    task.status?.state !== undefined && STOPPING_STATES.has(task.status.state)
  );
}

export function taskMessage(task: Task): string {
  return (
    task.status?.message?.parts
      .flatMap((part) =>
        part.content?.$case === "text" ? [part.content.value] : []
      )
      .join("\n")
      .trim() ?? ""
  );
}

function artifactText(task: Task, artifactId: string): string {
  const artifact = task.artifacts.find(
    (item) => item.artifactId === artifactId
  );
  return (
    artifact?.parts
      .flatMap((part) =>
        part.content?.$case === "text" ? [part.content.value] : []
      )
      .join("\n")
      .trim() ?? ""
  );
}

async function readResponseWithLimit(
  response: Response,
  limit: number
): Promise<string> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error("A2A response is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result = "";
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      length += value.byteLength;
      if (length > limit) throw new Error("A2A response is too large.");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function closeIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  if (!iterator.return) return;
  try {
    await iterator.return();
  } catch {
    // Preserve the protocol result or original stream error.
  }
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(message);
  }
}

function stateName(task: Task): string {
  return TaskState[task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED];
}

function isSseLimitError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("maximum allowed size")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RecoverableStreamError extends Error {
  constructor(cause: unknown) {
    super("A2A stream was interrupted.", { cause });
    this.name = "RecoverableStreamError";
  }
}
