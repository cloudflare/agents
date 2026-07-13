import { AbortedError, NotFoundError, ValidationError, toErrorValue, type ErrorValue } from "../kernel/errors.js";
import { scoped } from "../ports/storage.js";
import type { Connection } from "../ports/transport.js";
import type { ModelChunk, ModelClient, ModelMessage } from "../ports/model.js";
import type { FetchLike } from "../ports/http.js";

import { Agent, type AgentHost } from "./agent.js";

import { createTurnQueue, type TurnQueue } from "../domain/turn/admission.js";
import {
  createTurnEngine,
  type StepConfig,
  type StepResult,
  type TurnConfig,
  type TurnContext,
  type TurnEngine,
  type TurnHooks,
  type TurnOutcome,
} from "../domain/turn/loop.js";
import {
  assistantMessage,
  isToolPart,
  toolName,
  userMessage,
  type ChatMessage,
  type MessagePart,
  type ToolPart,
} from "../domain/messages/model.js";
import { repairTranscript } from "../domain/messages/repair.js";
import { createAccumulator, type UiChunk } from "../domain/stream/chunks.js";
import { createResumableStreamBuffer, type ResumableStreamBuffer } from "../domain/stream/resumable.js";
import {
  assembleTools,
  type AfterToolCallContext,
  type AssembledTools,
  type BeforeToolCallContext,
  type ToolCallDecision,
  type ToolHooks,
  type ToolSources,
} from "../domain/tools/registry.js";
import type { Tool, ToolExecutionContext, ToolSet } from "../domain/tools/types.js";
import {
  createSession,
  type ContextProviderLike,
  type ContextBlockConfig,
  type Session,
  type SessionConfig,
  type SessionStatus,
} from "../domain/session/session.js";
import type { CompactionConfig } from "../domain/session/compaction.js";
import {
  createSubmissionService,
  type SubmissionRecord,
  type SubmissionService,
} from "../domain/submissions/submissions.js";
import {
  actionRejectionErrorValue,
  createActionService,
  type Action,
  type ActionAuthorizationContext,
  type ActionService,
  type ActionTurnContext,
  type ApprovalRisk,
  type AuthorizationDecision,
  type ParkedResolution,
  type PendingApproval,
  type ReplyAttachment,
} from "../domain/actions/actions.js";
import {
  createScheduledTaskService,
  type DeclaredTasks,
  type ScheduledTaskService,
} from "../domain/scheduled-tasks/tasks.js";
import {
  createChatRecovery,
  type ChatRecovery,
  type Incident,
  type RecoveryPolicy,
  type TurnInputSnapshot,
} from "../domain/recovery/recovery.js";
import {
  createOverflowGuard,
  type ChatErrorClassification,
  type OverflowGuard,
} from "../domain/recovery/overflow.js";
import { createWorkspace, type Workspace } from "../domain/workspace/workspace.js";
import { createWorkspaceTools } from "../domain/workspace/tools.js";
import { createFetchTools, type FetchToolConfig } from "../domain/fetch/fetch-tool.js";
import { createSkillRegistry, type SkillRegistry, type SkillSource } from "../domain/skills/skills.js";
import {
  createChannelService,
  type ChannelDefinition,
  type ChannelPolicy,
  type ChannelService,
  type DeliverNoticeOptions,
} from "../domain/channels/channels.js";
import {
  agentTool as buildAgentTool,
  createAgentToolRunService,
  type AgentToolRun,
  type AgentToolRunService,
  type RunStatus,
} from "../domain/delegation/runs.js";
import { createSubAgentRegistry } from "../domain/delegation/registry.js";
import type {
  ListCriteria,
  RetryPolicy,
  Schedule,
  ScheduleSpec,
  Scheduler,
} from "../domain/scheduling/scheduler.js";
import type { FiberRecoveryContext, FiberRecoveryResult, FiberService } from "../domain/fibers/fibers.js";

// ---------------------------------------------------------------------------
// Public wire/API types
// ---------------------------------------------------------------------------

/** Relay handed to `chat()` for sub-agent / streaming callers. Structurally the delegation module's ChildChatRelay. */
export interface StreamCallback {
  onStart(info: { requestId: string }): void;
  onEvent(json: unknown): void;
  onDone(): void;
  onError(err: unknown): void;
  onInterrupted?(): void;
}

export interface TurnResult {
  requestId: string;
  outcome: TurnOutcome["kind"];
  message?: ChatMessage;
  error?: ErrorValue;
}

export interface ContextOverflowConfig {
  reactive?: boolean;
  maxRetries?: number;
  proactive?: { maxInputTokens: number; maxCompactions?: number };
}

export interface ChatResponseResult {
  requestId: string;
  outcome: "completed";
  message: ChatMessage;
  attachments: ReplyAttachment[];
}

export interface ChatErrorContext {
  requestId: string;
  stage: "turn" | "recovery";
  classification?: ChatErrorClassification;
}

// ---------------------------------------------------------------------------
// Session builder (audit 23 "configureSession(builder)")
// ---------------------------------------------------------------------------

export interface SessionBuilder {
  withContext(
    label: string,
    opts?: { description?: string; maxTokens?: number; provider?: ContextProviderLike },
  ): SessionBuilder;
  /** Marks the base instructions block with a token budget; content still comes from getSystemPrompt(). */
  withCachedPrompt(opts?: { maxTokens?: number }): SessionBuilder;
  onCompaction(summarize: (prompt: string) => Promise<string>, opts?: Omit<CompactionConfig, "summarize">): SessionBuilder;
  compactAfter(tokens: number): SessionBuilder;
}

class SessionBuilderImpl implements SessionBuilder {
  readonly extraBlocks: ContextBlockConfig[] = [];
  baseMaxTokens: number | undefined;
  compaction: CompactionConfig | undefined;

  withContext(label: string, opts?: { description?: string; maxTokens?: number; provider?: ContextProviderLike }): SessionBuilder {
    const block: ContextBlockConfig = { label };
    if (opts?.description !== undefined) block.description = opts.description;
    if (opts?.maxTokens !== undefined) block.maxTokens = opts.maxTokens;
    if (opts?.provider !== undefined) block.provider = opts.provider;
    this.extraBlocks.push(block);
    return this;
  }

