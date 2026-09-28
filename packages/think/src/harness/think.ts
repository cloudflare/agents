/**
 * Think, rebuilt on `agents/harness/think`.
 *
 * @experimental Internal. Not exported from `@cloudflare/think`. The package
 * runs its test suite against this class (`pnpm test:harness`) and records
 * the result in `harness-compat.md`. When every test passes, this class
 * replaces `../think.ts`.
 */
import {
  Agent,
  type AgentContext,
  type Connection,
  type WSMessage
} from "agents";
import { CHAT_MESSAGE_TYPES, parseProtocolMessage } from "agents/chat";
import type { ChatResponseResult, SaveMessagesResult } from "agents/chat";
import { Driver } from "agents/driver";
import {
  ThinkHarness,
  type ThinkStepConfig,
  type ThinkToolCallDecision,
  type ThinkTurnConfig,
  type ThinkTurnContext,
  type ThinkTurnEnd
} from "agents/harness/think";
import { Sessions } from "agents/sessions";
import {
  convertToModelMessages,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk
} from "ai";
import { ThinkSession } from "../session";
import { Think as LegacyThink } from "../think";
import type {
  ChatOptions,
  ChunkContext,
  PrepareStepContext,
  StepConfig,
  StepContext,
  StreamCallback,
  ThinkModel,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
  TurnInputMessages
} from "../think";

const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;

/** The one chat this Think serves. Multi-session comes later. */
const CHAT = "main";

type TurnListener = {
  readonly chunk?: (chunk: UIMessageChunk) => void | Promise<void>;
  readonly end: (end: ThinkTurnEnd) => void;
};

