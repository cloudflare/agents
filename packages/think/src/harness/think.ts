/**
 * Think, rebuilt on `agents/harness/think`.
 *
 * Internal. Not exported from `@cloudflare/think`. The package runs its
 * test suite against this class (`pnpm test:harness`) and records the
 * result in `harness-compat.md`. When every test passes, this class
 * replaces `../think.ts`.
 */
import {
  Agent,
  type AgentContext,
  type Connection,
  type ConnectionContext,
  type WSMessage
} from "agents";
import type { ChatResponseResult, SaveMessagesResult } from "agents/chat";
import {
  ThinkChat,
  ThinkHarness,
  type ThinkErrorClass,
  type ThinkOperationResult,
  type ThinkOperationStatus,
  type ThinkToolCallDecision,
  type ThinkTurnConfig,
  type ThinkTurnContext
} from "agents/harness/think";
import type { WebSocketHandlers } from "agents/websockets";
import {
  convertToModelMessages,
  type LanguageModel,
  type ToolSet,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic } from "workers-ai-provider/anthropic";
import { openai } from "workers-ai-provider/openai";
import { ThinkSession } from "../session";
import { Think as LegacyThink } from "../think";
import type { SessionMessage } from "agents/sessions";
import type {
  AddMessagesOptions,
  CancelSubmissionResult,
  ChatErrorClassification,
  RunTurnOptions,
  RunTurnStream,
  RunTurnSubmit,
  RunTurnWait,
  TurnResult,
  ChatOptions,
  ChunkContext,
  StepContext,
  StreamCallback,
  SubmitMessagesOptions,
  SubmitMessagesResult,
  ThinkModel,
  ThinkSubmissionInspection,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
  TurnInputMessages
} from "../think";

const WORKERS_AI_MODEL_PREFIXES = ["@cf/", "@hf/"];

function isWorkersAIModelId(model: string): boolean {
  return WORKERS_AI_MODEL_PREFIXES.some(
    (prefix) => model.startsWith(prefix) && model.length > prefix.length
  );
}

function toInput(
  input: Exclude<TurnInputMessages, (current: UIMessage[]) => unknown>
): UIMessage[] {
  if (typeof input === "string") {
    return [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: input }]
      }
    ];
  }
  return Array.isArray(input) ? input : [input];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Think's submission status for a harness operation status. */
function submissionStatus(
  status: ThinkOperationStatus
): ThinkSubmissionInspection["status"] {
  switch (status.status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "completed";
    case "unanswered":
      return status.reason === "aborted"
        ? "aborted"
        : status.reason === "withdrawn"
          ? "aborted"
          : "error";
  }
}

function saveResult(result: ThinkOperationResult): SaveMessagesResult {
  if (result.status === "done") {
    return { requestId: result.operationId, status: "completed" };
  }
  return {
    requestId: result.operationId,
    status: result.reason === "aborted" ? "aborted" : "error",
    ...(result.reason !== undefined && { error: result.reason })
  };
}