  withCachedPrompt(opts?: { maxTokens?: number }): SessionBuilder {
    this.baseMaxTokens = opts?.maxTokens;
    return this;
  }

  onCompaction(summarize: (prompt: string) => Promise<string>, opts?: Omit<CompactionConfig, "summarize">): SessionBuilder {
    this.compaction = { ...(opts ?? {}), summarize };
    return this;
  }

  compactAfter(tokens: number): SessionBuilder {
    const base = this.compaction ?? { summarize: async (prompt: string) => prompt };
    this.compaction = { ...base, compactAfterTokens: tokens };
    return this;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Combines multiple AbortSignals into one that aborts when any of them does. */
function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** The real method name Agent's private dispatch table resolves declared-task alarms to (see buildSchedulerFacade). */
const DECLARED_TASK_DISPATCH_METHOD = "__thinkRunDeclaredTaskOccurrence";

interface AdmittedTurnSpec {
  requestId: string;
  trigger: TurnContext["trigger"];
  continuation: boolean;
  newMessages: ChatMessage[];
  channelId?: string;
  clientTools?: ToolSet;
  callback?: StreamCallback;
}

// ---------------------------------------------------------------------------
// Think
// ---------------------------------------------------------------------------

/**
 * Think composes the chat domain services over Agent. Like Agent, it is a
 * thin composition root: every real decision lives in a domain module; this
 * class wires them together, exposes the chat entry points, and speaks the
 * `cf_agent_*` WebSocket protocol over Agent's `onUnhandledMessage` seam.
 */
export class Think<State = unknown> extends Agent<State> {
  // --- configuration surface: plain overridable values (audit 23 table) ----
  maxSteps = 10;
  sendReasoning = true;
  chatRecovery: boolean | RecoveryPolicy = true;
  chatStreamStallTimeoutMs = 0;
  contextOverflow: ContextOverflowConfig | undefined;
  classifyChatError: ((error: unknown) => ChatErrorClassification | void) | undefined;
  actionLedgerPendingRetryLeaseMs: number | false = 300_000;
  workspaceTools = true;
  fetchTools: FetchToolConfig | false = false;
  /** Debounce before an auto-continuation turn is enqueued once every tool part of the last message settles. */
  chatToolResultDebounceMs = 150;

  // --- configuration surface: hooks -----------------------------------------
  beforeTurn?: (ctx: TurnContext) => void | TurnConfig | Promise<void | TurnConfig>;
  beforeStep?: (ctx: { stepNumber: number; messages: ModelMessage[] }) => void | StepConfig | Promise<void | StepConfig>;
  beforeToolCall?: (ctx: BeforeToolCallContext) => void | ToolCallDecision | Promise<void | ToolCallDecision>;
  afterToolCall?: (ctx: AfterToolCallContext) => void | Promise<void>;
  onStepFinish?: (ctx: StepResult) => void | Promise<void>;
  onChunk?: (ctx: { chunk: ModelChunk }) => void | Promise<void>;
  onChatResponse?: (result: ChatResponseResult) => void | Promise<void>;
  onChatError?: (error: unknown, ctx: ChatErrorContext) => void | Promise<void>;
  authorizeTurn?: (ctx: ActionTurnContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeAction?: (ctx: ActionAuthorizationContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  repairInterruptedToolPart?: (part: ToolPart) => MessagePart;
  onChatRecovery?: (ctx: { requestId: string; incidentId: string; attempt: number }) => void | Promise<void>;
  renderAttachment?: (att: ReplyAttachment) => unknown;
  onAgentToolStart?: (run: AgentToolRun) => void;
  onAgentToolFinish?: (run: AgentToolRun) => void;
  onProgress?: (runId: string, progress: unknown) => void;

  // --- eagerly-built services (safe: only capture callbacks, never bare config values) ---
  private readonly turnQueue: TurnQueue;
  private readonly turnEngine: TurnEngine;
  private readonly resumableBuffer: ResumableStreamBuffer;
  private readonly submissionService: SubmissionService;
  private readonly channelService: ChannelService;
  private readonly scheduledTaskService: ScheduledTaskService;
  private readonly workspace: Workspace;
  private readonly agentRunsService?: AgentToolRunService;

  // --- lazily-built on first use (onStart / defensive) so subclass field
  // overrides — which only apply once the *subclass's own* constructor has
  // finished — are seen (Think's constructor runs first and would otherwise
  // silently capture its own defaults). See report for rationale. ---
  private runtimeInitialized = false;
  private actionService!: ActionService;
  private overflowGuardService!: OverflowGuard;
  private chatRecoveryService!: ChatRecovery;

  private sessionInstance?: Session;
  private skillRegistryInstance?: SkillRegistry;

  private readonly continuationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(host: AgentHost) {
    super(host);

    this.turnQueue = createTurnQueue();
    this.turnEngine = createTurnEngine({ clock: host.clock, ids: this.ids, bus: this.events });
    this.resumableBuffer = createResumableStreamBuffer({ store: scoped(host.store, "think:stream:"), clock: host.clock });
    this.workspace = createWorkspace({ store: scoped(host.store, "think:ws:"), clock: host.clock });

    this.submissionService = createSubmissionService({
      store: scoped(host.store, "think:"),
      clock: host.clock,
      ids: this.ids,
      bus: this.events,
      runSubmission: (record, signal) => this.runSubmissionTurn(record, signal),
    });

    this.channelService = createChannelService({
      bus: this.events,
      transcriptNotice: (text, informModel) => this.appendTranscriptNotice(text, informModel),
    });

    this.scheduledTaskService = createScheduledTaskService({
      store: scoped(host.store, "think:"),
      scheduler: this.buildSchedulerFacade(),
      submissions: this.submissionService,
      clock: host.clock,
      bus: this.events,
      defaultTimezone: () => this.getDefaultTimezone(),
      declarations: () => this.getScheduledTasks(),
    });

    if (host.spawner) {
      const registry = createSubAgentRegistry({ store: host.store, spawner: host.spawner, clock: host.clock, ids: this.ids });
      this.agentRunsService = createAgentToolRunService({
        store: scoped(host.store, "think:"),
        registry,
        clock: host.clock,
        ids: this.ids,
        bus: this.events,
        onEvent: (runId, event) => this.broadcast(JSON.stringify({ type: "cf_agent_tool_run_event", runId, event })),
        hooks: {
          onRunStart: (run) => this.onAgentToolStart?.(run),
          onRunFinish: (run) => this.onAgentToolFinish?.(run),
          onProgress: (runId, progress) => this.onProgress?.(runId, progress),
        },
      });
    }

    // Drives the cf_agent_chat_recovering broadcast from the recovery module's events.
    this.events.subscribe("chat", (e) => {
      if (e.type === "chat:recovery:scheduled") {
        this.broadcast(JSON.stringify({ type: "cf_agent_chat_recovering", active: true }));
      } else if (
        e.type === "chat:recovery:completed" ||
        e.type === "chat:recovery:exhausted" ||
        e.type === "chat:recovery:skipped"
      ) {
        this.broadcast(JSON.stringify({ type: "cf_agent_chat_recovering", active: false }));
      }
    });
  }

  // ==========================================================================
  // Config surface: overridable methods (audit 23 — the "subclass API")
  // ==========================================================================

  protected getModel(): ModelClient {
    throw new ValidationError("Think subclasses must override getModel() to provide a ModelClient");
  }

  protected getSystemPrompt(): string {
    return "You are a careful, helpful assistant. Use the tools available to you when they help, think " +
      "before acting, and say plainly when you are unsure.";
  }

  protected getTools(): ToolSet {
    return {};
  }

  protected getActions(): Record<string, Action> {
    return {};
  }

  protected getSkills(): SkillSource[] {
    return [];
  }

  protected configureSession(builder: SessionBuilder): SessionBuilder {
    return builder;
  }

  protected configureChannels(): Record<string, ChannelDefinition> {
    return {};
  }

  protected getScheduledTasks(): DeclaredTasks {
    return {};
  }

  protected getDefaultTimezone(): string | undefined {
    return undefined;
  }

  /** Override to plug in a real outbound fetch (service binding, etc.). Default: the platform's global fetch. */
  protected getFetchClient(): FetchLike {
    return (async (url: string, init?: Parameters<FetchLike>[1]) => {
      const response = await fetch(url, {
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.headers !== undefined ? { headers: init.headers } : {}),
        ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}),
        ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      });
      return {
        status: response.status,
        headers: new Map([...response.headers.entries()]),
        url: response.url,
        arrayBuffer: () => response.arrayBuffer(),
      };
    }) as FetchLike;
  }

  configure<T = unknown>(config: T): void {
    this.host.store.put("think:cfg", config);
  }

  getConfig<T = unknown>(): T | undefined {
    return this.host.store.get<T>("think:cfg");
  }

  // ==========================================================================
  // Runtime bundle (lazy — see field comment above)
  // ==========================================================================

  private ensureRuntime(): void {
    if (this.runtimeInitialized) return;
    this.runtimeInitialized = true;

    this.channelService.register(this.configureChannels());

    this.actionService = createActionService({
      store: scoped(this.host.store, "think:"),
      clock: this.host.clock,
      ids: this.ids,
      bus: this.events,
      ...(this.authorizeTurn ? { authorizeTurn: (ctx: ActionTurnContext) => this.authorizeTurn!(ctx) } : {}),
      ...(this.authorizeAction ? { authorizeAction: (ctx: ActionAuthorizationContext) => this.authorizeAction!(ctx) } : {}),
      pendingRetryLeaseMs: this.actionLedgerPendingRetryLeaseMs,
      onResolved: (executionId, resolution) => this.onActionResolved(executionId, resolution),
    });

    this.overflowGuardService = createOverflowGuard({
      ...(this.contextOverflow ? { config: this.contextOverflow } : {}),
      ...(this.classifyChatError ? { classify: this.classifyChatError } : {}),
      compact: () => this.compactSession(),
      bus: this.events,
    });

    this.chatRecoveryService = createChatRecovery({
      store: scoped(this.host.store, "think:"),
      fibers: this.buildFiberFacade(),
      clock: this.host.clock,
      ids: this.ids,
      bus: this.events,
      policy: this.resolvedRecoveryPolicy(),
      conversation: {
        lastRequestId: () => this.getLastRequestId(),
        partialAssistant: (requestId) => this.partialAssistantFor(requestId),
        scheduleRetry: async (input, incident) => this.scheduleRecoveryRun(input.requestId, incident),
        scheduleContinuation: async (incident) => this.scheduleRecoveryRun(incident.requestId, incident),
        terminalize: (incident, message) => this.terminalizeRecovery(incident, message),
      },
    });
  }

  private get recoveryEnabled(): boolean {
    return this.chatRecovery !== false;
  }

  private resolvedRecoveryPolicy(): RecoveryPolicy {
    if (this.chatRecovery === true || this.chatRecovery === false) return {};
    return this.chatRecovery;
  }

  protected override async onStart(): Promise<void> {
    this.ensureRuntime();
  }

  // --- facades bridging other domain services onto Agent's own (private)
  // scheduler/fiber machinery, since Agent exposes only wrapper methods, not
  // the underlying Scheduler/FiberService objects those modules expect. ---

  private buildSchedulerFacade(): Scheduler {
    return {
      create: <T>(spec: ScheduleSpec, _callback: string, payload?: T, options?: { id?: string; retry?: RetryPolicy }): Schedule<T> => {
        if (spec.kind !== "once") {
          throw new ValidationError("Think's declared-task scheduler facade only supports 'once' specs");
        }
        return this.schedule<T>(new Date(spec.at), DECLARED_TASK_DISPATCH_METHOD, payload, options);
      },
      get: <T>(id: string) => this.getScheduleById<T>(id),
      list: <T>(criteria?: ListCriteria) => this.listSchedules<T>(criteria),
      cancel: (id: string) => this.cancelSchedule(id),
      onAlarm: async () => {
        /* not used: Agent's own onAlarm() drives this scheduler via the facade's create(). */
      },
      nextWake: () => null,
    };
  }

  /** Real method (not "$internal:"-prefixed) so Agent's dispatch table resolves it by name; see buildSchedulerFacade. */
  private async __thinkRunDeclaredTaskOccurrence(payload: unknown): Promise<void> {
    await this.scheduledTaskService.runOccurrence(payload as { taskId: string; scheduledFor: number });
  }

  private buildFiberFacade(): FiberService {
    return {
      run: (name, fn) => this.runFiber(name, fn),
      start: (name, fn, options) => this.startFiber(name, fn, options),
      stash: (data) => this.stash(data),
      inspect: (id) => this.inspectFiber(id),
      inspectByKey: (key) => this.inspectFiberByKey(key),
      list: (options) => this.listFibers(options),
      cancel: (id, reason) => this.cancelFiber(id, reason),
      cancelByKey: (key, reason) => this.cancelFiberByKey(key, reason),
      resolve: (id, result) => this.resolveFiber(id, result),
      deleteFibers: (options) => this.deleteFibers(options),
      checkInterrupted: async () => {
        /* not used: Agent's own start()/onFiberRecovered drive fiber recovery scanning. */
      },
    };
  }

  protected override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    this.ensureRuntime();
    return this.chatRecoveryService.onFiberRecovered(ctx);
  }

