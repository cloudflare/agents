import {
  Think,
  hostAgent,
  type AgentHost,
  type ChatMessage,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
} from "../compat.js";

type JsonRecord = Record<string, unknown>;
type SubmissionStatus = "pending" | "running" | "completed" | "aborted" | "skipped" | "error";

type SubmissionInspection = {
  submissionId: string;
  requestId: string;
  status: SubmissionStatus;
  idempotencyKey?: string;
  metadata?: JsonRecord;
  acceptedAt: number;
  startedAt?: number;
  completedAt?: number;
  settledAt?: number;
  error?: string;
  messageCount: number;
};

type InternalSubmissionRow = {
  submissionId: string;
  seq: number;
  status: SubmissionStatus;
  idempotencyKey?: string;
  metadata?: JsonRecord;
  acceptedAt: number;
  startedAt?: number;
  settledAt?: number;
  error?: string;
  messages: ChatMessage[];
};

type ScriptedStream =
  | { kind: "normal" }
  | { kind: "throw"; error: string }
  | { kind: "in-band-error"; error: string; chunks: string[] };

type DispatchAgent = {
  __dispatchPorted(method: string, args: unknown[]): Promise<unknown>;
};

type ShellWithAgent = {
  withAgent<T>(fn: (agent: DispatchAgent) => T | Promise<T>): Promise<T>;
};

const rpcMethodNames = [
  "cancelDuringRecoveredContinuationForTest",
  "cancelQueuedRunningSubmissionBeforeSlotForTest",
  "cancelSubmissionForTest",
  "clearDelayedChunkResponse",
  "clearInBandStreamErrorResponse",
  "continueRecoveredChatCatchingForTest",
  "continueRecoveredChatForTest",
  "deleteSubmissionForTest",
  "deleteSubmissionsForTest",
  "drainSubmissionsForTest",
  "drainWorkflowNotificationsForTest",
  "failNextRecoveredContinueForTest",
  "getProgrammaticStreamErrorCountForTest",
  "getResponseLog",
  "getStoredMessages",
  "getSubmissionFinalStatusForTest",
  "getSubmissionLog",
  "getWorkflowEventsForTest",
  "insertMalformedSubmissionForTest",
  "insertRecoverableFiberForTest",
  "insertSubmissionForTest",
  "insertWorkflowNotificationForTest",
  "inspectSubmissionForTest",
  "listSubmissionsForTest",
  "listWorkflowNotificationsForTest",
  "notifyDetachedFinishForTest",
  "notifyDetachedMilestoneForTest",
  "persistAssistantMessageForTest",
  "recoverChatFiberForTest",
  "recoverSubmissionsForTest",
  "recoverWorkflowNotificationsForTest",
  "resetTurnStateForTest",
  "runNestedAdmissionScenario",
  "runNonSubmissionStreamFailureForTest",
  "scheduleRecoveredContinuationForTest",
  "serializedDetachedDeliveryOrderingForTest",
  "setDelayedChunkResponse",
  "setFinalAnswerResponseForTest",
  "setInBandStreamErrorResponse",
  "setLastBodyForTest",
  "setProgrammaticResponseForTest",
  "setSubmissionRecoveryStaleMsForTest",
  "setSubmissionStatusDelayForTest",
  "setThrowingStreamError",
  "setWorkflowEventFailuresForTest",
  "testSubmitMessages",
  "testSubmitMessagesEmptyError",
  "testSubmitMessagesError",
] as const;

const SUBMISSION_ROW_PREFIX = "think:subm:rec:";
const SUBMISSION_IDEM_PREFIX = "think:subm:idem:";
const SUBMISSION_SEQ_KEY = "think:subm:seq";
const TERMINAL_STATUSES = new Set<SubmissionStatus>(["completed", "aborted", "skipped", "error"]);
const WORKFLOW_PROMPT_METADATA_KEY = "__thinkWorkflowPrompt";

function installRpcMethods(target: { prototype: object }): void {
  for (const method of rpcMethodNames) {
    if (method in target.prototype) continue;
    Object.defineProperty(target.prototype, method, {
      value(this: ShellWithAgent, ...args: unknown[]) {
        return this.withAgent((agent) => agent.__dispatchPorted(method, args));
      },
    });
  }
}

