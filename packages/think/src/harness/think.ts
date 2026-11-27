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
  type TypedToolCall,
  type UIMessage
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic } from "workers-ai-provider/anthropic";
import { openai } from "workers-ai-provider/openai";
import { isWorkersAIModelId } from "../model";
import {
  reconcileScheduledTasks,
  type ThinkScheduledTasks
} from "../scheduled-tasks";
import { Workspace } from "@cloudflare/computer";
import { workspaceExtension } from "./extensions/workspace";
import { fetchExtension } from "./extensions/fetch";
import { skillsExtension } from "./extensions/skills";
import { sandboxedExtensions } from "./extensions/sandboxed";
import {
  callThinkHostApi,
  createThinkHostApi,
  type ThinkHostApi,
  type ThinkHostOperation
} from "../extensions/host-api";
import { coreOf, type ExtensionManager } from "../extensions/manager";
import {
  createThinkExtensionManager,
  loadThinkExtensions,
  ThinkExtensionHooks
} from "../extensions/wiring";
import type { ExtensionConfig } from "../turn-types";
import { ThinkSkills } from "../skills-runtime";
import { declaredOverrides } from "../overrides";
import type { SkillScriptRunner, SkillSource } from "agents/skills";
import { mcpConnectionsExtension, mcpExtension } from "agents/internal";
import {
  admittedSubmissionMetadata,
  isTerminalSubmissionStatus,
  SubmissionStatusQueue,
  TERMINAL_SUBMISSION_STATUSES,
  type DeleteSubmissionsOptions,
  type ListSubmissionsOptions,
  type ThinkSubmissionStatus
} from "../submissions";
import type { TaskStatus } from "agents/tasks";
import type { CreateFetchToolsOptions } from "../tools/fetch";
import type { ThinkWorkspace } from "../workspace-files";
import { ThinkSession } from "../session";
import { Think as LegacyThink } from "../think";
import type { Session, SessionMessage } from "agents/sessions";
import { Context, type ContextConfig } from "agents/context";
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

const { snapshot: snapshotDeclaredMembers, isOverridden: isMethodOverridden } =
  declaredOverrides(() => Think.prototype);

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

/**
 * Submissions read per page when deleting in bulk, whatever the limit: a
 * small limit does not cost a read per submission it passes over.
 */
const DELETE_PAGE = 100;

/** An operation's inspection: its status, times, key and metadata. */
type ThinkOperationInspection = NonNullable<
  Awaited<ReturnType<ThinkHarness["inspection"]>>
>;

/** A harness operation as Think's submission inspection. */
function submissionInspection(
  status: ThinkOperationInspection
): ThinkSubmissionInspection {
  return {
    submissionId: status.operationId,
    requestId: status.operationId,
    status: submissionStatus(status),
    createdAt: status.createdAt,
    ...(status.startedAt !== undefined && { startedAt: status.startedAt }),
    ...(status.settledAt !== undefined && { completedAt: status.settledAt }),
    ...(status.idempotencyKey !== undefined && {
      idempotencyKey: status.idempotencyKey
    }),
    ...(status.metadata !== undefined && { metadata: status.metadata }),
    ...(status.status === "unanswered" &&
      status.reason !== undefined && { error: status.reason }),
    ...("messageId" in status &&
      status.messageId !== undefined && { messageId: status.messageId })
  };
}

/** A status filter as a list, or none. */
function submissionStatuses(
  status: ThinkSubmissionStatus | ThinkSubmissionStatus[] | undefined
): ThinkSubmissionStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}

/**
 * The run statuses a submission of these statuses can have. An operation
 * that ended unanswered is a completed run, so a terminal status other
 * than `completed` also looks at completed runs; callers match the mapped
 * status after.
 */
