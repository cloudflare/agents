import {
  Role,
  TaskState,
  type AgentCard,
  type CancelTaskRequest,
  type DeleteTaskPushNotificationConfigRequest,
  type GetExtendedAgentCardRequest,
  type GetTaskPushNotificationConfigRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type ListTaskPushNotificationConfigsResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  type Task,
  type TaskPushNotificationConfig
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError
} from "@a2a-js/sdk/errors";
import { extractPrompt, type WorkflowRunner } from "./executor";
import { mintTaskId, validateContextId } from "./ids";
import {
  normalizeStatusTimestampAfter,
  restoreMessageDataNull
} from "./json-validation";
import {
  messageFingerprint,
  messageText,
  validateClientMessageId
} from "./messages";
import type { ResolvedA2AServerFeatures } from "./types";
import type { A2ATaskRepository, AcceptedTask } from "./task-store";

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED
]);

export interface RequestBehavior {
  maxTextCharacters?: number;
  features: ResolvedA2AServerFeatures;
  cancellationHook?: (task: Task) => Promise<void>;
  errors: {
    blockingSendNotSupported?: string;
    streamingNotSupported?: string;
    subscriptionNotSupported?: string;
  };
}

/**
 * Implements the SDK's A2A operations using the store and Workflow executor
 * belonging to one context-sharded Durable Object.
 */
export class DurableA2ARequestHandler implements A2ARequestHandler {
  /** Wires the handler to this context's card, task store, and runtime behavior. */
  constructor(
    private readonly card: AgentCard,
    private readonly store: A2ATaskRepository,
    private readonly executor: WorkflowRunner,
    private readonly behavior: RequestBehavior
  ) {}

  /** Returns the agent card supplied when this handler was created. */
  async getAgentCard(): Promise<AgentCard> {
    return this.card;
  }

  /** Rejects extended-card requests because this runtime does not support them. */
  async getAuthenticatedExtendedAgentCard(
    _params: GetExtendedAgentCardRequest,
    _context: ServerCallContext
  ): Promise<AgentCard> {
    throw new UnsupportedOperationError(
      "This server does not expose an extended agent card."
    );
  }