  // ==========================================================================
  // Session / skills (lazy)
  // ==========================================================================

  private async ensureSession(): Promise<Session> {
    if (this.sessionInstance) return this.sessionInstance;
    const builder = new SessionBuilderImpl();
    const configured = (this.configureSession(builder) ?? builder) as SessionBuilderImpl;

    const baseBlock: ContextBlockConfig = {
      label: "instructions",
      provider: { get: async () => this.getSystemPrompt() },
    };
    if (configured.baseMaxTokens !== undefined) baseBlock.maxTokens = configured.baseMaxTokens;

    const config: SessionConfig = {
      blocks: [baseBlock, ...configured.extraBlocks],
      onStatus: (s) => this.broadcastSessionStatus(s),
      onCompactionError: (e) => this.events.emit("chat:context:compaction_error", { error: toErrorValue(e) }),
    };
    if (configured.compaction) config.compaction = configured.compaction;

    this.sessionInstance = createSession(
      { store: scoped(this.host.store, "think:"), clock: this.host.clock, ids: this.ids },
      config,
    );
    return this.sessionInstance;
  }

  private async ensureSkills(): Promise<SkillRegistry> {
    if (this.skillRegistryInstance) return this.skillRegistryInstance;
    this.skillRegistryInstance = await createSkillRegistry(this.getSkills());
    return this.skillRegistryInstance;
  }