function taskStatusesFor(
  wanted: readonly ThinkSubmissionStatus[]
): TaskStatus[] {
  const out = new Set<TaskStatus>();
  for (const status of wanted) {
    if (status === "pending" || status === "running") {
      out.add("pending");
      out.add("running");
    } else {
      out.add("completed");
      if (status !== "completed") out.add(status);
    }
  }
  return [...out];
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

  /**
   * The agent's Workspace, as in Think: a subclass may assign its own; by
   * default one on this Durable Object's storage, made at start.
   */
  workspace!: ThinkWorkspace;

  /** Offer the connected MCP servers' tools each turn, as on Think. */
  includeMcpTools = true;

  /** Wait for MCP connections before a turn's tools are built, as on Think. */
  waitForMcpConnections: boolean | { timeout: number } = false;

  /** WorkerLoader binding for sandboxed extensions, as on Think. */
  extensionLoader?: WorkerLoader;

  /** The sandboxed extensions, made at start when `extensionLoader` is set. */
  extensionManager?: ExtensionManager;

  /** Per-extension hook timeout in milliseconds, as on Think. */
  hookTimeout = 5000;

  /** Runs the sandboxed extensions' hooks of each turn, as Think does. */
  readonly #extensionHooks = new ThinkExtensionHooks(
    () =>
      this.extensionManager &&
      coreOf(this.extensionManager, () => this.hookTimeout)
  );

  /** Think's opt-in fetch tools, as on Think: off unless set. */
  fetchTools: false | Omit<CreateFetchToolsOptions, "workspace" | "onEvent"> =
    false;

  #messages: UIMessage[] = [];
  #context: Context | undefined;
  #handle: Session | undefined;
  /** Each submission's status reports, run one at a time in order. */
  readonly #submissionStatuses = new SubmissionStatusQueue();
  /** Skills from `getSkills()`, loaded in onStart as Think loads them. */
  readonly #skills = new ThinkSkills();
  #defaultProvider: ReturnType<typeof createWorkersAI> | undefined;

  constructor(ctx: AgentContext, env: Env) {
    snapshotDeclaredMembers(new.target.prototype);
    super(ctx, env);
    const self = this;
    this.harness = new ThinkHarness({
      // The Agent's own Tasks, which Think's runs already use.
      tasks: this.tasks,
      // In Think's tool order: the workspace's tools, then fetch.
      extensions: [
        // Think waits for MCP connections at the top of a turn, before any
        // tool is built.
        {
          name: "mcp-connections",
          extension: mcpConnectionsExtension(
            () => this.mcp,
            () => this.waitForMcpConnections
          )
        },
        {
          name: "workspace",
          extension: workspaceExtension(() => this.workspace)
        },
        {
          name: "fetch",
          extension: fetchExtension(
            () => this.fetchTools,
            () => this.workspace,
            (event) =>
              (
                this._emit as unknown as (
                  type: string,
                  payload: Record<string, unknown>
                ) => void
              ).call(this, "tool:fetch", { ...event })
          )
        },
        // The sandboxed extensions' tools follow the agent's own, as in
        // Think. Then skills, then MCP tools.
        {
          name: "sandboxed",
          after: true,
          extension: sandboxedExtensions(() => this.extensionManager)
        },
        {
          name: "skills",
          after: true,
          extension: skillsExtension(this.#skills, () =>
            this.getSkillScriptRunner()
          )
        },
        {
          name: "mcp",
          after: true,
          extension: mcpExtension({
            manager: () => this.mcp,
            include: () => this.includeMcpTools
          })
        }
      ],
      // Think's reserved keys, so client writes are stripped the same way.
      reservedMetadataKeys: ["channel", "turnMetadata"],
      // Think's own API writes and configures the Sessions handle directly.
      configureSession: (handle, id) => {
        if (id === this.harness.session().id) this.#handle = handle;
      },
      // The root session's blocks, built in onStart, as Think builds them.
      context: (_handle, id) =>
        id === this.harness.session().id ? this.#context : undefined,
      model: async () => this.resolveModel(await this.getModel()),
      // As in Think: an overridden getSystemPrompt() stays above the
      // context blocks; the default is only the fallback for no blocks,
      // the skill catalog's included.
      system: () =>
        isMethodOverridden(this, "getSystemPrompt") ||
        ((!this.#context || this.#context.getBlocks().length === 0) &&
          !this.#skills.loaded)
          ? this.getSystemPrompt()
          : undefined,
      tools: () => this.getTools(),
      // A turn's `beforeTurn` may set its own, as in Think.
      get maxSteps() {
        return self.#turnMaxSteps ?? self.maxSteps;
      },
      // One submission's reports in order, as on Think.
      onSubmissionStatus: (status) =>
        this.#submissionStatuses.run(status.operationId, () =>
          this.#submissionStatus(status)
        ),
      hooks: {
        beforeTurn: (turn) => this.#beforeTurn(turn),
        beforeToolCall: async (call) => {
          // The step's chunks reach extensions before its tool calls do.
          await this.#chunkHooks;
          const decision = await this.#beforeToolCall(call);
          // As in Think: extensions hear of a call that runs, with the
          // input it runs with.
          if (!decision || decision.action === "run") {
            const input =
              decision?.action === "run" && decision.input !== undefined
                ? decision.input
                : call.input;
            await this.#extensionHooks.toolCallStart({
              // SAFETY: a snapshot reads the name, id and input only.
              toolCall: { ...call, input } as unknown as TypedToolCall<ToolSet>,
              stepNumber: undefined
            });
          }
          return decision;
        },
        afterToolCall: async (result) => {
          await this.#extensionHooks.toolCallFinish({
            // SAFETY: a snapshot reads the name, id and input only.
            toolCall: result as unknown as TypedToolCall<ToolSet>,
            stepNumber: undefined,
            durationMs: 0,
            success: result.ok,
            ...(result.ok
              ? { output: result.output }
              : { error: result.errorText })
          });
          return this.afterToolCall({
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            input: result.input,
            stepNumber: 0,
            messages: [],
            requestId: result.operationId,
            ...(result.ok
              ? { success: true, output: result.output }
              : { success: false, error: result.errorText })
          } as unknown as ToolCallResultContext);
        },
        onStepFinish: async ({ message, finishReason, operationId, step }) => {
          await this.#chunkHooks;
          await this.#extensionHooks.stepFinish({
            stepNumber: step,
            finishReason: finishReason ?? "unknown",
            text: message.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
            reasoningText: undefined,
            toolCalls: [],
            toolResults: []
            // SAFETY: the fields a step snapshot reads are all here.
          } as unknown as StepContext);
          return this.onStepFinish({
            response: { messages: [] },
            finishReason,
            message,
            requestId: operationId
          } as unknown as StepContext);
        },
        onChunk: ({ chunk }) => {
          // A snapshot reads a delta's text as `text`, as a stream part has it.
          const text = "delta" in chunk ? chunk.delta : undefined;
          // In order, one after another, as Think awaits each chunk's hooks.
          this.#chunkHooks = this.#chunkHooks
            .then(() =>
              this.#extensionHooks.chunk({
                chunk: text === undefined ? chunk : { ...chunk, text }
              } as unknown as ChunkContext)
            )
            .catch((error: unknown) =>
              console.error("[Think] An extension's onChunk failed", error)
            );
          void this.onChunk({ chunk } as unknown as ChunkContext);
        },
        onTurnEnd: async (end) => {
          // The extensions' chunk hooks finish inside the turn, as in Think.
          await this.#chunkHooks;
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
    this.harness.observe((session, event) => {
      if (event.type === "prefix-changed") {
        this._emit("chat:prefix:changed", {
          session,
          requestId: event.operationId,
          causes: event.causes
        });
      }
      if (event.type === "run-end") {
        this.#wakeStableWaiters();
        this.#running = undefined;
        this.#extensionTurn = undefined;
        this.#turnMaxSteps = undefined;
      }
    });
    this.lifecycle.use(this.harness);

    const onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      if (!this.workspace) {
        this.workspace = new Workspace({ storage: this.ctx.storage });
      }
      const handle = await this.#rootHandle();
      this.session = await this.configureSession(
        new ThinkSession(handle, () => this.context)
      );
      this.#context = new Context(handle, {
        blocks: [
          ...(await this.configureContext()),
          ...this.session.internal_takePendingContext()
        ],
        sql: this
      });
      await this.#context.load();
      if (this.extensionLoader) {
        this.extensionManager = createThinkExtensionManager({
          loader: this.extensionLoader,
          storage: this.ctx.storage,
          agentClassName: this.constructor.name,
          agentId: this.ctx.id.toString(),
          agentPath: this.selfPath,
          rootJurisdiction: this._cf_rootJurisdictionOptions()?.jurisdiction,
          exports: (
            this.ctx as unknown as { exports?: Record<string, unknown> }
          ).exports
        });
        await loadThinkExtensions(
          this.extensionManager,
          this.getExtensions(),
          this.#context
        );
      }
      await this.#skills.start(() => this.getSkills());
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
        if (
          event.type === "message" ||
          event.type === "reset" ||
          event.type === "transcript"
        ) {
          void this.#sync().then(() => this.#wakeStableWaiters());
        }
      });
      await this.#sync();
      this.#installProtocol();
      await onStart(props);
      // Best-effort, as in Think: a getScheduledTasks() that throws must
      // not stop the agent from starting.
      try {
        await this.internal_reconcileScheduledTasks();
      } catch (error) {
        console.error("[Think] Scheduled tasks were not reconciled", error);
      }
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

  /** The skill sources, as in Think: none unless overridden. */
  getSkills(): SkillSource[] | Promise<SkillSource[]> {
    return [];
  }

  /** A runner for `run_skill_script`, as in Think: none unless overridden. */
  getSkillScriptRunner(): SkillScriptRunner | null {
    return null;
  }

  /** Declare the prompt context blocks, as in Think. */
  configureContext(): ContextConfig[] | Promise<ContextConfig[]> {
    return [];
  }

  /** The root session's context blocks. Available once started. */
  protected get context(): Context {
    if (!this.#context) {
      throw new Error(
        "Context is not initialized yet; it is available after onStart()."
      );
    }
    return this.#context;
  }

  // Think calls these with a default; the harness-backed Think has none of
  // the features behind them, so each returns Think's empty default.
  /**
   * Sandboxed extensions to load at start, in order, as on Think. Needs
   * `extensionLoader`.
   */
  getExtensions(): ExtensionConfig[] {
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
  getScheduledTasks(): ThinkScheduledTasks | Promise<ThinkScheduledTasks> {
    return {};
  }

  getDefaultTimezone(): string | undefined | Promise<string | undefined> {
    return undefined;
  }

  /** Reconcile code-declared scheduled tasks, as Think does. */
  internal_reconcileScheduledTasks(): Promise<void> {
    return reconcileScheduledTasks({
      scheduler: this.scheduler,
      selfPath: this.selfPath,
      tasks: () => this.getScheduledTasks(),
      timezone: () => this.getDefaultTimezone(),
      submit: (messages, options) => this.submitMessages(messages, options)
    });
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

  /**
   * Resolved at the next run's end or transcript change, for
   * {@link waitUntilStable}: a client's answer applied with no continuation
   * changes the transcript and ends no run.
   */
  readonly #stableWaiters: Array<() => void> = [];

  #wakeStableWaiters(): void {
    for (const wake of this.#stableWaiters.splice(0)) wake();
  }

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
    const handle = await this.#rootHandle();
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

  /** The extensions' `onChunk` calls, chained so they run in order. */
  #chunkHooks: Promise<void> = Promise.resolve();

  /** The running turn's own `maxSteps`, from its `beforeTurn`. */
  #turnMaxSteps: number | undefined;

  /** The extensions' `beforeTurn` changes, kept for the operation. */
  #extensionTurn:
    | { readonly operationId: string; readonly changes: TurnConfig }
    | undefined;

  /** What a sandboxed extension can reach on this agent, as on Think. */
  readonly #hostApi = createThinkHostApi({
    workspace: () => this.workspace,
    context: () => this.context,
    messages: () => this.#messages,
    // Not a submission: a tool calling this during a turn would wait on
    // its own turn. One appended from `beforeTurn` comes before the reply,
    // as in Think: the harness attaches the reply to it.
    appendMessage: (message) => this.appendMessageToHistory(message)
  });

  /**
   * Run one host operation for a sandboxed extension, as on Think.
   * `HostBridgeLoopback` calls this after it checks the extension's
   * permissions.
   *
   * @internal
   */
  async _cfHostBridge<K extends ThinkHostOperation>(
    operation: K,
    args: Parameters<ThinkHostApi[K]>
  ): Promise<Awaited<ReturnType<ThinkHostApi[K]>>> {
    await this.__unsafe_ensureInitialized();
    return await callThinkHostApi(this.#hostApi, operation, args);
  }

  protected async appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    await (
      await this.#rootHandle()
    ).appendMessage(message as unknown as SessionMessage, {
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

  /**
   * Resolve `true` once no operation is open and nothing waits on a client,
   * or `false` when `timeout` milliseconds pass first, as on Think.
   */
  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;
    const session = this.harness.session();
    for (;;) {
      // Listen before looking, so a change in between still wakes us.
      let wake!: () => void;
      const ended = new Promise<void>((resolve) => {
        wake = resolve;
        this.#stableWaiters.push(resolve);
      });
      if ((await session.pending()).length === 0) {
        await this.#sync();
        if (!this.hasPendingInteraction()) return true;
      }
      if (deadline === null) {
        await ended;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        ended.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        })
      ]);
      clearTimeout(timer);
      if (timedOut) {
        const index = this.#stableWaiters.indexOf(wake);
        if (index !== -1) this.#stableWaiters.splice(index, 1);
        return false;
      }
    }
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
    if (messages.length === 0) {
      throw new Error("submitMessages requires at least one message");
    }
    const metadata = admittedSubmissionMetadata(options?.metadata);
    const { submissionId, idempotencyKey } = options ?? {};
    if (submissionId !== undefined && idempotencyKey) {
      // Think's message for a pair that names two submissions; the harness
      // refuses the pair too.
      const session = this.harness.session().id;
      const keyed = await this.harness.keyedOperation(session, idempotencyKey);
      const byId = await this.harness.inspection(session, submissionId);
      if (
        (keyed !== undefined && keyed !== submissionId) ||
        (byId?.idempotencyKey !== undefined &&
          byId.idempotencyKey !== idempotencyKey)
      ) {
        throw new Error(
          "submissionId and idempotencyKey refer to different submissions"
        );
      }
    }
    const receipt = await this.harness.session().submit(messages, {
      ...(options?.submissionId !== undefined && {
        operationId: options.submissionId
      }),
      submission: true,
      // An empty key is no key, as on Think.
      ...(options?.idempotencyKey && {
        idempotencyKey: options.idempotencyKey
      }),
      ...(metadata !== undefined && { metadata })
    });
    const inspection = await this.inspectSubmission(receipt.operationId);
    return {
      ...(inspection ?? {
        submissionId: receipt.operationId,
        status: "pending",
        createdAt: Date.now()
      }),
      accepted: receipt.accepted
    };
  }

  async inspectSubmission(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    const status = await this.harness.inspection(
      this.harness.session().id,
      submissionId
    );
    return status ? submissionInspection(status) : null;
  }

  async listSubmissions(
    options?: ListSubmissionsOptions
  ): Promise<ThinkSubmissionInspection[]> {
    const wanted = submissionStatuses(options?.status);
    if (wanted?.length === 0) return [];
    const listed = await this.harness.submissions(this.harness.session().id, {
      ...(wanted && { status: taskStatusesFor(wanted) }),
      limit: Math.min(Math.max(options?.limit ?? 50, 1), 100)
    });
    return listed
      .map(submissionInspection)
      .filter((submission) => !wanted || wanted.includes(submission.status));
  }

  async deleteSubmission(submissionId: string): Promise<boolean> {
    return this.harness.deleteSubmission(
      this.harness.session().id,
      submissionId
    );
  }

  async deleteSubmissions(options?: DeleteSubmissionsOptions): Promise<number> {
    const wanted = (
      submissionStatuses(options?.status) ?? TERMINAL_SUBMISSION_STATUSES
    ).filter(isTerminalSubmissionStatus);
    if (wanted.length === 0) return 0;
    const session = this.harness.session().id;
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const matches: readonly ThinkSubmissionStatus[] = wanted;
    const matching = (submission: ThinkSubmissionInspection) =>
      matches.includes(submission.status) &&
      (!options?.completedBefore ||
        (submission.completedAt !== undefined &&
          submission.completedAt < options.completedBefore.getTime()));
    // Oldest accepted first (Think deletes oldest settled first; the two
    // differ only for a submission that settled before an older one).
    // Matched on Think's status, so a run the harness counts as completed
    // but which ended unanswered is not taken for a completed submission.
    // Read a page of `DELETE_PAGE` at a time, each after the last one read, so a
    // long run of submissions that do not match is passed over, never
    // read twice, and no more than a page is in memory.
    let deleted = 0;
    // The last record read, as it was read: it may be deleted by then.
    let after: { operationId: string; createdAt: number } | undefined;
    while (deleted < limit) {
      const listed = await this.harness.submissions(session, {
        status: taskStatusesFor(wanted),
        order: "oldest",
        ...(after !== undefined && { after }),
        limit: DELETE_PAGE
      });
      for (const submission of listed.map(submissionInspection)) {
        if (deleted >= limit) break;
        if (!matching(submission)) continue;
        if (
          await this.harness.deleteSubmission(session, submission.submissionId)
        ) {
          deleted++;
        }
      }
      if (listed.length < DELETE_PAGE) break;
      const last = listed[listed.length - 1];
      after = { operationId: last.operationId, createdAt: last.createdAt };
    }
    return deleted;
  }

  /** Called when a submission's status changes, as on Think. */
  protected onSubmissionStatus(
    _submission: ThinkSubmissionInspection
  ): void | Promise<void> {}

  /**
   * The harness's report of a submission's status: Think's events, then
   * the app's hook, before a wait on the submission resolves.
   */
  async #submissionStatus(status: ThinkOperationInspection): Promise<void> {
    const inspection = submissionInspection(status);
    const { submissionId, requestId } = inspection;
    if (status.status === "queued") {
      this._emit("submission:create", {
        submissionId,
        requestId,
        idempotencyKey: inspection.idempotencyKey
      });
    }
    this._emit("submission:status", {
      submissionId,
      requestId,
      status: inspection.status
    });
    if (inspection.status === "error" && inspection.error) {
      this._emit("submission:error", {
        submissionId,
        requestId,
        error: inspection.error
      });
      console.error("[Think] Submission failed", {
        submissionId,
        requestId,
        idempotencyKey: inspection.idempotencyKey,
        metadata: inspection.metadata,
        error: inspection.error
      });
    }
    try {
      await this.onSubmissionStatus(inspection);
    } catch (error) {
      console.error("[Think] onSubmissionStatus failed", error);
    }
  }

  async waitForSubmission(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    const before = await this.harness.inspection(
      this.harness.session().id,
      submissionId
    );
    if (!before) return null;
    const open = before.status === "queued" || before.status === "running";
    if (
      this.#submissionStatuses.reporting(submissionId) ||
      (open && this.#submissionStatuses.reporting())
    ) {
      // As on Think: the hook's own submission, or one still open, settles
      // only after the hook returns.
      throw new Error(
        "waitForSubmission() cannot be called from onSubmissionStatus: the submission settles only after the hook returns"
      );
    }
    const result = await this.harness.session().wait(submissionId);
    // Read again for its times; deleted meanwhile (the app's terminal hook
    // may delete it), the wait's result still says how it ended, and it
    // ended no later than now.
    return (
      (await this.inspectSubmission(submissionId)) ??
      submissionInspection({
        ...before,
        ...result,
        settledAt: before.settledAt ?? Date.now()
      })
    );
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
    const session = this.harness.session().id;
    // Read before the cancel: the app's terminal hook may delete the record.
    const ids = await this.harness.submittedMessageIds(session, submissionId);
    await this.harness.session().abort(submissionId);
    await this.harness.session().wait(submissionId);
    const after = (await this.inspectSubmission(submissionId)) ?? before;
    // Only a started submission places its messages; one that never ran
    // placed nothing, even if a message of the same id was already there.
    const messagesApplied =
      before.status === "running" &&
      ids.length > 0 &&
      (await this.harness.storedIds(session, ids)).size > 0;
    return {
      outcome: "cancelled",
      submissionId,
      previousStatus: before.status,
      messagesApplied,
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
    // Every tool on offer, as Think's `beforeTurn` sees them.
    const tools = turn.toolSet;
    // Resolved only when read, as in Think: a `beforeTurn` that sets its
    // own model never needs the default's binding.
    const chosen = await this.getModel();
    let resolved: LanguageModel | undefined;
    const resolveDefault = () => (resolved ??= this.resolveModel(chosen));
    this.#running = {
      requestId: turn.operationId,
      trigger: "submission",
      continuation: turn.continuation
    };
    const context = {
      system: turn.system ?? this.getSystemPrompt(),
      messages: await convertToModelMessages([...turn.messages], {
        tools,
        ignoreIncompleteToolCalls: true
      }),
      tools,
      get model() {
        return resolveDefault();
      },
      continuation: turn.continuation,
      requestId: turn.operationId
    };
    const own = await this.beforeTurn(context);
    // The sandboxed extensions see the subclass's config, as in Think,
    // once per operation: Think prepares a turn once for its whole tool
    // loop, and the harness asks before every model call.
    const folded =
      this.#extensionTurn?.operationId === turn.operationId
        ? this.#extensionTurn.changes
        : undefined;
    const config =
      folded !== undefined
        ? { ...(own ?? {}), ...folded }
        : await this.#extensionHooks.beforeTurn(
            // SAFETY: the fields a turn snapshot reads are all here.
            context as unknown as TurnContext,
            own ?? {}
          );
    if (folded === undefined) {
      // `messages` is the first call's transcript: a later call has the
      // tool results since, so it is not kept.
      const { messages: _messages, ...kept } = changesOf(own ?? {}, config);
      this.#extensionTurn = { operationId: turn.operationId, changes: kept };
    }
    this.#turnMaxSteps = config.maxSteps;
    // Nothing to change: neither the subclass nor an extension set a field.
    if (!own && Object.keys(config).length === 0) return;
    const system = config.instructions ?? config.system;
    return {
      ...(config.model !== undefined && {
        model: this.resolveModel(config.model)
      }),
      ...(typeof system === "string" && { system }),
      ...(config.messages && { messages: config.messages }),
      ...(config.activeTools && { activeTools: config.activeTools }),
      ...(config.toolChoice !== undefined && {
        toolChoice: config.toolChoice
      }),
      ...(config.providerOptions !== undefined && {
        // SAFETY: provider options are JSON by the AI SDK's contract.
        providerOptions: config.providerOptions as NonNullable<
          ThinkTurnConfig["providerOptions"]
        >
      }),
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

  /** The root session's Sessions handle, which the harness hands over on first use. */
  async #rootHandle(): Promise<Session> {
    if (!this.#handle) await this.harness.session().messages();
    if (!this.#handle)
      throw new Error("The harness did not configure the root session");
    return this.#handle;
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

/** The fields `folded` set or changed relative to `own`. */
function changesOf(own: TurnConfig, folded: TurnConfig): TurnConfig {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(folded)) {
    if ((own as Record<string, unknown>)[key] !== value) changes[key] = value;
  }
  // SAFETY: every key is one of `folded`'s, a TurnConfig's.
  return changes as TurnConfig;
}
