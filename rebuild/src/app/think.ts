import { AbortedError, ValidationError, toErrorValue, type ErrorValue } from "../kernel/errors.js";
import { scoped } from "../ports/storage.js";
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
  userMessage,
  type ChatMessage,
  type MessagePart,
  type ToolPart,
} from "../domain/messages/model.js";
import { repairTranscript } from "../domain/messages/repair.js";
import { createAccumulator, type UiChunk } from "../domain/stream/chunks.js";
import { createConversationTurnState, type ConversationTurnState } from "../domain/chat/turn-state.js";
import { relayTurn } from "../domain/events/relay.js";
import { createPendingInteractions, type PendingInteractions } from "../domain/chat/continuation.js";
import { assembleTurn } from "../domain/chat/assembly.js";
import type {
  AfterToolCallContext,
  AssembledTools,
  BeforeToolCallContext,
  ToolCallDecision,
  ToolHooks,
} from "../domain/tools/registry.js";
import type { Tool, ToolSet } from "../domain/tools/types.js";
import {
  createSession,
  type ContextProviderLike,
  type ContextBlockConfig,
  type Session,
  type SessionConfig,
  type SessionStatus,
} from "../domain/session/session.js";
import { SessionBuilderImpl, type SessionBuilder } from "../domain/session/builder.js";
import {
  createSubmissionService,
  type SubmissionRecord,
  type SubmissionService,
} from "../domain/submissions/submissions.js";
import {
  createActionService,
  type Action,
  type ActionAuthorizationContext,
  type ActionService,
  type ActionTurnContext,
  type AuthorizationDecision,
  type PendingApproval,
  type ReplyAttachment,
} from "../domain/actions/actions.js";
import {
  DECLARED_TASK_CALLBACK,
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
import type { FiberRecoveryContext, FiberRecoveryResult } from "../domain/fibers/fibers.js";

// ---------------------------------------------------------------------------
// Public API types
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

/** Re-exported for API compatibility (moved to domain/session/builder.ts per audit 26 extraction 6). */
export type { SessionBuilder } from "../domain/session/builder.js";

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

interface AdmittedTurnSpec {
  requestId: string;
  trigger: TurnContext["trigger"];
  continuation: boolean;
  newMessages: ChatMessage[];
  channelId?: string;
  clientTools?: ToolSet;
}

// ---------------------------------------------------------------------------
// Think
// ---------------------------------------------------------------------------

/**
 * Think composes the chat domain services over Agent: a thin composition
 * root wiring domain modules and exposing chat entry points. It never speaks
 * a wire protocol — only typed methods and `ConversationEvent`s (audit 25).
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
  private readonly turnState: ConversationTurnState;
  private readonly submissionService: SubmissionService;
  private readonly channelService: ChannelService;
  private readonly scheduledTaskService: ScheduledTaskService;
  private readonly workspace: Workspace;
  private readonly agentRunsService?: AgentToolRunService;

  // --- lazily-built on first use so subclass field overrides (which only
  // apply once the subclass's own constructor has finished) are seen. ---
  private runtimeInitialized = false;
  private actionService!: ActionService;
  private overflowGuardService!: OverflowGuard;
  private chatRecoveryService!: ChatRecovery;
  private pendingInteractions!: PendingInteractions;

  private sessionInstance?: Session;
  private skillRegistryInstance?: SkillRegistry;

  /** In-memory only: adapters use this for the resume handshake; not durable across eviction (matches the turn queue's own liveness). */
  private activeTurnInfo: { requestId: string; startOffset: number } | null = null;

  constructor(host: AgentHost) {
    super(host);

    this.turnQueue = createTurnQueue();
    this.turnEngine = createTurnEngine({ clock: host.clock, ids: this.ids, bus: this.bus });
    this.turnState = createConversationTurnState({ store: scoped(host.store, "think:turnstate:") });
    this.workspace = createWorkspace({ store: scoped(host.store, "think:ws:"), clock: host.clock });

    this.submissionService = createSubmissionService({
      store: scoped(host.store, "think:"),
      clock: host.clock,
      ids: this.ids,
      bus: this.bus,
      runSubmission: (record, signal) => this.runSubmissionTurn(record, signal),
    });

    this.channelService = createChannelService({
      bus: this.bus,
      transcriptNotice: (text, informModel) => this.appendTranscriptNotice(text, informModel),
    });

    this.scheduledTaskService = createScheduledTaskService({
      store: scoped(host.store, "think:"),
      scheduler: this.schedulerService,
      submissions: this.submissionService,
      clock: host.clock,
      bus: this.bus,
      defaultTimezone: () => this.getDefaultTimezone(),
      declarations: () => this.getScheduledTasks(),
    });
    this.registerInternalCallback(DECLARED_TASK_CALLBACK, (payload) =>
      this.scheduledTaskService.runOccurrence(payload as { taskId: string; scheduledFor: number }),
    );

    if (host.spawner) {
      const registry = createSubAgentRegistry({ store: host.store, spawner: host.spawner, clock: host.clock, ids: this.ids });
      this.agentRunsService = createAgentToolRunService({
        store: scoped(host.store, "think:"),
        registry,
        clock: host.clock,
        ids: this.ids,
        bus: this.bus,
        onEvent: (runId, event) => this.publishEvent({ type: "run:event", runId, event }),
        hooks: {
          onRunStart: (run) => this.onAgentToolStart?.(run),
          onRunFinish: (run) => this.onAgentToolFinish?.(run),
          onProgress: (runId, progress) => this.onProgress?.(runId, progress),
        },
      });
    }

    // Drives the recovering:changed event from the recovery module's telemetry.
    this.bus.subscribe("chat", (e) => {
      const requestId = typeof e.payload.requestId === "string" ? e.payload.requestId : undefined;
      if (e.type === "chat:recovery:scheduled") {
        this.publishEvent({ type: "recovering:changed", active: true, ...(requestId ? { requestId } : {}) });
      } else if (
        e.type === "chat:recovery:completed" ||
        e.type === "chat:recovery:exhausted" ||
        e.type === "chat:recovery:skipped"
      ) {
        this.publishEvent({ type: "recovering:changed", active: false, ...(requestId ? { requestId } : {}) });
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
      bus: this.bus,
      ...(this.authorizeTurn ? { authorizeTurn: (ctx: ActionTurnContext) => this.authorizeTurn!(ctx) } : {}),
      ...(this.authorizeAction ? { authorizeAction: (ctx: ActionAuthorizationContext) => this.authorizeAction!(ctx) } : {}),
      pendingRetryLeaseMs: this.actionLedgerPendingRetryLeaseMs,
      onResolved: (executionId, resolution) => this.pendingInteractions.onExecutionResolved(executionId, resolution),
    });

    this.overflowGuardService = createOverflowGuard({
      ...(this.contextOverflow ? { config: this.contextOverflow } : {}),
      ...(this.classifyChatError ? { classify: this.classifyChatError } : {}),
      compact: () => this.compactSession(),
      bus: this.bus,
    });

    this.chatRecoveryService = createChatRecovery({
      store: scoped(this.host.store, "think:"),
      fibers: this.fiberService,
      clock: this.host.clock,
      ids: this.ids,
      bus: this.bus,
      policy: this.resolvedRecoveryPolicy(),
      conversation: {
        turnState: this.turnState,
        session: () => this.ensureSession(),
        repairPart: () => this.repairInterruptedToolPart,
        publish: (event) => this.publishEvent(event),
        scheduleTurn: (incident) => this.scheduleRecoveryTurn(incident),
        onTerminal: async (incident, terminalText) => {
          if (this.onChatError) {
            await this.onChatError(new Error(terminalText), { requestId: incident.requestId, stage: "recovery" });
          }
        },
      },
    });

    this.pendingInteractions = createPendingInteractions({
      session: () => this.ensureSession(),
      actions: this.actionService,
      tools: async () => {
        const requestId = this.turnState.lastRequestId();
        const channelId = requestId ? this.turnState.channelFor(requestId) : undefined;
        return (await this.buildAssembly(channelId, undefined)).tools;
      },
      requestId: () => this.turnState.lastRequestId(),
      publish: (e) => this.publishEvent(e),
      requestContinuation: () => {
        void this.continueLastTurn().catch((err: unknown) => {
          this.bus.emit("chat:continuation:failed", { error: toErrorValue(err) });
        });
      },
      debounceMs: this.chatToolResultDebounceMs,
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
    // Audit 13: declared scheduled tasks reconcile on startup. Invalid
    // declarations throw here, before any schedule rows are persisted.
    await this.reconcileScheduledTasks();
  }

  protected override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    this.ensureRuntime();
    return this.chatRecoveryService.onFiberRecovered(ctx);
  }

  override async destroy(): Promise<void> {
    this.pendingInteractions?.cancelPending();
    await super.destroy();
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
      // Fixed, not `this.ids.newId("session")`: a Think instance has exactly
      // one conversation over its store, and audit 10 documents the session
      // (frozen prompt included) as surviving recreation over the same KV —
      // which a per-instance-random id would silently break, orphaning all
      // prior history (and the chat-recovery machinery built on top of it)
      // the moment a fresh instance is constructed over the same store.
      sessionId: "main",
      blocks: [baseBlock, ...configured.extraBlocks],
      onStatus: (s) => this.publishSessionStatus(s),
      onCompactionError: (e) => this.bus.emit("chat:context:compaction_error", { error: toErrorValue(e) }),
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

  private publishSessionStatus(status: SessionStatus): void {
    this.publishEvent({
      type: "session:status",
      phase: status.phase,
      tokenEstimate: status.tokenEstimate,
      ...(status.tokenThreshold !== undefined ? { tokenThreshold: status.tokenThreshold } : {}),
    });
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

    const workspaceTools = this.workspaceTools ? createWorkspaceTools(this.workspace) : undefined;
    const fetchTools = this.fetchTools
      ? createFetchTools(this.fetchTools, { fetch: this.getFetchClient(), workspace: this.workspace, bus: this.bus, clock: this.host.clock })
      : undefined;
    const actionsToolSet = this.actionService.compile(this.getActions());

    const hooks: ToolHooks = {};
    if (this.beforeToolCall) hooks.beforeToolCall = (ctx) => this.beforeToolCall!(ctx);
    if (this.afterToolCall) hooks.afterToolCall = (ctx) => this.afterToolCall!(ctx);

    const { system, tools } = await assembleTurn({
      session,
      skills,
      policy,
      ...(workspaceTools ? { workspaceTools } : {}),
      ...(fetchTools ? { fetchTools } : {}),
      actions: actionsToolSet,
      userTools: this.getTools(),
      ...(clientTools ? { clientTools } : {}),
      hooks,
      clock: this.host.clock,
    });

    return { system, tools, policy };
  }

  // ==========================================================================
  // Turn orchestration
  // ==========================================================================

  private toMessages(input: string | ChatMessage[]): ChatMessage[] {
    if (typeof input === "string") return [userMessage(input, this.ids.newId("msg"))];
    return input;
  }

  private async executeTurn(spec: AdmittedTurnSpec & { admission?: "queue" | "replace" | "reject" }): Promise<TurnOutcome> {
    this.ensureRuntime();
    return this.turnQueue.run({
      requestId: spec.requestId,
      trigger: spec.trigger,
      admission: spec.admission ?? "queue",
      execute: (signal) => this.runAdmittedTurn(spec, signal),
    });
  }

  private async runAdmittedTurn(spec: AdmittedTurnSpec, queueSignal: AbortSignal): Promise<TurnOutcome> {
    this.turnState.setLastRequestId(spec.requestId);
    if (spec.channelId) this.turnState.stampChannel(spec.requestId, spec.channelId);

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

      const started = this.events().publish({
        type: "turn:started",
        requestId: spec.requestId,
        trigger: spec.trigger,
        ...(spec.channelId ? { channelId: spec.channelId } : {}),
      });
      this.activeTurnInfo = { requestId: spec.requestId, startOffset: started.offset };

      const accumulator = createAccumulator();
      const emit = (chunk: UiChunk): void => {
        accumulator.push(chunk);
        this.publishEvent({ type: "chunk", requestId: spec.requestId, chunk });
        this.turnState.recordPartial(spec.requestId, accumulator.current());
      };

      // getModel() may throw (e.g. the default implementation); resolve it up
      // front so that failure goes through the normal error-outcome pipeline.
      let model: ModelClient;
      try {
        model = this.getModel();
      } catch (err) {
        emit({ type: "start", messageId: this.ids.newId("msg") });
        emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        emit({ type: "finish", finishReason: "error" });
        const errorOutcome: TurnOutcome = { kind: "error", error: err, steps: [] };
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
          this.activeTurnInfo = null;
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
      this.turnState.recordPartial(spec.requestId, message);
      this.publishEvent({ type: "message:updated", message, requestId: spec.requestId });
    }

    switch (outcome.kind) {
      case "completed": {
        const attachments = this.actionService.attachments(spec.requestId);
        if (this.renderAttachment) for (const att of attachments) this.renderAttachment(att);
        this.bus.emit("message:response", { requestId: spec.requestId, messageId: message.id });
        if (this.onChatResponse) {
          await this.onChatResponse({ requestId: spec.requestId, outcome: "completed", message, attachments });
        }
        this.publishEvent({ type: "turn:settled", requestId: spec.requestId, outcome: "completed" });
        break;
      }
      case "suspended": {
        // Think stays metadata-blind: ActionService wrote the durablePause
        // metadata (compile()), so it also interprets it (audit 26 extr. 4).
        const parked = this.actionService.maybeParkSuspension({
          requestId: spec.requestId,
          pending: outcome.pending,
          tools: assembled,
        });
        this.publishEvent({
          type: "turn:settled",
          requestId: spec.requestId,
          outcome: "suspended",
          suspendedOn: parked.parked ? "durable-pause" : outcome.reason,
        });
        break;
      }
      case "aborted": {
        this.bus.emit("message:cancel", { requestId: spec.requestId, reason: outcome.reason });
        this.publishEvent({
          type: "turn:settled",
          requestId: spec.requestId,
          outcome: "cancelled",
          ...(outcome.reason ? { errorText: outcome.reason } : {}),
        });
        break;
      }
      case "error": {
        const classification = this.classifyChatError?.(outcome.error) || undefined;
        const ctx: ChatErrorContext = { requestId: spec.requestId, stage: "turn" };
        if (classification) ctx.classification = classification;
        if (this.onChatError) await this.onChatError(outcome.error, ctx);
        this.publishEvent({
          type: "turn:settled",
          requestId: spec.requestId,
          outcome: "failed",
          errorText: toErrorValue(outcome.error).message,
        });
        break;
      }
    }

    this.activeTurnInfo = null;
  }

  // ==========================================================================
  // Recovery conversation callbacks
  // ==========================================================================

  /**
   * The one recovery callback (audit 26 §1): the recovery module owns what
   * retry/continue/terminalize MEAN; Think only enqueues the recovery turn.
   * Fire-and-forget by contract — this can be invoked from within the
   * currently-running turn (stall path), so awaiting completion would
   * deadlock the turn queue.
   */
  private scheduleRecoveryTurn(incident: Incident): void {
    if (this.onChatRecovery) {
      void this.onChatRecovery({
        requestId: incident.requestId,
        incidentId: incident.incidentId,
        attempt: incident.attempt,
      });
    }
    void this.executeTurn({
      requestId: incident.requestId,
      trigger: "continuation",
      continuation: true,
      newMessages: [],
    }).catch((err: unknown) => {
      this.bus.emit("chat:recovery:run_failed", {
        requestId: incident.requestId,
        incidentId: incident.incidentId,
        error: toErrorValue(err),
      });
    });
  }

  // ==========================================================================
  // Entry points (audit 23 "Entry points")
  // ==========================================================================

  /**
   * Relays this turn's events onto `callback` (sub-agent / streaming
   * callers) via `relayTurn` (domain/events/relay.ts, audit 25 §5): a
   * subscription installed before the turn starts, so it only ever needs
   * "live" (nothing to catch up on). Adapters relaying an *already
   * in-flight* turn use the same primitive directly, from the turn's
   * `startOffset` (see adapters/relay/child-relay.ts).
   */
  async chat(input: string | ChatMessage[], callback?: StreamCallback, opts?: { channel?: string; requestId?: string; clientTools?: ToolSet }): Promise<TurnResult> {
    this.ensureRuntime();
    const requestId = opts?.requestId ?? this.ids.newId("req");
    const newMessages = this.toMessages(input);

    const unsubscribe = callback ? relayTurn(this.events(), requestId, callback) : undefined;

    try {
      const outcome = await this.executeTurn({
        requestId,
        trigger: "chat",
        continuation: false,
        newMessages,
        ...(opts?.channel ? { channelId: opts.channel } : {}),
        ...(opts?.clientTools ? { clientTools: opts.clientTools } : {}),
      });
      return this.toTurnResult(requestId, outcome);
    } catch (err) {
      callback?.onError(toErrorValue(err));
      return { requestId, outcome: "error", error: toErrorValue(err) };
    } finally {
      unsubscribe?.();
    }
  }

  private toTurnResult(requestId: string, outcome: TurnOutcome): TurnResult {
    const result: TurnResult = { requestId, outcome: outcome.kind };
    const stored = this.turnState.partialFor(requestId);
    if (stored) result.message = stored;
    if (outcome.kind === "error") result.error = toErrorValue(outcome.error);
    if (outcome.kind === "aborted") result.error = { name: "AbortedError", message: outcome.reason ?? "aborted" };
    return result;
  }

  async runTurn(args: {
    input: string | ChatMessage[];
    channel?: string;
    clientTools?: ToolSet;
    mode: "wait" | "submit" | "stream";
    callback?: StreamCallback;
  }): Promise<TurnResult | (SubmissionRecord & { accepted: boolean }) | void> {
    this.ensureRuntime();
    if (args.mode === "submit") {
      return this.submitMessages(this.toMessages(args.input));
    }
    const opts: { channel?: string; clientTools?: ToolSet } = {};
    if (args.channel) opts.channel = args.channel;
    if (args.clientTools) opts.clientTools = args.clientTools;
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

  inspectSubmission(submissionId: string): SubmissionRecord | null {
    this.ensureRuntime();
    return this.submissionService.inspect(submissionId);
  }

  listSubmissions(options?: Parameters<SubmissionService["list"]>[0]): SubmissionRecord[] {
    this.ensureRuntime();
    return this.submissionService.list(options);
  }

  async cancelSubmission(submissionId: string, reason?: string): Promise<boolean> {
    this.ensureRuntime();
    return this.submissionService.cancel(submissionId, reason);
  }

  deleteSubmissions(options?: Parameters<SubmissionService["deleteSubmissions"]>[0]): number {
    this.ensureRuntime();
    return this.submissionService.deleteSubmissions(options);
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

  /** Repaired transcript — what `onConnect` used to send. */
  async history(): Promise<ChatMessage[]> {
    this.ensureRuntime();
    const session = await this.ensureSession();
    const rawHistory = await session.getHistory();
    return repairTranscript(rawHistory, this.repairInterruptedToolPart ? { repairPart: this.repairInterruptedToolPart } : undefined).messages;
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
    this.pendingInteractions.cancelPending();
    this.turnState.setLastRequestId(undefined);
    this.publishEvent({ type: "conversation:cleared" });
  }

  cancelChat(requestId: string, reason?: string): boolean {
    return this.turnQueue.cancel(requestId, reason);
  }

  cancelAllChats(reason?: string): void {
    this.turnQueue.cancelAll(reason);
  }

  async continueLastTurn(): Promise<TurnOutcome | undefined> {
    this.ensureRuntime();
    const requestId = this.turnState.lastRequestId();
    if (!requestId) return undefined;
    return this.executeTurn({
      requestId: this.ids.newId("req"),
      trigger: "continuation",
      continuation: true,
      newMessages: [],
    });
  }

  /** Lets adapters implement the resume handshake: the currently-streaming turn, if any. */
  activeTurn(): { requestId: string; startOffset: number } | null {
    return this.activeTurnInfo;
  }

  /**
   * Whether an interruption/stall recovery is currently in flight — lets an
   * adapter mirror this at connect time (audit 25 §4). Not covered by
   * `activeTurn()`: recovery can be scheduled (an alarm/fiber retry
   * pending) between admissions, when no turn is actively streaming.
   */
  isRecovering(): boolean {
    this.ensureRuntime();
    return this.chatRecoveryService.isRecovering();
  }

  // ==========================================================================
  // Client-tool / approval resolution (audit 25 §2; delegates to PendingInteractions)
  // ==========================================================================

  async applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void> {
    this.ensureRuntime();
    await this.pendingInteractions.applyToolResult(args);
  }

  async resolveApproval(args: { toolCallId?: string; executionId?: string; approved: boolean; reason?: string }): Promise<void> {
    this.ensureRuntime();
    await this.pendingInteractions.resolveApproval(args);
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
    this.publishEvent({ type: "message:updated", message });
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
}