  private async compactSession(): Promise<{ shortened: boolean }> {
    const session = await this.ensureSession();
    const before = await session.estimatedTokens();
    const result = await session.compact();
    if (!result.compacted) return { shortened: false };
    const after = await session.estimatedTokens();
    return { shortened: after < before };
  }

  private broadcastSessionStatus(status: SessionStatus): void {
    this.broadcast(
      JSON.stringify({
        type: "cf_agent_session",
        phase: status.phase,
        tokenEstimate: status.tokenEstimate,
        tokenThreshold: status.tokenThreshold,
      }),
    );
  }

  // ==========================================================================
  // Per-request durable bookkeeping (small KV records, synchronous)
  // ==========================================================================

  private partialKey(requestId: string): string {
    return `think:reqmsg:${requestId}`;
  }

  private channelKey(requestId: string): string {
    return `think:reqchannel:${requestId}`;
  }

  private recordPartial(requestId: string, message: ChatMessage): void {
    this.host.store.put(this.partialKey(requestId), message);
  }

  private partialAssistantFor(requestId: string): ChatMessage | undefined {
    return this.host.store.get<ChatMessage>(this.partialKey(requestId));
  }

  private getLastRequestId(): string | undefined {
    return this.host.store.get<string>("think:lastRequestId");
  }

  private setLastRequestId(id: string): void {
    this.host.store.put("think:lastRequestId", id);
  }

  private async findMessage(id: string): Promise<ChatMessage | undefined> {
    const session = await this.ensureSession();
    const history = await session.getHistory();
    return history.find((m) => m.id === id);
  }

  // ==========================================================================
  // Tool + system-prompt assembly (shared by turn execution and approval re-execution)
  // ==========================================================================

  private async buildAssembly(
    channelId: string | undefined,
    clientTools: ToolSet | undefined,
  ): Promise<{ system: string; tools: AssembledTools; policy: ChannelPolicy }> {
    const session = await this.ensureSession();
    const skills = await this.ensureSkills();
    const policy = await this.channelService.policyFor(channelId);

    const builtin: ToolSet = {
      ...(this.workspaceTools ? createWorkspaceTools(this.workspace) : {}),
      ...(await session.tools()),
      ...skills.tools(),
    };
    const external: ToolSet = this.fetchTools
      ? createFetchTools(this.fetchTools, {
          fetch: this.getFetchClient(),
          workspace: this.workspace,
          bus: this.events,
          clock: this.host.clock,
        })
      : {};
    const actionsToolSet = this.actionService.compile(this.getActions());
    const sources: ToolSources = {
      builtin,
      external,
      actions: actionsToolSet,
      user: this.getTools(),
      client: clientTools ?? {},
    };

    const toolHooks: ToolHooks = {};
    if (this.beforeToolCall) toolHooks.beforeToolCall = (ctx) => this.beforeToolCall!(ctx);
    if (this.afterToolCall) toolHooks.afterToolCall = (ctx) => this.afterToolCall!(ctx);

    const tools = assembleTools(sources, {
      hooks: toolHooks,
      ...(policy.toolFilter ? { filter: policy.toolFilter } : {}),
      clock: this.host.clock,
    });

    const baseSystemPrompt = await session.freezeSystemPrompt();
    const catalog = skills.catalogBlock();
    const capBlock = tools.capabilityBlock();
    const system = [baseSystemPrompt, policy.instructions, catalog, capBlock]
      .filter((s): s is string => Boolean(s))
      .join("\n\n");

    return { system, tools, policy };
  }

  // ==========================================================================
  // Turn orchestration
  // ==========================================================================

  private toMessages(input: string | ChatMessage[]): ChatMessage[] {
    if (typeof input === "string") return [userMessage(input, this.ids.newId("msg"))];
    return input;
  }

  private async executeTurn(
    spec: AdmittedTurnSpec & { admission?: "queue" | "replace" | "reject" },
  ): Promise<TurnOutcome> {
    this.ensureRuntime();
    return this.turnQueue.run({
      requestId: spec.requestId,
      trigger: spec.trigger,
      admission: spec.admission ?? "queue",
      execute: (signal) => this.runAdmittedTurn(spec, signal),
    });
  }

