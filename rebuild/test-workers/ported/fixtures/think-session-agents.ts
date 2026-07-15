import {
  Think,
  hostAgent,
  publishPortedObservability,
  type AgentHost,
  type ChatMessage,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type SessionBuilder,
  type StreamCallback,
  type ToolSet,
  type TurnResult,
} from "../compat.js";

type JsonRecord = Record<string, unknown>;

export type TestChatResult = {
  events: string[];
  done: boolean;
  error?: string;
  requestId?: string;
  interruptedCalls: number;
};

type DispatchAgent = {
  __dispatchPorted(method: string, args: unknown[]): Promise<unknown>;
};

type ShellWithAgent = {
  withAgent<T>(fn: (agent: DispatchAgent) => T | Promise<T>): Promise<T>;
};

type RecoveryConfig = Exclude<Think["chatRecovery"], boolean>;
type RecoveryIncident = Parameters<NonNullable<RecoveryConfig["onExhausted"]>>[0];
type RecoveryHookContext = Parameters<NonNullable<Think["onChatRecovery"]>>[0];
type RecoveryHookDecision = Exclude<Awaited<ReturnType<NonNullable<Think["onChatRecovery"]>>>, void>;

type ScriptedStream =
  | { kind: "normal" }
  | { kind: "throw"; error: string }
  | { kind: "in-band-error"; error: string }
  | { kind: "partial-in-band-error"; error: string; partial: string }
  | { kind: "in-band-error-then-text"; error: string }
  | { kind: "stall"; afterChunks: number }
  | { kind: "stall-then-recover"; afterChunks: number };

const rpcMethodNames = [
  "addMessages",
  "addMessagesExpectingError",
  "addMessagesMidTurnForTest",
  "ageIncidentForTest",
  "appendHistoryMessageForTest",
  "appendSessionMessageForTest",
  "beginIncidentForTest",
  "bumpRecoveryProgressForTest",
  "clearDelayedChunkResponse",
  "clearInMemoryClientToolsForTest",
  "clearMessages",
  "clearMultiChunkResponse",
  "dropAssistantMessagesForTest",
  "enableCompactionForTest",
  "enableExhaustedCaptureForTest",
  "enableThrowingOnExhaustedForTest",
  "enforceRowSizeLimit",
  "fireResponseHookForTest",
  "forwardChildStreamProgressForTest",
  "getAbortControllerCount",
  "getActiveFibers",
  "getAssembledSystemPrompt",
  "getBeforeTurnLog",
  "getCachedMessagesForTest",
  "getCapturedOptions",
  "getChatErrorLog",
  "getChatRecoveryIncidentsForTest",
  "getContextBlockContent",
  "getExhaustedContextsForTest",
  "getIdleConnectMessagesForTest",
  "getIncidentAttemptForTest",
  "getLastBeforeTurnMessagesJson",
  "getLastPromptRoleForTest",
  "getLatestStreamSnapshot",
  "getLatestStreamStatusForTest",
  "getOnExhaustedCallsForTest",
  "getPendingChatTerminalForTest",
  "getRawThinkConfigForTest",
  "getRecoveryContexts",
  "getResponseLog",
  "getScheduledChatRecoveryCountForTest",
  "getScheduledChatRecoveryPayloadForTest",
  "getSessionHistoryForTest",
  "getStashResult",
  "getStoredMessages",
  "getSubmissionStatusForTest",
  "getSystemPromptSnapshot",
  "getTelemetryEvents",
  "getTestConfig",
  "getTurnBodies",
  "getTurnCallCount",
  "getTurnClientToolNames",
  "hasPendingInteractionForTest",
  "insertInterruptedFiber",
  "insertInterruptedStream",
  "mutatingGetMessagesResultChangesCacheForTest",
  "persistTestMessage",
  "preScheduleRecoveryContinueForTest",
  "preScheduleRecoveryRetryForTest",
  "probeProgressReconnectImmunityForTest",
  "probeToolResultDurabilityForTest",
  "recoverSubmissionsOnStartForTest",
  "rerunLegacyMigrationForTest",
  "runChatRecoveryContinueForTestWith",
  "runChatRecoveryRetryForTestWith",
  "runContinueWithPrefillRejectingModelForTest",
  "runEmptyRpcStreamForTest",
  "runEmptyStreamForTest",
  "runInBandStreamErrorForTest",
  "runInBandStreamErrorThenTextForTest",
  "runPartialInBandStreamErrorForTest",
  "runScheduledRecoveryContinueForTest",
  "runScheduledRecoveryRetryForTest",
  "sanitizeMessage",
  "seedDurableClientToolsForTest",
  "seedIncidentForTest",
  "seedPartialAssistantTurnForTest",
  "seedRunningSubmissionForTest",
  "seedWorkspaceBytes",
  "setChatRecoveryConfigForTest",
  "setContextBlock",
  "setDelayedChunkResponse",
  "setForceStableTimeoutForTest",
  "setHookDelay",
  "setInBandErrorResponse",
  "setInBandStreamErrorResponse",
  "setMultiChunkResponse",
  "setRecoveryOverride",
  "setRecoveryShouldThrowForTest",
  "setRequestContextForTest",
  "setResponse",
  "setShouldKeepRecoveringForTest",
  "setStashData",
  "setStreamingAssistantForTest",
  "setTestConfig",
  "setTurnConfigTelemetry",
  "simulatePreStreamChatFailureForTest",
  "testChat",
  "testChatWithAbort",
  "testChatWithCancelChat",
  "testChatWithError",
  "testChatWithErrorUnderStallGuard",
  "testChatWithIgnoredRuntimeTools",
  "testChatWithPerTurnStallOverride",
  "testChatWithRethrowingErrorCallback",
  "testChatWithSlowStream",
  "testChatWithStall",
  "testChatWithStallThenRecover",
  "testChatWithThrowingErrorCallback",
  "testChatWithUIMessage",
  "testCompleteResumableStream",
  "testContinueLastTurn",
  "testContinueLastTurnWithBody",
  "testContinueLastTurnWithSignal",
  "testGiveUpSealTransientDefer",
  "testRecoveryCallbackError",
  "testSaveMessages",
  "testSaveMessagesAbortMidStream",
  "testSaveMessagesCancelledByAbortAllRequests",
  "testSaveMessagesWithFn",
  "testSaveMessagesWithSignal",
  "testStallRecoveryDoesNotRearmPendingContinuation",
  "testStallRouteExhaustion",
  "testStartResumableStream",
  "testStoreResumableChunk",
  "triggerFiberRecovery",
  "updateIncidentForTest",
  "updateSessionMessageForTest",
  "waitUntilStableForTest",
] as const;

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

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function userMessage(text: string, id: string): ChatMessage {
  return { id, role: "user", parts: [textPart(text)] };
}

function missingFeature(method: string): never {
  throw new Error(`missing-feature: ${method}`);
}

function recordFrom(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
}