export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /** Model calls per turn. Read per call, so a subclass field applies. */
  maxSteps = 10;

  readonly harness: ThinkHarness;
  readonly #chat: ThinkChat;
  readonly #handlers: WebSocketHandlers[] = [];

  /** The conversation, configured by {@link configureSession}. */
  session!: ThinkSession;

  #messages: UIMessage[] = [];
  #defaultProvider: ReturnType<typeof createWorkersAI> | undefined;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    const self = this;
    this.harness = new ThinkHarness({
      // Think's reserved keys, so client writes are stripped the same way.
      reservedMetadataKeys: ["channel", "turnMetadata"],
      model: async () => this.resolveModel(await this.getModel()),
      system: () => this.getSystemPrompt(),
      tools: () => this.getTools(),
      get maxSteps() {
        return self.maxSteps;
      },
      hooks: {
        beforeTurn: (turn) => this.#beforeTurn(turn),
        beforeToolCall: (call) => this.#beforeToolCall(call),
        afterToolCall: (result) =>
          this.afterToolCall({
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            input: result.input,
            stepNumber: 0,
            messages: [],
            requestId: result.operationId,
            ...(result.ok
              ? { success: true, output: result.output }
              : { success: false, error: result.errorText })
          } as unknown as ToolCallResultContext),
        onStepFinish: ({ message, finishReason, operationId }) =>
          this.onStepFinish({
            response: { messages: [] },
            finishReason,
            message,
            requestId: operationId
          } as unknown as StepContext),
        onChunk: ({ chunk }) =>
          void this.onChunk({ chunk } as unknown as ChunkContext),
        onTurnEnd: async (end) => {
          if (!end.message) return;
          await this.onChatResponse({
            message: end.message,
            requestId: end.operationId,
            continuation: false,
            status:
              end.status === "done"
                ? "completed"
                : end.reason === "aborted"
                  ? "aborted"
                  : "error",
            ...(end.status === "unanswered" &&
              end.reason !== undefined && { error: end.reason })
          });
        },
        classifyError: (error) => this.#classify(error)
      }
    });
    this.#chat = new ThinkChat({
      harness: this.harness,
      webSockets: {
        getConnections: () => this.getConnections(),
        use: (handlers) => {
          this.#handlers.push(handlers);
        }
      }
    });
    this.harness.observe((_session, event) => {
      if (event.type === "run-end") this.#running = undefined;
    });
    this.lifecycle.use(this.harness);

    const onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      this.session = await this.configureSession(
        new ThinkSession(this.harness.session().transcript, () => {
          throw new Error(
            "Context blocks are not supported by the harness-backed Think yet"
          );
        })
      );
      this.harness.observe((session, event) => {
        if (session !== this.harness.session().id) return;
        if (event.type === "reset") this.#messages = [];
        if (event.type === "message") {
          // Apply it now, so a synchronous read right after a turn sees it;
          // the re-read that follows picks up compaction and branching.
          const index = this.#messages.findIndex(
            (message) => message.id === event.message.id
          );
          this.#messages =
            index === -1
              ? [...this.#messages, event.message]
              : this.#messages.map((message, i) =>
                  i === index ? event.message : message
                );
        }
        if (event.type === "message" || event.type === "reset") {
          void this.#sync();
        }
      });
      await this.#sync();
      this.#installProtocol();
      await onStart(props);
    };
  }

  // ── Overridable configuration ─────────────────────────────────────

  getModel(): ThinkModel | Promise<ThinkModel> {
    throw new Error(
      "Override getModel() to return a model id string or a LanguageModel."
    );
  }

  getAIBinding(): Ai {
    const binding = (this.env as { AI?: Ai }).AI;
    if (!binding)
      throw new Error('Think needs a Workers AI binding named "AI"');
    return binding;
  }

  getGateway(_model: string): undefined {
    return undefined;
  }

  resolveModel(model: ThinkModel): LanguageModel {
    if (typeof model !== "string") return model;
    this.#defaultProvider ??= createWorkersAI({
      binding: this.getAIBinding(),
      providers: [openai, anthropic]
    });
    return isWorkersAIModelId(model)
      ? this.#defaultProvider(model, { sessionAffinity: this.sessionAffinity })
      : this.#defaultProvider(model);
  }

  getSystemPrompt(): string {
    return "You are a helpful assistant.";
  }

  getTools(): ToolSet {
    return {};
  }

  configureSession(
    session: ThinkSession
  ): ThinkSession | Promise<ThinkSession> {
    return session;
  }

  // Think calls these with a default; the harness-backed Think has none of
  // the features behind them, so each returns Think's empty default.
  configureContext(): unknown[] | Promise<unknown[]> {
    return [];
  }
  getSkills(): unknown[] | Promise<unknown[]> {
    return [];
  }
  getExtensions(): unknown[] {
    return [];
  }
  getActions(): Record<string, unknown> | Promise<Record<string, unknown>> {
    return {};
  }
  getMessengers(): Record<string, unknown> {
    return {};
  }
  configureChannels():
    | Record<string, unknown>
    | Promise<Record<string, unknown>> {
    return {};
  }
  getScheduledTasks():
    | Record<string, unknown>
    | Promise<Record<string, unknown>> {
    return {};
  }

  // ── Lifecycle hooks ───────────────────────────────────────────────

  beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {}

  beforeToolCall(
    _ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {}

  afterToolCall(_ctx: ToolCallResultContext): void | Promise<void> {}

  onStepFinish(_ctx: StepContext): void | Promise<void> {}

  onChunk(_ctx: ChunkContext): void | Promise<void> {}

  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

  onChatError(error: unknown): unknown {
    return error;
  }

  classifyChatError(_error: unknown): ChatErrorClassification | void {}

  // ── Messages ──────────────────────────────────────────────────────

  get messages(): UIMessage[] {
    return this.#messages;
  }

  /** The channel of the running turn. Channels are not supported. */
  get activeChannel(): undefined {
    return undefined;
  }

  /** Metadata of the running turn. Not supported. */
  get activeTurnMetadata(): undefined {
    return undefined;
  }

  /** The turn running now, if any. */
  get activeTurn():
    | { requestId: string; trigger: string; continuation: boolean }
    | undefined {
    return this.#running;
  }

  #running:
    | { requestId: string; trigger: string; continuation: boolean }
    | undefined;

  async getMessages(): Promise<UIMessage[]> {
    return this.harness.session().messages();
  }

  async syncMessagesFromStorage(): Promise<void> {
    await this.#sync();
  }

  /** Add messages to the conversation and run a turn over it. */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>)
  ): Promise<SaveMessagesResult> {
    await this.#sync();
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    const known = new Set(this.messages.map((message) => message.id));
    const session = this.harness.session();
    const receipt = await session.submit(
      resolved.filter((message) => !known.has(message.id))
    );
    const result = await session.wait(receipt.operationId);
    await this.#sync();
    return saveResult(result);
  }

  async clearMessages(): Promise<void> {
    await this.harness.session().reset();
    await this.#sync();
  }

  async continueLastTurn(): Promise<SaveMessagesResult> {
    const session = this.harness.session();
    const receipt = await session.continue();
    const result = await session.wait(receipt.operationId);
    await this.#sync();
    return saveResult(result);
  }

  /** Add messages to the conversation without running a turn. */
  async addMessages(
    messages:
      | UIMessage[]
      | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: AddMessagesOptions
  ): Promise<void> {
    await this.#sync();
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    const handle = this.harness.session().transcript;
    let parentId = options?.parentId;
    for (const message of resolved) {
      const stored = message as unknown as SessionMessage;
      if (options?.mode === "upsert") {
        await handle.upsertMessage(stored, { parentId });
      } else {
        await handle.appendMessage(stored, { parentId });
      }
      parentId = message.id;
    }
    await this.#sync();
  }

  protected async appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    await this.harness
      .session()
      .transcript.appendMessage(message as unknown as SessionMessage, {
        parentId
      });
    await this.#sync();
    return message;
  }

  /** Messengers are not supported, so there is never a messenger turn. */
  getMessengerContext(): undefined {
    return undefined;
  }

  /** Whether the latest message has a tool call waiting on a client. */
  protected hasPendingInteraction(): boolean {
    const last = this.#messages.at(-1);
    return (last?.parts ?? []).some(
      (part) =>
        "toolCallId" in part &&
        (part.state === "input-available" ||
          part.state === "approval-requested")
    );
  }

  // ── Turns ─────────────────────────────────────────────────────────

  runTurn(options: RunTurnStream): Promise<void>;
  runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
  runTurn(options: RunTurnWait): Promise<TurnResult>;
  async runTurn(
    options: RunTurnOptions
  ): Promise<TurnResult | SubmitMessagesResult | void> {
    if (options === null || typeof options !== "object") {
      throw new TypeError("runTurn: options must be an object");
    }
    const mode = options.mode ?? "wait";
    if (mode === "stream") {
      const stream = options as RunTurnStream;
      if (!stream.input)
        throw new TypeError('runTurn: mode "stream" requires input');
      return this.chat(stream.input, stream.callback, {
        ...(stream.signal && { signal: stream.signal })
      });
    }
    if (mode === "submit") {
      const submit = options as RunTurnSubmit;
      if (!submit.input)
        throw new TypeError('runTurn: mode "submit" requires input');
      const messages =
        typeof submit.input === "function"
          ? await submit.input(this.messages)
          : toInput(submit.input);
      return this.submitMessages(messages, {
        ...(submit.submissionId !== undefined && {
          submissionId: submit.submissionId
        }),
        ...(submit.idempotencyKey !== undefined && {
          idempotencyKey: submit.idempotencyKey
        }),
        ...(submit.metadata !== undefined && { metadata: submit.metadata })
      });
    }
    const wait = options as RunTurnWait;
    if (wait.input !== undefined && wait.continuation) {
      throw new TypeError(
        "runTurn: supply either input or continuation: true, not both"
      );
    }
    if (wait.input === undefined && !wait.continuation) {
      throw new TypeError("runTurn: supply either input or continuation: true");
    }
    const session = this.harness.session();
    let receipt;
    if (wait.continuation) receipt = await session.continue();
    else {
      const input = wait.input;
      const messages =
        typeof input === "function"
          ? await input(this.messages)
          : toInput(
              input as Exclude<
                TurnInputMessages,
                (current: UIMessage[]) => unknown
              >
            );
      receipt = await session.submit(messages);
    }
    wait.signal?.addEventListener(
      "abort",
      () => void session.abort(receipt.operationId),
      { once: true }
    );
    const result = await session.wait(receipt.operationId);
    await this.#sync();
    const message =
      result.status === "done" && result.messageId !== undefined
        ? this.#messages.find((m) => m.id === result.messageId)
        : undefined;
    return {
      ...saveResult(result),
      continuation: wait.continuation === true,
      ...(message && { message: message as unknown as SessionMessage })
    };
  }

  // ── Submissions ───────────────────────────────────────────────────

  async submitMessages(
    messages: UIMessage[],
    options?: SubmitMessagesOptions
  ): Promise<SubmitMessagesResult> {
    const submissionId =
      options?.submissionId ?? options?.idempotencyKey ?? crypto.randomUUID();
    const receipt = await this.harness
      .session()
      .submit(messages, { operationId: submissionId });
    const inspection = await this.inspectSubmission(submissionId);
    return {
      ...(inspection ?? {
        submissionId,
        status: "pending",
        createdAt: Date.now()
      }),
      ...(options?.idempotencyKey !== undefined && {
        idempotencyKey: options.idempotencyKey
      }),
      ...(options?.metadata !== undefined && { metadata: options.metadata }),
      accepted: receipt.accepted
    };
  }

  async inspectSubmission(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    const status = await this.harness.session().inspect(submissionId);
    if (!status) return null;
    return {
      submissionId,
      requestId: submissionId,
      status: submissionStatus(status),
      createdAt: Date.now(),
      ...(status.status === "unanswered" &&
        status.reason !== undefined && { error: status.reason }),
      ...("messageId" in status &&
        status.messageId !== undefined && { messageId: status.messageId })
    };
  }

  async waitForSubmission(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    if (!(await this.harness.session().inspect(submissionId))) return null;
    await this.harness.session().wait(submissionId);
    return this.inspectSubmission(submissionId);
  }

  // ── Programmatic chat ─────────────────────────────────────────────

  async chat(
    userMessage: TurnInputMessages,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const operationId = crypto.randomUUID();
    const messages =
      typeof userMessage === "function"
        ? await userMessage(this.messages)
        : toInput(userMessage);
    options?.signal?.addEventListener(
      "abort",
      () => void this.harness.session().abort(operationId),
      { once: true }
    );
    await this.harness.session().chat(
      messages,
      {
        onStart: () => callback.onStart({ requestId: operationId }),
        onEvent: (json) => callback.onEvent(json),
        onDone: () => callback.onDone(),
        onError: (error) => {
          const wrapped = this.onChatError(new Error(error));
          return callback.onError(errorText(wrapped));
        }
      },
      { operationId }
    );
    await this.#sync();
  }

  async cancelSubmission(
    submissionId: string
  ): Promise<CancelSubmissionResult> {
    const before = await this.inspectSubmission(submissionId);
    if (!before) return { outcome: "not_found", submissionId };
    if (before.status !== "pending" && before.status !== "running") {
      return { outcome: "already_terminal", submissionId, submission: before };
    }
    await this.harness.session().abort(submissionId);
    await this.harness.session().wait(submissionId);
    const after = (await this.inspectSubmission(submissionId)) ?? before;
    return {
      outcome: "cancelled",
      submissionId,
      previousStatus: before.status,
      messagesApplied: before.status === "running",
      submission: after
    };
  }

  async cancelChat(requestId: string): Promise<void> {
    await this.harness.session().abort(requestId);
  }

  async cancelAllChats(): Promise<void> {
    await this.harness.session().abort();
  }

  // ── Left over from Think's previous engine ────────────────────────

  // Scheduler jobs that the previous engine queued call these by name. The
  // turns they would have recovered are gone after the move, so each
  // completes without doing anything instead of failing on retry.
  async _chatRecoveryRetry(): Promise<void> {}
  async _chatRecoveryContinue(): Promise<void> {}
  async _cfRetryMessengerRecoveryDelivery(): Promise<void> {}

  // ── Harness wiring ────────────────────────────────────────────────

  async #beforeTurn(turn: ThinkTurnContext): Promise<ThinkTurnConfig | void> {
    const tools = await this.getTools();
    const model = this.resolveModel(await this.getModel());
    this.#running = {
      requestId: turn.operationId,
      trigger: "submission",
      continuation: turn.continuation
    };
    const config = await this.beforeTurn({
      system: turn.system ?? this.getSystemPrompt(),
      messages: await convertToModelMessages([...turn.messages], {
        tools,
        ignoreIncompleteToolCalls: true
      }),
      tools,
      model,
      continuation: turn.continuation,
      requestId: turn.operationId
    });
    if (!config) return;
    const system = config.instructions ?? config.system;
    return {
      ...(config.model !== undefined && {
        model: this.resolveModel(config.model)
      }),
      ...(typeof system === "string" && { system }),
      ...(config.messages && { messages: config.messages }),
      ...(config.activeTools && { activeTools: config.activeTools }),
      ...(config.maxOutputTokens !== undefined && {
        maxOutputTokens: config.maxOutputTokens
      }),
      ...(config.temperature !== undefined && {
        temperature: config.temperature
      })
    };
  }

  async #beforeToolCall(call: {
    readonly operationId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  }): Promise<ThinkToolCallDecision | void> {
    const decision = await this.beforeToolCall({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      stepNumber: 0,
      messages: [],
      requestId: call.operationId
    } as unknown as ToolCallContext);
    if (!decision) return;
    switch (decision.action) {
      case "block":
        return {
          action: "block",
          reason: decision.reason ?? "Blocked by beforeToolCall"
        };
      case "substitute":
        return { action: "substitute", output: decision.output };
      default:
        return {
          action: "run",
          ...("input" in decision && { input: decision.input })
        };
    }
  }

  #classify(error: unknown): ThinkErrorClass {
    const classification = this.classifyChatError(error);
    return classification === "context_overflow" ? "context-overflow" : "fail";
  }

  async #sync(): Promise<void> {
    this.#messages = await this.harness.session().messages();
  }

  /** Route this Agent's connections through ThinkChat's handlers. */
  #installProtocol(): void {
    const onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      for (const handlers of this.#handlers) {
        await handlers.onConnect?.(connection, ctx);
      }
      return onConnect(connection, ctx);
    };
    const onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      for (const handlers of this.#handlers) {
        if ((await handlers.onMessage?.(connection, message)) === true) return;
      }
      return onMessage(connection, message);
    };
    const onClose = this.onClose.bind(this);
    this.onClose = async (connection, code, reason, wasClean) => {
      for (const handlers of this.#handlers) {
        await handlers.onClose?.(connection, code, reason, wasClean);
      }
      return onClose(connection, code, reason, wasClean);
    };
    const onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      const handled = await this.#chat.onRequest({ request });
      return handled ?? onRequest(request);
    };
  }
}

/**
 * Give every method the real Think has and this one lacks a stub that says
 * so. A test that reaches one fails with the name of the missing feature,
 * which is what the compat scoreboard reports.
 */
function stubUnsupported(target: object, legacy: object): void {
  for (const name of Object.getOwnPropertyNames(legacy)) {
    if (name === "constructor" || name in target) continue;
    const descriptor = Object.getOwnPropertyDescriptor(legacy, name);
    if (!descriptor) continue;
    const unsupported = () => {
      throw new Error(
        `Think.${name} is not supported by the harness-backed Think yet`
      );
    };
    Object.defineProperty(
      target,
      name,
      typeof descriptor.value === "function"
        ? { value: unsupported, configurable: true, writable: true }
        : { get: unsupported, configurable: true }
    );
  }
}

stubUnsupported(Think.prototype, LegacyThink.prototype);