  private async runAdmittedTurn(spec: AdmittedTurnSpec, queueSignal: AbortSignal): Promise<TurnOutcome> {
    spec.callback?.onStart({ requestId: spec.requestId });
    this.setLastRequestId(spec.requestId);
    if (spec.channelId) this.host.store.put(this.channelKey(spec.requestId), spec.channelId);

    const session = await this.ensureSession();
    const channelCtx = this.channelService.resolve(spec.channelId);

    return this.channelService.runWithActive(channelCtx, async () => {
      for (const m of spec.newMessages) {
        await session.appendMessage(m);
      }

      const { system, tools: assembled, policy } = await this.buildAssembly(spec.channelId, spec.clientTools);
      const history = await session.getHistory();
      const turnCtx: TurnContext = {
        requestId: spec.requestId,
        trigger: spec.trigger,
        continuation: spec.continuation,
        ...(spec.channelId ? { channelId: spec.channelId } : {}),
        messages: history,
      };

      await this.actionService.authorizeTurnOnce(turnCtx);

      const streamId = spec.requestId;
      this.resumableBuffer.begin(streamId, spec.requestId);
      const accumulator = createAccumulator();
      const emit = (chunk: UiChunk): void => {
        accumulator.push(chunk);
        this.resumableBuffer.append(streamId, chunk);
        this.broadcastChunk(spec.requestId, chunk);
        spec.callback?.onEvent(chunk);
        this.recordPartial(spec.requestId, accumulator.current());
      };

      // getModel() may throw (e.g. the default implementation); resolve it up
      // front so that failure goes through the normal error-outcome pipeline
      // (emits proper chunks, persists a partial, calls onChatError) instead
      // of an uncaught rejection swallowed by Agent.onMessage's onError seam.
      let model: ModelClient;
      try {
        model = this.getModel();
      } catch (err) {
        emit({ type: "start", messageId: this.ids.newId("msg") });
        emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        emit({ type: "finish", finishReason: "error" });
        const errorOutcome: TurnOutcome = { kind: "error", error: err, steps: [] };
        this.resumableBuffer.settle(streamId, "errored");
        await this.finalizeOutcome(spec, session, accumulator.current(), errorOutcome, { tools: {} } as AssembledTools);
        this.actionService.clearTurn(spec.requestId);
        return errorOutcome;
      }

      const config: TurnConfig = {
        maxSteps: policy.maxTurns ?? this.maxSteps,
        sendReasoning: this.sendReasoning,
        stallTimeoutMs: this.chatStreamStallTimeoutMs,
      };

      const hooks: TurnHooks = {};
      if (this.beforeTurn) hooks.beforeTurn = (ctx) => this.beforeTurn!(ctx);
      if (this.beforeStep) hooks.beforeStep = (ctx) => this.beforeStep!(ctx);
      if (this.beforeToolCall) hooks.beforeToolCall = (ctx) => this.beforeToolCall!(ctx);
      if (this.afterToolCall) hooks.afterToolCall = (ctx) => this.afterToolCall!(ctx);
      hooks.onStepFinish = async (step) => {
        if (this.onStepFinish) await this.onStepFinish(step);
        await this.overflowGuardService.maybeCompactBeforeStep(step.usage, spec.requestId);
      };
      if (this.onChunk) hooks.onChunk = (c) => this.onChunk!(c);

      const snapshot: TurnInputSnapshot = {
        requestId: spec.requestId,
        messages: spec.newMessages,
        ...(spec.channelId ? { channelId: spec.channelId } : {}),
        trigger: spec.trigger,
      };

      const runOnce = (signal: AbortSignal): Promise<TurnOutcome> =>
        this.turnEngine.run({ context: turnCtx, system, tools: assembled, model, config, hooks, emit, signal });

      const runRecoverably = (): Promise<TurnOutcome> =>
        this.recoveryEnabled
          ? this.chatRecoveryService.runRecoverable({
              requestId: spec.requestId,
              input: snapshot,
              execute: (fiberSignal) => runOnce(combineSignals(queueSignal, fiberSignal)),
            })
          : runOnce(queueSignal);

      let outcome = await runRecoverably();

      if (outcome.kind === "error" && outcome.stalled) {
        const result = await this.chatRecoveryService.handleStall(spec.requestId);
        if (result === "recovering") {
          spec.callback?.onInterrupted?.();
          this.resumableBuffer.settle(streamId, "errored");
          this.actionService.clearTurn(spec.requestId);
          return outcome;
        }
        // terminal: chatRecoveryService already persisted a terminal message via conversation.terminalize().
      } else if (outcome.kind === "error") {
        const action = await this.overflowGuardService.handleTurnError(outcome.error, spec.requestId);
        if (action === "retry") {
          outcome = await runRecoverably();
        }
      }

      this.resumableBuffer.settle(streamId, outcome.kind === "error" ? "errored" : "completed");
      await this.finalizeOutcome(spec, session, accumulator.current(), outcome, assembled);
      this.actionService.clearTurn(spec.requestId);
      return outcome;
    });
  }

