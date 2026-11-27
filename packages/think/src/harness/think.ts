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
  type WSMessage,
  callable,
  isPlatformTransientError
} from "agents";
import {
  DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
  unexecutedToolNames,
  type ChatRecoveryConfig,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  classifyProviderError
} from "agents/chat";
import type {
  ChatResponseResult,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";
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
  getToolName,
  isToolUIPart,
  jsonSchema,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type TypedToolCall,
  type UIMessage,
  type UIMessageChunk
} from "ai";
import { ThinkModelResolver } from "../model";
import {
  DEFAULT_MESSENGER_CONCURRENCY,
  type MessengerConcurrency,
  type MessengerContext,
  type ThinkMessengers
} from "../messengers";
import { resolveChannels } from "../channels";
import type {
  ChannelContext,
  NormalizedChannelDefinition,
  ThinkChannels
} from "../channels";
import {
  deliverChannelNotice,
  resolveChannelContext
} from "../channels/runtime";
import {
  channelFromMessages,
  stampTurnContext,
  turnMetadataFromMessages
} from "../turn-metadata";
import type { DeliverNoticeOptions } from "../turn-types";
import {
  messengerChannels,
  type ThinkMessengerChannels
} from "./messenger-channels";
import {
  reconcileScheduledTasks,
  type ThinkScheduledTasks
} from "../scheduled-tasks";
import { Workspace, type WorkspaceStub } from "@cloudflare/computer";
import { workspaceExtension } from "./extensions/workspace";
import { fetchExtension } from "./extensions/fetch";
import { skillsExtension } from "./extensions/skills";
import { sandboxedExtensions } from "./extensions/sandboxed";
import { actionsExtension } from "./extensions/actions";
import {
  actionApprovalInputErrorEnvelope,
  compileActionTools,
  normalizeActionAuthorization,
  resolveActionPermissions,
  type ActionToolHost
} from "../action-tools";
import {
  createEffectState,
  registerEffectTask,
  stableStringify,
  sweepEffects
} from "../action-ledger";
import { runLedgeredAction } from "../action-run";
import { ReplyAttachments } from "../reply-attachments";
import type {
  Action,
  ActionApprovalDescriptor,
  ActionAuthorizationContext,
  ActionAuthorizationDecision,
  ActionPermissionSpec,
  CompiledActionMetadata,
  ReplyAttachment,
  NormalizedActionAuthorization
} from "../actions";
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
import { stampTurnContext, turnMetadataFromMessages } from "../turn-metadata";
import type {
  ChatErrorContext,
  ContextOverflowConfig,
  ExtensionConfig,
  MessageMetadataCallback,
  OnStartDegradation
} from "../turn-types";
import { ThinkSkills } from "../skills-runtime";
import { declaredOverrides } from "../overrides";
import type { SkillScriptRunner, SkillSource } from "agents/skills";
import {
  CONTEXT_REMINDER_MESSAGE_ID,
  mcpConnectionsExtension,
  mcpExtension,
  registerDeliverySink
} from "agents/internal";
import {
  WORKFLOW_NOTIFICATION_SINK,
  sendWorkflowNotification,
  workflowNotificationSink,
  workflowPromptContext
} from "../workflow-notifications";
import {
  THINK_FINAL_ANSWER_TOOL_NAME,
  thinkFinalAnswerInstruction,
  withoutFinalAnswerParts
} from "../inference/structured-output";
import {
  admittedSubmissionMetadata,
  SKIPPED_BY_RESET,
  cancelReason,
  isTerminalSubmissionStatus,
  SubmissionStatusQueue,
  TERMINAL_SUBMISSION_STATUSES,
  type DeleteSubmissionsOptions,
  type ListSubmissionsOptions,
  type ThinkSubmissionStatus
} from "../submissions";
import type { TaskJson, TaskStatus } from "agents/tasks";
import type { CreateFetchToolsOptions } from "../tools/fetch";
import { isLocalWorkspace, type ThinkWorkspace } from "../workspace-files";
import { ThinkSession } from "../session";
import { ThinkConfigStore } from "../config-store";
import { DEFAULT_SYSTEM_PROMPT, systemPromptForTurn } from "../system-prompt";
import { Think as LegacyThink } from "../think";
import type { AgentToolRunInspection, AgentToolStoredChunk } from "agents";
import {
  chunksOfMessage,
  REPLAY_PAGE_BYTES,
  utf8Length
} from "agents/internal";
import {
  isCompactionMessage,
  type Session,
  type SessionMessage
} from "agents/sessions";
import {
  MediaEvictionPasses,
  resolveMediaEvictionConfig,
  type MediaEvictionConfig
} from "../media-eviction";
import { MODEL_TRUNCATION_STEP } from "../inference/model-messages";
import { WorkspaceFiles } from "../workspace-files";
import {
  HYDRATION_MESSAGE_OVERHEAD_BYTES,
  cachedMessageBytes,
  ThinkTranscriptCache,
  type HydrationResult
} from "../transcript-cache";
import {
  AgentContextProvider,
  Context,
  type ContextConfig
} from "agents/context";
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
  PrepareStepContext,
  StepConfig,
  StepContext,
  StreamCallback,
  SubmitMessagesOptions,
  WaitForSubmissionOptions,
  SubmitMessagesResult,
  ThinkModel,
  ThinkSubmissionInspection,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
  TurnInputMessages,
  PendingApproval,
  RejectExecutionOptions,
  TurnTrigger
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
  status: ThinkOperationStatus & { readonly abortReason?: string }
): ThinkSubmissionInspection["status"] {
  switch (status.status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "completed";
    case "unanswered":
      // A turn reset stops its submissions with this reason; as on Think,
      // they end skipped.
      if (status.abortReason === SKIPPED_BY_RESET) return "skipped";
      return status.reason === "aborted" || status.reason === "withdrawn"
        ? "aborted"
        : "error";
  }
}

/** What Think reports for a submission interrupted and not recovered. */
const SUBMISSION_INTERRUPTED =
  "Submission was interrupted after messages were applied.";

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
    // A cancel's own reason, as on Think; else how the operation ended. A
    // turn that was interrupted and not recovered is reported in Think's
    // words.
    ...(status.status === "unanswered" &&
      (status.abortReason ?? status.reason) !== undefined && {
        error:
          status.abortReason ??
          (status.reason === "interrupted"
            ? SUBMISSION_INTERRUPTED
            : status.reason)
      }),
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
      // A submission a turn reset ended is an aborted run.
      if (status === "skipped") out.add("aborted");
    }
  }
  return [...out];
}

/** What a `chat()` caller is told when a reset cuts its turn off. As on Think. */
const CHAT_CLEARED_ERROR = "The chat was cleared before the turn finished.";

/** The reasons ThinkHarness ends an operation with when it never ran. */
const NEVER_RAN = new Set(["withdrawn", "not_waiting", "not_found", "empty"]);

/** A programmatic turn stopped, or cleared by a reset, before it began. */
function cutOffBeforeStart(cut: "stopped" | "cleared"): SaveMessagesResult {
  return cut === "cleared"
    ? { requestId: crypto.randomUUID(), status: "skipped", reason: "cleared" }
    : { requestId: crypto.randomUUID(), status: "aborted", reason: "stopped" };
}

function saveResult(result: ThinkOperationResult): SaveMessagesResult {
  if (result.status === "done") {
    return { requestId: result.operationId, status: "completed" };
  }
  // A stopped turn ends "aborted"; one stopped while it waited, before it
  // started, ends "withdrawn". Think reports both as aborted by a stop.
  if (result.reason === "aborted" || result.reason === "withdrawn") {
    return {
      requestId: result.operationId,
      status: "aborted",
      reason: "stopped"
    };
  }
  return {
    requestId: result.operationId,
    status: "error",
    ...(result.reason !== undefined && { error: result.reason })
  };
}