  /** Accepts a message and either returns immediately or waits for the turn to stop. */
  async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext
  ): Promise<Message | Task> {
    let task = await this.acceptAndStart(params, context, true);
    if (params.configuration?.returnImmediately !== true) {
      task = await this.waitForTaskStop(
        task.id,
        context,
        params.configuration?.historyLength
      );
    }
    applyHistoryLength(task, params.configuration?.historyLength);
    return task;
  }

  /** Accepts a message, starts its Workflow, and streams its durable task events. */
  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext
  ): AsyncGenerator<StreamResponse, void, undefined> {
    if (!this.behavior.features.streaming) {
      throw new UnsupportedOperationError(
        this.behavior.errors.streamingNotSupported ??
          "Streaming is not supported."
      );
    }
    const task = await this.acceptAndStart(params, context, false);
    yield* this.streamTask(
      task.id,
      context,
      params.configuration?.historyLength
    );
  }

  /** Loads one task and limits its returned history when requested. */
  async getTask(
    params: GetTaskRequest,
    context: ServerCallContext
  ): Promise<Task> {
    validateHistoryLength(params.historyLength);
    const task = await this.store.load(params.id, context, {
      historyLength: params.historyLength
    });
    if (!task) throw new TaskNotFoundError(`Task not found: ${params.id}`);
    applyHistoryLength(task, params.historyLength);
    return task;
  }

  /** Validates list options, queries the store, and shapes each returned task. */
  async listTasks(
    params: ListTasksRequest,
    context: ServerCallContext
  ): Promise<ListTasksResponse> {
    if (!this.behavior.features.taskListing) {
      throw new UnsupportedOperationError("Task listing is not enabled.");
    }
    validateHistoryLength(params.historyLength);
    const pageSize = params.pageSize ?? 50;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RequestMalformedError(
        "pageSize must be an integer between 1 and 100."
      );
    }
    let listParams = params;
    if (params.statusTimestampAfter) {
      try {
        listParams = {
          ...params,
          statusTimestampAfter: normalizeStatusTimestampAfter(
            params.statusTimestampAfter
          )
        };
      } catch (error) {
        throw new RequestMalformedError(errorMessage(error));
      }
    }
    const response = await this.store.list(listParams, context);
    for (const task of response.tasks) {
      applyHistoryLength(task, params.historyLength);
      if (params.includeArtifacts !== true) task.artifacts = [];
    }
    return response;
  }

  /**
   * Persists cancellation intent, terminates the targeted Workflow, then
   * atomically marks storage canceled if no other terminal transition wins.
   */
  async cancelTask(
    params: CancelTaskRequest,
    context: ServerCallContext
  ): Promise<Task> {
    if (!this.behavior.features.taskCancellation) {
      throw new UnsupportedOperationError("Task cancellation is not enabled.");
    }
    while (true) {
      await this.store.armRecovery();
      const preparation = this.store.beginCancellation(params.id, context);
      await this.store.armRecovery();
      if (preparation.status === "canceled") return preparation.task;

      const target = preparation.target;
      await this.executor.terminate(
        target.workflowInstanceId,
        target.params,
        target.allowMissing
      );
      const canceled = this.store.cancelAfterTermination(
        params.id,
        target,
        context
      );
      if (!canceled) continue;
      const stableTaskId = canceled.task.id;
      const responseTask = structuredClone(canceled.task);
      if (canceled.newlyCanceled && this.behavior.cancellationHook) {
        try {
          await this.behavior.cancellationHook(structuredClone(responseTask));
          this.store.acknowledgeCancellationHook(stableTaskId);
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "task cancellation hook failed",
              taskId: params.id,
              error: error instanceof Error ? error.name : "UnknownError"
            })
          );
        }
      }
      return responseTask;
    }
  }

  /** Streams an existing non-terminal task; interrupted snapshots end immediately. */
  async *resubscribe(
    params: SubscribeToTaskRequest,
    context: ServerCallContext
  ): AsyncGenerator<StreamResponse, void, undefined> {
    if (!this.behavior.features.streaming) {
      throw new UnsupportedOperationError(
        this.behavior.errors.subscriptionNotSupported ??
          "Streaming subscriptions are not supported."
      );
    }
    const snapshot = await this.store.streamSnapshot(params.id, context);
    if (isTerminal(snapshot.task)) {
      throw new UnsupportedOperationError(
        `Task ${params.id} is already terminal and cannot be subscribed to.`
      );
    }
    yield* this.streamTask(params.id, context);
  }

  /** Rejects creation because push notifications are outside this runtime's scope. */
  async createTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context: ServerCallContext
  ): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }

  /** Rejects reads because push notifications are outside this runtime's scope. */
  async getTaskPushNotificationConfig(
    _params: GetTaskPushNotificationConfigRequest,
    _context: ServerCallContext
  ): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }

  /** Rejects listing because push notifications are outside this runtime's scope. */
  async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigsRequest,
    _context: ServerCallContext
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new PushNotificationNotSupportedError();
  }

  /** Rejects deletion because push notifications are outside this runtime's scope. */
  async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigRequest,
    _context: ServerCallContext
  ): Promise<void> {
    throw new PushNotificationNotSupportedError();
  }

  /**
   * Validates and durably accepts one turn before creating its Workflow. Alarms
   * on both sides of acceptance close the crash window around Workflow launch.
   */
  private async acceptAndStart(
    params: SendMessageRequest,
    context: ServerCallContext,
    enforceImmediateResponse: boolean
  ): Promise<Task> {
    validateHistoryLength(params.configuration?.historyLength);
    const incoming = params.message;
    if (!incoming?.messageId) {
      throw new RequestMalformedError("message.messageId is required.");
    }
    restoreMessageDataNull(incoming);
    try {
      validateClientMessageId(incoming.messageId);
    } catch (error) {
      throw new RequestMalformedError(errorMessage(error));
    }
    if (incoming.role !== Role.ROLE_USER) {
      throw new RequestMalformedError("message.role must be ROLE_USER.");
    }
    if (incoming.taskId && !this.behavior.features.multiTurn) {
      throw new UnsupportedOperationError(
        "Multi-turn continuation is not enabled."
      );
    }
    try {
      extractPrompt(messageText(incoming), this.behavior.maxTextCharacters);
    } catch (error) {
      throw new RequestMalformedError(errorMessage(error));
    }
    if (
      enforceImmediateResponse &&
      !this.behavior.features.blockingSend &&
      params.configuration?.returnImmediately !== true
    ) {
      throw new UnsupportedOperationError(
        this.behavior.errors.blockingSendNotSupported ??
          "configuration.returnImmediately must be true."
      );
    }

    let contextId: string;
    try {
      contextId = validateContextId(incoming.contextId);
    } catch (error) {
      throw new RequestMalformedError(errorMessage(error));
    }

    await this.store.armRecovery();
    let accepted: AcceptedTask;
    if (incoming.taskId) {
      const userMessage: Message = { ...incoming, contextId };
      accepted = this.store.acceptContinuation(
        incoming.taskId,
        userMessage,
        messageFingerprint(userMessage, contextId, incoming.taskId),
        context
      );
    } else {
      const taskId = mintTaskId(contextId);
      const userMessage: Message = { ...incoming, contextId, taskId };
      accepted = this.store.acceptInitial(
        taskId,
        contextId,
        userMessage,
        messageFingerprint(incoming, contextId, ""),
        context
      );
    }
    await this.store.armRecovery();

    if (accepted.shouldStart) {
      try {
        await this.executor.start(accepted.workflowInstanceId, accepted.params);
        this.store.markWorking(accepted.task.id, accepted.params.turn);
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "workflow creation failed",
            taskId: accepted.task.id,
            workflowInstanceId: accepted.workflowInstanceId,
            error: error instanceof Error ? error.name : "UnknownError"
          })
        );
        throw error;
      }
    }

    const task = await this.store.load(accepted.task.id, context, {
      historyLength: params.configuration?.historyLength
    });
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${accepted.task.id}`);
    }
    return task;
  }

  /**
   * Yields the current task snapshot, then tails persisted events until the
   * task needs input, reaches a final state, or the request is aborted.
   */
  private async *streamTask(
    taskId: string,
    context: ServerCallContext,
    historyLength?: number
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const snapshot = await this.store.streamSnapshot(
      taskId,
      context,
      historyLength
    );
    applyHistoryLength(snapshot.task, historyLength);
    yield { payload: { $case: "task", value: snapshot.task } };
    if (isInterruptedOrTerminal(snapshot.task)) return;

    let sequence = snapshot.sequence;
    while (true) {
      let events = this.store.eventsAfter(taskId, sequence);
      if (events.length === 0) {
        const signal = abortSignal(context);
        const waiter = this.store.waitForUpdate(taskId, signal);
        try {
          // Re-read after registering the waiter so an update cannot be missed.
          events = this.store.eventsAfter(taskId, sequence);
          if (events.length === 0) await waiter.promise;
        } finally {
          waiter.cancel();
        }
        if (events.length === 0) {
          events = this.store.eventsAfter(taskId, sequence);
        }
        if (events.length === 0) {
          if (signal?.aborted) throw signal.reason;
          if (this.store.isInterruptedOrTerminal(taskId)) return;
          continue;
        }
      }

      for (const event of events) {
        sequence = event.sequence;
        yield event.response;
        if (isStoppingEvent(event.response)) return;
      }
    }
  }

  /** Blocks a non-streaming send until its task needs input or becomes terminal. */
  private async waitForTaskStop(
    taskId: string,
    context: ServerCallContext,
    historyLength?: number
  ): Promise<Task> {
    const signal = abortSignal(context);
    while (true) {
      const task = await this.store.load(taskId, context, { historyLength });
      if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);
      if (isInterruptedOrTerminal(task)) return task;
      const waiter = this.store.waitForUpdate(taskId, signal);
      try {
        // Re-read after registration to close the same update-before-wait race.
        const latest = await this.store.load(taskId, context, {
          historyLength
        });
        if (latest && isInterruptedOrTerminal(latest)) return latest;
        await waiter.promise;
      } finally {
        waiter.cancel();
      }
      if (signal?.aborted) throw signal.reason;
    }
  }
}

/** Checks whether a task is in one of the four final states. */
function isTerminal(task: Task): boolean {
  return (
    task.status?.state !== undefined && TERMINAL_STATES.has(task.status.state)
  );
}

/** Checks whether this turn is complete or paused for client action. */
function isInterruptedOrTerminal(task: Task): boolean {
  return (
    task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED ||
    task.status?.state === TaskState.TASK_STATE_AUTH_REQUIRED ||
    isTerminal(task)
  );
}

/** Recognizes the status events that end the current SSE subscription. */
function isStoppingEvent(response: StreamResponse): boolean {
  if (response.payload?.$case !== "statusUpdate") return false;
  const state = response.payload.value.status?.state;
  return (
    state === TaskState.TASK_STATE_INPUT_REQUIRED ||
    state === TaskState.TASK_STATE_AUTH_REQUIRED ||
    (state !== undefined && TERMINAL_STATES.has(state))
  );
}

/** Trims task history to the most recent requested number of messages. */
function applyHistoryLength(task: Task, historyLength?: number): void {
  if (historyLength === undefined) return;
  task.history = historyLength === 0 ? [] : task.history.slice(-historyLength);
}

function validateHistoryLength(historyLength?: number): void {
  if (
    historyLength !== undefined &&
    (!Number.isSafeInteger(historyLength) || historyLength < 0)
  ) {
    throw new RequestMalformedError(
      "historyLength must be a non-negative safe integer."
    );
  }
}

/** Safely turns any thrown value into an error message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the transport's request-cancellation signal from the SDK context. */
function abortSignal(context: ServerCallContext): AbortSignal | undefined {
  const signal = context.state.get("signal");
  return signal instanceof AbortSignal ? signal : undefined;
}