  private async finalizeOutcome(
    spec: AdmittedTurnSpec,
    session: Session,
    message: ChatMessage,
    outcome: TurnOutcome,
    assembled: AssembledTools,
  ): Promise<void> {
    if (message.parts.length > 0) {
      await session.appendMessage(message);
      this.recordPartial(spec.requestId, message);
      this.broadcast(JSON.stringify({ type: "cf_agent_message_updated", message }));
    }

    switch (outcome.kind) {
      case "completed": {
        const attachments = this.actionService.attachments(spec.requestId);
        if (this.renderAttachment) for (const att of attachments) this.renderAttachment(att);
        this.events.emit("message:response", { requestId: spec.requestId, messageId: message.id });
        spec.callback?.onDone();
        if (this.onChatResponse) {
          await this.onChatResponse({ requestId: spec.requestId, outcome: "completed", message, attachments });
        }
        break;
      }
      case "suspended": {
        // The turn engine's suspension reason only distinguishes "client-tool"
        // vs "approval" — it has no concept of durable-pause actions. Think
        // itself inspects the tool's metadata (set by ActionService.compile)
        // to tell an approval-gated tool (wait for a WS approval frame, then
        // re-execute) from a durable-pause action (park it durably instead).
        if (outcome.reason === "approval" || outcome.reason === "durable-pause") {
          const call = outcome.pending[0];
          const toolDef: Tool | undefined = call ? assembled.tools[call.toolName] : undefined;
          const meta = (toolDef?.metadata ?? {}) as Record<string, unknown>;
          if (call && meta.durablePause === true) {
            const resolvePermissions = meta.resolvePermissions as ((input: unknown) => readonly string[]) | undefined;
            this.actionService.park({
              requestId: spec.requestId,
              toolCallId: call.toolCallId,
              action: String(meta.action ?? call.toolName),
              summary: String(meta.approvalSummary ?? call.toolName),
              input: call.input,
              permissions: resolvePermissions ? resolvePermissions(call.input) : [],
              ...(meta.approvalRisk ? { risk: meta.approvalRisk as ApprovalRisk } : {}),
              kind: "durable-pause",
            });
          }
        }
        spec.callback?.onDone();
        break;
      }
      case "aborted": {
        this.events.emit("message:cancel", { requestId: spec.requestId, reason: outcome.reason });
        spec.callback?.onError(outcome.reason ?? "aborted");
        break;
      }
      case "error": {
        const classification = this.classifyChatError?.(outcome.error) || undefined;
        const ctx: ChatErrorContext = { requestId: spec.requestId, stage: "turn" };
        if (classification) ctx.classification = classification;
        if (this.onChatError) await this.onChatError(outcome.error, ctx);
        spec.callback?.onError(toErrorValue(outcome.error));
        break;
      }
    }
  }

  private broadcastChunk(requestId: string, chunk: UiChunk): void {
    this.broadcast(JSON.stringify({ type: "cf_agent_use_chat_response", id: requestId, chunk }));
  }

  // ==========================================================================
  // Recovery conversation callbacks
  // ==========================================================================

  private scheduleRecoveryRun(requestId: string, incident: Incident): void {
    if (this.onChatRecovery) {
      void this.onChatRecovery({ requestId, incidentId: incident.incidentId, attempt: incident.attempt });
    }
    void this.executeTurn({
      requestId,
      trigger: "continuation",
      continuation: true,
      newMessages: [],
    }).catch((err: unknown) => {
      this.events.emit("chat:recovery:run_failed", { requestId, incidentId: incident.incidentId, error: toErrorValue(err) });
    });
  }

  private async terminalizeRecovery(incident: Incident, message: string): Promise<void> {
    const session = await this.ensureSession();
    const terminalMsg = assistantMessage([{ type: "text", text: message }], this.ids.newId("msg"));
    await session.appendMessage(terminalMsg);
    this.recordPartial(incident.requestId, terminalMsg);
    this.broadcast(JSON.stringify({ type: "cf_agent_message_updated", message: terminalMsg }));
    if (this.onChatError) {
      await this.onChatError(new Error(message), { requestId: incident.requestId, stage: "recovery" });
    }
  }

  // ==========================================================================
  // Entry points (audit 23 "Entry points")
  // ==========================================================================

  async chat(input: string | ChatMessage[], callback?: StreamCallback, opts?: { channel?: string; requestId?: string }): Promise<TurnResult> {
    this.ensureRuntime();
    const requestId = opts?.requestId ?? this.ids.newId("req");
    const newMessages = this.toMessages(input);
    try {
      const outcome = await this.executeTurn({
        requestId,
        trigger: "chat",
        continuation: false,
        newMessages,
        ...(opts?.channel ? { channelId: opts.channel } : {}),
        ...(callback ? { callback } : {}),
      });
      return this.toTurnResult(requestId, outcome);
    } catch (err) {
      callback?.onError(toErrorValue(err));
      return { requestId, outcome: "error", error: toErrorValue(err) };
    }
  }

  private toTurnResult(requestId: string, outcome: TurnOutcome): TurnResult {
    const result: TurnResult = { requestId, outcome: outcome.kind };
    const stored = this.partialAssistantFor(requestId);
    if (stored) result.message = stored;
    if (outcome.kind === "error") result.error = toErrorValue(outcome.error);
    if (outcome.kind === "aborted") result.error = { name: "AbortedError", message: outcome.reason ?? "aborted" };
    return result;
  }

  async runTurn(args: {
    input: string | ChatMessage[];
    channel?: string;
    mode: "wait" | "submit" | "stream";
    callback?: StreamCallback;
  }): Promise<TurnResult | (SubmissionRecord & { accepted: boolean }) | void> {
    this.ensureRuntime();
    if (args.mode === "submit") {
      return this.submitMessages(this.toMessages(args.input));
    }
    const opts = args.channel ? { channel: args.channel } : undefined;
    if (args.mode === "stream") {
      await this.chat(args.input, args.callback, opts);
      return;
    }
    return this.chat(args.input, undefined, opts);
  }

  async saveMessages(messages: ChatMessage[]): Promise<TurnResult> {
    this.ensureRuntime();
    const requestId = this.ids.newId("req");
    const outcome = await this.executeTurn({ requestId, trigger: "save", continuation: false, newMessages: messages });
    return this.toTurnResult(requestId, outcome);
  }

  async submitMessages(
    messages: ChatMessage[],
    opts?: { submissionId?: string; idempotencyKey?: string; metadata?: Record<string, unknown> },
  ): Promise<SubmissionRecord & { accepted: boolean }> {
    this.ensureRuntime();
    return this.submissionService.submit(messages, opts);
  }