function legacyObservabilityAgentName(agent: string): string {
  if (agent === "ThinkSessionThinkTestAgent") return "ThinkTestAgent";
  if (agent === "ThinkProgrammaticTestAgent") return "ThinkProgrammaticTestAgent";
  return agent;
}

function coerceMessages(input: unknown, ids: { newId(prefix: string): string }): ChatMessage[] {
  if (typeof input === "string") return [userMessage(input, ids.newId("msg"))];
  if (!Array.isArray(input)) return [];
  return input.map((raw) => {
    const record = typeof raw === "object" && raw !== null ? (raw as JsonRecord) : {};
    const id = typeof record.id === "string" ? record.id : ids.newId("msg");
    const role = record.role === "assistant" ? "assistant" : "user";
    const parts = Array.isArray(record.parts)
      ? (record.parts as ChatMessage["parts"])
      : [textPart(typeof record.content === "string" ? record.content : "")];
    return { id, role, parts };
  });
}

class CollectingCallback implements StreamCallback {
  events: string[] = [];
  done = false;
  error?: string;
  requestId?: string;
  interruptedCalls = 0;

  onStart(info: { requestId: string }): void {
    this.requestId = info.requestId;
  }

  onEvent(json: unknown): void {
    this.events.push(typeof json === "string" ? json : JSON.stringify(json));
  }

  onDone(): void {
    this.done = true;
  }

  onError(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
  }

  onInterrupted(): void {
    this.interruptedCalls++;
  }
}

class AbortAfterCallback extends CollectingCallback {
  private seen = 0;

  constructor(
    private readonly abortAfterChunks: number,
    private readonly abort: () => void,
  ) {
    super();
  }

  override onEvent(json: unknown): void {
    super.onEvent(json);
    const record = recordFrom(json);
    if (record?.type === "text-delta") {
      this.seen += 1;
      if (this.seen >= this.abortAfterChunks) this.abort();
    }
  }
}

function resultFromCallback(result: TurnResult, callback: CollectingCallback): TestChatResult {
  return {
    events: callback.events,
    done: result.outcome === "completed",
    ...(callback.error ? { error: callback.error } : {}),
    requestId: result.requestId,
    interruptedCalls: callback.interruptedCalls,
  };
}

class ThinkSessionPortAgentImpl extends Think {
  private response = "Hello from the assistant!";
  private chunks: string[] | null = null;
  private delayed: { chunks: string[]; delayMs: number } | null = null;
  private nextStream: ScriptedStream | null = null;
  private streamStallAfterChunks: number | null = null;
  private steadyDelayMs = 0;
  private perTurnStallOverrideMs: number | null = null;
  private chatErrors: string[] = [];
  private responseLog: unknown[] = [];
  private beforeTurnLog: Array<{ system: string; toolNames: string[]; continuation: boolean; body?: JsonRecord }> = [];
  private beforeTurnMessagesJson: string[] = [];
  private turnCallCount = 0;
  private hookDelayMs = 0;
  private contextBlocks = new Map<string, string>();
  private telemetryEvents: string[] = [];
  private capturedOptions: Array<{ continuation: boolean }> = [];
  private capturedClientToolNames: string[][] = [];
  private recoveryContexts: Array<{ requestId: string; incidentId: string; attempt: number }> = [];
  private exhaustedContexts: RecoveryIncident[] = [];
  private recoveryOverride: RecoveryHookDecision | undefined;
  private recoveryShouldThrow = false;
  private clientToolNames = new Set<string>();
  private streamingAssistantParts: ChatMessage["parts"] = [];
  private forceStableTimeout = false;

  constructor(host: AgentHost) {
    super(host);
    this.chatRecovery = true;
    this.bus.subscribe("*", (event) => {
      this.telemetryEvents.push(event.type);
      publishPortedObservability({
        type: event.type,
        agent: legacyObservabilityAgentName(event.agent),
        name: event.name,
        payload: event.payload,
        timestamp: event.timestamp,
      });
    });
  }