export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /** Model steps per turn. */
  maxSteps = 10;

  readonly sessions = new Sessions();
  readonly driver = new Driver();
  readonly harness: ThinkHarness = new ThinkHarness({
    driver: this.driver,
    session: () => this.sessions.session(),
    model: async () => this.#resolveModel(await this.getModel()),
    system: () => this.getSystemPrompt(),
    tools: () => this.#tools(),
    hooks: {
      beforeTurn: (turn) => this.#beforeTurn(turn),
      beforeToolCall: ({ call, ...turn }) => this.#beforeToolCall(turn, call),
      afterToolCall: ({ call, result, ...turn }) =>
        this.afterToolCall({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
          stepNumber: turn.step,
          messages: [],
          toolExecutionMs: 0,
          durationMs: 0,
          requestId: turn.turnId,
          ...(result.ok
            ? { success: true, output: result.output }
            : { success: false, error: result.error })
        } as unknown as ToolCallResultContext),
      beforeStep: async ({ step, model, messages }) => {
        const config = await this.beforeStep({
          model,
          stepNumber: step,
          steps: [],
          messages
        } as unknown as PrepareStepContext);
        if (!config) return;
        // `StepConfig` is an Omit over a union, so its fields are read loosely.
        const overrides = config as {
          model?: ThinkModel;
          instructions?: unknown;
          system?: unknown;
          messages?: ModelMessage[];
          activeTools?: string[];
          toolChoice?: ThinkStepConfig["toolChoice"];
          providerOptions?: ThinkStepConfig["providerOptions"];
        };
        const system = overrides.instructions ?? overrides.system;
        return {
          ...(overrides.model !== undefined
            ? { model: await this.#resolveModel(overrides.model) }
            : {}),
          ...(typeof system === "string" ? { system } : {}),
          ...(overrides.messages ? { messages: overrides.messages } : {}),
          ...(overrides.activeTools
            ? { activeTools: overrides.activeTools }
            : {}),
          ...(overrides.toolChoice ? { toolChoice: overrides.toolChoice } : {}),
          ...(overrides.providerOptions
            ? { providerOptions: overrides.providerOptions }
            : {})
        };
      },
      onModelChunk: ({ chunk }) =>
        this.onChunk({ chunk } as unknown as ChunkContext),
      onStepFinish: ({ result }) => {
        if (result) return this.onStepFinish(result as unknown as StepContext);
      },
      onChunk: ({ turnId, chunk }) => this.#onChunk(turnId, chunk),
      onTurnEnd: (end) => this.#onTurnEnd(end)
    }
  });

  /** The conversation, configured by {@link configureSession}. */
  session!: ThinkSession;

  #messages: UIMessage[] = [];
  readonly #listeners = new Map<string, Set<TurnListener>>();

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.sessions).use(this.driver).use(this.harness);

    const onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      this.session = await this.configureSession(
        new ThinkSession(this.sessions.session(), () => {
          throw new Error(
            "Context blocks are not supported by the harness-backed Think yet"
          );
        })
      );
      this.sessions.subscribe(async (event) => {
        if (event.sessionId !== this.session.sessionId) return;
        await this.#sync();
        if (event.type !== "update") this.#broadcastMessages();
      });
      await this.#sync();
      this.#installProtocol();
      await onStart(props);
    };
  }

  // ── Overridable configuration ─────────────────────────────────────

  getModel(): ThinkModel | Promise<ThinkModel> {
    throw new Error(
      "Override getModel() to return the LanguageModel this agent uses."
    );
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
  // the features behind them yet, so each returns Think's empty default.
  configureContext(): unknown[] | Promise<unknown[]> {
    return [];
  }
  getSkills(): unknown[] | Promise<unknown[]> {
    return [];
  }
  getSkillScriptRunner(): null {
    return null;
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
  getMessengerContext(): undefined {
    return undefined;
  }
  getScheduledTasks():
    | Record<string, unknown>
    | Promise<Record<string, unknown>> {
    return {};
  }
  getDefaultTimezone(): string | undefined | Promise<string | undefined> {
    return undefined;
  }
  getGateway(_model: string): undefined {
    return undefined;
  }
  getOnStartDegradations(): ReadonlyArray<unknown> {
    return [];
  }

  // ── Lifecycle hooks ───────────────────────────────────────────────

  beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {}

  beforeToolCall(
    _ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {}

  afterToolCall(_ctx: ToolCallResultContext): void | Promise<void> {}

  beforeStep(
    _ctx: PrepareStepContext
  ): StepConfig | void | Promise<StepConfig | void> {}

  onStepFinish(_ctx: StepContext): void | Promise<void> {}

  onStepEnd(_ctx: StepContext): void | Promise<void> {}

  onChunk(_ctx: ChunkContext): void | Promise<void> {}

  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

  onChatError(error: unknown): unknown {
    return error;
  }

  // ── Messages ──────────────────────────────────────────────────────

  get messages(): UIMessage[] {
    return this.#messages;
  }

  /** The channel of the running turn. Channels are not supported yet. */
  get activeChannel(): undefined {
    return undefined;
  }

  /** Metadata of the running turn. Not supported yet. */
  get activeTurnMetadata(): undefined {
    return undefined;
  }

  /** The turn running now, if any. */
  get activeTurn():
    | { requestId: string; trigger: string; continuation: boolean }
    | undefined {
    const turn = this.harness.activeTurn(CHAT);
    return turn
      ? { requestId: turn.turnId, trigger: "rpc", continuation: false }
      : undefined;
  }

  async getMessages(): Promise<UIMessage[]> {
    return (await this.sessions
      .session()
      .getHistory()) as unknown as UIMessage[];
  }

  /**
   * Add messages to the conversation and run a turn over it.
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>)
  ): Promise<SaveMessagesResult> {
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    const known = new Set(this.messages.map((message) => message.id));
    const receipt = await this.harness.submit(CHAT, {
      messages: resolved.filter((message) => !known.has(message.id))
    });
    const end = await this.harness.waitForTurn(receipt.turnId);
    return {
      requestId: receipt.turnId,
      status: end.status === "stopped" ? "aborted" : end.status,
      ...(end.error !== undefined ? { error: end.error } : {})
    };
  }

  async clearMessages(): Promise<void> {
    await this.harness.stopChat(CHAT);
    await this.sessions.session().clearMessages();
    this.harness.clear(CHAT);
    await this.#sync();
    this.broadcast(JSON.stringify({ type: MSG_CHAT_CLEAR }));
  }

  // ── Programmatic chat ─────────────────────────────────────────────

  async chat(
    userMessage: TurnInputMessages,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const turnId = crypto.randomUUID();
    await callback.onStart({ requestId: turnId });
    const messages =
      typeof userMessage === "function"
        ? await userMessage(this.messages)
        : normalizeMessages(userMessage);

    const done = new Promise<ThinkTurnEnd>((resolve) => {
      this.#listen(turnId, {
        chunk: (chunk) => callback.onEvent(JSON.stringify(chunk)),
        end: resolve
      });
    });
    options?.signal?.addEventListener(
      "abort",
      () => void this.harness.stop(turnId),
      { once: true }
    );
    await this.harness.submit(CHAT, { messages }, { turnId });

    const end = await done;
    if (end.status === "error") {
      const wrapped = this.onChatError(new Error(end.error));
      await callback.onError(
        wrapped instanceof Error ? wrapped.message : String(wrapped)
      );
      return;
    }
    await callback.onDone();
  }

  /** Stop the running turn, and any queued behind it. */
  async cancelAllChats(): Promise<void> {
    await this.harness.stopChat(CHAT);
  }

  // ── Harness wiring ────────────────────────────────────────────────

  async #tools(): Promise<ToolSet> {
    return this.getTools();
  }

  async #resolveModel(model: ThinkModel): Promise<LanguageModel> {
    if (typeof model === "string") {
      throw new Error(
        "Model ids are not supported by the harness-backed Think yet; return a LanguageModel from getModel()."
      );
    }
    return model;
  }

  async #beforeTurn(turn: ThinkTurnContext): Promise<ThinkTurnConfig> {
    const tools = await this.#tools();
    const model = await this.#resolveModel(await this.getModel());
    const system = this.getSystemPrompt();
    const messages: ModelMessage[] = await convertToModelMessages(
      this.messages,
      { tools, ignoreIncompleteToolCalls: true }
    );
    const config = await this.beforeTurn({
      system,
      messages,
      tools,
      model,
      continuation: false,
      ...(turn.body ? { body: turn.body } : {}),
      requestId: turn.turnId
    });
    // `maxSteps` is read per turn: a subclass field is set after the
    // harness is constructed.
    if (!config) return { maxSteps: this.maxSteps };
    return {
      maxSteps: config.maxSteps ?? this.maxSteps,
      ...(config.model !== undefined
        ? { model: await this.#resolveModel(config.model) }
        : {}),
      ...((config.instructions ?? config.system) !== undefined
        ? { system: config.instructions ?? config.system }
        : {}),
      ...(config.messages ? { messages: config.messages } : {}),
      ...(config.tools ? { tools: { ...tools, ...config.tools } } : {}),
      ...(config.activeTools ? { activeTools: config.activeTools } : {}),
      ...(config.toolChoice ? { toolChoice: config.toolChoice } : {}),
      ...(config.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.maxOutputTokens }
        : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
      ...(config.topP !== undefined ? { topP: config.topP } : {}),
      ...(config.topK !== undefined ? { topK: config.topK } : {})
    };
  }

  async #beforeToolCall(
    turn: ThinkTurnContext,
    call: { toolCallId: string; toolName: string; input: unknown }
  ): Promise<ThinkToolCallDecision | void> {
    const decision = await this.beforeToolCall({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      stepNumber: turn.step,
      messages: [],
      abortSignal: undefined,
      requestId: turn.turnId
    } as unknown as ToolCallContext);
    if (!decision) return;
    if (decision.action === "substitute") {
      return { action: "substitute", output: decision.output };
    }
    return decision;
  }

  async #onChunk(turnId: string, chunk: UIMessageChunk): Promise<void> {
    this.#broadcastChat({
      type: MSG_CHAT_RESPONSE,
      id: turnId,
      body: JSON.stringify(chunk),
      done: false
    });
    for (const listener of this.#listeners.get(turnId) ?? []) {
      await listener.chunk?.(chunk);
    }
  }

  async #onTurnEnd(end: ThinkTurnEnd): Promise<void> {
    await this.#sync();
    if (end.status === "error") {
      this.#broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: end.turnId,
        body: end.error ?? "",
        done: true,
        error: true
      });
    } else {
      this.#broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: end.turnId,
        body: "",
        done: true
      });
    }
    if (end.message) {
      await this.onChatResponse({
        message: end.message,
        requestId: end.turnId,
        continuation: false,
        status: end.status === "stopped" ? "aborted" : end.status,
        ...(end.error !== undefined ? { error: end.error } : {})
      });
    }
    const listeners = this.#listeners.get(end.turnId);
    this.#listeners.delete(end.turnId);
    for (const listener of listeners ?? []) listener.end(end);
  }

  #listen(turnId: string, listener: TurnListener): void {
    let listeners = this.#listeners.get(turnId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(turnId, listeners);
    }
    listeners.add(listener);
  }

  async #sync(): Promise<void> {
    this.#messages = (await this.sessions
      .session()
      .getHistory()) as unknown as UIMessage[];
  }

  #broadcastMessages(except?: string[]): void {
    this.broadcast(
      JSON.stringify({ type: MSG_CHAT_MESSAGES, messages: this.#messages }),
      except
    );
  }

  #broadcastChat(frame: Record<string, unknown>): void {
    this.broadcast(JSON.stringify(frame));
  }

  // ── WebSocket chat protocol ───────────────────────────────────────

  #installProtocol(): void {
    const onConnect = this.onConnect.bind(this);
    this.onConnect = async (
      connection: Connection,
      ctx: { request: Request }
    ) => {
      connection.send(
        JSON.stringify({ type: MSG_CHAT_MESSAGES, messages: this.#messages })
      );
      return onConnect(connection, ctx);
    };

    const onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      const event =
        typeof message === "string" ? parseProtocolMessage(message) : null;
      if (!event) return onMessage(connection, message);
      switch (event.type) {
        case "chat-request":
          return this.#onChatRequest(event.id, event.init.body);
        case "clear":
          return this.clearMessages();
        case "cancel":
          await this.harness.stop(event.id);
          return;
        case "tool-approval":
          await this.harness.answer(CHAT, event.toolCallId, {
            approved: event.approved
          });
          return;
        case "tool-result":
          await this.harness.resolveTool(
            CHAT,
            event.toolCallId,
            event.state === "output-error"
              ? { ok: false, error: event.errorText ?? "Tool failed" }
              : { ok: true, output: event.output }
          );
          return;
        default:
          return onMessage(connection, message);
      }
    };
  }

  async #onChatRequest(
    requestId: string,
    rawBody: string | undefined
  ): Promise<void> {
    const body = parseBody(rawBody);
    const incoming = Array.isArray(body.messages)
      ? (body.messages as UIMessage[])
      : [];
    const { messages: _messages, ...custom } = body;
    const known = new Set(this.#messages.map((message) => message.id));
    await this.harness.submit(
      CHAT,
      {
        messages: incoming.filter((message) => !known.has(message.id)),
        ...(Object.keys(custom).length > 0 ? { body: custom } : {})
      },
      { turnId: requestId }
    );
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

function normalizeMessages(
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

function parseBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