  private async runSubmissionTurn(
    record: { submissionId: string; messages: ChatMessage[] },
    signal: AbortSignal,
  ): Promise<{ kind: "completed" | "aborted" | "error"; error?: string }> {
    const onAbort = (): void => {
      this.cancelChat(record.submissionId, "submission cancelled");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await this.executeTurn({
        requestId: record.submissionId,
        trigger: "submission",
        continuation: false,
        newMessages: record.messages,
      });
      if (outcome.kind === "completed" || outcome.kind === "suspended") return { kind: "completed" };
      if (outcome.kind === "aborted") return { kind: "aborted" };
      return { kind: "error", error: toErrorValue(outcome.error).message };
    } catch (err) {
      if (err instanceof AbortedError) return { kind: "aborted" };
      return { kind: "error", error: toErrorValue(err).message };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async getMessages(): Promise<ChatMessage[]> {
    const session = await this.ensureSession();
    return session.getHistory();
  }

  async clearMessages(): Promise<void> {
    this.ensureRuntime();
    const session = await this.ensureSession();
    await session.clearMessages();
    this.submissionService.markAllPendingSkipped();
    this.turnQueue.cancelAll("cleared");
    this.host.store.delete("think:lastRequestId");
    this.broadcast(JSON.stringify({ type: "cf_agent_chat_clear" }));
  }

  cancelChat(requestId: string, reason?: string): boolean {
    return this.turnQueue.cancel(requestId, reason);
  }

  cancelAllChats(reason?: string): void {
    this.turnQueue.cancelAll(reason);
  }

  async continueLastTurn(): Promise<TurnOutcome | undefined> {
    this.ensureRuntime();
    const requestId = this.getLastRequestId();
    if (!requestId) return undefined;
    return this.executeTurn({
      requestId: this.ids.newId("req"),
      trigger: "continuation",
      continuation: true,
      newMessages: [],
    });
  }

  pendingApprovals(executionId?: string): PendingApproval[] {
    this.ensureRuntime();
    return this.actionService.pendingApprovals(executionId);
  }

  async approveExecution(executionId: string): Promise<unknown> {
    this.ensureRuntime();
    return this.actionService.approveExecution(executionId);
  }

  async rejectExecution(executionId: string, reason?: string): Promise<void> {
    this.ensureRuntime();
    return this.actionService.rejectExecution(executionId, reason);
  }

  private async onActionResolved(executionId: string, resolution: ParkedResolution): Promise<void> {
    void executionId;
    const session = await this.ensureSession();
    const snapshot = this.partialAssistantFor(resolution.requestId);
    if (!snapshot) return;
    const stored = (await this.findMessage(snapshot.id)) ?? snapshot;
    const updatedParts = stored.parts.map((p) => {
      if (isToolPart(p) && p.toolCallId === resolution.toolCallId) {
        if (resolution.rejection) {
          return { ...p, state: "output-error", errorText: resolution.rejection.message } as MessagePart;
        }
        return { ...p, state: "output-available", output: resolution.output } as MessagePart;
      }
      return p;
    });
    const updated: ChatMessage = { ...stored, parts: updatedParts };
    await session.updateMessage(updated);
    this.recordPartial(resolution.requestId, updated);
    this.broadcast(JSON.stringify({ type: "cf_agent_message_updated", message: updated }));
    this.maybeAutoContinue(updated);
  }

  replyAttachments(requestId?: string): ReplyAttachment[] {
    this.ensureRuntime();
    return this.actionService.attachments(requestId);
  }

  async deliverNotice(text: string, opts?: DeliverNoticeOptions): Promise<void> {
    this.ensureRuntime();
    await this.channelService.deliverNotice(text, opts);
  }

  private async appendTranscriptNotice(text: string, informModel: boolean): Promise<void> {
    const session = await this.ensureSession();
    const message = assistantMessage([{ type: "text", text }], this.ids.newId("msg"));
    message.metadata = { notice: true, informModel };
    await session.appendMessage(message);
    this.broadcast(JSON.stringify({ type: "cf_agent_message_updated", message }));
  }

  async reconcileScheduledTasks(): Promise<void> {
    this.ensureRuntime();
    await this.scheduledTaskService.reconcile(this.getScheduledTasks());
  }

  // --- agent-tool client surface (doc 19) -----------------------------------

  private requireAgentRuns(): AgentToolRunService {
    if (!this.agentRunsService) {
      throw new ValidationError("No AgentSpawner configured on this host: agent-tool runs are unavailable");
    }
    return this.agentRunsService;
  }

  async startAgentToolRun(args: { agentClassName: string; prompt: string; displayName?: string }): Promise<AgentToolRun> {
    return this.requireAgentRuns().startRun(args);
  }

  async cancelAgentToolRun(runId: string, reason?: string): Promise<void> {
    return this.requireAgentRuns().cancelRun(runId, reason);
  }

  inspectAgentToolRun(runId: string): AgentToolRun | null {
    return this.requireAgentRuns().inspectRun(runId);
  }

  tailAgentToolRun(runId: string, afterIndex?: number): Array<{ index: number; event: unknown }> {
    return this.requireAgentRuns().readEvents(runId, afterIndex);
  }

  async clearAgentToolRuns(options?: { statuses?: RunStatus[]; before?: number }): Promise<number> {
    return this.requireAgentRuns().clearRuns(options);
  }

  /** Sugar mirroring the delegation module's tool factory, bound to this Think's run service. */
  agentTool(
    agentClassName: string,
    cfg: Parameters<typeof buildAgentTool>[1],
  ): Tool {
    return buildAgentTool(agentClassName, cfg, { runs: this.requireAgentRuns() });
  }

  // ==========================================================================
  // Auto-continuation (client tool results / approvals)
  // ==========================================================================

  private maybeAutoContinue(message: ChatMessage): void {
    const toolParts = message.parts.filter(isToolPart);
    if (toolParts.length === 0) return;
    const allSettled = toolParts.every((p) => p.state === "output-available" || p.state === "output-error");
    if (!allSettled) return;

    const key = message.id;
    const existing = this.continuationTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);

    const fire = (): void => {
      this.continuationTimers.delete(key);
      void this.continueLastTurn().catch((err: unknown) => {
        this.events.emit("chat:continuation:failed", { error: toErrorValue(err) });
      });
    };

    if (this.chatToolResultDebounceMs <= 0) {
      fire();
    } else {
      this.continuationTimers.set(key, setTimeout(fire, this.chatToolResultDebounceMs));
    }
  }

  // ==========================================================================
  // WebSocket protocol (over Agent's onUnhandledMessage / onConnect)
  // ==========================================================================

  override async onConnect(conn: Connection): Promise<void> {
    await super.onConnect(conn);
    this.ensureRuntime();
    const session = await this.ensureSession();
    const rawHistory = await session.getHistory();
    const repairOpts = this.repairInterruptedToolPart ? { repairPart: this.repairInterruptedToolPart } : undefined;
    const messages = repairTranscript(rawHistory, repairOpts).messages;
    conn.send(JSON.stringify({ type: "cf_agent_chat_messages", messages }));
    if (this.chatRecoveryService.isRecovering()) {
      conn.send(JSON.stringify({ type: "cf_agent_chat_recovering", active: true }));
    }
  }

  protected override async onUnhandledMessage(conn: Connection, message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const msg = message as Record<string, unknown>;
    this.ensureRuntime();

    switch (msg.type) {
      case "cf_agent_use_chat_request":
        await this.handleChatRequestFrame(conn, msg);
        return;
      case "cf_agent_chat_clear":
        await this.clearMessages();
        return;
      case "cf_agent_chat_request_cancel":
        this.cancelChat(String(msg.id));
        return;
      case "cf_agent_stream_resume_request":
        await this.handleResumeRequest(conn, msg);
        return;
      case "cf_agent_stream_resume_ack":
        return;
      case "cf_agent_tool_result":
        await this.handleToolResultFrame(msg);
        return;
      case "cf_agent_tool_approval":
        await this.handleToolApprovalFrame(msg);
        return;
      default:
        return;
    }
  }

  private parseClientTools(raw: unknown): ToolSet | undefined {
    if (!Array.isArray(raw)) return undefined;
    const tools: ToolSet = {};
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { name, description, inputSchema } = item as { name?: string; description?: string; inputSchema?: unknown };
      if (!name) continue;
      tools[name] = { description: description ?? "", inputSchema: { jsonSchema: inputSchema ?? {} } };
    }
    return tools;
  }