export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";
  /**
   * How long after its turn started an interrupted submission is still
   * recovered. Past it, the submission ends `error`.
   */
  protected static submissionRecoveryStaleMs = 15 * 60 * 1000;

  /** Model calls per turn. Read per call, so a subclass field applies. */
  maxSteps = 10;
  /** Whether reasoning reaches the stream, as in Think; a turn may say. */
  sendReasoning = true;

  /** How a messenger thread's burst of messages is answered, as on Think. */
  messengerConcurrency: MessengerConcurrency = DEFAULT_MESSENGER_CONCURRENCY;

  /**
   * Metadata for every assistant message, as on Think. A turn's
   * `beforeTurn` may return its own `messageMetadata` instead.
   */
  messageMetadata?: MessageMetadataCallback;

  /**
   * Opt-in handling for a turn that overflows the context window, as on
   * Think. Unset leaves an overflow terminal.
   */
  contextOverflow?: ContextOverflowConfig;

  readonly harness: ThinkHarness;
  readonly #chat: ThinkChat;
  /** The messengers from `getMessengers()`, as Chat SDK Channels. */
  readonly #messengers: ThinkMessengerChannels | undefined;
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

  /**
   * As on Think: the byte budget for the in-memory message view. A stored
   * transcript larger than this is hydrated as its most recent messages
   * that fit, and `chat:hydration:windowed` is emitted. Non-finite or
   * non-positive: always the whole transcript.
   *
   * @default 32 * 1024 * 1024
   */
  hydrationByteBudget: number = 32 * 1024 * 1024;

  /** The in-memory message view, bounded by `hydrationByteBudget`. */
  readonly #transcript = new ThinkTranscriptCache({
    budget: () => this.hydrationByteBudget,
    // As on Think, through the session `configureSession` returned, so an
    // app's wrapping of its reads applies; before it exists, the harness's.
    readAll: async () =>
      this.session
        ? ((await this.session.getHistory()) as UIMessage[])
        : this.harness.session().messages(),
    readRecent: async (budget) => {
      const recent = this.session
        ? await this.session.getRecentHistory(budget)
        : await (await this.#rootHandle()).getRecentHistory(budget);
      return { ...recent, messages: recent.messages as UIMessage[] };
    },
    emitWindowed: (payload) => this._emit("chat:hydration:windowed", payload),
    // A refresh is where an eviction pass may become worth scheduling, as
    // on Think.
    refreshed: () => this.#mediaEviction.request()
  });

  /**
   * Evict aged media from the conversation, as on Think: the bytes go to
   * the Workspace and a marker stays in the message.
   */
  mediaEviction: MediaEvictionConfig | boolean = true;

  /** How many messages the media-eviction cutoff moves by at a time. */
  truncationStep = MODEL_TRUNCATION_STEP;

  /** Aged-media eviction passes: Think's capability, on this shell's view. */
  readonly #mediaEviction = new MediaEvictionPasses({
    config: () => resolveMediaEvictionConfig(this.mediaEviction),
    truncationStep: () => this.truncationStep,
    cachedMessages: () => this.#transcript.messages,
    agedRowsHiddenFromCache: () =>
      this.#transcript.lastHydration?.truncated === true ||
      this.#transcript.messages.some((message) =>
        isCompactionMessage(message as unknown as SessionMessage)
      ),
    storedBytes: () =>
      this.#transcript.lastHydration?.totalContentBytes ?? null,
    storedPathRows: (options) => this.session.internal_storedPathRows(options),
    readMessage: async (id) =>
      (await this.session.getMessage(id)) as unknown as UIMessage | null,
    openFiles: () => new WorkspaceFiles(this.workspace),
    // An update, never an insert, as on Think: a row a clear removed
    // during the pass stays removed.
    updateMessage: (message) =>
      this.session.updateMessage(message as unknown as SessionMessage),
    emitEvicted: (totals) =>
      (
        this._emit as unknown as (
          type: string,
          payload: Record<string, unknown>
        ) => void
      ).call(this, "chat:media:evicted", {
        ...totals,
        externalizedBytes: totals.bytes
      }),
    // A facet has no alarm of its own: its pass goes through the root's
    // queue, named by its path, as on Think.
    queueRouted: () =>
      this.queue("_cfEvictAgedMedia", undefined, {
        id: `media-eviction:${JSON.stringify(this.selfPath)}`
      })
  });
  #context: Context | undefined;
  /** Ends the view's subscription to the root session's change feed. */
  #unsubscribeMirror: (() => void) | undefined;
  #handle: Session | undefined;
  /** Each submission's status reports, run one at a time in order. */
  readonly #submissionStatuses = new SubmissionStatusQueue();
  /** Skills from `getSkills()`, loaded in onStart as Think loads them. */
  readonly #skills = new ThinkSkills();
  /** Think's `think_config` rows, the table and migration Think has. */
  readonly #config = new ThinkConfigStore();
  #configCache: unknown = null;
  /** What `beforeTurn` returned for the running operation's turn. */
  #ownTurn:
    | {
        readonly operationId: string;
        readonly own: TurnConfig | void;
        /** The default model, once a call of the turn resolved it. */
        defaultModel?: LanguageModel;
        /** The messages `beforeTurn` rewrote the turn's prompt to, if any. */
        messages?: TurnConfig["messages"];
        /** How many parts of a continued reply the rewrite already had. */
        replyParts?: number;
        /** Whether the turn continues a reply (its first call's value). */
        continuation?: boolean;
        /** The proactive compactions the turn tried (`contextOverflow`). */
        proactive?: number;
        /** The history a proactive compaction left, for the turn's later calls. */
        compactedHead?: UIMessage[];
        /** The turn's `stopWhen`, checked as each step ends. */
        stopWhen?: TurnConfig["stopWhen"];
      }
    | undefined;
  /**
   * What started each operation (Think's `TurnTrigger`) and its turn's
   * abort signal, by operation id, until it settles.
   */
  readonly #turns = new Map<string, { readonly trigger: TurnTrigger }>();
  /**
   * A signal for a resumed approval's grant, by operation, until the
   * operation settles: it fires if the operation ends unanswered.
   */
  readonly #grantSignals = new Map<string, AbortController>();

  async #grantSignal(operationId: string): Promise<AbortSignal> {
    const kept = this.#grantSignals.get(operationId);
    if (kept) return kept.signal;
    // An operation that already ended (stopped while the grant was being
    // prepared) gets a signal that says so, and nothing is kept for it.
    const status = await this.harness.session().inspect(operationId);
    if (status && status.status !== "queued" && status.status !== "running") {
      return stoppedStatus(status)
        ? AbortSignal.abort()
        : new AbortController().signal;
    }
    // A grant prepared beside this one while it waited keeps its signal:
    // one signal per operation, so a stop reaches both.
    const raced = this.#grantSignals.get(operationId);
    if (raced) return raced.signal;
    const controller = new AbortController();
    this.#grantSignals.set(operationId, controller);
    return controller.signal;
  }
  /**
   * A step that called tools, by operation, until its tools ran: at most
   * one per running operation, removed when it ends.
   */
  readonly #openSteps = new Map<string, OpenStep>();
  /**
   * The input the model gave each running tool call, by call id, from
   * `beforeToolCall` to `afterToolCall`, which removes it; what an
   * operation leaves goes when it settles.
   */
  readonly #modelInputs = new Map<
    string,
    {
      readonly operationId: string;
      readonly input: unknown;
      /** When the call was decided, for its duration. */
      started: number;
    }
  >();
  /** Builds string models through one cached default provider, as Think. */
  readonly #models = new ThinkModelResolver({
    binding: () => this.getAIBinding(),
    gateway: (model) => this.getGateway(model),
    sessionAffinity: () => this.sessionAffinity
  });
  /** The latest turn's reply attachments, as on Think. */
  readonly #replyAttachments = new ReplyAttachments();
  /** The action ledger's coalescing, as on Think. */
  readonly #effects = createEffectState();
  /** Each approval-gated action's summary, permissions and risk. */
  readonly #actionMetadata = new Map<string, CompiledActionMetadata>();
  /**
   * The descriptors of calls asked for approval since this isolate started.
   * After a restart a pending call's descriptor is computed again from its
   * action and input.
   */
  readonly #actionDescriptors = new Map<string, ActionApprovalDescriptor>();

  constructor(ctx: AgentContext, env: Env) {
    snapshotDeclaredMembers(new.target.prototype);
    super(ctx, env);
    registerDeliverySink(
      this.tasks,
      WORKFLOW_NOTIFICATION_SINK,
      workflowNotificationSink(
        (notification) =>
          this.sendWorkflowEvent(
            notification.workflowName as string & {},
            notification.workflowId,
            notification.event
          ),
        (error) => this.onError(error)
      )
    );
    registerEffectTask(this.tasks, this.#effects);
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
          // Made here when first needed, as at start: Channels follows a
          // run cut off by a reset as it starts, before Think's onStart.
          extension: workspaceExtension(
            () =>
              (this.workspace ??= new Workspace({ storage: this.ctx.storage }))
          )
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
        // The actions follow the agent's own tools, as in Think.
        {
          name: "actions",
          after: true,
          extension: actionsExtension(
            () => this.getActions(),
            this.#actionToolHost,
            this.#actionMetadata
          )
        },
        // The sandboxed extensions' tools follow the actions, as in
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
      // context blocks; the default is only the fallback when the context
      // has no text, the skill catalog's and a prompt a release froze
      // included.
      system: async () => {
        if (isMethodOverridden(this, "getSystemPrompt")) {
          return this.getSystemPrompt();
        }
        if (this.#skills.loaded) return undefined;
        if (this.#context && this.#context.getBlocks().length > 0) {
          return undefined;
        }
        const frozen = (await this.#context?.freezeSystemPrompt()) ?? "";
        return frozen ? undefined : this.getSystemPrompt();
      },
      tools: async () => this.#withFinalAnswer(await this.getTools()),
      // The harness cuts older messages as Think does, by its step.
      truncationStep: () => this.truncationStep,
      // A turn's `beforeTurn` may set its own, as in Think.
      get maxSteps() {
        return self.#turnMaxSteps ?? self.maxSteps;
      },
      // One submission's reports in order, as on Think.
      onSubmissionStatus: (status) =>
        this.#submissionStatuses.run(status.operationId, () =>
          this.#submissionStatus(status)
        ),
      // Think's `chatRecovery`, read when a run starts, as on Think.
      get recovery() {
        return self.#recoveryOptions();
      },
      hooks: {
        // As in Think: a workflow turn's final-answer tool is plumbing,
        // never stored. A reply that held only it is not stored at all.
        // As in Think: a structured workflow turn that ends without its
        // final-answer tool's answer fails.
        beforeTurnEnd: ({ operationId }) => {
          const final = this.#finalAnswer;
          if (final?.operationId === operationId && !final.output) {
            throw new Error(
              `Model ended the turn without calling the ${final.name} tool`
            );
          }
        },
        storedReply: (message) => {
          const kept = withoutFinalAnswerParts(message);
          return kept === message ||
            kept.parts.some((part) => part.type !== "step-start")
            ? kept
            : { ...kept, parts: [] };
        },
        onRecovery: (context) => this.#onRecovery(context),
        onContextOverflow: ({ operationId, signal }) =>
          this.#onContextOverflow(operationId, signal),
        beforeTurn: (turn) => this.#beforeTurn(turn),
        beforeToolCall: async (call) => {
          // As in Think, the final-answer tool is plumbing: no hook sees it.
          if (this.#isFinalAnswer(call)) return undefined;
          // The step's chunks reach extensions before its tool calls do.
          await this.#chunkHooks;
          // A call approved after a restart runs before any model call of
          // its turn: the turn's grant is asked for here.
          await this.#authorizeTurn(call.operationId, async () => {
            // Asked for here, and only resolved when the grant reads it:
            // a failing `getModel()` fails that read, as in Think.
            let chosen: ThinkModel | undefined;
            let failure: unknown;
            try {
              chosen = await this.getModel();
            } catch (error) {
              failure = error;
            }
            let model: LanguageModel | undefined;
            const self = this;
            return {
              system: this.getSystemPrompt(),
              messages: await convertToModelMessages(this.messages, {
                ignoreIncompleteToolCalls: true
              }),
              tools: {},
              // Resolved only when read, as in Think.
              get model() {
                if (failure !== undefined) throw failure;
                return (model ??= self.resolveModel(chosen as ThinkModel));
              },
              continuation: true,
              requestId: call.operationId,
              // As Think's resuming turn: what started it (after a restart,
              // an approval's continuation), and a signal that fires if the
              // operation is stopped.
              trigger:
                this.#turns.get(call.operationId)?.trigger ??
                "auto-continuation",
              abortSignal: await this.#grantSignal(call.operationId)
            } as unknown as TurnContext;
          });
          const decision = await this.#beforeToolCall(call);
          // As in Think: an approved action runs with the input a human
          // approved, or not at all.
          if (
            decision?.action === "run" &&
            decision.input !== undefined &&
            this.#actionMetadata.has(call.toolName)
          ) {
            const approved = await this.#approvedInput(call.toolCallId);
            if (
              approved.found &&
              stableStringify(decision.input) !==
                stableStringify(approved.input)
            ) {
              return {
                action: "substitute",
                output: actionApprovalInputErrorEnvelope()
              };
            }
          }
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
            // The call's time starts as it runs, after the extensions heard.
            const kept = this.#modelInputs.get(call.toolCallId);
            if (kept) {
              this.#modelInputs.set(call.toolCallId, {
                ...kept,
                started: Date.now()
              });
            }
          }
          return decision;
        },
        afterToolCall: async (result) => {
          if (this.#isFinalAnswer(result)) return;
          const kept = this.#modelInputs.get(result.toolCallId);
          // From the decision to run it to its result, as Think times
          // `execute`: not the approval before it or the hooks after.
          const toolExecutionMs = kept ? Date.now() - kept.started : 0;
          await this.#extensionHooks.toolCallFinish({
            // SAFETY: a snapshot reads the name, id and input only.
            toolCall: result as unknown as TypedToolCall<ToolSet>,
            stepNumber: undefined,
            durationMs: toolExecutionMs,
            success: result.ok,
            ...(result.ok
              ? { output: result.output }
              : { error: result.errorText })
          });
          const modelInput = kept ? kept.input : result.input;
          this.#modelInputs.delete(result.toolCallId);
          return this.afterToolCall({
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            input: modelInput,
            stepNumber: 0,
            messages: [],
            requestId: result.operationId,
            toolExecutionMs,
            durationMs: toolExecutionMs,
            ...(result.ok
              ? {
                  toolOutput: { type: "tool-result", output: result.output },
                  success: true,
                  output: result.output
                }
              : {
                  toolOutput: { type: "tool-error", error: result.errorText },
                  success: false,
                  error: result.errorText
                })
          } as unknown as ToolCallResultContext);
        },
        onStepFinish: async ({
          message,
          finishReason,
          operationId,
          step,
          usage
        }) => {
          await this.#chunkHooks;
          // The step before this one ran its tools since: its results are
          // in this message now.
          await this.#endStep(operationId, message);
          const segment = stepSegments(message);
          const ended = { operationId, step, finishReason, segment, usage };
          await this.#checkStopWhen(operationId, step, message, segment);

          // A step that called tools ends once they ran, as an AI SDK step
          // does: at the next step, or at the turn's end.
          if (stepResultOf(message, segment).toolCalls.length > 0) {
            this.#openSteps.set(operationId, ended);
            return;
          }
          await this.#stepEnded(ended, message);
        },
        onChunk: ({ chunk, operationId }) => {
          this.#streamed.add(operationId);
          this.#noteLiveCall(operationId, chunk);
          // The AI SDK's stream part, which Think gives its extensions and
          // `onChunk` alike.
          const part = streamPartOf(chunk, this.#callsOf(operationId), (id) =>
            this.#storedCall(id)
          );
          // In order, one after another, as Think awaits each chunk's hooks.
          this.#chunkHooks = this.#chunkHooks
            .then(() =>
              this.#extensionHooks.chunk({
                chunk: part
              } as unknown as ChunkContext)
            )
            .catch((error: unknown) =>
              console.error("[Think] An extension's onChunk failed", error)
            );
          void this.onChunk({ chunk: part } as unknown as ChunkContext);
        },
        onTurnEnd: async (end) => {
          // A turn no `chat()` caller waits on has nobody to tell.
          if (!this.#chatClears.has(end.operationId)) {
            this.#overflowed.delete(end.operationId);
          }
          // The extensions' chunk hooks finish inside the turn, as in Think.
          await this.#chunkHooks;
          const continued = this.#continued.get(end.operationId);
          this.#continued.delete(end.operationId);
          const streamed = this.#streamed.delete(end.operationId);
          this.#liveCalls.delete(end.operationId);
          this.#toolCalls.delete(end.operationId);
          const clearsAtStart = this.#clearsAtStart.get(end.operationId);
          this.#clearsAtStart.delete(end.operationId);
          // A turn's end is a safe boundary: a view grown past its budget
          // re-windows here, as Think's does after a chat request. After the
          // turn's own bookkeeping, and best-effort: a read that fails leaves
          // the view as it is, and the turn still reports.
          await this.#transcript.refreshIfNeeded().catch((error: unknown) => {
            console.warn("[Think] Could not re-window the transcript", error);
          });
          // A clear that ran, or runs, while the turn was open.
          const clearedUnder =
            this.#clearing > 0 ||
            (clearsAtStart !== undefined && clearsAtStart !== this.#clears);
          if (end.message) await this.#endStep(end.operationId, end.message);
          else this.#openSteps.delete(end.operationId);
          // A turn that never ran has no response: one stopped while it
          // waited, or input the harness turned away before a model call (a
          // tool result no call waits for, an empty or unknown operation).
          // Its messenger context, for its response hook; forgotten here,
          // whichever way the hook ends.
          const responding = this.#responseContexts.get(end.operationId);
          this.#responseContexts.delete(end.operationId);
          const stoppedByCaller = this.#callerStops.delete(end.operationId);
          // As on Think, a turn the chat was cleared under, running or
          // waiting, gets no response hook. Its `chat()` caller is told of
          // the clear, unless it had stopped the turn itself first.
          if (
            end.status === "unanswered" &&
            (end.reason === "aborted" || end.reason === "withdrawn") &&
            clearedUnder
          ) {
            if (!stoppedByCaller && this.#chatClears.has(end.operationId)) {
              this.#chatClears.set(end.operationId, true);
            }
            return;
          }
          // A turn that wrote a message ran, whatever its reason's text.
          if (
            end.status === "unanswered" &&
            end.message === undefined &&
            end.reason !== undefined &&
            NEVER_RAN.has(end.reason)
          ) {
            return;
          }
          if (end.status === "unanswered" && end.reason !== "aborted") {
            // As on Think, a failed turn is reported to observability: in its
            // stream once the model streamed (a message error too, as the
            // reply pump reports one), in the turn before that. Its messages
            // were placed once it reached `beforeTurn`.
            const error = end.reason ?? "unanswered";
            if (streamed) this._emit("message:error", { error });
            this._emit("chat:request:failed", {
              requestId: end.operationId,
              stage: streamed ? "stream" : "turn",
              messagesPersisted: continued !== undefined,
              error
            });
          }
          this.#respondingContext = responding;
          try {
            await this.onChatResponse({
              // As on Think, a turn that ended before it wrote anything still
              // reports, with an empty assistant message.
              message: end.message ?? {
                id: end.messageId ?? crypto.randomUUID(),
                role: "assistant",
                parts: []
              },
              requestId: end.operationId,
              // As `beforeTurn` saw it, if the turn got that far.
              continuation: continued ?? false,
              status:
                end.status === "done"
                  ? "completed"
                  : end.reason === "aborted"
                    ? "aborted"
                    : "error",
              ...(end.status === "unanswered" &&
                end.reason !== undefined && { error: end.reason })
            });
          } finally {
            this.#respondingContext = undefined;
          }
        },
        classifyError: (error, context) =>
          this.#classify(error, context?.operationId)
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
      // A tool's progress, which the harness gives its observers: Think's
      // `onChunk` hears it as the AI SDK's preliminary tool-result.
      if (
        event.type === "chunk" &&
        event.chunk.type === "tool-output-available" &&
        event.chunk.preliminary
      ) {
        void this.onChunk({
          chunk: streamPartOf(
            event.chunk,
            this.#callsOf(event.operationId),
            (id) => this.#storedCall(id)
          )
        } as unknown as ChunkContext);
      }
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
        this.#ownTurn = undefined;
        this.#actionTurn = undefined;
        this.#extensionTurn = undefined;
        this.#turnMaxSteps = undefined;
      }
      // A settled operation's turn is over: its signal fires if it was cut
      // short, and it is forgotten.
      if (
        event.type === "operation" &&
        (event.status.status === "done" || event.status.status === "unanswered")
      ) {
        this.#turns.delete(event.status.operationId);
        this.#webRequests.delete(event.status.operationId);
        const grant = this.#grantSignals.get(event.status.operationId);
        if (grant) {
          // As Think's turn signal: it fires on a stop, not on a failure.
          if (stoppedStatus(event.status)) grant.abort();
          this.#grantSignals.delete(event.status.operationId);
        }
        this.#messengerContexts.delete(event.status.operationId);
        this.#explicitChannels.delete(event.status.operationId);
        // A call the operation left without an afterToolCall is forgotten.
        for (const [toolCallId, kept] of this.#modelInputs) {
          if (kept.operationId === event.status.operationId) {
            this.#modelInputs.delete(toolCallId);
          }
        }
      }
    });
    this.lifecycle.use(this.harness);
    this.lifecycle.use(this.#config);
    this.lifecycle.use(this.#mediaEviction);
    // Read here, not at start as Think reads them: Channels mounts its
    // channels, and their deliveries register on Tasks, at construction. A
    // sub-agent mounts them too (its path is not known yet) but takes no
    // webhook.
    // A messenger declared in `configureChannels()` mounts too, when it
    // returns its channels at once; one it returns later cannot mount
    // (checked at start).
    // One that reads what its subclass sets up later is read at start.
    let configured: ThinkChannels | Promise<ThinkChannels> | undefined;
    try {
      configured = this.configureChannels();
    } catch {
      configured = undefined;
    }
    if (configured instanceof Promise) {
      // Not used: it may have read a field its subclass had not set yet.
      configured.catch(() => {});
      configured = undefined;
    }
    this.#configuredAtConstruction = configured;
    this.#messengers = messengerChannels({
      messengers: resolveChannels(
        this.#configuredAtConstruction ?? {},
        this.getMessengers() as ThinkMessengers
      ).messengers as ThinkMessengers,
      harness: this.harness,
      tasks: this.tasks,
      root: () => this.parentPath.length === 0,
      kv: this.ctx.storage.kv,
      storage: this.ctx.storage,
      parent: this,
      concurrency: () => this.messengerConcurrency
    });
    if (this.#messengers) {
      this.lifecycle
        .use(this.#messengers.channels.streams)
        .use(this.#messengers.channels);
    }

    const onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      if (!this.workspace) {
        this.workspace = new Workspace({ storage: this.ctx.storage });
      }
      const handle = await this.#rootHandle();
      this.session = await this.configureSession(
        new ThinkSession(handle, () => this.context)
      );
      const sessionId = this.session.sessionId;
      this.#context = new Context(handle, {
        blocks: [
          ...(await this.configureContext()),
          ...this.session.internal_takePendingContext()
        ],
        sql: this,
        // As on Think: the prompt a release froze (a custom store, or the
        // `_system_prompt` row) is read, never written, so the turns sent
        // before the upgrade are sent it.
        promptStore:
          this.session.internal_promptStore() ??
          new AgentContextProvider(
            this,
            sessionId ? `_system_prompt_${sessionId}` : "_system_prompt"
          )
      });
      await this.#context.load();
      // As in Think: the channel registry, read at start on the root.
      if (this.parentPath.length === 0) {
        // TEMPORARY: remove in the next minor. The recovered replies
        // think@0.24.0 kept, delivered as deliveries.
        await this.#messengers?.importReleasedReplies();
        // Read again at start, once its subclass is set up: the registry
        // is what it answers now.
        const resolved = resolveChannels(
          await this.configureChannels(),
          this.getMessengers() as ThinkMessengers
        );
        this.#channels = resolved.channels;
        const unmounted = Object.keys(resolved.messengers).filter(
          (id) => !this.#messengers?.ids.includes(id)
        );
        if (unmounted.length > 0) {
          throw new Error(
            `Messenger channels ${unmounted.map((id) => `"${id}"`).join(", ")} come from an async configureChannels(): the harness-backed Think mounts messengers at construction, so declare them in getMessengers() or return them from configureChannels() synchronously`
          );
        }
      }
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
        if (event.type === "reset") {
          this.#transcript.replace([]);
          this.#lastTurnChannel = undefined;
        }
        // A message is applied by the root session's change feed below,
        // which knows an append from an update, as on Think.
        if (event.type === "message") this.#wakeStableWaiters();
        // A reset, a delete or a compaction reaches the view through the
        // change feed too (clear, delete, compaction): it re-reads there.
        if (event.type === "reset" || event.type === "transcript") {
          this.#wakeStableWaiters();
        }
      });
      // As on Think, the view follows the root session's own change feed:
      // every write, the harness's and one made straight to the session (an
      // app's, or a late tool result on an older reply), reaches it and
      // media eviction, told apart as an append or an update.
      this.#unsubscribeMirror?.();
      this.#unsubscribeMirror = (await this.#rootHandle()).mirror<UIMessage>({
        get: () => this.#transcript.messages,
        set: (messages) => this.#transcript.replace(messages),
        transform: (message) => message as unknown as UIMessage,
        intercept: async (event) => {
          switch (event.type) {
            case "append":
              // An append under the view's tail extends it in place; a
              // branch append moves the path, which a patch cannot express.
              if (
                !event.inserted ||
                event.parentId === undefined ||
                event.parentId ===
                  (this.#transcript.messages.at(-1)?.id ?? null)
              ) {
                return false;
              }
              await this.#transcript.sync();
              return true;
            case "update":
              // An update to a row the view does not hold (an older reply a
              // late tool result lands on) may have put media on a row
              // media eviction already examined.
              if (
                !this.#transcript.messages.some(
                  (message) => message.id === event.message.id
                )
              ) {
                this.#mediaEviction.rowChangedOutsideCache();
              }
              return false;
            case "import":
              this.#transcript.markStale();
              return true;
            case "clear":
              this.#transcript.replace([]);
              this.#transcript.coversActivePath = true;
              return true;
            // Think also refreshes its context's prompt on a compaction; on
            // the harness-backed Think the harness's step loop owns the
            // context and records the change itself.
            case "delete":
            case "compaction":
            case "compact":
              await this.#transcript.sync();
              this.#wakeStableWaiters();
              return true;
            default:
              return false;
          }
        },
        onApplied: (event, message, previous) => {
          if (event.type === "update") {
            // A row that grew may now hold media the cursor has passed; a
            // pass's own rewrites shrink rows and leave it alone.
            // Charged against the budget as Think charges it.
            const grew = previous
              ? cachedMessageBytes(message) - cachedMessageBytes(previous)
              : 0;
            if (grew > 0) {
              this.#transcript.noteGrowth(grew);
              this.#mediaEviction.invalidate();
            }
            return;
          }
          // A budgeted refresh charges each message an overhead on top of
          // its bytes, so growth is charged the same way.
          this.#transcript.noteGrowth(
            cachedMessageBytes(message) + HYDRATION_MESSAGE_OVERHEAD_BYTES
          );
          this.#mediaEviction.noteAppend();
        }
      });
      this.#onStartDegradations = [];
      // As in Think: a transcript that cannot be read must not stop the
      // agent from starting; it starts with an empty view.
      const hydrated = await this.#bestEffortStartStep(
        "transcript-hydration",
        () => this.#sync(),
        "The agent is starting with an empty in-memory message view; " +
          "persisted history is untouched."
      );
      if (!hydrated) this.#transcript.replace([]);
      this.#installProtocol();
      await onStart(props);
      // Best-effort, as in Think: a getScheduledTasks() that throws must
      // not stop the agent from starting.
      // As in Think: expired action ledger rows are deleted at start.
      try {
        await this.#sweepActionLedger();
      } catch (error) {
        console.error("[Think] The action ledger was not swept", error);
      }
      await this.#bestEffortStartStep(
        "scheduled-task-reconcile",
        () => this.internal_reconcileScheduledTasks(),
        "Declared scheduled tasks were not reconciled on this wake; the " +
          "next successful wake will reconcile them."
      );
    };
  }

  #onStartDegradations: OnStartDegradation[] = [];

  /**
   * The onStart steps that failed on this wake and were skipped so the
   * agent could still come up, as on Think. Empty when the start was clean.
   */
  getOnStartDegradations(): ReadonlyArray<OnStartDegradation> {
    return [...this.#onStartDegradations];
  }

  /**
   * Run an onStart step whose failure must not stop the agent starting:
   * record it, report it, and go on, as Think does. `true` when it ran.
   */
  async #bestEffortStartStep(
    step: OnStartDegradation["step"],
    fn: () => unknown,
    hint: string
  ): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      this.#onStartDegradations.push({ step, error });
      console.error(
        `[Think] onStart step "${step}" failed; continuing with degraded state. ${hint}`,
        error
      );
      this._emit("chat:onstart:degraded", {
        step,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  // ── Overridable configuration ─────────────────────────────────────

  getModel(): ThinkModel | Promise<ThinkModel> {
    throw new Error(
      "Override getModel() to return a model id string or a LanguageModel."
    );
  }

  getAIBinding(): Ai {
    const binding = (this.env as { AI?: Ai }).AI;
    if (!binding) {
      throw new Error(
        "Think's default model provider needs a Workers AI binding named " +
          '"AI". Add `"ai": { "binding": "AI" }` to wrangler.jsonc, override ' +
          "getAIBinding() to return your binding, or override getModel() to " +
          "return a LanguageModel."
      );
    }
    return binding;
  }

  getGateway(_model: string): GatewayOptions | undefined {
    return undefined;
  }

  resolveModel(model: ThinkModel): LanguageModel {
    return this.#models.resolve(model);
  }

  getSystemPrompt(): string {
    return DEFAULT_SYSTEM_PROMPT;
  }

  getTools(): ToolSet {
    return {};
  }

  configureSession(
    session: ThinkSession
  ): ThinkSession | Promise<ThinkSession> {
    return session;
  }

  /**
   * Persist a JSON-serializable configuration for this agent, as on Think:
   * private to the server, kept across restarts.
   */
  configure<T = Record<string, unknown>>(config: T): void {
    this.#config.set("_think_config", JSON.stringify(config));
    this.#configCache = config;
  }

  /** The configuration stored by {@link configure}, or null, as on Think. */
  getConfig<T = Record<string, unknown>>(): T | null {
    if (this.#configCache !== null) return this.#configCache as T;
    const raw = this.#config.get("_think_config");
    if (raw === undefined) return null;
    this.#configCache = JSON.parse(raw);
    return this.#configCache as T;
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
  getActions(): Record<string, Action> | Promise<Record<string, Action>> {
    return {};
  }

  /**
   * Authorize action permissions for the current turn, as on Think.
   * Returning `true` grants all of them; `grantedPermissions` limits the
   * default `authorizeAction` to that set.
   */
  authorizeTurn(
    _ctx: TurnContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    return true;
  }

  /**
   * Authorize a single action call, as on Think. The default enforces the
   * grant `authorizeTurn` returned for the turn.
   */
  authorizeAction(
    ctx: ActionAuthorizationContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    const turn = this.#actionTurn?.authorization ?? { allowed: true };
    if (!turn.allowed) return { allowed: false, reason: turn.reason };
    if (turn.grantedPermissions === undefined) return true;
    const granted = new Set(turn.grantedPermissions);
    const missing = ctx.requiredPermissions.filter(
      (permission) => !granted.has(permission)
    );
    if (missing.length === 0) return true;
    return {
      allowed: false,
      reason: `Missing required permission: ${missing.join(", ")}`
    };
  }

  /**
   * The running operation and what `authorizeTurn` granted it. Set before
   * its first model call, or, for a call approved after a restart, before
   * that call runs.
   */
  #actionTurn:
    | { operationId: string; authorization: NormalizedActionAuthorization }
    | undefined;

  async #authorizeTurn(
    operationId: string,
    context: () => Promise<TurnContext>
  ): Promise<void> {
    if (this.#actionTurn?.operationId === operationId) return;
    this.#replyAttachments.begin(operationId);
    this.#actionTurn = {
      operationId,
      authorization: normalizeActionAuthorization(
        await this.authorizeTurn(await context())
      )
    };
  }

  /**
   * As on Think: how long settled and pending action ledger rows are kept.
   * Deleting a row ends the idempotency guarantee for its key.
   */
  actionLedgerRetention: {
    settledMs: number | false;
    pendingMs: number | false;
    maxSweepRows: number;
  } = {
    settledMs: 30 * 24 * 60 * 60 * 1000,
    pendingMs: 90 * 24 * 60 * 60 * 1000,
    maxSweepRows: 500
  };

  async #sweepActionLedger(): Promise<void> {
    const now = Date.now();
    const retention = this.actionLedgerRetention;
    const swept = await sweepEffects(this.tasks, {
      settledBefore:
        retention.settledMs === false ? null : now - retention.settledMs,
      pendingBefore:
        retention.pendingMs === false ? null : now - retention.pendingMs,
      limit: Math.max(0, Math.floor(retention.maxSweepRows))
    });
    (
      this._emit as unknown as (
        type: string,
        payload: Record<string, unknown>
      ) => void
    ).call(this, "action:ledger:swept", { ...swept });
  }

  /** As on Think: how long a stale claim of a keyed action is held. */
  actionLedgerPendingRetryLeaseMs: number | false = 5 * 60 * 1000;

  /** What the actions call on this agent. */
  readonly #actionToolHost: ActionToolHost = {
    agent: this as unknown as LegacyThink,
    env: () => this.env as Cloudflare.Env,
    requestId: () => this.#actionTurn?.operationId ?? "",
    // An approved call runs without asking again: the harness decides that
    // from its answered approval.
    isApproved: () => false,
    grantedPermissions: () =>
      this.#actionTurn?.authorization.grantedPermissions,
    authorizeAction: (ctx) => this.authorizeAction(ctx),
    recordApprovalDescriptor: (toolCallId, descriptor) =>
      this.#actionDescriptors.set(toolCallId, descriptor),
    recordReplyAttachment: (requestId, attachment, actionName) => {
      const attachmentType = this.#replyAttachments.record(
        requestId,
        attachment
      );
      if (attachmentType === undefined) return;
      (
        this._emit as unknown as (
          type: string,
          payload: Record<string, unknown>
        ) => void
      ).call(this, "action:reply-attached", {
        action: actionName,
        attachmentType
      });
    },
    runLedgered: (args) =>
      runLedgeredAction(
        {
          tasks: this.tasks,
          effects: this.#effects,
          pendingRetryLeaseMs: this.actionLedgerPendingRetryLeaseMs,
          emit: (event) =>
            (
              this._emit as unknown as (
                type: string,
                payload: Record<string, unknown>
              ) => void
            ).call(this, event.type, event.payload),
          attachments: {
            count: () => this.#replyAttachments.count(),
            truncate: (n) => this.#replyAttachments.truncate(n)
          }
        },
        args
      )
  };

  /**
   * Advisory reply attachments the latest turn's actions recorded through
   * `ctx.attachReply`, as on Think: with a `requestId`, only if they belong
   * to that turn.
   */
  replyAttachments(requestId?: string): ReplyAttachment[] {
    return this.#replyAttachments.list(requestId);
  }

  /**
   * Everything awaiting human approval: the action calls of the latest reply
   * that wait for a decision, each with its descriptor. Resolve one with
   * `approveExecution` or `rejectExecution`, by its `executionId`.
   */
  async pendingApprovals(executionId?: string): Promise<PendingApproval[]> {
    const actions = await this.getActions();
    if (this.#actionMetadata.size === 0) {
      // A fresh isolate: compile the actions once for their metadata.
      compileActionTools(actions, this.#actionToolHost, this.#actionMetadata);
    }
    const out: PendingApproval[] = [];
    for (const call of await this.harness.pendingApprovals(
      this.harness.session().id
    )) {
      if (executionId !== undefined && call.approvalId !== executionId) {
        continue;
      }
      const metadata = this.#actionMetadata.get(call.toolName);
      if (!metadata) continue;
      out.push({
        executionId: call.approvalId,
        source: "action",
        descriptor: this.#actionDescriptors.get(call.toolCallId) ?? {
          requestId: "",
          toolCallId: call.toolCallId,
          action: metadata.actionName,
          summary: metadata.summary,
          input: call.input,
          // Computed again from the input, as when the call was asked.
          permissions:
            metadata.permissions !== undefined
              ? [...metadata.permissions]
              : await resolveActionPermissions(
                  Object.entries(actions).find(
                    ([key, action]) =>
                      (action.config.name ?? key) === call.toolName
                  )?.[1].config.permissions as
                    | ActionPermissionSpec<unknown>
                    | undefined,
                  call.input,
                  {
                    agent: this as unknown as LegacyThink,
                    env: this.env as Cloudflare.Env,
                    requestId: "",
                    toolCallId: call.toolCallId,
                    messages: [],
                    signal: new AbortController().signal,
                    attachReply: () => {}
                  }
                ),
          ...(metadata.risk !== undefined && { risk: metadata.risk }),
          kind: metadata.kind
        }
      });
    }
    return out;
  }

  /** Approve a pending action call; the turn continues and runs it. */
  async approveExecution(executionId: string): Promise<unknown> {
    return this.#decide(executionId, true);
  }

  /**
   * Reject a pending action call; the turn continues with the refusal, or
   * waits for a later turn with `{ autoContinue: false }`.
   */
  async rejectExecution(
    executionId: string,
    reason?: string,
    options?: RejectExecutionOptions
  ): Promise<unknown> {
    return this.#decide(executionId, false, reason, options?.autoContinue);
  }

  async #decide(
    executionId: string,
    approved: boolean,
    reason?: string,
    autoContinue?: boolean
  ): Promise<unknown> {
    const [pending] = await this.pendingApprovals(executionId);
    if (!pending) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }
    const session = this.harness.session();
    const receipt = await session.submit(
      {
        type: "approval",
        approvalId: executionId,
        approved,
        ...(reason !== undefined && { reason })
      },
      autoContinue === undefined ? {} : { autoContinue }
    );
    // Recorded, so the call is never listed again. A decision stopped
    // before this point leaves the call pending with its descriptor.
    this.#actionDescriptors.delete(pending.descriptor.toolCallId);
    const result = await session.wait(receipt.operationId);
    await this.#sync();
    // A decision the harness did not apply leaves the call waiting: that
    // alone is an error. A follow-up reply that failed after the action
    // ran is not.
    if ((await this.pendingApprovals(executionId)).length > 0) {
      return {
        status: "error",
        executionId,
        error:
          result.status === "done"
            ? "not applied"
            : (result.reason ?? result.status)
      };
    }
    // As on Think: the action's outcome, or the rejection. Read from the
    // call's final state, not from this decision: when two decisions race,
    // the one the harness applied is what happened.
    const toolCallId = pending.descriptor.toolCallId;
    let final:
      | {
          state?: unknown;
          output?: unknown;
          errorText?: unknown;
          approval?: { reason?: unknown };
        }
      | undefined;
    for (const message of this.messages) {
      for (const part of message.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          final = part as typeof final;
        }
      }
    }
    if (final?.state === "output-denied") {
      return {
        status: "rejected",
        executionId,
        // The reason the applied rejection carries, whichever caller sent
        // it.
        reason:
          (typeof final.approval?.reason === "string"
            ? final.approval.reason
            : undefined) ?? "Rejected by user"
      };
    }
    if (final?.state === "output-available") return final.output;
    if (final?.state === "output-error") {
      return { status: "error", executionId, error: final.errorText };
    }
    return {
      status: "error",
      executionId,
      error:
        "The decision was recorded; its outcome is written when the " +
        "action can run."
    };
  }
  getMessengers(): ThinkMessengers {
    return {};
  }

  /**
   * Post a notice outside a turn, as Think does: to the web transcript
   * (`"web"`, the default) as an assistant message that starts no turn, or
   * to a messenger's `thread`.
   */
  async deliverNotice(
    text: string | { markdown: string },
    options?: DeliverNoticeOptions
  ): Promise<void> {
    const channelId = options?.channel ?? "web";
    await deliverChannelNotice(text, options, {
      channelId,
      registry: this.#channels,
      surface: async () =>
        this.#messengers?.noticeSurface(channelId, options?.thread) as never,
      addMessages: (messages) => this.addMessages(messages),
      emit: (event) => {
        const emit = this._emit as unknown as (
          type: string,
          payload: Record<string, unknown>
        ) => void;
        emit.call(this, event.type, event.payload);
      }
    });
  }
  /**
   * Return the channels for this agent, as on Think: the implicit `web`
   * channel and each messenger are always present; these add surfaces and
   * per-channel policy (instructions, a narrower tool set, `maxTurns`).
   */
  configureChannels(): ThinkChannels | Promise<ThinkChannels> {
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

  /** An operation's trigger and signal: a submission unless set first. */
  #turnOf(operationId: string) {
    let turn = this.#turns.get(operationId);
    if (!turn) {
      turn = { trigger: "submission" };
      this.#turns.set(operationId, turn);
    }
    return turn;
  }

  /** End the operation's open step, if any, from `message`. */
  async #endStep(operationId: string, message: UIMessage): Promise<void> {
    const open = this.#openSteps.get(operationId);
    if (!open) return;
    this.#openSteps.delete(operationId);
    await this.#stepEnded(open, message);
  }

  /** Tell the extensions and `onStepEnd` that a step ended. */
  async #stepEnded(step: OpenStep, message: UIMessage): Promise<void> {
    const result = stepResultOf(message, step.segment);
    await this.#extensionHooks.stepFinish({
      stepNumber: step.step,
      finishReason: step.finishReason ?? "unknown",
      ...(step.usage && { usage: step.usage }),
      ...result
      // SAFETY: the fields a step snapshot reads are all here.
    } as unknown as StepContext);
    await this.onStepEnd({
      ...result,
      response: { messages: [] },
      finishReason: step.finishReason,
      ...(step.usage && { usage: step.usage }),
      message,
      stepNumber: step.step,
      requestId: step.operationId
    } as unknown as StepContext);
  }

  /** Before each model call, as the AI SDK's `prepareStep` in Think. */
  beforeStep(
    _ctx: PrepareStepContext
  ): StepConfig | void | Promise<StepConfig | void> {}

  /** After each step, as in Think. */
  onStepEnd(ctx: StepContext): void | Promise<void> {
    return this.onStepFinish(ctx);
  }

  /** @deprecated Prefer `onStepEnd`, as in Think. */
  onStepFinish(_ctx: StepContext): void | Promise<void> {}

  onChunk(_ctx: ChunkContext): void | Promise<void> {}

  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

  onChatError(error: unknown, _ctx?: ChatErrorContext): unknown {
    return error;
  }

  classifyChatError(
    _error: unknown,
    _ctx?: ChatErrorContext
  ): ChatErrorClassification | void {}

  // ── Messages ──────────────────────────────────────────────────────

  /**
   * Result of the most recent refresh when `hydrationByteBudget` applies.
   * `truncated` means `this.messages` is a recent window of a larger
   * stored transcript.
   */
  protected get _lastHydration(): HydrationResult | null {
    return this.#transcript.lastHydration;
  }

  get messages(): UIMessage[] {
    return this.#transcript.messages;
  }

  /** The channel of the running turn, if it resolved to one. */
  get activeChannel(): ChannelContext | undefined {
    const turn = this.#turnChannel;
    return turn && turn.operationId === this.#running?.requestId
      ? turn.context
      : undefined;
  }

  /** What `configureChannels()` returned at construction, when not a promise. */
  #configuredAtConstruction: ThinkChannels | undefined;
  /** The channel the last turn ran on, for a continuation, as on Think. */
  #lastTurnChannel: string | undefined;
  /**
   * Continue the latest reply, as on Think: on `channel` when one is given,
   * otherwise on the channel the last turn ran on.
   */
  async #continue(channel: string | undefined) {
    const operationId = crypto.randomUUID();
    if (channel !== undefined) this.#explicitChannels.set(operationId, channel);
    try {
      return await this.harness.session().continue({ operationId });
    } catch (error) {
      this.#explicitChannels.delete(operationId);
      throw error;
    }
  }

  /** Continuations given their own channel, until they start. */
  #explicitChannels = new Map<string, string>();
  /** Operations a browser's chat request started: they run on `web`. */
  #webRequests = new Set<string>();
  /** The channel registry, read at start (none on a sub-agent). */
  #channels: Map<string, NormalizedChannelDefinition> | undefined;
  /** The running operation's channel, resolved at its first model call. */
  #turnChannel:
    | {
        operationId: string;
        /** The channel asked for, registered or not. */
        channelId: string | undefined;
        context: ChannelContext | undefined;
        definition: NormalizedChannelDefinition | undefined;
      }
    | undefined;

  /**
   * The server-supplied metadata stamped on the turn's user message, as on
   * Think: read from the latest user message, so a recovered or continued
   * turn reads the same value.
   */
  get activeTurnMetadata(): Record<string, unknown> | undefined {
    return turnMetadataFromMessages(this.messages);
  }

  /** The turn running now, if any. */
  get activeTurn():
    | { requestId: string; trigger: string; continuation: boolean }
    | undefined {
    return this.#running;
  }

  /** The running operations whose model has streamed; dropped at their end. */
  #streamed = new Set<string>();
  /** Whether each running operation continues a reply; dropped at its end. */
  #continued = new Map<string, boolean>();
  #running:
    | { requestId: string; trigger: string; continuation: boolean }
    | undefined;

  /**
   * Hand out an RPC stub to this agent's Workspace, as on Think.
   * `getWorkspace(stub)` from `@cloudflare/computer` calls it to reach the
   * Workspace from another Worker or Durable Object. Only a Workspace this
   * agent owns can hand out a stub.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.__unsafe_ensureInitialized();
    const workspace = this.workspace;
    if (!isLocalWorkspace(workspace)) {
      throw new Error(
        "[Think] This agent's workspace belongs to another Durable Object, " +
          "so it cannot hand out a Workspace stub."
      );
    }
    await workspace.ready();
    return workspace.stub();
  }

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

  /** Re-read the transcript and return it, as on Think. */
  async syncMessagesFromStorage(): Promise<UIMessage[]> {
    await this.#sync();
    return this.#transcript.messages.slice();
  }

  /** Add messages to the conversation and run a turn over it. */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    // As on Think: a turn stopped before it starts builds and stores nothing.
    const cut = await this.#cutOffByStop(options?.signal);
    if (cut) return cutOffBeforeStart(cut);
    await this.#sync();
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    const known = new Set(this.messages.map((message) => message.id));
    const session = this.harness.session();
    const receipt = await session.submit(
      resolved.filter((message) => !known.has(message.id))
    );
    return this.#waitForTurn(receipt.operationId, options?.signal);
  }

  async clearMessages(): Promise<void> {
    this.#actionDescriptors.clear();
    this.#clearing++;
    this.#clears++;
    // As on Think, a turn started before the clear but not yet submitted is
    // cut off by it: it counts as a stop, so that turn is skipped as cleared.
    this.#stops++;
    this.#lastStop = "cleared";
    const resetting = this.harness.session().reset();
    this.#stopping = resetting.catch(() => {});
    try {
      await resetting;
    } finally {
      this.#clearing--;
    }
    await this.#sync();
  }

  /** Clears so far, and the count each running operation started under. */
  #clears = 0;
  #clearsAtStart = new Map<string, number>();
  /** Clears in progress: a turn they stop ends cleared, not stopped. */
  #clearing = 0;
  /**
   * The operations a `chat()` call waits on, and whether a clear stopped
   * each. Only those are tracked; each entry goes when its call returns.
   */
  #chatClears = new Map<string, boolean>();

  async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions & { channel?: string }
  ): Promise<SaveMessagesResult> {
    if (body !== undefined) {
      throw new Error(
        "Think.continueLastTurn with a body is not supported by the harness-backed Think yet"
      );
    }
    // As on Think: with no assistant message to continue, nothing runs.
    await this.#sync();
    if (this.#transcript.messages.at(-1)?.role !== "assistant") {
      return {
        requestId: "",
        status: "skipped",
        reason: "nothing-to-continue"
      };
    }
    const cut = await this.#cutOffByStop(options?.signal);
    if (cut) return cutOffBeforeStart(cut);
    const receipt = await this.#continue(options?.channel);
    return this.#waitForTurn(receipt.operationId, options?.signal);
  }

  /**
   * Wait for a programmatic turn to end. The caller's signal stops it as a
   * stop from a tab would, so the turn ends `aborted`.
   */
  async #waitForTurn(
    operationId: string,
    signal: AbortSignal | undefined
  ): Promise<SaveMessagesResult> {
    const session = this.harness.session();
    const stop = () => this.#stopForCaller(operationId);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      if (signal?.aborted) stop();
      const result = await session.wait(operationId);
      await this.#sync();
      return saveResult(result);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
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

  /**
   * Each running turn's tool calls by id, so `onChunk` can name a call's
   * tool and input on its result, as the AI SDK's stream parts do.
   */
  readonly #toolCalls = new Map<
    string,
    Map<string, { toolName: string; input: unknown }>
  >();

  /**
   * A call the transcript holds already, as one approved before its turn
   * runs it: its tool and input.
   */
  #storedCall(
    toolCallId: string
  ): { toolName: string; input: unknown } | undefined {
    for (let i = this.#transcript.messages.length - 1; i >= 0; i--) {
      for (const part of this.#transcript.messages[i].parts) {
        if (isToolUIPart(part) && part.toolCallId === toolCallId) {
          return { toolName: getToolName(part), input: part.input };
        }
      }
    }
    return undefined;
  }

  #callsOf(operationId: string) {
    let calls = this.#toolCalls.get(operationId);
    if (!calls) this.#toolCalls.set(operationId, (calls = new Map()));
    return calls;
  }

  /** The extensions' `onChunk` calls, chained so they run in order. */
  #chunkHooks: Promise<void> = Promise.resolve();

  /** The running turn's own `maxSteps`, from its `beforeTurn`. */
  #turnMaxSteps: number | undefined;

  /**
   * The running operation's workflow prompt, when it asked for structured
   * output: the turn offers `think_final_answer` with its schema, and the
   * call's input is the output the workflow is told.
   */
  #finalAnswer:
    | {
        readonly operationId: string;
        readonly schema: unknown;
        name: string;
        output?: { readonly value: unknown };
      }
    | undefined;

  /** Whether `call` is the running workflow turn's final-answer tool. */
  #isFinalAnswer(call: {
    readonly operationId: string;
    readonly toolName: string;
  }): boolean {
    const final = this.#finalAnswer;
    return (
      final?.operationId === call.operationId && final.name === call.toolName
    );
  }

  /** The tools on offer, with the final-answer tool on a workflow turn. */
  #withFinalAnswer(tools: ToolSet): ToolSet {
    const final = this.#finalAnswer;
    if (!final) return tools;
    // As in Think: a tool of the app's with the name gets a suffixed one.
    let name = THINK_FINAL_ANSWER_TOOL_NAME;
    for (let suffix = 1; name in tools; suffix++) {
      name = `${THINK_FINAL_ANSWER_TOOL_NAME}_${suffix}`;
    }
    final.name = name;
    return {
      ...tools,
      [name]: tool({
        description:
          "Provide your final answer. The arguments MUST match the required " +
          "schema. Calling this tool ends the task — call it exactly once " +
          "when you have everything you need.",
        inputSchema: jsonSchema(final.schema as never),
        execute: async (input: unknown) => {
          final.output = { value: input };
          // The answer ends the turn: no model call after it.
          this.#turnMaxSteps = 0;
          return "Final answer recorded.";
        }
      })
    };
  }

  /** The extensions' `beforeTurn` changes, kept for the operation. */
  #extensionTurn:
    | { readonly operationId: string; readonly changes: TurnConfig }
    | undefined;

  /** What a sandboxed extension can reach on this agent, as on Think. */
  readonly #hostApi = createThinkHostApi({
    workspace: () => this.workspace,
    context: () => this.context,
    messages: () => this.#transcript.messages,
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

  /**
   * The running messenger turn's context, as on Think; outside one, the
   * latest message's.
   */
  getMessengerContext(): MessengerContext | undefined {
    const running = this.#running?.requestId;
    const active =
      running !== undefined ? this.#messengerContexts.get(running) : undefined;
    if (active) return active;
    // While `onChatResponse` runs, its turn's, from its user message.
    if (this.#respondingContext) return this.#respondingContext;
    return messengerOf(this.messages.at(-1));
  }

  /** The messenger context of the turn whose `onChatResponse` runs. */
  #respondingContext: MessengerContext | undefined;

  /**
   * A message's messenger context, trusted only when the server stamped its
   * messenger's channel on it (a client's write cannot set the channel).
   */
  #trustedMessengerOf(
    message: UIMessage | undefined
  ): MessengerContext | undefined {
    const context = messengerOf(message);
    const channel = message ? channelFromMessages([message]) : undefined;
    return context && channel === context.messengerId ? context : undefined;
  }

  /** Each turn's messenger context, kept for its response hook. */
  #responseContexts = new Map<string, MessengerContext>();

  /**
   * Run a turn for a messenger event, as on Think: the context is kept on
   * the user message, and the turn runs on the messenger's channel.
   */
  async chatWithMessengerContext(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
    options?: ChatOptions
  ): Promise<void> {
    const messages = toInput(userMessage).map((message) =>
      message.role === "user"
        ? {
            ...message,
            metadata: {
              ...(message.metadata as Record<string, unknown> | undefined),
              messenger: context
            }
          }
        : message
    );
    await this.chat(messages, callback, {
      ...options,
      channel: context.messengerId
    });
  }

  /** Each running operation's messenger context; dropped at its end. */
  #messengerContexts = new Map<string, MessengerContext>();

  /**
   * The tools a client answers, as on Think: those the last turn had that
   * the server does not run (the client's own, and the app's declared with
   * no `execute`). Read once per isolate, since `hasPendingInteraction()`
   * is polled; stored, so the answer is there after a restart.
   */
  #unexecutedTools: string[] | undefined;
  /** Whether a `think_config` row holds the list; read once per isolate. */
  #unexecutedToolsStored: boolean | undefined;

  /** Store which of a turn's tools the server does not run, as Think does. */
  #recordUnexecutedTools(tools: ToolSet): void {
    const names = unexecutedToolNames(tools);
    this.#unexecutedTools = names;
    // An empty list with no row stored says nothing a reader does not
    // already assume, so it costs no write; an unchanged one is skipped by
    // the store.
    this.#unexecutedToolsStored ??=
      this.#config.get("unexecutedTools") !== undefined;
    if (names.length === 0 && !this.#unexecutedToolsStored) return;
    this.#config.set("unexecutedTools", JSON.stringify(names));
    this.#unexecutedToolsStored = true;
  }

  /**
   * The list, read once per isolate. Before the first turn on this version
   * there is no record, so read `getTools()`, where an app declares a tool
   * without `execute`, as Think does.
   */
  #unexecutedToolNames(): string[] {
    if (this.#unexecutedTools) return this.#unexecutedTools;
    const stored = this.#config.get("unexecutedTools");
    if (stored !== undefined) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          this.#unexecutedTools = parsed.filter(
            (name): name is string => typeof name === "string"
          );
          return this.#unexecutedTools;
        }
      } catch {
        // Fall through to the app's tools.
      }
    }
    try {
      this.#unexecutedTools = unexecutedToolNames(this.getTools());
    } catch {
      // `getTools()` can need turn-time context: without it, nothing is
      // known to be a client's.
      this.#unexecutedTools = [];
    }
    return this.#unexecutedTools;
  }

  /**
   * Each running operation's tool calls that have streamed and not had a
   * result yet, by call id: what Think's in-flight accumulator holds before
   * the reply is stored. Dropped at the operation's end.
   */
  readonly #liveCalls = new Map<
    string,
    Map<string, { toolName: string; approval: boolean }>
  >();

  /** Track a streamed tool call until its result streams too. */
  #noteLiveCall(operationId: string, chunk: UIMessageChunk): void {
    const calls = (): Map<string, { toolName: string; approval: boolean }> => {
      let held = this.#liveCalls.get(operationId);
      if (!held) {
        held = new Map();
        this.#liveCalls.set(operationId, held);
      }
      return held;
    };
    switch (chunk.type) {
      case "tool-input-available":
        calls().set(chunk.toolCallId, {
          toolName: chunk.toolName,
          approval: false
        });
        return;
      case "tool-approval-request": {
        const call = this.#liveCalls.get(operationId)?.get(chunk.toolCallId);
        if (call) call.approval = true;
        return;
      }
      case "tool-output-available":
      case "tool-output-error":
      case "tool-output-denied":
        this.#liveCalls.get(operationId)?.delete(chunk.toolCallId);
        return;
      default:
        return;
    }
  }

  /**
   * Whether the latest message has a tool call waiting on a client, as on
   * Think: an approval, or a call with no result to a tool a client
   * answers. A call to any other tool was the server's to run; unanswered
   * in a stored reply, it is dead (a removed tool, or an MCP tool not yet
   * reconnected, included).
   */
  protected hasPendingInteraction(): boolean {
    const answerable = new Set(this.#unexecutedToolNames());
    // A reply still streaming: its calls with no result yet, as Think's
    // accumulator holds them.
    for (const calls of this.#liveCalls.values()) {
      for (const call of calls.values()) {
        if (call.approval || answerable.has(call.toolName)) return true;
      }
    }
    const last = this.#transcript.messages.at(-1);
    const parts = last?.parts ?? [];
    if (!parts.some((part) => "toolCallId" in part)) return false;
    return parts.some((part) => {
      if (!("toolCallId" in part)) return false;
      if (part.state === "approval-requested") return true;
      if (part.state !== "input-available") return false;
      return answerable.has(
        getToolName(part as Parameters<typeof getToolName>[0])
      );
    });
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
      // Listen before looking, so a change in between still wakes us. The
      // waiter goes when this round ends, however it ends.
      let wake!: () => void;
      const ended = new Promise<void>((resolve) => {
        wake = resolve;
        this.#stableWaiters.push(resolve);
      });
      try {
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
        if (timedOut) return false;
      } finally {
        const index = this.#stableWaiters.indexOf(wake);
        if (index !== -1) this.#stableWaiters.splice(index, 1);
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
        ...(stream.signal && { signal: stream.signal }),
        ...(stream.channel !== undefined && { channel: stream.channel })
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
        ...(submit.metadata !== undefined && { metadata: submit.metadata }),
        ...(submit.channel !== undefined && { channel: submit.channel })
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
    // As saveMessages: a turn stopped before it starts builds nothing.
    const cut = await this.#cutOffByStop(wait.signal);
    if (cut) {
      return {
        ...cutOffBeforeStart(cut),
        continuation: wait.continuation === true
      };
    }
    const session = this.harness.session();
    // As in Think: an overridden `continueLastTurn` runs the continuation,
    // and its result's status stands, with the turn's message and output.
    if (wait.continuation && isMethodOverridden(this, "continueLastTurn")) {
      const returned = await this.continueLastTurn(undefined, {
        ...(wait.signal && { signal: wait.signal })
      });
      const settled = returned.requestId
        ? await session.wait(returned.requestId)
        : undefined;
      await this.#sync();
      const message =
        settled?.status === "done" && settled.messageId !== undefined
          ? this.#transcript.messages.find((m) => m.id === settled.messageId)
          : undefined;
      const output =
        settled?.status === "done"
          ? this.harness.operationOutput(session.id, returned.requestId)
          : undefined;
      return {
        ...returned,
        continuation: true,
        ...(message && { message: message as unknown as SessionMessage }),
        ...(output !== undefined && { output })
      } as TurnResult;
    }
    let receipt;
    if (wait.continuation) receipt = await this.#continue(wait.channel);
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
      receipt = await session.submit(
        // As in Think: the channel is stamped on the durable user message,
        // so a continuation or a recovered turn resolves it again.
        wait.channel ? stampTurnContext(messages, wait.channel) : messages
      );
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
        ? this.#transcript.messages.find((m) => m.id === result.messageId)
        : undefined;
    // A `beforeTurn` that asked for structured output gets it parsed.
    const output =
      result.status === "done"
        ? this.harness.operationOutput(session.id, receipt.operationId)
        : undefined;
    return {
      ...saveResult(result),
      continuation: wait.continuation === true,
      ...(message && { message: message as unknown as SessionMessage }),
      ...(output !== undefined && { output })
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
    // As in Think: the channel is stamped on the user messages, so the
    // turn that runs them resolves it.
    const receipt = await this.harness
      .session()
      .submit(stampTurnContext(messages, options?.channel), {
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
    const session = this.harness.session().id;
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    if (!wanted) {
      return (await this.harness.submissions(session, { limit })).map(
        submissionInspection
      );
    }
    // Several submission statuses share a run status (a queued and a
    // started operation are both open runs; an aborted one is a completed
    // run), so a page can hold submissions that were not asked for: read on
    // until `limit` of the wanted ones are found, or there are no more.
    const status = taskStatusesFor(wanted);
    const found: ThinkSubmissionInspection[] = [];
    let after: { operationId: string; createdAt: number } | undefined;
    for (let size = limit; ; size = DELETE_PAGE) {
      const page = await this.harness.submissions(session, {
        status,
        ...(after && { after }),
        limit: size
      });
      for (const item of page) {
        const submission = submissionInspection(item);
        if (!wanted.includes(submission.status)) continue;
        found.push(submission);
        if (found.length === limit) return found;
      }
      const last = page.at(-1);
      if (page.length < size || !last) return found;
      after = { operationId: last.operationId, createdAt: last.createdAt };
    }
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
    // A workflow prompt that asks for structured output arms the turn's
    // final-answer tool before its tools are built.
    if (status.status === "running") {
      const schema = workflowPromptContext(inspection.metadata ?? null)?.output
        ?.schema;
      this.#finalAnswer =
        schema === undefined
          ? undefined
          : {
              operationId: status.operationId,
              schema,
              name: THINK_FINAL_ANSWER_TOOL_NAME
            };
    }
    if (status.status === "queued") {
      this._emit("submission:create", {
        submissionId,
        requestId,
        idempotencyKey: inspection.idempotencyKey
      });
    }
    // The workflow that submitted it is told first, as on Think. A repeated
    // terminal report joins the delivery while it is open.
    if (isTerminalSubmissionStatus(inspection.status)) {
      const final =
        this.#finalAnswer?.operationId === status.operationId
          ? this.#finalAnswer
          : undefined;
      if (final) this.#finalAnswer = undefined;
      sendWorkflowNotification(this.tasks, inspection, final?.output?.value);
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
    submissionId: string,
    options?: WaitForSubmissionOptions
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
    // As on Think: from inside this agent's running turn, a submission that
    // is still open runs only after that turn ends, so the wait could not.
    // Work an earlier turn left running is not inside a turn any more.
    if (
      open &&
      this.harness.insideOperation(this.harness.session().id) !== undefined
    ) {
      throw new Error(
        "waitForSubmission() cannot be called from inside an active turn: the submission runs only after this turn ends"
      );
    }
    // A timeout stops only the wait: the submission is returned as it is
    // then, still open, or `null` when it was deleted meanwhile.
    const timeout =
      options?.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(options.timeoutMs);
    let settled: ThinkOperationInspection | undefined;
    try {
      settled = await this.harness.settled(
        this.harness.session().id,
        submissionId,
        timeout
      );
    } catch (error) {
      if (!timeout?.aborted) throw error;
      return this.inspectSubmission(submissionId);
    }
    // Read again; deleted meanwhile (the app's terminal hook may delete
    // it), the wait still has it as it settled, with a cancel's reason.
    return (
      (await this.inspectSubmission(submissionId)) ??
      submissionInspection(
        settled ?? {
          ...before,
          status: "unanswered",
          reason: "not_found",
          settledAt: before.settledAt ?? Date.now()
        }
      )
    );
  }

  // ── Programmatic chat ─────────────────────────────────────────────

  async chat(
    userMessage: TurnInputMessages,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const cut = await this.#cutOffByStop(options?.signal);
    const operationId = crypto.randomUUID();
    if (cut) {
      // As on Think: the caller hears the request start. One its own signal
      // stopped hears nothing more; one a reset cut off is told the chat was
      // cleared, since a silent end would read as an answer.
      await callback.onStart({ requestId: operationId });
      if (cut === "cleared" && !options?.signal?.aborted) {
        await callback.onError(CHAT_CLEARED_ERROR);
      }
      return;
    }
    // As in Think: the channel and the caller's turn metadata are stamped
    // on the durable user message.
    const messages = stampTurnContext(
      typeof userMessage === "function"
        ? await userMessage(this.messages)
        : toInput(userMessage),
      options?.channel,
      options?.metadata
    );
    this.#turns.set(operationId, { trigger: "rpc" });
    options?.signal?.addEventListener(
      "abort",
      () => this.#stopForCaller(operationId),
      { once: true }
    );
    this.#chatClears.set(operationId, false);
    try {
      await this.harness.session().chat(
        messages,
        {
          onStart: () => callback.onStart({ requestId: operationId }),
          onEvent: (json) => callback.onEvent(json),
          onDone: () => callback.onDone(),
          onError: (error) => {
            // A stopped turn is not an error: as on Think, its caller hears
            // neither `onDone` nor `onError`, and `onChatError` does not run.
            // "aborted" is the harness's reason for a stop, and "withdrawn" for
            // a stop that reached the turn while it waited (see `saveResult`).
            if (error === "aborted" || error === "withdrawn") return;
            const wrapped = this.#overflowed.delete(operationId)
              ? this.onChatError(new Error(error), {
                  requestId: operationId,
                  stage: "stream",
                  messagesPersisted: true,
                  classification: "context_overflow"
                })
              : this.onChatError(new Error(error));
            return callback.onError(errorText(wrapped));
          }
        },
        { operationId }
      );
      if (
        this.#chatClears.get(operationId) === true &&
        !options?.signal?.aborted
      ) {
        await callback.onError(CHAT_CLEARED_ERROR);
      }
    } finally {
      this.#chatClears.delete(operationId);
      this.#overflowed.delete(operationId);
    }
    await this.#sync();
  }

  async cancelSubmission(
    submissionId: string,
    reason?: unknown
  ): Promise<CancelSubmissionResult> {
    const before = await this.inspectSubmission(submissionId);
    if (!before) return { outcome: "not_found", submissionId };
    if (before.status !== "pending" && before.status !== "running") {
      return { outcome: "already_terminal", submissionId, submission: before };
    }
    const session = this.harness.session().id;
    // Read before the cancel: the app's terminal hook may delete the record.
    const ids = await this.harness.submittedMessageIds(session, submissionId);
    await this.harness.abort(session, submissionId, cancelReason(reason));
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

  /** Stop one turn by its request id; it ends `aborted`. */
  protected abortRequest(requestId: string, _reason?: unknown): void {
    this.#stopForCaller(requestId);
  }

  async cancelChat(requestId: string): Promise<void> {
    await this.#stopForCaller(requestId);
  }

  /**
   * The operations their callers stopped, until each ends: a clear that
   * lands while one unwinds did not stop it.
   */
  #callerStops = new Set<string>();
  #stopForCaller(operationId: string): Promise<boolean> {
    this.#callerStops.add(operationId);
    const stopping = this.harness
      .session()
      .abort(operationId)
      .then(
        (stopped) => {
          // Nothing was open under that id, so no turn end will clear it.
          if (!stopped) this.#callerStops.delete(operationId);
          return stopped;
        },
        (error: unknown) => {
          this.#callerStops.delete(operationId);
          throw error;
        }
      );
    void this.keepAliveWhile(() => stopping).catch((error: unknown) =>
      console.error("[Think] Stopping a turn failed", error)
    );
    return stopping;
  }

  /** Stop every turn, running or waiting; each ends `aborted`. */
  protected abortAllRequests(): void {
    this.#stopEveryTurn("stopped");
  }

  /**
   * Stop every turn, running or waiting, and keep the transcript. A
   * `clearMessages` resets the session as well.
   */
  protected resetTurnState(): void {
    this.#stopEveryTurn("cleared");
  }

  /**
   * A stop of every turn that is open now. The harness reads the open turns
   * once it is ready, so the turns this shell starts afterwards wait for the
   * stop first, as Think's synchronous reset cuts them off.
   */
  #stopping: Promise<unknown> = Promise.resolve();
  /** Counts the stops of every turn, so a turn waiting for one sees the next. */
  #stops = 0;
  /** What the latest stop does to a turn it cuts off before it starts. */
  #lastStop: "stopped" | "cleared" = "stopped";
  #stopEveryTurn(kind: "stopped" | "cleared"): void {
    this.#stops++;
    this.#lastStop = kind;
    const stopping =
      kind === "cleared"
        ? this.harness.abort(
            this.harness.session().id,
            undefined,
            SKIPPED_BY_RESET
          )
        : this.harness.session().abort();
    // A failed stop is reported, and does not fail the turns after it.
    this.#stopping = stopping.catch(() => {});
    void this.keepAliveWhile(() => stopping).catch((error: unknown) =>
      console.error("[Think] Stopping every turn failed", error)
    );
  }

  /**
   * Wait for the stop in progress, and say what cut a turn off before it
   * started, if anything: its caller's signal, or another stop that came
   * while it waited (that stop was meant for it too). As on Think, a reset
   * skips it as cleared, and `abortAllRequests` stops it.
   */
  async #cutOffByStop(
    signal: AbortSignal | undefined
  ): Promise<"stopped" | "cleared" | undefined> {
    if (signal?.aborted) return "stopped";
    const stops = this.#stops;
    await this.#stopping;
    if (this.#stops !== stops) return this.#lastStop;
    return signal?.aborted ? "stopped" : undefined;
  }

  async cancelAllChats(): Promise<void> {
    await this.harness.session().abort();
  }

  // ── Left over from Think's previous engine ────────────────────────

  // Scheduler jobs that the previous engine queued call these by name. The
  // turns they would have recovered are gone after the move, so each
  // completes without doing anything instead of failing on retry.
  /**
   * As on Think: how often an interrupted turn is attempted again. `true`
   * keeps the default budget.
   */
  chatRecovery: ChatRecoveryConfig = true;

  /**
   * As on Think: decide what an interrupted turn does. Return
   * `{ continue: false }` to give it up; the default continues it within
   * the `chatRecovery` budget.
   */
  protected async onChatRecovery(
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return {};
  }

  /**
   * As on Think: how long a model stream may send nothing before the turn
   * is treated as interrupted. `0`, the default, turns the watchdog off.
   */
  chatStreamStallTimeoutMs = 0;

  /** The running model call's own stall timeout, from `beforeTurn`. */
  #turnStallTimeoutMs: number | undefined;

  #recoveryOptions(): {
    maxAttempts?: number;
    stallTimeoutMs: number;
    chatRecovery?: Exclude<ChatRecoveryConfig, true>;
  } {
    const config = this.chatRecovery;
    const stallTimeoutMs =
      this.#turnStallTimeoutMs ?? this.chatStreamStallTimeoutMs;
    // Think's released config, as it is: the turn definition's recovery
    // budget honours its fields.
    const onExhausted = config === true ? undefined : config.onExhausted;
    // A give-up is announced, then the app is told, as on Think. The
    // definition names a turn by its run; an app knows it by its request
    // (the operation) id.
    const exhausted = (ctx: ChatRecoveryExhaustedContext) => {
      const event = withOperationIds(ctx);
      this._emit("chat:recovery:exhausted", event);
      return onExhausted?.(event);
    };
    if (config === true) {
      return { stallTimeoutMs, chatRecovery: { onExhausted: exhausted } };
    }
    const { shouldKeepRecovering } = config;
    return {
      ...(config.maxAttempts !== undefined && {
        maxAttempts: config.maxAttempts
      }),
      stallTimeoutMs,
      chatRecovery: {
        ...config,
        onExhausted: exhausted,
        ...(shouldKeepRecovering && {
          shouldKeepRecovering: (ctx) =>
            shouldKeepRecovering(withOperationIds(ctx))
        })
      }
    };
  }

  async #onRecovery(context: {
    readonly operationId: string;
    readonly attempt: number;
    readonly partial: UIMessage | undefined;
    readonly recoveryData?: unknown;
  }): Promise<"continue" | "abandon" | ChatRecoveryOptions> {
    // As on Think: a submission cut off by a reset whose turn started
    // longer ago than the stale window is not recovered. It ends `error`.
    // An attempt that already asked the model in this isolate is a live
    // retry (a stalled stream), which the window does not judge.
    if (this.#turnChannel?.operationId !== context.operationId) {
      const [running] = await this.harness.submissions(
        this.harness.session().id,
        { status: ["running"], limit: 1 }
      );
      if (
        running?.operationId === context.operationId &&
        Date.now() - (running.startedAt ?? running.createdAt) >
          (this.constructor as typeof Think).submissionRecoveryStaleMs
      ) {
        return "abandon";
      }
    }
    const parts = [...(context.partial?.parts ?? [])];
    const config = this.chatRecovery;
    const decision = await this.onChatRecovery({
      // One incident per operation: the harness attempts an operation
      // again until it is answered or given up.
      incidentId: context.operationId,
      recoveryRootRequestId: context.operationId,
      attempt: context.attempt,
      maxAttempts:
        config === true
          ? DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS
          : (config.maxAttempts ?? DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS),
      recoveryKind: parts.length > 0 ? "continue" : "retry",
      streamId: context.operationId,
      requestId: context.operationId,
      partialText: parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(""),
      partialParts: parts,
      recoveryData: context.recoveryData ?? null,
      messages: [...this.messages],
      // When the turn started, as Think gives it (not its time in the
      // queue), so an app can refuse stale work.
      createdAt: await this.#turnStartedAt(context.operationId)
    });
    // The app's answer goes to the turn definition as given: it drops the
    // partial for `persist: false`, as Think's recovery does.
    if (decision?.continue !== false && decision?.persist !== false) {
      return "continue";
    }
    return { continue: decision.continue, persist: decision.persist };
  }

  async #turnStartedAt(operationId: string): Promise<number> {
    const run = await this.harness.inspection(
      this.harness.session().id,
      operationId
    );
    return run?.startedAt ?? run?.createdAt ?? Date.now();
  }

  // A job think@0.24.0 queued to recover an incident: that recovery does
  // not run after the move, so the messenger reply held for it is
  // released as interrupted (the apology). TEMPORARY: remove in the next
  // minor.
  async _chatRecoveryRetry(data?: { incidentId?: string }): Promise<void> {
    await this.#releaseHeldReply(data);
  }
  async _chatRecoveryContinue(data?: { incidentId?: string }): Promise<void> {
    await this.#releaseHeldReply(data);
  }

  async #releaseHeldReply(data?: { incidentId?: string }): Promise<void> {
    if (typeof data?.incidentId !== "string") return;
    await this.#messengers?.releaseReleasedReply(
      data.incidentId,
      "interrupted"
    );
  }

  /**
   * TEMPORARY: remove in the next minor. Think's start step for the
   * recovered replies think@0.24.0 kept; the shell runs it at start.
   * @internal
   */
  async _replayMessengerRecoveryDeliveries(): Promise<void> {
    await this.#messengers?.importReleasedReplies();
  }

  /**
   * TEMPORARY: remove in the next minor. Release the reply held for a
   * think@0.24.0 recovery incident, as Think does.
   * @internal
   */
  async _releaseMessengerRecovery(
    incidentId: string,
    outcome: "completed" | "interrupted",
    text?: string
  ): Promise<void> {
    await this.#messengers?.releaseReleasedReply(incidentId, outcome, text);
  }
  async _cfRetryMessengerRecoveryDelivery(): Promise<void> {}

  // ── Harness wiring ────────────────────────────────────────────────

  async #beforeTurn(turn: ThinkTurnContext): Promise<ThinkTurnConfig | void> {
    // The turn's channel, from the stamp on its latest user message, as
    // Think resolves it for a new, continued or recovered turn.
    if (this.#turnChannel?.operationId !== turn.operationId) {
      // A context reminder the harness adds as a message of its own is not
      // the turn's user message.
      const history = turn.messages.filter(
        (message) => message.id !== CONTEXT_REMINDER_MESSAGE_ID
      );
      const web = this.#webRequests.delete(turn.operationId);
      const explicit = this.#explicitChannels.get(turn.operationId);
      this.#explicitChannels.delete(turn.operationId);
      const user = [...history].reverse().find((m) => m.role === "user");
      // As in Think: a browser's request runs on `web`; a continuation on
      // the channel the last turn ran on; anything else on its stamp. A
      // messenger's message is stamped once its turn starts.
      let channel =
        explicit ??
        (web
          ? "web"
          : ((turn.continuation ? this.#lastTurnChannel : undefined) ??
            channelFromMessages(history)));
      // A browser's new user message is stamped `web` here, as Think stamps
      // it at intake: the client's own write cannot carry the key, and the
      // harness writes the message when its turn starts.
      if (web && user) await this.#stamp(user.id, "web");
      const messenger =
        channel === undefined && user
          ? this.#messengers?.channelOf(user.id)
          : undefined;
      // As in Think, the turn's messenger context: kept on its user
      // message, or the webhook's, stamped with the channel.
      const webhook = user ? this.#messengers?.contextOf(user.id) : undefined;
      // A message's own context is trusted only on a messenger's channel,
      // which only the server stamps: a browser cannot claim a sender.
      const context = this.#trustedMessengerOf(user) ?? webhook;
      if (context) {
        this.#messengerContexts.set(turn.operationId, context);
        this.#responseContexts.set(turn.operationId, context);
      }
      if (messenger !== undefined && user) {
        channel = messenger;
        await this.#stamp(
          user.id,
          messenger,
          webhook && { messenger: webhook }
        );
      }
      const emit = this._emit as unknown as (
        type: string,
        payload: Record<string, unknown>
      ) => void;
      this.#turnChannel = {
        operationId: turn.operationId,
        channelId: channel,
        context: resolveChannelContext(channel, {
          registry: this.#channels,
          requestId: turn.operationId,
          messengerContext: () => context,
          emit: (event) => emit.call(this, event.type, event.payload)
        }),
        definition: channel ? this.#channels?.get(channel) : undefined
      };
    }
    const channel = this.#turnChannel.context
      ? this.#turnChannel.definition
      : undefined;
    // Every tool on offer, as Think's `beforeTurn` sees them, narrowed by
    // the channel's policy.
    const tools = channel?.tools ? channel.tools(turn.toolSet) : turn.toolSet;
    // Resolved only when read, as in Think: a `beforeTurn` that sets its
    // own model never needs the default's binding.
    // The step before this call ran its tools: it ends now, before this
    // call's hooks, as an AI SDK step ends before the next `prepareStep`.
    const reply = turn.messages.at(-1);
    // The step that just ended, whose usage the proactive guard reads.
    const lastUsage =
      turn.step > 0 ? this.#openSteps.get(turn.operationId)?.usage : undefined;
    if (turn.step > 0 && reply?.role === "assistant") {
      await this.#endStep(turn.operationId, reply);
    }
    const chosen = await this.getModel();
    // Resolved once per turn (and only when read), as in Think: a
    // `getGateway` that reads the turn's state picks one gateway for all
    // of the turn's model calls.
    const kept =
      this.#ownTurn?.operationId === turn.operationId
        ? this.#ownTurn
        : undefined;
    let resolved: LanguageModel | undefined = kept?.defaultModel;
    const resolveDefault = () => {
      resolved ??= this.resolveModel(chosen);
      if (this.#ownTurn?.operationId === turn.operationId) {
        this.#ownTurn.defaultModel = resolved;
      }
      return resolved;
    };
    const identity = this.#turnOf(turn.operationId);
    this.#running = {
      requestId: turn.operationId,
      trigger: identity.trigger,
      continuation: turn.continuation
    };
    // The first call of an operation says whether it continues a reply.
    if (!this.#continued.has(turn.operationId)) {
      this.#recordUnexecutedTools(tools);
      this.#continued.set(turn.operationId, turn.continuation);
      this.#clearsAtStart.set(turn.operationId, this.#clears);
    }
    // As in Think: the capability block for the turn's tools follows the
    // prompt, unless a `beforeTurn` gives its own.
    const prompt = turn.system ?? this.getSystemPrompt();
    // As in Think: the channel's instructions come before the prompt.
    const instructions =
      channel?.instructions && this.#turnChannel.context
        ? typeof channel.instructions === "function"
          ? await channel.instructions(this.#turnChannel.context)
          : channel.instructions
        : undefined;
    const base = instructions ? `${instructions}\n\n${prompt}` : prompt;
    const context = {
      system: systemPromptForTurn(base, tools),
      messages: await convertToModelMessages([...turn.messages], {
        tools,
        ignoreIncompleteToolCalls: true
      }),
      tools,
      get model() {
        return resolveDefault();
      },
      continuation: turn.continuation,
      requestId: turn.operationId,
      trigger: identity.trigger,
      abortSignal: turn.signal,
      ...(this.#messengerContexts.has(turn.operationId) && {
        messenger: this.#messengerContexts.get(turn.operationId)
      })
    };
    // As in Think, `beforeTurn` runs once per turn; the harness asks
    // before every model call, and later calls reuse what it returned.
    const first = this.#ownTurn?.operationId !== turn.operationId;
    const own = first
      ? await this.beforeTurn(context)
      : (this.#ownTurn?.own ?? undefined);
    if (first) {
      this.#ownTurn = {
        operationId: turn.operationId,
        own,
        ...(resolved && { defaultModel: resolved })
      };
    }
    // As on Think: a turn may set its own stall timeout. The harness asks
    // before every model call and reads `recovery` right after.
    this.#turnStallTimeoutMs = own?.chatStreamStallTimeoutMs;
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
    // A channel's `maxTurns` is a default a `beforeTurn` may override.
    this.#turnMaxSteps = config.maxSteps ?? channel?.maxTurns;
    // The model stays lazy, as in Think: spreading `context` would read
    // its `model` getter and resolve the default.
    const turnModel = config.model;
    let grantModel: LanguageModel | undefined;
    const self = this;
    await this.#authorizeTurn(
      turn.operationId,
      async () =>
        ({
          system: config.system ?? context.system,
          messages: config.messages ?? context.messages,
          tools: context.tools,
          // Resolved once, when first read.
          get model() {
            return (grantModel ??=
              turnModel !== undefined
                ? self.resolveModel(turnModel)
                : resolveDefault());
          },
          continuation: context.continuation,
          requestId: context.requestId,
          // As in Think: the grant sees what started the turn, and its
          // signal, so it can stop its own I/O when the turn stops.
          trigger: context.trigger,
          abortSignal: context.abortSignal
        }) as unknown as TurnContext
    );
    if (this.#ownTurn?.operationId === turn.operationId) {
      this.#ownTurn.stopWhen = config.stopWhen;
    }
    // Then `beforeStep`, before each model call, as the AI SDK's
    // `prepareStep` runs in Think. Its fields win for this call.
    // A `beforeTurn` that rewrote the messages rewrote them for the whole
    // turn, as Think's base prompt: a later call sends them with what this
    // turn's reply added since.
    if (first && config.messages && this.#ownTurn) {
      this.#ownTurn.messages = config.messages;
      // A continued reply's parts so far are in the rewritten prompt's
      // source already: a later call adds only what this turn adds.
      const continued = turn.messages.at(-1);
      this.#ownTurn.replyParts =
        turn.continuation && continued?.role === "assistant"
          ? continued.parts.length
          : 0;
    }
    const compacted = await this.#compactBeforeStep(turn, lastUsage, tools);
    const rewritten = this.#ownTurn?.messages;
    // This turn's reply, and what follows it (a context reminder), as the
    // harness projects them for this call.
    let replyAt = turn.messages.length - 1;
    while (replyAt >= 0 && turn.messages[replyAt].role !== "assistant") {
      replyAt--;
    }
    const ownReply = replyAt >= 0 ? turn.messages[replyAt] : undefined;
    const added =
      ownReply && !first
        ? [
            {
              ...ownReply,
              parts: ownReply.parts.slice(this.#ownTurn?.replyParts ?? 0)
            },
            ...turn.messages.slice(replyAt + 1)
          ].filter((m) => m.parts.length > 0)
        : [];
    const turnMessages = compacted
      ? compacted
      : rewritten === undefined
        ? undefined
        : added.length === 0
          ? rewritten
          : [
              ...rewritten,
              ...(await convertToModelMessages(added, {
                tools,
                ignoreIncompleteToolCalls: true
              }))
            ];
    const step: StepFields = isMethodOverridden(this, "beforeStep")
      ? (((await this.beforeStep({
          stepNumber: turn.step,
          steps: previousSteps(turn),
          get model() {
            return config.model !== undefined
              ? self.resolveModel(config.model)
              : resolveDefault();
          },
          messages: turnMessages ?? context.messages,
          experimental_context: undefined
        } as unknown as PrepareStepContext)) ?? {}) as StepFields)
      : {};
    const stepSystem = systemText(step.instructions ?? step.system);
    const system =
      stepSystem ??
      config.instructions ??
      config.system ??
      systemPromptForTurn(
        base,
        config.tools ? { ...tools, ...config.tools } : tools
      );
    const model = step.model ?? config.model;
    // Without an override, the turn's one resolution of the default.
    // As in Think, the model the grant was given is the one the call uses,
    // unless a step changed it: a string override is resolved once.
    const sent =
      model === undefined
        ? resolveDefault()
        : model === turnModel
          ? (grantModel ??= this.resolveModel(model))
          : this.resolveModel(model);
    const messages = step.messages ?? turnMessages;
    // A narrowing channel limits the tools the model is offered.
    // A narrowing channel limits the tools the model is offered, and a
    // selection cannot bring back a tool it removed.
    const selected = step.activeTools ?? config.activeTools;
    const chosenTools = channel?.tools
      ? (selected ?? Object.keys(tools)).filter((name) => name in tools)
      : selected;
    // A workflow turn that asked for structured output ends by calling the
    // final-answer tool, as in Think: the prompt says so, and a tool call
    // is required.
    const final =
      this.#finalAnswer?.operationId === turn.operationId
        ? this.#finalAnswer
        : undefined;
    // As in Think: with tools of its own the turn must call one each step,
    // else the final-answer tool; and on its last permitted step, that one.
    const lastStep =
      final !== undefined &&
      step.toolChoice === undefined &&
      turn.step >= (config.maxSteps ?? this.maxSteps) - 1;
    const pinned = final && { type: "tool" as const, toolName: final.name };
    const toolChoice = lastStep
      ? pinned
      : (step.toolChoice ??
        config.toolChoice ??
        (final
          ? Object.keys(tools).some((name) => name !== final.name)
            ? "required"
            : pinned
          : undefined));
    // A turn that names its active tools keeps the final-answer tool on.
    const activeTools =
      final && lastStep
        ? [final.name]
        : final && chosenTools
          ? [...chosenTools, final.name]
          : chosenTools;
    const callSettings = defined({
      topP: config.topP,
      topK: config.topK,
      presencePenalty: config.presencePenalty,
      frequencyPenalty: config.frequencyPenalty,
      stopSequences: config.stopSequences,
      seed: config.seed,
      maxRetries: config.maxRetries,
      headers: config.headers,
      experimental_transform: config.experimental_transform,
      experimental_repairToolCall: config.repairToolCall
    });
    // As in Think: recorded once the turn is prepared, so a continuation
    // never extends a turn whose preparation threw.
    if (first) this.#lastTurnChannel = this.#turnChannel.channelId;
    const writer = config.messageMetadata ?? this.messageMetadata;
    // Whether the turn continues a reply, as Think tells the writer: the
    // turn's own value, from its first call, not each call's.
    if (first && this.#ownTurn) {
      this.#ownTurn.continuation = turn.continuation;
    }
    const turnContinuation = this.#ownTurn?.continuation ?? turn.continuation;
    const lastAllowed = turn.step >= (config.maxSteps ?? this.maxSteps) - 1;
    const endsTurn = (part: unknown) =>
      lastAllowed ||
      (part as { finishReason?: string }).finishReason !== "tool-calls";
    const sentSystem =
      final && typeof system === "string"
        ? [system, thinkFinalAnswerInstruction(final.name)]
            .filter(Boolean)
            .join("\n\n")
        : system;
    return {
      model: sent,
      ...(typeof sentSystem === "string" && { system: sentSystem }),
      ...(messages && { messages }),
      ...(activeTools && { activeTools: [...activeTools] }),
      ...(toolChoice !== undefined && {
        // SAFETY: Think's and the harness's tool choice are the AI SDK's.
        toolChoice: toolChoice as ThinkTurnConfig["toolChoice"]
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
      }),
      // The rest of Think's call settings, as `streamText` takes them.
      ...(Object.keys(callSettings).length > 0 && { callSettings }),
      ...(config.output !== undefined && { output: config.output }),
      sendReasoning: config.sendReasoning ?? this.sendReasoning,
      // As in Think: the turn's writer, else the agent's, told whether the
      // turn continues a reply.
      ...(writer && {
        messageMetadata: ({ part }: { readonly part: unknown }) => {
          // As Think's one stream for the whole turn: the writer hears the
          // turn's start once, on its first call, and its finish once, on
          // the call that ends it (not a tool round's).
          const kind = (part as { type?: string }).type;
          if (kind === "start" && turn.step > 0) return undefined;
          if (kind === "finish" && !endsTurn(part)) return undefined;
          return writer({
            // SAFETY: the parts are the AI SDK's stream parts.
            part: part as Parameters<MessageMetadataCallback>[0]["part"],
            continuation: turnContinuation
          });
        }
      })
    } as ThinkTurnConfig;
  }

  /** Stamp `channel` on stored user message `id`, unless it has one. */
  async #stamp(
    id: string,
    channel: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const handle = await this.#rootHandle();
    const stored = await handle.getMessage(id);
    if (!stored || stored.role !== "user") return;
    if (channelFromMessages([stored as UIMessage]) !== undefined) return;
    const [stamped] = stampTurnContext(
      [
        extra
          ? {
              ...(stored as UIMessage),
              metadata: {
                ...(stored.metadata as Record<string, unknown> | undefined),
                ...extra
              }
            }
          : (stored as UIMessage)
      ],
      channel
    );
    await handle.updateMessage(stamped as SessionMessage);
  }

  /** The input a human approved for a call, from the latest reply. */
  async #approvedInput(
    toolCallId: string
  ): Promise<{ found: false } | { found: true; input: unknown }> {
    const leaf = await (await this.#rootHandle()).getLatestLeaf();
    for (const part of leaf?.parts ?? []) {
      const record = part as {
        toolCallId?: unknown;
        input?: unknown;
        approval?: { approved?: unknown };
      };
      if (
        record.toolCallId === toolCallId &&
        record.approval?.approved === true
      ) {
        return { found: true, input: record.input };
      }
    }
    return { found: false };
  }

  async #beforeToolCall(call: {
    readonly operationId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  }): Promise<ThinkToolCallDecision | void> {
    // `afterToolCall` sees the input the model gave, as in Think, even when
    // the call runs with one `beforeToolCall` substituted.
    const kept = {
      operationId: call.operationId,
      input: call.input,
      started: Date.now()
    };
    this.#modelInputs.set(call.toolCallId, kept);
    let decision: ToolCallDecision | void;
    try {
      decision = await this.beforeToolCall({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        input: call.input,
        stepNumber: 0,
        messages: [],
        requestId: call.operationId
      } as unknown as ToolCallContext);
    } catch (error) {
      // As a throwing `execute`: the call settles as a tool error, with
      // the error as the AI SDK words it in Think.
      return { action: "block", reason: String(error) };
    }
    // The call's time starts once it is decided.
    kept.started = Date.now();
    if (!decision) return;
    switch (decision.action) {
      case "block":
        // As in Think, a blocked call answers the model with the reason.
        return {
          action: "substitute",
          output:
            decision.reason ??
            `Tool "${call.toolName}" was blocked by beforeToolCall.`
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

  /**
   * As in Think: with `contextOverflow.reactive`, an overflowing call
   * compacts the session and the turn runs again, `beforeTurn` included.
   * Without it, or when compaction can't shorten the history, the
   * overflow ends the turn.
   */
  async #onContextOverflow(
    operationId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    // If the turn ends on it, its caller hears an overflow.
    this.#overflowed.add(operationId);
    // A stopped turn is not compacted, nor run again.
    if (!this.contextOverflow?.reactive || signal.aborted) return false;
    let shortened = false;
    try {
      shortened = Boolean(await this.session.compact());
    } catch (error) {
      console.warn(
        `[Think] context-overflow compaction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this._emit("chat:context:compacted", {
      reason: "reactive",
      shortened,
      requestId: operationId,
      attempt: 1
    });
    // Stopped while it compacted: the turn ends.
    if (signal.aborted) return false;
    if (shortened && this.#ownTurn?.operationId === operationId) {
      // The retry is the same turn run again: its hooks run again.
      this.#ownTurn = undefined;
      this.#extensionTurn = undefined;
    }
    return shortened;
  }

  /**
   * Think's proactive guard (`contextOverflow.proactive`): when the step
   * before reported input tokens past the budget, compact the session and
   * send this call the compacted history with the turn's reply so far.
   * Best-effort: on any failure the call goes on unchanged.
   */
  async #compactBeforeStep(
    turn: ThinkTurnContext,
    usage: LanguageModelUsage | undefined,
    tools: ToolSet
  ): Promise<ModelMessage[] | undefined> {
    const guard = this.contextOverflow?.proactive;
    const own = this.#ownTurn;
    if (!guard || guard.maxInputTokens <= 0) return undefined;
    if (own?.operationId !== turn.operationId) return undefined;
    // The turn's reply, and what the harness projects after it for this
    // call (the context reminder), found by role, not position.
    let replyAt = turn.messages.length - 1;
    while (replyAt >= 0 && turn.messages[replyAt].role !== "assistant") {
      replyAt--;
    }
    const reply = replyAt >= 0 ? turn.messages[replyAt] : undefined;
    const after = turn.messages.slice(replyAt + 1);
    // The compacted history, then the live reply (never a stored copy of
    // it under the same id) and the call's projection after it.
    const withLive = async (head: UIMessage[]) =>
      convertToModelMessages(
        [
          ...head.filter((m) => m.id !== reply?.id),
          ...(reply ? [reply] : []),
          ...after
        ],
        { tools, ignoreIncompleteToolCalls: true }
      );
    // Once compacted, every later call of the turn sends the compacted
    // history: the harness's own transcript for the turn predates it.
    const compactedHead = own.compactedHead;
    const tried = own.proactive ?? 0;
    const used = usage?.inputTokens ?? usage?.totalTokens;
    const due =
      tried < Math.max(1, guard.maxCompactions ?? 1) &&
      used != null &&
      Number.isFinite(used) &&
      used >= guard.maxInputTokens * (guard.headroom ?? 0.9);
    if (!due) return compactedHead ? withLive(compactedHead) : undefined;
    try {
      // The attempt counts, so a no-op compaction isn't tried every step.
      own.proactive = tried + 1;
      // The branch the turn answers, not the session's active one (a
      // regenerate answers an earlier message).
      // The turn's leaf before its reply: its question, or the last message
      // a programmatic input supplied (an assistant's too).
      const question =
        replyAt > 0
          ? turn.messages[replyAt - 1]?.id
          : turn.messages[turn.messages.length - 1]?.id;
      const shortened = Boolean(await this.session.compact(question));
      this._emit("chat:context:compacted", {
        reason: "proactive",
        shortened
      });
      if (!shortened) {
        return compactedHead ? withLive(compactedHead) : undefined;
      }
      const head = (await this.session.getHistory(question)) as UIMessage[];
      own.compactedHead = head;
      return await withLive(head);
    } catch (error) {
      console.warn(
        `[Think] proactive context compaction failed; proceeding without it: ${error instanceof Error ? error.message : String(error)}`
      );
      return compactedHead ? withLive(compactedHead) : undefined;
    }
  }

  /**
   * As in Think, a turn's `stopWhen` beside its `maxSteps`: once a step
   * meets a condition, the turn ends after that step's tools ran.
   */
  async #checkStopWhen(
    operationId: string,
    step: number,
    message: UIMessage,
    segment: number
  ): Promise<void> {
    const own = this.#ownTurn;
    if (own?.operationId !== operationId || !own.stopWhen) return;
    const conditions = Array.isArray(own.stopWhen)
      ? own.stopWhen
      : [own.stopWhen];
    const steps: ReturnType<typeof stepResultOf>[] = [];
    for (let at = segment - step; at <= segment; at++) {
      steps.push(stepResultOf(message, at));
    }
    // SAFETY: a condition reads the steps' calls and results, as here.
    const met = await Promise.all(
      conditions.map((condition) =>
        condition({ steps } as unknown as Parameters<typeof condition>[0])
      )
    );
    if (met.some(Boolean)) this.#turnMaxSteps = step + 1;
  }

  #classify(error: unknown, operationId?: string): ThinkErrorClass {
    // As in Think: the app's classifier wins, hearing the turn it
    // classifies for; without a verdict from it, what the provider's
    // error says.
    let classification: ChatErrorClassification | void = undefined;
    if (isMethodOverridden(this, "classifyChatError")) {
      try {
        classification = this.classifyChatError(error, {
          ...(operationId !== undefined && { requestId: operationId }),
          stage: "stream"
        });
      } catch (err) {
        console.warn(
          `[Think] classifyChatError threw; treating as unclassified: ${err instanceof Error ? err.message : String(err)}`
        );
        return "fail";
      }
    }
    const appSaid = classification !== undefined;
    classification ??= classifyProviderError(error);
    if (classification === "context_overflow") return "context-overflow";
    // As on Think: a transient or rate-limited error is tried again within
    // chatRecovery's budget. An app's own classification wins; without one,
    // a platform transient (a lost connection) is tried again too.
    if (appSaid) {
      return classification === "transient" || classification === "rate_limit"
        ? "retry"
        : "fail";
    }
    return isPlatformTransientError(error) ? "retry" : "fail";
  }

  /**
   * Operations a context overflow ended, until their caller is told, so
   * it hears the error as an overflow, as on Think. One entry per running
   * operation at most, deleted when reported or at the turn's end.
   */
  readonly #overflowed = new Set<string>();

  /** The root session's Sessions handle, which the harness hands over on first use. */
  async #rootHandle(): Promise<Session> {
    if (!this.#handle) await this.harness.session().messages();
    if (!this.#handle)
      throw new Error("The harness did not configure the root session");
    return this.#handle;
  }

  /**
   * Run one media-eviction pass queued on the Agent queue, by a sub-agent
   * facet, as on Think.
   * @internal Queue callback.
   */
  async _cfEvictAgedMedia(): Promise<void> {
    await this.#mediaEviction.run();
  }

  async #sync(): Promise<void> {
    await this.#transcript.sync();
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
      // As in Think: a browser's chat request runs on the `web` channel.
      const request = chatRequestId(message);
      if (request !== undefined) this.#webRequests.add(request);
      for (const handlers of this.#handlers) {
        if ((await handlers.onMessage?.(connection, message)) === true) {
          // A request that started nothing (refused, or a resend of one
          // that ended) is forgotten now; one that runs, when it settles.
          if (
            request !== undefined &&
            !(await this.harness.inspection(this.harness.session().id, request))
          ) {
            this.#webRequests.delete(request);
          }
          return;
        }
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
      const handled =
        (await this.#chat.onRequest({ request })) ??
        (await this.#messengers?.receive(request));
      return handled ?? onRequest(request);
    };
  }
  // ── As an agent tool ────────────────────────────────────────────────
  // A parent runs this agent as a tool through these methods. The run is
  // one operation of the root session, `agent-tool:<runId>`, so every
  // attempt of its turn (a reset replays it) stays that run.

  /** The message an agent-tool run's input becomes. */
  protected formatAgentToolInput(input: unknown): UIMessage {
    const text =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  /** A completed agent-tool run's output. Default: none. */
  protected getAgentToolOutput(_runId: string): unknown {
    return undefined;
  }

  /** A completed agent-tool run's summary. Default: its reply's text. */
  protected getAgentToolSummary(runId: string, output: unknown): string {
    const text = this.#agentToolReplyText.get(runId);
    if (text) return text;
    if (typeof output === "string") return output;
    if (output !== undefined) {
      try {
        return JSON.stringify(output);
      } catch {
        return String(output);
      }
    }
    return "";
  }

  /** The text of a completed agent-tool run's reply, while its result is made. */
  readonly #agentToolReplyText = new Map<string, string>();

  async startAgentToolRun(
    input: unknown,
    options: {
      runId: string;
      signal?: AbortSignal;
      eventDelivery?: "full" | "terminal";
    }
  ): Promise<AgentToolRunInspection> {
    const session = this.harness.session();
    const operationId = agentToolOperationId(options.runId);
    // A start of a run this agent has returns it.
    if (!(await this.harness.inspection(session.id, operationId))) {
      // A parent that stopped before the run started starts nothing.
      if (options.signal?.aborted) {
        return {
          runId: options.runId,
          status: "aborted",
          startedAt: Date.now(),
          error: abortText(options.signal.reason) ?? "cancelled"
        };
      }
      await this.#sync();
      this.#turns.set(operationId, { trigger: "agent-tool" });
      await session.submit([this.formatAgentToolInput(input)], {
        operationId,
        metadata: {
          agentTool: {
            runId: options.runId,
            startMessageId: this.messages.at(-1)?.id ?? null,
            ...(options.eventDelivery === "terminal" && {
              terminalOnly: true
            })
          }
        }
      });
    }
    // A parent that stops while the run waits or runs cancels it.
    options.signal?.addEventListener(
      "abort",
      () => void this.cancelAgentToolRun(options.runId, options.signal?.reason),
      { once: true }
    );
    // SAFETY: submitted above, or there already.
    return (await this.inspectAgentToolRun(
      options.runId
    )) as AgentToolRunInspection;
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    await this.harness.abort(
      this.harness.session().id,
      agentToolOperationId(runId),
      abortText(reason)
    );
  }

  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    const session = this.harness.session().id;
    const operationId = agentToolOperationId(runId);
    const status = await this.harness.inspection(session, operationId);
    if (!status) return null;
    const base = {
      runId,
      requestId: operationId,
      startedAt: status.startedAt ?? status.createdAt,
      ...(status.settledAt !== undefined && {
        completedAt: status.settledAt
      })
    };
    if (status.status === "queued" || status.status === "running") {
      return { ...base, status: "running" };
    }
    if (status.status === "done") {
      return {
        ...base,
        status: "completed",
        ...this.#agentToolResult(session, operationId, runId, status)
      };
    }
    // A turn reset skips the run, as on Think: an error, not a cancel.
    if (status.abortReason === SKIPPED_BY_RESET) {
      return {
        ...base,
        status: "error",
        error: "Agent tool run was skipped before the child could finish."
      };
    }
    const reason = status.status === "unanswered" ? status.reason : undefined;
    if (
      status.abortReason !== undefined ||
      reason === "aborted" ||
      reason === "withdrawn"
    ) {
      return {
        ...base,
        status: "aborted",
        ...(status.abortReason !== undefined && { error: status.abortReason })
      };
    }
    return {
      ...base,
      status: "error",
      error: reason ?? "Agent tool run failed"
    };
  }

  /**
   * A completed run's output and summary, made once from its reply and
   * kept on the operation, so a later read returns the same result.
   */
  #agentToolResult(
    session: string,
    operationId: string,
    runId: string,
    status: { metadata?: Record<string, unknown>; messageId?: string }
  ): { output?: unknown; summary: string } {
    const kept = (
      status.metadata?.agentTool as
        | { result?: { output?: unknown; summary: string } }
        | undefined
    )?.result;
    if (kept) return kept;
    const reply = status.messageId
      ? this.messages.find((message) => message.id === status.messageId)
      : undefined;
    const text = reply?.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    if (text) this.#agentToolReplyText.set(runId, text);
    try {
      const output = this.getAgentToolOutput(runId);
      const result = {
        ...(output !== undefined && { output }),
        summary: this.getAgentToolSummary(runId, output)
      };
      this.harness.patchOperationMetadata(session, operationId, "agentTool", {
        result: result as TaskJson
      });
      return result;
    } finally {
      this.#agentToolReplyText.delete(runId);
    }
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    const all = await this.#agentToolChunks(runId, options?.afterSequence);
    // One page per call, as the adapter's contract says: at most
    // REPLAY_PAGE_BYTES of bodies, at least one chunk.
    const page: AgentToolStoredChunk[] = [];
    let bytes = 0;
    for (const chunk of all) {
      const size = utf8Length(chunk.body);
      if (page.length > 0 && bytes + size > REPLAY_PAGE_BYTES) break;
      page.push(chunk);
      bytes += size;
    }
    return page;
  }

  /** Every chunk of the run after `afterSequence`, numbered from 0. */
  async #agentToolChunks(
    runId: string,
    afterSequence = -1
  ): Promise<AgentToolStoredChunk[]> {
    const session = this.harness.session().id;
    const operationId = agentToolOperationId(runId);
    const stored = await this.harness.operationChunks(session, operationId);
    // Numbered by stream position: what recovery discarded is left out, and
    // the rest keep their places.
    let first = stored.first;
    let chunks = stored.chunks;
    if (chunks.length === 0 && first === 0) {
      // Settled: the reply is stored and its stream gone. A replay from the
      // start gets the reply; a reader with a position saw it live.
      if (afterSequence >= 0) return [];
      const status = await this.harness.inspection(session, operationId);
      const messageId =
        status?.status === "done" ? status.messageId : undefined;
      const message = messageId
        ? this.messages.find((candidate) => candidate.id === messageId)
        : undefined;
      chunks = message ? chunksOfMessage(message) : [];
    }
    return chunks
      .map((chunk, at) => ({
        sequence: first + at,
        body: JSON.stringify(chunk)
      }))
      .filter((chunk) => chunk.sequence > afterSequence);
  }

  /**
   * Follow the run: its chunks after `afterSequence`, then each chunk its
   * reply streams, as newline-delimited JSON, until the run ends or
   * `signal` aborts. It waits on the harness's events for the operation,
   * never in a loop. Cancelling the stream only detaches.
   */
  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    const session = this.harness.session().id;
    const operationId = agentToolOperationId(runId);
    const after = options?.afterSequence ?? -1;
    const encoder = new TextEncoder();
    const line = (chunk: AgentToolStoredChunk) =>
      encoder.encode(`${JSON.stringify(chunk)}\n`);
    const open = (status: { status: string } | undefined) =>
      status?.status === "queued" || status?.status === "running";
    const status = await this.harness.inspection(session, operationId);
    if (!open(status)) {
      // Settled: what a read returns, then the end.
      const chunks = await this.#agentToolChunks(runId, after);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(line(chunk));
          controller.close();
        }
      });
    }
    let follow: { stop(): void } | undefined;
    let ended = false;
    const signal = options?.signal;
    let onAbort: (() => void) | undefined;
    const end = () => {
      if (ended) return;
      ended = true;
      follow?.stop();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let next = 0;
        const close = () => {
          if (ended) return;
          end();
          controller.close();
        };
        const emit = (chunk: UIMessageChunk) => {
          const sequence = next++;
          if (sequence > after) {
            controller.enqueue(line({ sequence, body: JSON.stringify(chunk) }));
          }
        };
        const followed = this.harness.followOperation(
          session,
          operationId,
          (event) => {
            if (ended) return;
            if (event.type === "chunk") emit(event.chunk);
            else close();
          }
        );
        follow = followed;
        // Positions recovery discarded are skipped, not renumbered.
        next = followed.first;
        for (const chunk of followed.chunks) emit(chunk);
        onAbort = close;
        if (signal?.aborted) return close();
        signal?.addEventListener("abort", onAbort, { once: true });
        // It may have ended between the read above and the subscription.
        void this.harness.inspection(session, operationId).then((now) => {
          if (!open(now)) close();
        });
      },
      cancel: () => end()
    });
  }
}

/** A run id (`["", operationId]`) as the operation id it names. */
function operationIdOf(id: string): string {
  if (!id.startsWith("[")) return id;
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) && typeof parsed[1] === "string"
      ? parsed[1]
      : id;
  } catch {
    return id;
  }
}

/**
 * A recovery context with its ids as the operation ids an app knows, the
 * ones `onChatRecovery` is given: one incident id across every hook.
 */
function withOperationIds<
  T extends {
    requestId: string;
    recoveryRootRequestId: string;
    incidentId?: string;
    streamId?: string;
  }
>(ctx: T): T {
  return {
    ...ctx,
    requestId: operationIdOf(ctx.requestId),
    recoveryRootRequestId: operationIdOf(ctx.recoveryRootRequestId),
    // The definition derives both from the run id in its own formats
    // (`<run>:`, `chat-turn:<run>`); an app is given the operation id for
    // each, as `onChatRecovery` gives them.
    ...(ctx.incidentId !== undefined && {
      incidentId: operationIdOf(ctx.requestId)
    }),
    ...(ctx.streamId !== undefined && {
      streamId: operationIdOf(ctx.requestId)
    })
  };
}

/** Whether an operation's status says it was stopped (not failed). */
function stoppedStatus(status: { status: string; reason?: string }): boolean {
  return (
    status.status === "unanswered" &&
    (status.reason === "aborted" || status.reason === "withdrawn")
  );
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

/** The operation an agent-tool run is. */
function agentToolOperationId(runId: string): string {
  return `agent-tool:${runId}`;
}

/** A cancel's reason as text, or `undefined` when none was given. */
function abortText(reason: unknown): string | undefined {
  if (reason instanceof Error) return reason.message;
  return reason === undefined || reason === null ? undefined : String(reason);
}

/** A step that ended, waiting for its tools when it called any. */
type OpenStep = {
  readonly operationId: string;
  readonly step: number;
  readonly finishReason: string | undefined;
  /** Which of the reply's steps it is, counted by `step-start` parts. */
  readonly segment: number;
  /** The step's token usage, when the provider gave it. */
  readonly usage?: LanguageModelUsage;
};

/** The fields of a `StepConfig` the harness-backed Think applies. */
type StepFields = {
  readonly model?: ThinkModel;
  readonly instructions?: unknown;
  readonly system?: unknown;
  readonly messages?: TurnConfig["messages"];
  readonly activeTools?: readonly string[];
  readonly toolChoice?: unknown;
};

/**
 * The steps an operation's model calls made before this one, in the AI
 * SDK's step terms, from the reply they are on: the last message, when
 * this is not the first call.
 */
function previousSteps(turn: ThinkTurnContext) {
  const reply = turn.messages.at(-1);
  if (turn.step === 0 || reply?.role !== "assistant") return [];
  const segments = stepSegments(reply);
  const steps = [];
  for (let segment = segments - turn.step + 1; segment <= segments; segment++) {
    steps.push(stepResultOf(reply, segment));
  }
  return steps;
}

/** How many steps a reply has, by its `step-start` parts. */
function stepSegments(message: UIMessage): number {
  return message.parts.filter((part) => part.type === "step-start").length;
}

/**
 * What one step of the reply says (the `segment`-th, by `step-start`
 * parts), in the AI SDK's step terms: its text, reasoning, the tool calls
 * it made and the results it has.
 */
function stepResultOf(message: UIMessage, segment: number) {
  const parts: UIMessage["parts"] = [];
  let seen = 0;
  for (const part of message.parts) {
    if (part.type === "step-start") {
      seen += 1;
      continue;
    }
    // A reply without step parts is one step.
    if (seen === segment || (segment === 0 && seen === 0)) parts.push(part);
  }
  const toolCalls: unknown[] = [];
  const toolResults: unknown[] = [];
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    const toolName = getToolName(part);
    toolCalls.push({
      type: "tool-call",
      toolCallId: part.toolCallId,
      toolName,
      input: part.input
    });
    if (part.state === "output-available") {
      toolResults.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName,
        input: part.input,
        output: part.output
      });
    }
  }
  return {
    text: parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    reasoningText:
      parts
        .map((part) => (part.type === "reasoning" ? part.text : ""))
        .join("") || undefined,
    toolCalls,
    toolResults
  };
}

/**
 * A step's `instructions` or `system` as text: a string, or the text of
 * the system messages the AI SDK also takes there.
 */
function systemText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const messages = Array.isArray(value) ? value : value ? [value] : [];
  const texts = messages.flatMap((message: unknown) => {
    const content = (message as { content?: unknown } | null)?.content;
    return typeof content === "string" ? [content] : [];
  });
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/**
 * A UI chunk as the AI SDK's stream has it in Think's `onChunk`: a tool's
 * output is a `tool-result` (or `tool-error`) part, a delta carries its
 * `text`. Other chunks pass as they are.
 */
function streamPartOf(
  chunk: UIMessageChunk,
  calls: Map<string, { toolName: string; input: unknown }>,
  stored: (
    toolCallId: string
  ) => { toolName: string; input: unknown } | undefined
): unknown {
  const named = (toolCallId: string) =>
    calls.get(toolCallId) ?? stored(toolCallId);
  switch (chunk.type) {
    case "tool-input-error":
      // The AI SDK reports a call it couldn't parse as an invalid call.
      calls.set(chunk.toolCallId, {
        toolName: chunk.toolName,
        input: chunk.input
      });
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
        invalid: true,
        error: chunk.errorText,
        ...(chunk.providerExecuted && { providerExecuted: true }),
        ...(chunk.dynamic && { dynamic: true })
      };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        id: chunk.toolCallId,
        toolName: chunk.toolName
      };
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        id: chunk.toolCallId,
        delta: chunk.inputTextDelta
      };
    case "tool-input-available": {
      // The call, as the AI SDK's stream has it; its result names it again.
      calls.set(chunk.toolCallId, {
        toolName: chunk.toolName,
        input: chunk.input
      });
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
        ...(chunk.providerExecuted && { providerExecuted: true }),
        ...(chunk.dynamic && { dynamic: true })
      };
    }
    case "tool-output-available":
      return {
        type: "tool-result",
        toolCallId: chunk.toolCallId,
        ...named(chunk.toolCallId),
        output: chunk.output,
        ...(chunk.preliminary && { preliminary: true })
      };
    case "tool-output-error":
      return {
        type: "tool-error",
        toolCallId: chunk.toolCallId,
        ...named(chunk.toolCallId),
        error: chunk.errorText
      };
    default:
      return "delta" in chunk ? { ...chunk, text: chunk.delta } : chunk;
  }
}

/** `fields` without its undefined ones. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/** The fields `folded` set or changed relative to `own`. */
function changesOf(own: TurnConfig, folded: TurnConfig): TurnConfig {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(folded)) {
    if ((own as Record<string, unknown>)[key] !== value) changes[key] = value;
  }
  // SAFETY: every key is one of `folded`'s, a TurnConfig's.
  return changes as TurnConfig;
}

// The approval methods are client-callable, as on Think.
for (const method of [
  Think.prototype.pendingApprovals,
  Think.prototype.approveExecution,
  Think.prototype.rejectExecution
]) {
  callable()(method, undefined as unknown as ClassMethodDecoratorContext);
}

/** The id of a browser's chat request, if `message` is one. */
function chatRequestId(message: WSMessage): string | undefined {
  if (typeof message !== "string") return undefined;
  try {
    const parsed = JSON.parse(message) as { type?: unknown; id?: unknown };
    return parsed.type === "cf_agent_use_chat_request" &&
      typeof parsed.id === "string"
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
}

/** The messenger context a user message keeps, if any. */
function messengerOf(
  message: UIMessage | undefined
): MessengerContext | undefined {
  const messenger = (message?.metadata as { messenger?: unknown } | undefined)
    ?.messenger;
  return messenger && typeof messenger === "object"
    ? (messenger as MessengerContext)
    : undefined;
}