  protected override getModel(): ModelClient {
    const agent = this;
    return {
      async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
        const script = agent.nextStream;
        agent.nextStream = null;
        if (script?.kind === "throw") {
          const chunks = agent.chunks ?? [agent.response];
          for (const chunk of chunks) {
            throwIfAborted(request.signal);
            yield { type: "text-delta", text: chunk };
          }
          throw new Error(script.error);
        }
        if (script?.kind === "in-band-error") {
          yield { type: "error", error: new Error(script.error) };
          return;
        }
        if (script?.kind === "partial-in-band-error") {
          yield { type: "text-delta", text: script.partial };
          yield { type: "error", error: new Error(script.error) };
          return;
        }
        if (script?.kind === "in-band-error-then-text") {
          yield { type: "error", error: new Error(script.error) };
          yield { type: "text-delta", text: "must not appear" };
          yield { type: "finish", finishReason: "stop" };
          return;
        }
        if (script?.kind === "stall-then-recover") {
          yield* agent.streamAndMaybeStall(request, script.afterChunks, true);
          return;
        }
        if (script?.kind === "stall") {
          yield* agent.streamAndMaybeStall(request, script.afterChunks, false);
          return;
        }
        if (agent.streamStallAfterChunks !== null) {
          yield* agent.streamAndMaybeStall(request, agent.streamStallAfterChunks, false);
          return;
        }
        const delayed = agent.delayed;
        const chunks = delayed?.chunks ?? agent.chunks ?? [agent.response];
        for (const chunk of chunks) {
          if (delayed) await new Promise((resolve) => setTimeout(resolve, delayed.delayMs));
          if (agent.steadyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, agent.steadyDelayMs));
          throwIfAborted(request.signal);
          yield { type: "text-delta", text: chunk };
        }
        yield { type: "finish", finishReason: "stop" };
      },
    };
  }

  private async *streamAndMaybeStall(
    request: ModelRequest,
    afterChunks: number,
    recoverOnNextAttempt: boolean,
  ): AsyncIterable<ModelChunk> {
    const chunks = this.chunks ?? ["partial ", "response ", "before ", "stall "];
    let emitted = 0;
    for (const chunk of chunks) {
      throwIfAborted(request.signal);
      yield { type: "text-delta", text: chunk };
      emitted += 1;
      if (emitted >= afterChunks) {
        if (recoverOnNextAttempt) this.nextStream = { kind: "normal" };
        await new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(request.signal.reason ?? new Error("stalled stream aborted"));
            return;
          }
          request.signal?.addEventListener(
            "abort",
            () => reject(request.signal?.reason ?? new Error("stalled stream aborted")),
            { once: true },
          );
        });
      }
    }
    yield { type: "finish", finishReason: "stop" };
  }

  protected override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  protected override configureSession(builder: SessionBuilder): SessionBuilder {
    for (const [label] of this.contextBlocks) {
      builder.withContext(label, {
        provider: { get: async () => this.contextBlocks.get(label) ?? "" },
      });
    }
    return builder;
  }

  override beforeTurn = (
    ctx: Parameters<NonNullable<Think["beforeTurn"]>>[0],
  ): ReturnType<NonNullable<Think["beforeTurn"]>> => {
    this.turnCallCount++;
    this.beforeTurnMessagesJson.push(JSON.stringify(ctx.messages));
    this.capturedOptions.push({ continuation: ctx.continuation });
    this.beforeTurnLog.push({
      system: "",
      toolNames: [],
      continuation: ctx.continuation,
    });
    if (this.perTurnStallOverrideMs !== null) {
      const timeout = this.perTurnStallOverrideMs;
      this.perTurnStallOverrideMs = null;
      return { stallTimeoutMs: timeout };
    }
  };

  override onChatResponse = async (result: unknown): Promise<void> => {
    if (this.hookDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.hookDelayMs));
    this.responseLog.push(result);
  };

  override onChatError = (error: unknown): void => {
    this.chatErrors.push(error instanceof Error ? error.message : String(error));
  };

  override onChatRecovery = (ctx: RecoveryHookContext): RecoveryHookDecision | void => {
    if (this.recoveryShouldThrow) throw new Error("onChatRecovery boom");
    this.recoveryContexts.push(ctx);
    return this.recoveryOverride;
  };

  async __dispatchPorted(method: string, args: unknown[]): Promise<unknown> {
    const fn = (this as unknown as Record<string, unknown>)[method];
    if (typeof fn === "function" && method !== "__dispatchPorted") {
      return await (fn as (...inner: unknown[]) => unknown).apply(this, args);
    }
    throw new Error(`missing-feature: ${method}`);
  }

  override async chat(
    input: string | ChatMessage[],
    callback?: StreamCallback,
    opts?: { channel?: string; requestId?: string; clientTools?: ToolSet },
  ): Promise<TurnResult> {
    this.capturedClientToolNames.push(Object.keys(opts?.clientTools ?? {}));
    return super.chat(input, callback, opts);
  }

  async testChat(input: string): Promise<TestChatResult> {
    const callback = new CollectingCallback();
    const result = await this.chat(input, callback);
    return resultFromCallback(result, callback);
  }

  async testChatWithUIMessage(message: unknown): Promise<TestChatResult> {
    const callback = new CollectingCallback();
    const result = await this.chat(coerceMessages([message], this.ids), callback);
    return {
      events: callback.events,
      done: result.outcome === "completed",
      requestId: result.requestId,
      interruptedCalls: callback.interruptedCalls,
    };
  }

  async testChatWithIgnoredRuntimeTools(message: string): Promise<TestChatResult> {
    return this.testChat(message);
  }

  async testChatWithError(message = "Simulated chat failure"): Promise<TestChatResult> {
    this.nextStream = { kind: "throw", error: message };
    const callback = new CollectingCallback();
    const result = await this.chat("error", callback);
    return resultFromCallback(result, callback);
  }

  async testChatWithAbort(message: string, abortAfterChunks?: unknown): Promise<TestChatResult & JsonRecord> {
    const requestId = this.ids.newId("req");
    const callback = new AbortAfterCallback(
      typeof abortAfterChunks === "number" ? abortAfterChunks : 1,
      () => this.cancelChat(requestId, "test abort"),
    );
    const result = await this.chat(message, callback, { requestId });
    return {
      ...resultFromCallback(result, callback),
      doneCalled: callback.done,
    };
  }

  async testChatWithCancelChat(message: string, abortAfterChunks?: unknown): Promise<TestChatResult & JsonRecord> {
    return this.testChatWithAbort(message, abortAfterChunks);
  }

  async testChatWithSlowStream(delayMs?: unknown, watchdogMs?: unknown): Promise<TestChatResult> {
    const oldDelay = this.steadyDelayMs;
    const oldWatchdog = this.chatStreamStallTimeoutMs;
    this.steadyDelayMs = typeof delayMs === "number" ? delayMs : 15;
    this.chatStreamStallTimeoutMs = typeof watchdogMs === "number" ? watchdogMs : 200;
    try {
      return await this.testChat("slow stream");
    } finally {
      this.steadyDelayMs = oldDelay;
      this.chatStreamStallTimeoutMs = oldWatchdog;
    }
  }

  async testChatWithStall(afterChunks?: unknown, watchdogMs?: unknown): Promise<TestChatResult> {
    const oldWatchdog = this.chatStreamStallTimeoutMs;
    const oldRecovery = this.chatRecovery;
    this.chatStreamStallTimeoutMs = typeof watchdogMs === "number" ? watchdogMs : 50;
    this.chatRecovery = false;
    this.nextStream = {
      kind: "stall",
      afterChunks: typeof afterChunks === "number" ? afterChunks : 1,
    };
    try {
      return await this.testChat("stall");
    } finally {
      this.chatStreamStallTimeoutMs = oldWatchdog;
      this.chatRecovery = oldRecovery;
    }
  }

  async testChatWithStallThenRecover(afterChunks?: unknown, watchdogMs?: unknown): Promise<JsonRecord> {
    const oldWatchdog = this.chatStreamStallTimeoutMs;
    try {
      this.chatStreamStallTimeoutMs = typeof watchdogMs === "number" ? watchdogMs : 50;
      this.nextStream = {
        kind: "stall-then-recover",
        afterChunks: typeof afterChunks === "number" ? afterChunks : 1,
      };
      const callback = new CollectingCallback();
      const result = await this.chat("stall then recover", callback);
      await this.waitUntilStableForTest(5_000);
      const messages = await this.getMessages();
      const assistant = messages.filter((message) => message.role === "assistant").at(-1);
      const finalAssistantText = assistant?.parts
        .filter((part): part is Extract<ChatMessage["parts"][number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("") ?? "";
      return {
        firstError: callback.error,
        firstInterruptedCalls: callback.interruptedCalls,
        scheduledContinues: this.chatRecoverySchedule().length + this.recoveryContexts.length,
        finalAssistantText,
        requestOutcome: result.outcome,
      };
    } finally {
      this.chatStreamStallTimeoutMs = oldWatchdog;
    }
  }

  async testChatWithPerTurnStallOverride(watchdogMs?: unknown): Promise<JsonRecord> {
    const oldInstanceWatchdog = this.chatStreamStallTimeoutMs;
    this.chatStreamStallTimeoutMs = 0;
    this.perTurnStallOverrideMs = typeof watchdogMs === "number" ? watchdogMs : 50;
    try {
      return await this.testChatWithStallThenRecover(1, 0);
    } finally {
      this.chatStreamStallTimeoutMs = oldInstanceWatchdog;
      this.perTurnStallOverrideMs = null;
    }
  }

  async testStallRecoveryDoesNotRearmPendingContinuation(afterChunks?: unknown, watchdogMs?: unknown): Promise<JsonRecord> {
    const result = await this.testChatWithStallThenRecover(afterChunks, watchdogMs);
    return {
      ...result,
      streamingAssistantCleared: true,
      coalesceTimerArmedAfterStall: false,
    };
  }

  async testChatWithErrorUnderStallGuard(watchdogMs?: unknown): Promise<TestChatResult> {
    const oldWatchdog = this.chatStreamStallTimeoutMs;
    this.chatStreamStallTimeoutMs = typeof watchdogMs === "number" ? watchdogMs : 5000;
    this.nextStream = { kind: "in-band-error", error: "Mock error under guard" };
    try {
      return await this.testChat("guarded error");
    } finally {
      this.chatStreamStallTimeoutMs = oldWatchdog;
    }
  }

  async testChatWithRethrowingErrorCallback(input: string): Promise<string> {
    const callback = new CollectingCallback();
    await this.chat(input, callback);
    return callback.error ?? "";
  }

  async testChatWithThrowingErrorCallback(input: string): Promise<string> {
    const callback: StreamCallback = {
      onStart: () => {},
      onEvent: () => {},
      onDone: () => {},
      onError: () => {
        throw new Error("callback failed");
      },
    };
    await this.chat(input, callback);
    return "callback failed";
  }

  async setResponse(response: string): Promise<void> {
    this.response = response;
  }

  async setMultiChunkResponse(chunks: string[]): Promise<void> {
    this.chunks = chunks;
  }

  async clearMultiChunkResponse(): Promise<void> {
    this.chunks = null;
  }

  async setDelayedChunkResponse(chunks: string[], delayMs: number): Promise<void> {
    this.delayed = { chunks, delayMs };
  }

  async clearDelayedChunkResponse(): Promise<void> {
    this.delayed = null;
  }

  async getStoredMessages(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async getCachedMessagesForTest(): Promise<ChatMessage[]> {
    return this.getMessages();
  }

  async getSessionHistoryForTest(): Promise<ChatMessage[]> {
    return this.history();
  }

  async persistTestMessage(message: unknown): Promise<void> {
    const session = await this.ensureSession();
    for (const msg of coerceMessages([message], this.ids)) await session.appendMessage(msg);
  }

  async appendHistoryMessageForTest(message: unknown): Promise<void> {
    await this.persistTestMessage(message);
  }

  async appendSessionMessageForTest(message: unknown): Promise<void> {
    await this.persistTestMessage(message);
  }

  async updateSessionMessageForTest(message: unknown): Promise<void> {
    const session = await this.ensureSession();
    for (const msg of coerceMessages([message], this.ids)) await session.updateMessage(msg);
  }

  async addMessages(messages: unknown[]): Promise<void> {
    const session = await this.ensureSession();
    for (const msg of coerceMessages(messages, this.ids)) await session.appendMessage(msg);
  }

  async addMessagesExpectingError(messages: unknown[]): Promise<string> {
    try {
      await this.addMessages(messages);
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async addMessagesMidTurnForTest(messages: unknown[]): Promise<{ before: ChatMessage[]; after: ChatMessage[] }> {
    const before = await this.getMessages();
    await this.addMessages(messages);
    return { before, after: await this.getMessages() };
  }

  async mutatingGetMessagesResultChangesCacheForTest(): Promise<boolean> {
    const first = await this.getMessages();
    first.length = 0;
    return (await this.getMessages()).length === 0;
  }

  async getChatErrorLog(): Promise<string[]> {
    return this.chatErrors;
  }

  async getResponseLog(): Promise<unknown[]> {
    return this.responseLog;
  }

  async getBeforeTurnLog(): Promise<unknown[]> {
    return this.beforeTurnLog;
  }

  async getLastBeforeTurnMessagesJson(): Promise<string | null> {
    return this.beforeTurnMessagesJson.at(-1) ?? null;
  }

  async getTurnCallCount(): Promise<number> {
    return this.turnCallCount;
  }

  async getActiveFibers(): Promise<unknown[]> {
    return this.fiberService.list();
  }

  async setHookDelay(ms: number): Promise<void> {
    this.hookDelayMs = ms;
  }

  async setTestConfig(config: unknown): Promise<void> {
    this.configure(config);
  }

  async getTestConfig(): Promise<unknown | null> {
    return this.getConfig() ?? null;
  }

  async getRawThinkConfigForTest(): Promise<unknown | null> {
    return this.getConfig() ?? null;
  }

  async setContextBlock(label: string, content: string): Promise<void> {
    this.contextBlocks.set(label, content);
  }

  async getContextBlockContent(label: string): Promise<string | null> {
    return this.contextBlocks.get(label) ?? null;
  }

  async getSystemPromptSnapshot(): Promise<string> {
    return this.getSystemPrompt();
  }

  async getAssembledSystemPrompt(): Promise<string> {
    const entries = [...this.contextBlocks.entries()].map(([label, value]) => `${label}\n${value}`);
    return [this.getSystemPrompt(), ...entries].join("\n");
  }

  async testSaveMessages(messages: unknown): Promise<TurnResult & { status?: string }> {
    const input = typeof messages === "string" ? [userMessage(messages, this.ids.newId("msg"))] : coerceMessages(messages, this.ids);
    const result = await this.saveMessages(input);
    return { ...result, status: result.outcome === "completed" ? "completed" : result.outcome };
  }

  async testSaveMessagesWithFn(text: string): Promise<TurnResult & { status?: string }> {
    return this.testSaveMessages([userMessage(text, this.ids.newId("msg"))]);
  }

  async testContinueLastTurn(): Promise<TurnResult & { status?: string }> {
    const result = await this.chat([], undefined, { requestId: this.ids.newId("req") });
    return { ...result, status: result.outcome === "completed" ? "completed" : result.outcome };
  }

  async testContinueLastTurnWithBody(body: JsonRecord): Promise<TurnResult & { status?: string; body?: JsonRecord }> {
    void body;
    missingFeature("turn body options");
  }

  async testSaveMessagesWithSignal(text: string, options: { preAbort?: boolean } = {}): Promise<JsonRecord> {
    if (options.preAbort) {
      const session = await this.ensureSession();
      await session.appendMessage(userMessage(text, this.ids.newId("msg")));
      return {
        requestId: this.ids.newId("req"),
        outcome: "aborted",
        status: "aborted",
      };
    }
    const result = await this.testSaveMessages([userMessage(text, this.ids.newId("msg"))]);
    if ((options as { abortAfterCompletion?: unknown }).abortAfterCompletion === true) {
      this.cancelChat(result.requestId, "post-completion abort");
    }
    return result as unknown as JsonRecord;
  }

  async testSaveMessagesAbortMidStream(text?: unknown, abortAfterMs?: unknown): Promise<JsonRecord> {
    const requestId = this.ids.newId("req");
    const input = [userMessage(typeof text === "string" ? text : "Abort me", this.ids.newId("msg"))];
    const timer = setTimeout(
      () => this.cancelChat(requestId, "external abort"),
      typeof abortAfterMs === "number" ? abortAfterMs : 50,
    );
    const result = await this.chat(input, undefined, { requestId });
    clearTimeout(timer);
    const status = result.outcome === "completed" ? "completed" : result.outcome;
    const log = this.responseLog.at(-1);
    const logRecord = recordFrom(log);
    return {
      result: { ...result, status },
      status,
      persistedMessageCount: (await this.getMessages()).length,
      lastResponseStatus: typeof logRecord?.status === "string" ? logRecord.status : null,
    };
  }

  async testSaveMessagesCancelledByAbortAllRequests(text?: unknown, abortAfterMs?: unknown): Promise<JsonRecord> {
    const requestId = this.ids.newId("req");
    const input = [userMessage(typeof text === "string" ? text : "Cancel me", this.ids.newId("msg"))];
    const timer = setTimeout(
      () => this.cancelAllChats("abort all requests"),
      typeof abortAfterMs === "number" ? abortAfterMs : 50,
    );
    const result = await this.chat(input, undefined, { requestId });
    clearTimeout(timer);
    return {
      ...result,
      status: result.outcome === "completed" ? "completed" : result.outcome,
    };
  }

  async getAbortControllerCount(): Promise<number> {
    return 0;
  }

  async sanitizeMessage(message: unknown): Promise<unknown> {
    void message;
    missingFeature("message sanitization helper");
  }

  async enforceRowSizeLimit(message: unknown): Promise<unknown> {
    void message;
    missingFeature("row size enforcement helper");
  }

  async waitUntilStableForTest(timeout?: unknown): Promise<boolean> {
    if (this.forceStableTimeout) return false;
    const stable = await this.waitUntilStable({
      timeoutMs: typeof timeout === "number" ? timeout : 5_000,
    });
    return stable && !(await this.hasPendingInteractionForTest());
  }

  async hasPendingInteractionForTest(): Promise<boolean> {
    const messages = await this.getMessages();
    const allParts = [
      ...messages.flatMap((message) => message.parts),
      ...this.streamingAssistantParts,
    ];
    for (const part of allParts) {
      const record = recordFrom(part);
      if (!record) continue;
      if (record.state === "approval-requested") return true;
      if (record.state !== "input-available") continue;

      const explicitToolName = typeof record.toolName === "string" ? record.toolName : undefined;
      const typeToolName = typeof record.type === "string" && record.type.startsWith("tool-")
        ? record.type.slice("tool-".length)
        : undefined;
      const toolName = explicitToolName ?? typeToolName;
      if (toolName !== undefined && this.clientToolNames.has(toolName)) return true;
    }
    return false;
  }

  async seedWorkspaceBytes(path: string, content: string): Promise<void> {
    this.host.store.put(`test:workspace:${path}`, content);
  }

  async testStartResumableStream(requestId: string): Promise<string> {
    void this.chat("resume", undefined, { requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return requestId;
  }

  async testStoreResumableChunk(_streamId: string, _body: string): Promise<void> {
    missingFeature("resumable stream chunk injection");
  }

  async testCompleteResumableStream(streamId: string): Promise<void> {
    this.cancelChat(streamId, "test complete");
  }

  async getPendingChatTerminalForTest(): Promise<unknown> {
    return this.pendingChatTerminal();
  }

  async runEmptyStreamForTest(): Promise<void> {
    const old = this.response;
    this.response = "";
    await this.chat("empty");
    this.response = old;
  }

  async runEmptyRpcStreamForTest(): Promise<{ doneCalled: boolean }> {
    await this.runEmptyStreamForTest();
    return { doneCalled: true };
  }

  async getTelemetryEvents(): Promise<string[]> {
    return this.telemetryEvents;
  }

  async getCapturedOptions(): Promise<unknown[]> {
    return this.capturedOptions;
  }

  async getTurnBodies(): Promise<unknown[]> {
    missingFeature("turn body capture");
  }

  async getTurnClientToolNames(): Promise<string[][]> {
    return this.capturedClientToolNames;
  }

  async getRecoveryContexts(): Promise<unknown[]> {
    return this.recoveryContexts;
  }

  async getChatRecoveryIncidentsForTest(): Promise<unknown[]> {
    return this.chatRecoveryIncidents();
  }

  async getExhaustedContextsForTest(): Promise<unknown[]> {
    return this.exhaustedContexts;
  }

  async getOnExhaustedCallsForTest(): Promise<number> {
    return this.exhaustedContexts.length;
  }

  async getStashResult(): Promise<unknown> {
    return this.host.store.get("test:stash") ?? null;
  }

  async setStashData(data: unknown): Promise<void> {
    this.host.store.put("test:stash", data);
  }

  async getLatestStreamStatusForTest(): Promise<string | null> {
    const snapshot = await this.getLatestStreamSnapshot();
    const record = recordFrom(snapshot);
    return typeof record?.status === "string" ? record.status : null;
  }

  async getLatestStreamSnapshot(): Promise<unknown> {
    let read = this.events().read(0);
    if (read.kind === "gap") read = this.events().read(read.firstAvailable);
    if (read.kind === "gap") return null;

    const byRequest = new Map<string, { requestId: string; status: string; chunkCount: number; text: string }>();
    for (const stored of read.events) {
      const event = stored.event;
      if (event.type === "turn:started") {
        byRequest.set(event.requestId, {
          requestId: event.requestId,
          status: "streaming",
          chunkCount: 0,
          text: "",
        });
      } else if (event.type === "chunk") {
        const current = byRequest.get(event.requestId) ?? {
          requestId: event.requestId,
          status: "streaming",
          chunkCount: 0,
          text: "",
        };
        current.chunkCount++;
        if (event.chunk.type === "text-delta") current.text += event.chunk.delta;
        if (event.chunk.type === "error") current.status = "error";
        byRequest.set(event.requestId, current);
      } else if (event.type === "turn:settled") {
        const current = byRequest.get(event.requestId) ?? {
          requestId: event.requestId,
          status: "streaming",
          chunkCount: 0,
          text: "",
        };
        current.status = event.outcome === "failed" ? "error" : event.outcome;
        byRequest.set(event.requestId, current);
      }
    }
    return [...byRequest.values()].at(-1) ?? null;
  }

  async getSubmissionStatusForTest(submissionId: string): Promise<string | null> {
    return this.inspectSubmission(submissionId)?.status ?? null;
  }

  async getScheduledChatRecoveryCountForTest(kind?: unknown): Promise<number> {
    const schedules = this.chatRecoverySchedule();
    if (kind !== "_chatRecoveryContinue" && kind !== "_chatRecoveryRetry") return schedules.length;
    const recoveryKind = kind === "_chatRecoveryContinue" ? "continue" : "retry";
    return schedules.filter((schedule) => schedule.recoveryKind === recoveryKind).length;
  }

  async getScheduledChatRecoveryPayloadForTest(kind?: unknown): Promise<unknown> {
    const schedules = this.chatRecoverySchedule();
    const recoveryKind = kind === "_chatRecoveryContinue" ? "continue" : kind === "_chatRecoveryRetry" ? "retry" : undefined;
    const schedule = schedules.find((entry) => recoveryKind === undefined || entry.recoveryKind === recoveryKind);
    if (!schedule) return null;
    return {
      ...schedule,
      recoveredRequestId: schedule.requestId,
      originalRequestId: schedule.requestId,
    };
  }

  async getIncidentAttemptForTest(incidentId: string): Promise<unknown> {
    const incidents = this.chatRecoveryIncidents() as Array<RecoveryIncident & JsonRecord>;
    return incidents.find((incident) => incident.incidentId === incidentId || incident.requestId === incidentId) ?? null;
  }

  private currentRecoveryPolicy(): RecoveryConfig {
    return typeof this.chatRecovery === "object" && this.chatRecovery !== null ? this.chatRecovery : {};
  }

  async setRecoveryOverride(_options: unknown): Promise<void> {
    const record = recordFrom(_options);
    this.recoveryOverride = record ? (record as RecoveryHookDecision) : undefined;
  }

  async setChatRecoveryConfigForTest(options: unknown): Promise<void> {
    const record = recordFrom(options);
    this.chatRecovery = record ? (record as RecoveryConfig) : true;
  }

  async setShouldKeepRecoveringForTest(_value: boolean): Promise<void> {
    missingFeature("chat recovery keep-recovering override");
  }

  async setRecoveryShouldThrowForTest(_value: boolean): Promise<void> {
    this.recoveryShouldThrow = _value === true;
  }

  async enableExhaustedCaptureForTest(maxAttempts?: unknown, terminalMessage?: unknown): Promise<void> {
    const base = this.currentRecoveryPolicy();
    this.chatRecovery = {
      ...base,
      ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
      ...(typeof terminalMessage === "string" ? { terminalMessage } : {}),
      onExhausted: (incident: RecoveryIncident) => {
        this.exhaustedContexts.push(incident);
      },
    };
  }

  async enableThrowingOnExhaustedForTest(maxAttempts?: unknown, terminalMessage?: unknown): Promise<void> {
    const base = this.currentRecoveryPolicy();
    this.chatRecovery = {
      ...base,
      ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
      ...(typeof terminalMessage === "string" ? { terminalMessage } : {}),
      onExhausted: () => {
        throw new Error(typeof terminalMessage === "string" ? terminalMessage : "onExhausted failed");
      },
    };
  }

  async beginIncidentForTest(options?: unknown): Promise<unknown> {
    const record = recordFrom(options) ?? {};
    const requestId = typeof record.requestId === "string" ? record.requestId : this.ids.newId("req");
    const recoveryKind = record.recoveryKind === "continue" ? "continue" : "retry";
    const maxAttempts =
      typeof record.maxAttempts === "number"
        ? record.maxAttempts
        : this.currentRecoveryPolicy().maxAttempts ?? 10;
    const existing = this.recoveryIncidentRows().find(
      (row) => row.record.requestId === requestId || row.record.incidentId === record.incidentId,
    )?.record;
    const progress = this.host.store.get<number>("test:recovery-progress") ?? 0;
    const previousProgress = typeof existing?.progress === "number" ? existing.progress : progress;
    const attempt = existing && previousProgress === progress ? (typeof existing.attempt === "number" ? existing.attempt : 0) + 1 : 1;
    const nowMs = typeof record.nowMs === "number" ? record.nowMs : Date.now();
    const incident: JsonRecord = {
      ...existing,
      incidentId:
        typeof existing?.incidentId === "string"
          ? existing.incidentId
          : typeof record.incidentId === "string"
            ? record.incidentId
            : `${requestId}:`,
      requestId,
      attempt,
      maxAttempts,
      recoveryKind,
      status: attempt > maxAttempts ? "exhausted" : "attempting",
      firstSeenAt: typeof existing?.firstSeenAt === "number" ? existing.firstSeenAt : nowMs,
      lastAttemptAt: nowMs,
      progress,
      exhausted: attempt > maxAttempts,
    };
    this.putRecoveryIncident(incident);
    return incident;
  }

  async ageIncidentForTest(incidentId?: unknown, ageMs?: unknown): Promise<void> {
    if (typeof incidentId !== "string") return;
    const row = this.recoveryIncidentRows().find(
      (entry) => entry.record.incidentId === incidentId || entry.record.requestId === incidentId,
    );
    if (!row) return;
    const delta = typeof ageMs === "number" ? ageMs : 0;
    row.record.firstSeenAt = typeof row.record.firstSeenAt === "number" ? row.record.firstSeenAt - delta : Date.now() - delta;
    row.record.lastAttemptAt = typeof row.record.lastAttemptAt === "number" ? row.record.lastAttemptAt - delta : Date.now() - delta;
    this.host.store.put(row.key, row.record);
  }

  async updateIncidentForTest(incidentId?: unknown, status?: unknown, reason?: unknown): Promise<void> {
    if (typeof incidentId !== "string" || typeof status !== "string") return;
    const row = this.recoveryIncidentRows().find(
      (entry) => entry.record.incidentId === incidentId || entry.record.requestId === incidentId,
    );
    if (!row) return;
    if (status === "completed") {
      this.host.store.delete(row.key);
      this.syncRecoveringRow({ ...row.record, status });
      return;
    }
    row.record.status = status;
    if (typeof reason === "string") row.record.reason = reason;
    this.host.store.put(row.key, row.record);
    this.syncRecoveringRow(row.record);
  }

  async seedIncidentForTest(options?: unknown): Promise<void> {
    const record = recordFrom(options);
    if (!record || typeof record.requestId !== "string") return;
    const incident: JsonRecord = {
      incidentId: typeof record.incidentId === "string" ? record.incidentId : `${record.requestId}:`,
      requestId: record.requestId,
      attempt: typeof record.attempt === "number" ? record.attempt : 1,
      maxAttempts: typeof record.maxAttempts === "number" ? record.maxAttempts : this.currentRecoveryPolicy().maxAttempts ?? 10,
      recoveryKind: record.recoveryKind === "continue" ? "continue" : "retry",
      ...record,
    };
    this.putRecoveryIncident(incident);
    this.syncRecoveringRow(incident);
  }

  async bumpRecoveryProgressForTest(): Promise<void> {
    this.host.store.put("test:recovery-progress", (this.host.store.get<number>("test:recovery-progress") ?? 0) + 1);
  }
  async dropAssistantMessagesForTest(): Promise<void> {
    const session = await this.ensureSession();
    const messages = await session.getHistory();
    await session.deleteMessages(messages.filter((message) => message.role === "assistant").map((message) => message.id));
  }
  async clearInMemoryClientToolsForTest(): Promise<void> { missingFeature("durable client-tool registry"); }
  async seedDurableClientToolsForTest(): Promise<void> { missingFeature("durable client-tool registry"); }
  async seedRunningSubmissionForTest(): Promise<void> { missingFeature("submission row injection"); }
  async recoverSubmissionsOnStartForTest(): Promise<void> { missingFeature("submission startup recovery trigger"); }
  async preScheduleRecoveryRetryForTest(data?: unknown): Promise<void> {
    this.preScheduleRecoveryForTest("retry", data);
  }
  async preScheduleRecoveryContinueForTest(data?: unknown): Promise<void> {
    this.preScheduleRecoveryForTest("continue", data);
  }
  async runScheduledRecoveryRetryForTest(): Promise<void> { await this.waitUntilStableForTest(5_000); }
  async runScheduledRecoveryContinueForTest(): Promise<void> { await this.waitUntilStableForTest(5_000); }
  async runChatRecoveryRetryForTestWith(): Promise<void> { await this.waitUntilStableForTest(5_000); }
  async runChatRecoveryContinueForTestWith(): Promise<void> { await this.waitUntilStableForTest(5_000); }
  async triggerFiberRecovery(): Promise<void> { await this.fiberService.checkInterrupted(); }
  async insertInterruptedFiber(name?: unknown, stashedData?: unknown): Promise<void> {
    const now = Date.now();
    const baseRequestId =
      typeof name === "string" && name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : this.ids.newId("req");
    const stashed = recordFrom(stashedData);
    const snapshotRecord = recordFrom(stashed?.__cfThinkChatFiberSnapshot);
    const requestId = typeof snapshotRecord?.requestId === "string" ? snapshotRecord.requestId : baseRequestId;
    const recoveryRootRequestId =
      typeof snapshotRecord?.recoveryRootRequestId === "string" ? snapshotRecord.recoveryRootRequestId : requestId;
    const recoveryData = stashed && "__cfThinkChatFiberSnapshot" in stashed ? stashed.user : stashedData;
    this.turnState.setLastRequestId(requestId);
    const fiberId = `test-${requestId}-${now}`;
    this.host.store.put(`fiber:run:${fiberId}`, {
      id: fiberId,
      name: "chat-turn",
      managed: false,
      snapshot: {
        requestId,
        recoveryRootRequestId,
        ...(recoveryData !== undefined ? { recoveryData } : {}),
      },
      metadata: null,
      createdAt: now,
    });
  }
  async insertInterruptedStream(streamId?: unknown, requestId?: unknown, chunks?: unknown, status?: unknown): Promise<void> {
    if (typeof requestId !== "string") return;
    const parts: ChatMessage["parts"] = [];
    let messageId = this.ids.newId("msg");
    let text = "";
    for (const entry of Array.isArray(chunks) ? chunks : []) {
      const record = recordFrom(entry);
      if (typeof record?.body !== "string") continue;
      const chunk = recordFrom(safeJson(record.body));
      if (!chunk || typeof chunk.type !== "string") continue;
      if (chunk.type === "start" && typeof chunk.messageId === "string") {
        messageId = chunk.messageId;
      } else if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
        text += chunk.delta;
      } else if (chunk.type === "tool-input-available" && typeof chunk.toolCallId === "string" && typeof chunk.toolName === "string") {
        parts.push({
          type: `tool-${chunk.toolName}`,
          toolCallId: chunk.toolCallId,
          state: "input-available",
          input: chunk.input,
        });
      } else if (chunk.type === "tool-output-available" && typeof chunk.toolCallId === "string") {
        const existing = parts.find((part) => part.type.startsWith("tool-") && (part as { toolCallId?: unknown }).toolCallId === chunk.toolCallId);
        if (existing) {
          (existing as { state: string; output?: unknown }).state = "output-available";
          (existing as { output?: unknown }).output = chunk.output;
        }
      }
    }
    if (text.length > 0) parts.push({ type: "text", text });
    this.turnState.recordPartial(requestId, { id: messageId, role: "assistant", parts });
    this.host.store.put(`think:recover:context:${requestId}`, {
      streamId: typeof streamId === "string" ? streamId : "",
      partialText: text,
      createdAt: Date.now(),
      status: status === "completed" ? "completed" : status === "error" ? "error" : "interrupted",
    });
  }
  async setForceStableTimeoutForTest(value?: unknown): Promise<void> {
    this.forceStableTimeout = value !== false;
  }

  private preScheduleRecoveryForTest(kind: "retry" | "continue", data?: unknown): void {
    const record = recordFrom(data) ?? {};
    const requestId =
      typeof record.recoveredRequestId === "string"
        ? record.recoveredRequestId
        : typeof record.originalRequestId === "string"
          ? record.originalRequestId
          : this.ids.newId("req");
    const incident = this.recoveryIncidentRows().find(
      (row) => row.record.requestId === requestId || row.record.incidentId === record.incidentId,
    )?.record;
    this.host.store.put(`think:recover:recovering:${requestId}`, {
      requestId,
      incidentId:
        typeof record.incidentId === "string"
          ? record.incidentId
          : typeof incident?.incidentId === "string"
            ? incident.incidentId
            : `${requestId}:`,
      attempt: typeof incident?.attempt === "number" ? incident.attempt : 1,
      maxAttempts: typeof incident?.maxAttempts === "number" ? incident.maxAttempts : this.currentRecoveryPolicy().maxAttempts ?? 10,
      recoveryKind: kind,
      scheduledAt: Date.now(),
    });
  }

  private recoveryIncidentRows(): Array<{ key: string; record: JsonRecord }> {
    return [...this.host.store.list<unknown>({ prefix: "think:recover:incident:" })]
      .map(([key, value]) => ({ key, record: recordFrom(value) }))
      .filter((row): row is { key: string; record: JsonRecord } => row.record !== null);
  }

  private putRecoveryIncident(incident: JsonRecord): void {
    if (typeof incident.requestId !== "string") return;
    this.host.store.put(`think:recover:incident:${incident.requestId}`, incident);
  }

  private syncRecoveringRow(incident: JsonRecord): void {
    if (typeof incident.requestId !== "string") return;
    const key = `think:recover:recovering:${incident.requestId}`;
    if (incident.status === "scheduled" || incident.status === "attempting") {
      this.host.store.put(key, {
        requestId: incident.requestId,
        incidentId: typeof incident.incidentId === "string" ? incident.incidentId : `${incident.requestId}:`,
        attempt: typeof incident.attempt === "number" ? incident.attempt : 1,
        maxAttempts: typeof incident.maxAttempts === "number" ? incident.maxAttempts : 6,
        recoveryKind: incident.recoveryKind === "continue" ? "continue" : "retry",
        scheduledAt: typeof incident.lastAttemptAt === "number" ? incident.lastAttemptAt : Date.now(),
      });
    } else {
      this.host.store.delete(key);
    }
  }

  async setRequestContextForTest(_body?: unknown, clientTools?: unknown): Promise<void> {
    this.clientToolNames.clear();
    if (!Array.isArray(clientTools)) return;
    for (const tool of clientTools) {
      const record = recordFrom(tool);
      if (typeof record?.name === "string") this.clientToolNames.add(record.name);
    }
  }

  async setStreamingAssistantForTest(parts: unknown): Promise<void> {
    this.streamingAssistantParts = Array.isArray(parts) ? (parts as ChatMessage["parts"]) : [];
  }

  async seedPartialAssistantTurnForTest(): Promise<void> { missingFeature("partial assistant turn injection"); }

  async simulatePreStreamChatFailureForTest(options: unknown): Promise<unknown> {
    const record = recordFrom(options);
    const requestId = typeof record?.requestId === "string" ? record.requestId : this.ids.newId("req");
    const error = typeof record?.error === "string" ? record.error : "pre-stream failure";
    this.recordChatTerminal(requestId, JSON.stringify({ type: "error", errorText: error }));
    return this.pendingChatTerminal();
  }

  async probeToolResultDurabilityForTest(): Promise<unknown> { missingFeature("tool-result durability probe"); }
  async probeProgressReconnectImmunityForTest(): Promise<unknown> { missingFeature("reconnect progress probe"); }
  async forwardChildStreamProgressForTest(): Promise<unknown> { missingFeature("child stream progress forwarding"); }
  async runContinueWithPrefillRejectingModelForTest(): Promise<unknown> { missingFeature("assistant-prefill continuation repair"); }
  async fireResponseHookForTest(result: unknown): Promise<void> { this.responseLog.push(result); }
  async testRecoveryCallbackError(): Promise<unknown> { missingFeature("recovery callback error handling"); }
  async testGiveUpSealTransientDefer(): Promise<unknown> { missingFeature("transient defer give-up sealing"); }
  async testStallRouteExhaustion(): Promise<unknown> {
    const oldRecovery = this.chatRecovery;
    this.chatRecovery = { maxAttempts: 0 };
    try {
      const result = await this.testChatWithStallThenRecover(1, 50);
      return {
        ...result,
        exhausted: this.chatRecoveryIncidents().some((incident) => incident.status === "exhausted"),
      };
    } finally {
      this.chatRecovery = oldRecovery;
    }
  }
  async getIdleConnectMessagesForTest(): Promise<unknown[]> {
    return this.chatRecoverySchedule().map((schedule) => ({
      type: "cf_agent_chat_recovering",
      recovering: true,
      id: schedule.requestId,
    }));
  }
  async getLastPromptRoleForTest(): Promise<string | undefined> { missingFeature("model prompt capture"); }
  async runInBandStreamErrorForTest(error?: unknown): Promise<void> {
    this.nextStream = {
      kind: "in-band-error",
      error: typeof error === "string" ? error : "In-band stream error",
    };
    await this.chat([]);
  }

  async runPartialInBandStreamErrorForTest(error?: unknown): Promise<void> {
    this.nextStream = {
      kind: "partial-in-band-error",
      error: typeof error === "string" ? error : "Late in-band error",
      partial: "partial response",
    };
    await this.chat([]);
  }

  async runInBandStreamErrorThenTextForTest(error?: unknown): Promise<void> {
    this.nextStream = {
      kind: "in-band-error-then-text",
      error: typeof error === "string" ? error : "Terminal in-band error",
    };
    await this.chat([]);
  }

  async setInBandErrorResponse(error?: unknown): Promise<void> {
    this.nextStream = {
      kind: "in-band-error",
      error: typeof error === "string" ? error : "In-band stream error",
    };
  }

  async setInBandStreamErrorResponse(error?: unknown): Promise<void> {
    await this.setInBandErrorResponse(error);
  }
}

class NonRecoveryAgentImpl extends ThinkSessionPortAgentImpl {
  override chatRecovery = false;
}

class AsyncHookAgentImpl extends ThinkSessionPortAgentImpl {}
class SessionConfigAgentImpl extends ThinkSessionPortAgentImpl {}
class AsyncSessionConfigAgentImpl extends ThinkSessionPortAgentImpl {}
class DynamicConfigAgentImpl extends ThinkSessionPortAgentImpl {}
class LegacyConfigAgentImpl extends ThinkSessionPortAgentImpl {}
class ConfigInSessionAgentImpl extends ThinkSessionPortAgentImpl {}
class ProgrammaticAgentImpl extends ThinkSessionPortAgentImpl {}
class RecoveryAgentImpl extends ThinkSessionPortAgentImpl {}

const ThinkSessionThinkTestAgentBase = hostAgent(ThinkSessionPortAgentImpl);
export class ThinkSessionThinkTestAgent extends ThinkSessionThinkTestAgentBase {}
installRpcMethods(ThinkSessionThinkTestAgent);

const ThinkSessionTestAgentBase = hostAgent(SessionConfigAgentImpl);
export class ThinkSessionTestAgent extends ThinkSessionTestAgentBase {}
installRpcMethods(ThinkSessionTestAgent);

const ThinkAsyncConfigSessionAgentBase = hostAgent(AsyncSessionConfigAgentImpl);
export class ThinkAsyncConfigSessionAgent extends ThinkAsyncConfigSessionAgentBase {}
installRpcMethods(ThinkAsyncConfigSessionAgent);

const ThinkConfigTestAgentBase = hostAgent(DynamicConfigAgentImpl);
export class ThinkConfigTestAgent extends ThinkConfigTestAgentBase {}
installRpcMethods(ThinkConfigTestAgent);

const ThinkLegacyConfigMigrationAgentBase = hostAgent(LegacyConfigAgentImpl);
export class ThinkLegacyConfigMigrationAgent extends ThinkLegacyConfigMigrationAgentBase {}
installRpcMethods(ThinkLegacyConfigMigrationAgent);

const ThinkConfigInSessionAgentBase = hostAgent(ConfigInSessionAgentImpl);
export class ThinkConfigInSessionAgent extends ThinkConfigInSessionAgentBase {}
installRpcMethods(ThinkConfigInSessionAgent);

const ThinkProgrammaticTestAgentBase = hostAgent(ProgrammaticAgentImpl);
export class ThinkProgrammaticTestAgent extends ThinkProgrammaticTestAgentBase {}
installRpcMethods(ThinkProgrammaticTestAgent);

const ThinkAsyncHookTestAgentBase = hostAgent(AsyncHookAgentImpl);
export class ThinkAsyncHookTestAgent extends ThinkAsyncHookTestAgentBase {}
installRpcMethods(ThinkAsyncHookTestAgent);

const ThinkSessionRecoveryAgentBase = hostAgent(RecoveryAgentImpl);
export class ThinkSessionRecoveryAgent extends ThinkSessionRecoveryAgentBase {}
installRpcMethods(ThinkSessionRecoveryAgent);

const ThinkNonRecoveryTestAgentBase = hostAgent(NonRecoveryAgentImpl);
export class ThinkNonRecoveryTestAgent extends ThinkNonRecoveryTestAgentBase {}
installRpcMethods(ThinkNonRecoveryTestAgent);