  private async handleChatRequestFrame(_conn: Connection, msg: Record<string, unknown>): Promise<void> {
    const requestId = typeof msg.id === "string" ? msg.id : this.ids.newId("req");
    const channel = typeof msg.channel === "string" ? msg.channel : undefined;
    const clientTools = this.parseClientTools(msg.clientTools);

    let newMessages: ChatMessage[];
    if (Array.isArray(msg.messages)) {
      newMessages = msg.messages as ChatMessage[];
    } else if (typeof msg.input === "string") {
      newMessages = [userMessage(msg.input, this.ids.newId("msg"))];
    } else {
      newMessages = [];
    }

    await this.executeTurn({
      requestId,
      trigger: "websocket",
      continuation: false,
      newMessages,
      ...(channel ? { channelId: channel } : {}),
      ...(clientTools ? { clientTools } : {}),
    });
  }

  private async handleResumeRequest(conn: Connection, msg: Record<string, unknown>): Promise<void> {
    const requested = typeof msg.id === "string" ? msg.id : undefined;

    const active = this.resumableBuffer.activeStream();
    if (active && (requested === undefined || active.streamId === requested)) {
      const rec = this.resumableBuffer.read(active.streamId);
      conn.send(JSON.stringify({ type: "cf_agent_stream_resuming", id: active.requestId }));
      for (const chunk of rec?.chunks ?? []) {
        conn.send(JSON.stringify({ type: "cf_agent_use_chat_response", id: active.requestId, chunk, replay: true }));
      }
      return;
    }

    if (requested !== undefined) {
      const rec = this.resumableBuffer.read(requested);
      if (rec) {
        conn.send(JSON.stringify({ type: "cf_agent_stream_resuming", id: requested }));
        for (const chunk of rec.chunks) {
          conn.send(JSON.stringify({ type: "cf_agent_use_chat_response", id: requested, chunk, replay: true }));
        }
        return;
      }
    }

    conn.send(JSON.stringify({ type: "cf_agent_stream_resume_none" }));
  }

  private async handleToolResultFrame(msg: Record<string, unknown>): Promise<void> {
    const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
    if (!toolCallId) return;

    const session = await this.ensureSession();
    const last = await session.getLatestLeaf();
    if (!last || last.role !== "assistant") return;

    const updatedParts = last.parts.map((p) => {
      if (isToolPart(p) && p.toolCallId === toolCallId && (p.state === "input-available" || p.state === "input-streaming")) {
        return { ...p, state: "output-available", output: msg.output } as MessagePart;
      }
      return p;
    });
    const updated: ChatMessage = { ...last, parts: updatedParts };
    await session.updateMessage(updated);

    const requestId = this.getLastRequestId();
    if (requestId) this.recordPartial(requestId, updated);
    this.broadcast(JSON.stringify({ type: "cf_agent_message_updated", message: updated }));
    this.maybeAutoContinue(updated);
  }

  private async handleToolApprovalFrame(msg: Record<string, unknown>): Promise<void> {
    const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
    const executionId = typeof msg.executionId === "string" ? msg.executionId : undefined;
    const approved = msg.approved === true;
    const reason = typeof msg.reason === "string" ? msg.reason : undefined;

    if (executionId) {
      if (approved) await this.approveExecution(executionId);
      else await this.rejectExecution(executionId, reason);
      return;
    }
    if (!toolCallId) return;

    const session = await this.ensureSession();
    const last = await session.getLatestLeaf();
    if (!last || last.role !== "assistant") return;
    const part = last.parts.find((p): p is ToolPart => isToolPart(p) && p.toolCallId === toolCallId);
    if (!part || part.state !== "approval-requested") return;

    let updatedPart: MessagePart;
    if (!approved) {
      updatedPart = {
        ...part,
        state: "output-error",
        errorText: actionRejectionErrorValue(toolName(part), reason).error.message,
      };
    } else {
      const requestId = this.getLastRequestId() ?? "";
      const channelId = this.host.store.get<string>(this.channelKey(requestId));
      const { tools } = await this.buildAssembly(channelId, undefined);
      const name = toolName(part);
      const ctx: ToolExecutionContext = {
        toolCallId,
        requestId,
        messages: await session.getHistory(),
        signal: new AbortController().signal,
      };
      const { output, isError } = await tools.execute(name, part.input, ctx);
      updatedPart = isError
        ? { ...part, state: "output-error", errorText: typeof output === "string" ? output : JSON.stringify(output) }
        : { ...part, state: "output-available", output };
    }

    const updated: ChatMessage = { ...last, parts: last.parts.map((p) => (p === part ? updatedPart : p)) };
    await session.updateMessage(updated);
    const requestId = this.getLastRequestId();
    if (requestId) this.recordPartial(requestId, updated);
    this.broadcast(JSON.stringify({ type: "cf_agent_message_updated", message: updated }));
    this.maybeAutoContinue(updated);
  }
}