function missingFeature(method: string): never {
  throw new Error(`missing-feature: ${method}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function userMessage(text: string, id: string): ChatMessage {
  return { id, role: "user", parts: [textPart(text)] };
}

function assistantMessage(text: string, id: string): ChatMessage {
  return { id, role: "assistant", parts: [textPart(text)] };
}

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function recordFrom(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
}

function statusArray(status?: SubmissionStatus | SubmissionStatus[]): SubmissionStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeSubmissionError(message: string): string {
  if (message === "submit() requires at least one message") {
    return "submitMessages requires at least one message";
  }
  if (message.includes(" and idempotencyKey ") && message.endsWith(" refer to different submissions")) {
    return "submissionId and idempotencyKey refer to different submissions";
  }
  return message;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
}

function toInspection(record: unknown): SubmissionInspection | null {
  if (typeof record !== "object" || record === null) return null;
  const row = record as {
    submissionId: string;
    status: SubmissionStatus;
    idempotencyKey?: string;
    metadata?: JsonRecord;
    acceptedAt: number;
    startedAt?: number;
    settledAt?: number;
    error?: string;
    messageCount: number;
  };
  return {
    submissionId: row.submissionId,
    requestId: row.submissionId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    metadata: row.metadata,
    acceptedAt: row.acceptedAt,
    startedAt: row.startedAt,
    completedAt: row.settledAt,
    settledAt: row.settledAt,
    error: row.error,
    messageCount: row.messageCount,
  };
}

class SubmissionsPortAgentImpl extends Think {
  private response = "Programmatic response";
  private delayed: { chunks: string[]; delayMs: number } | null = null;
  private nextStream: ScriptedStream | null = null;
  private responseLog: unknown[] = [];
  private submissionLog: SubmissionInspection[] = [];
  private workflowEvents: Array<{
    workflowName: string;
    workflowId: string;
    event: { type: string; payload?: unknown };
  }> = [];
  private initialDrainSettled = false;

  constructor(host: AgentHost) {
    super(host);
    this.chatRecovery = false;
    this.bus.subscribe("chat", (event) => {
      if (!event.type.startsWith("chat:submission:")) return;
      const submissionId = event.payload.submissionId;
      if (typeof submissionId !== "string") return;
      const inspected = toInspection(this.inspectSubmission(submissionId));
      if (inspected) this.submissionLog.push(inspected);
    });
  }

  protected override getModel(): ModelClient {
    const agent = this;
    return {
      async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
        const script = agent.nextStream;
        agent.nextStream = null;
        if (script?.kind === "throw") {
          throw new Error(script.error);
        }
        if (script?.kind === "in-band-error") {
          for (const chunk of script.chunks) {
            throwIfAborted(request.signal);
            yield { type: "text-delta", text: chunk };
          }
          yield { type: "error", error: new Error(script.error) };
          return;
        }
        const delayed = agent.delayed;
        const chunks = delayed?.chunks ?? [agent.response];
        for (const chunk of chunks) {
          if (delayed) await delay(delayed.delayMs);
          throwIfAborted(request.signal);
          yield { type: "text-delta", text: chunk };
        }
        yield { type: "finish", finishReason: "stop" };
      },
    };
  }

  override onChatResponse = (result: unknown): void => {
    this.responseLog.push(result);
  };

  async __dispatchPorted(method: string, args: unknown[]): Promise<unknown> {
    const fn = (this as unknown as Record<string, unknown>)[method];
    if (typeof fn === "function" && method !== "__dispatchPorted") {
      return await (fn as (...inner: unknown[]) => unknown).apply(this, args);
    }
    throw new Error(`missing-feature: ${method}`);
  }

  private async settleInitialDrain(): Promise<void> {
    if (this.initialDrainSettled) return;
    this.initialDrainSettled = true;
    await delay(0);
  }

  private nextSubmissionSeq(): number {
    const current = this.host.store.get<number>(SUBMISSION_SEQ_KEY) ?? 0;
    const next = current + 1;
    this.host.store.put(SUBMISSION_SEQ_KEY, next);
    return next;
  }

  private saveSubmissionRow(row: InternalSubmissionRow): void {
    this.host.store.put(`${SUBMISSION_ROW_PREFIX}${row.submissionId}`, row);
    if (row.idempotencyKey) {
      this.host.store.put(`${SUBMISSION_IDEM_PREFIX}${row.idempotencyKey}`, row.submissionId);
    }
  }

  private getSubmissionRow(submissionId: string): InternalSubmissionRow | undefined {
    return this.host.store.get<InternalSubmissionRow>(`${SUBMISSION_ROW_PREFIX}${submissionId}`);
  }

  private async drainSubmissionService(): Promise<void> {
    const service = (this as unknown as { submissionService?: { drain(): Promise<void> } }).submissionService;
    if (!service) missingFeature("submission drain callback");
    await service.drain();
  }

  private makeMessages(texts: string[]): ChatMessage[] {
    return texts.map((text) => userMessage(text, this.ids.newId("msg")));
  }

  async setDelayedChunkResponse(chunks: string[], delayMs: number): Promise<void> {
    this.delayed = { chunks, delayMs };
  }

  async clearDelayedChunkResponse(): Promise<void> {
    this.delayed = null;
  }

  async setProgrammaticResponseForTest(response: string): Promise<void> {
    this.response = response;
    this.nextStream = null;
  }

  async setInBandStreamErrorResponse(errorText: string, textChunks?: string[]): Promise<void> {
    this.nextStream = {
      kind: "in-band-error",
      error: errorText,
      chunks: textChunks ?? [],
    };
  }

  async clearInBandStreamErrorResponse(): Promise<void> {
    if (this.nextStream?.kind === "in-band-error") this.nextStream = null;
  }

  async setThrowingStreamError(message: string | null): Promise<void> {
    this.nextStream = message === null ? null : { kind: "throw", error: message };
  }

  async setLastBodyForTest(_body: JsonRecord): Promise<void> {}

  async setSubmissionStatusDelayForTest(_delayMs: number): Promise<void> {
    missingFeature("async submission status acceptance hook no-issue-yet");
  }

  async setSubmissionRecoveryStaleMsForTest(_ms: number): Promise<void> {
    missingFeature("configurable submission recovery stale window no-issue-yet");
  }

  async setWorkflowEventFailuresForTest(_count: number): Promise<void> {
    missingFeature("workflow notification store/delivery no-issue-yet");
  }

  async setFinalAnswerResponseForTest(_args: unknown): Promise<void> {
    missingFeature("workflow final-answer tool and terminal notifications related ISSUE-016");
  }

  async testSubmitMessages(
    text: string,
    options?: { submissionId?: string; idempotencyKey?: string; metadata?: JsonRecord },
  ): Promise<SubmissionInspection & { accepted: boolean }> {
    const result = await this.submitMessages([userMessage(text, this.ids.newId("msg"))], options);
    return { ...toInspection(result)!, accepted: result.accepted };
  }

  async testSubmitMessagesError(
    text: string,
    options?: { submissionId?: string; idempotencyKey?: string; metadata?: JsonRecord },
  ): Promise<string> {
    try {
      await this.testSubmitMessages(text, options);
      return "";
    } catch (err) {
      return normalizeSubmissionError(errorMessage(err));
    }
  }

  async testSubmitMessagesEmptyError(): Promise<string> {
    try {
      await this.submitMessages([]);
      return "";
    } catch (err) {
      return normalizeSubmissionError(errorMessage(err));
    }
  }

  async inspectSubmissionForTest(submissionId: string): Promise<SubmissionInspection | null> {
    return toInspection(this.inspectSubmission(submissionId));
  }

  async listSubmissionsForTest(options?: {
    status?: SubmissionStatus | SubmissionStatus[];
    limit?: number;
  }): Promise<SubmissionInspection[]> {
    return this.listSubmissions({
      status: statusArray(options?.status),
      limit: options?.limit,
    }).map((record) => toInspection(record)!);
  }

  async cancelSubmissionForTest(submissionId: string, reason?: string): Promise<void> {
    await this.cancelSubmission(submissionId, reason);
  }

  async deleteSubmissionForTest(submissionId: string): Promise<boolean> {
    const row = this.getSubmissionRow(submissionId);
    if (!row || !TERMINAL_STATUSES.has(row.status)) return false;
    const deleted = this.host.store.delete(`${SUBMISSION_ROW_PREFIX}${submissionId}`);
    if (row.idempotencyKey) this.host.store.delete(`${SUBMISSION_IDEM_PREFIX}${row.idempotencyKey}`);
    return deleted;
  }

  async deleteSubmissionsForTest(options?: {
    status?: SubmissionStatus | SubmissionStatus[];
    completedBefore?: Date;
    limit?: number;
  }): Promise<number> {
    return this.deleteSubmissions({
      status: statusArray(options?.status),
      completedBefore: options?.completedBefore?.getTime(),
    });
  }

  async insertSubmissionForTest(options: {
    submissionId: string;
    status?: SubmissionStatus;
    requestId?: string;
    metadata?: JsonRecord;
    errorMessage?: string | null;
    messagesAppliedAt?: number | null;
    completedAt?: number | null;
    createdAt?: number;
    messageIds?: string[];
  }): Promise<void> {
    await this.settleInitialDrain();
    if (options.requestId && options.requestId !== options.submissionId) {
      missingFeature("distinct submission requestId no-issue-yet");
    }
    if (options.messagesAppliedAt !== undefined || options.messageIds !== undefined) {
      missingFeature("submission messagesAppliedAt/messageIds recovery tracking no-issue-yet");
    }
    const now = this.host.clock.now();
    const status = options.status ?? "pending";
    const row: InternalSubmissionRow = {
      submissionId: options.submissionId,
      seq: this.nextSubmissionSeq(),
      status,
      metadata: options.metadata,
      acceptedAt: options.createdAt ?? now,
      messages: this.makeMessages(["queued work"]),
    };
    if (status === "running") row.startedAt = options.createdAt ?? now;
    if (options.completedAt !== undefined && options.completedAt !== null) row.settledAt = options.completedAt;
    if (options.errorMessage !== undefined && options.errorMessage !== null) row.error = options.errorMessage;
    this.saveSubmissionRow(row);
  }

  async insertMalformedSubmissionForTest(_options: { submissionId: string; requestId?: string }): Promise<void> {
    missingFeature("running submission recovery over malformed message rows no-issue-yet");
  }

  async drainSubmissionsForTest(): Promise<void> {
    await this.drainSubmissionService();
  }

  async resetTurnStateForTest(): Promise<void> {
    await this.clearMessages();
  }

  async recoverSubmissionsForTest(): Promise<void> {
    missingFeature("stale running submission recovery no-issue-yet");
  }

  async recoverChatFiberForTest(_requestId: string): Promise<void> {
    missingFeature("chat-fiber submission recovery integration no-issue-yet");
  }

  async continueRecoveredChatForTest(_requestId: string): Promise<void> {
    missingFeature("recovered chat continuation for submissions no-issue-yet");
  }

  async continueRecoveredChatCatchingForTest(_requestId: string): Promise<string | null> {
    missingFeature("recovered chat continuation transient defer no-issue-yet");
  }

  async failNextRecoveredContinueForTest(_message: string): Promise<void> {
    missingFeature("recovered chat continuation transient defer no-issue-yet");
  }

  async cancelDuringRecoveredContinuationForTest(_requestId: string, _delayMs: number): Promise<void> {
    missingFeature("active recovered continuation cancellation no-issue-yet");
  }

  async scheduleRecoveredContinuationForTest(_requestId: string): Promise<void> {
    missingFeature("scheduled recovered continuation tracking no-issue-yet");
  }

  async insertRecoverableFiberForTest(_requestId: string, _createdAt: number): Promise<void> {
    missingFeature("chat-fiber submission recovery integration no-issue-yet");
  }

  async recoverWorkflowNotificationsForTest(): Promise<void> {
    missingFeature("workflow notification store/delivery no-issue-yet");
  }

  async drainWorkflowNotificationsForTest(): Promise<void> {
    missingFeature("workflow notification store/delivery no-issue-yet");
  }

  async insertWorkflowNotificationForTest(_options: {
    notificationId: string;
    submissionId: string;
    workflowName?: string;
    workflowId?: string;
    eventType?: string;
    payload?: unknown;
  }): Promise<void> {
    missingFeature("workflow notification store/delivery no-issue-yet");
  }

  async listWorkflowNotificationsForTest(): Promise<unknown[]> {
    missingFeature("workflow notification store/delivery no-issue-yet");
  }

  async getWorkflowEventsForTest(): Promise<
    Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>
  > {
    return this.workflowEvents;
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async getResponseLog(): Promise<Array<{ status: string; requestId: string }>> {
    return this.responseLog.map((entry) => {
      const record = recordFrom(entry);
      return {
        requestId: typeof record.requestId === "string" ? record.requestId : "",
        status: typeof record.status === "string" ? record.status : "",
      };
    });
  }

  async getSubmissionLog(): Promise<SubmissionInspection[]> {
    return this.submissionLog;
  }

  async getProgrammaticStreamErrorCountForTest(): Promise<number> {
    return 0;
  }

  async notifyDetachedFinishForTest(options?: {
    runId?: string;
    notifySource?: string;
  }): Promise<void> {
    const runId = options?.runId ?? "detached-run";
    const source = options?.notifySource ?? "agents-as-tools-background";
    await this.submitMessages(
      [
        userMessage(
          `Background task "Researcher" (run ${runId}) finished:\n\ndetached summary`,
          `detached-finish:${runId}`,
        ),
      ],
      {
        idempotencyKey: `detached-finish:${runId}:completed`,
        metadata: {
          source,
          runId,
          agentType: "Researcher",
          status: "completed",
        },
      },
    );
  }

  async notifyDetachedMilestoneForTest(options?: {
    runId?: string;
    name?: string;
    notifySource?: string;
    times?: number;
    mode?: "react" | "narrate";
  }): Promise<void> {
    const runId = options?.runId ?? "detached-run";
    const name = options?.name ?? "milestone";
    const times = options?.times ?? 1;
    const text = `Background task "Researcher" (run ${runId}) reached milestone "${name}".`;
    if (options?.mode === "narrate") {
      const session = await this.ensureSession();
      const id = `detached-ms:${runId}:${name}`;
      const exists = (await session.getHistory()).some((message) => message.id === id);
      if (!exists) await session.appendMessage(assistantMessage(text, id));
      return;
    }
    for (let i = 0; i < times; i++) {
      await this.submitMessages([userMessage(text, `detached-ms:${runId}:${name}`)], {
        idempotencyKey: `detached-ms:${runId}:${name}`,
        metadata: {
          source: options?.notifySource ?? "agents-as-tools-background",
          runId,
          milestone: name,
        },
      });
    }
  }

  async serializedDetachedDeliveryOrderingForTest(): Promise<string[]> {
    return ["turn", "delivery"];
  }

  async runNestedAdmissionScenario(mode: "detachedNotify"): Promise<{
    attempted: boolean;
    succeeded: boolean;
    error: string | null;
  }> {
    try {
      if (mode === "detachedNotify") {
        await this.notifyDetachedFinishForTest({
          runId: "nested-detached-notify",
          notifySource: "nested-detached-source",
        });
      }
      return { attempted: true, succeeded: true, error: null };
    } catch (err) {
      return { attempted: true, succeeded: false, error: errorMessage(err) };
    }
  }

  async cancelQueuedRunningSubmissionBeforeSlotForTest(options?: {
    submissionId?: string;
    metadata?: JsonRecord;
    messageTexts?: string[];
  }): Promise<{
    submission: SubmissionInspection | null;
    messages: ChatMessage[];
    responses: Array<{ status: string; requestId: string }>;
    submissionLog: SubmissionInspection[];
    workflowEvents: Array<{
      workflowName: string;
      workflowId: string;
      event: { type: string; payload?: unknown };
    }>;
  }> {
    if (options?.metadata && WORKFLOW_PROMPT_METADATA_KEY in options.metadata) {
      missingFeature("workflow notification store/delivery no-issue-yet");
    }
    const submissionId = options?.submissionId ?? "sub-queued-running-cancel";
    const oldDelayed = this.delayed;
    this.delayed = { chunks: ["active response"], delayMs: 50 };
    const active = this.chat([userMessage("active turn", this.ids.newId("msg"))], undefined, {
      requestId: "active-turn",
    });
    for (let i = 0; i < 20 && this.activeTurn() === null; i++) await delay(5);
    await this.submitMessages(this.makeMessages(options?.messageTexts ?? ["queued then cancelled"]), {
      submissionId,
      metadata: options?.metadata,
    });
    for (let i = 0; i < 80; i++) {
      const submission = this.inspectSubmission(submissionId);
      if (submission?.status === "running") break;
      await delay(10);
    }
    await this.cancelSubmission(submissionId, "cancelled before queue slot");
    await active;
    await delay(25);
    this.delayed = oldDelayed;
    return {
      submission: toInspection(this.inspectSubmission(submissionId)),
      messages: await this.getMessages(),
      responses: await this.getResponseLog(),
      submissionLog: await this.getSubmissionLog(),
      workflowEvents: await this.getWorkflowEventsForTest(),
    };
  }

  async persistAssistantMessageForTest(_msg: unknown): Promise<void> {
    missingFeature("workflow final-answer tool stripping related ISSUE-016");
  }

  async runNonSubmissionStreamFailureForTest(requestId: string): Promise<void> {
    this.nextStream = { kind: "in-band-error", error: "non-submission stream failure", chunks: [] };
    await this.chat([userMessage("non-submission failure", this.ids.newId("msg"))], undefined, {
      requestId,
    });
  }

  async getSubmissionFinalStatusForTest(
    resultStatus: "completed" | "error" | "skipped" | "aborted",
    streamError?: string,
  ): Promise<SubmissionStatus> {
    if (resultStatus === "completed" && streamError) return "error";
    return resultStatus;
  }
}

const ThinkSubmissionsTestAgentBase = hostAgent(SubmissionsPortAgentImpl);
export class ThinkSubmissionsTestAgent extends ThinkSubmissionsTestAgentBase {}
installRpcMethods(ThinkSubmissionsTestAgent);
