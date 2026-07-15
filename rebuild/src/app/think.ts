import { AbortedError, ValidationError, toErrorValue } from "../kernel/errors.js";
import { scoped } from "../ports/storage.js";
import type { ModelClient } from "../ports/model.js";
import type { FetchLike } from "../ports/http.js";

import type { AgentRuntime } from "./agent.js";
import {
  ChatAgent,
  combineSignals,
  type AdmittedTurnSpec,
  type ChatErrorContext,
  type ChatResponseResult,
  type StreamCallback,
  type TurnResult,
  type WaitUntilStableOptions,
} from "./chat-agent.js";
import type { ApprovalApi, RecoveryIntrospection } from "./capabilities.js";

import type { StepResult, TurnContext, TurnOutcome } from "../domain/turn/loop.js";
import { assistantMessage, type ChatMessage } from "../domain/messages/model.js";
import {
  createSubmissionService,
  type SubmissionRecord,
  type SubmissionService,
} from "../domain/reliability/submissions/submissions.js";
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
} from "../domain/reliability/scheduled-tasks/tasks.js";
import {
  createChatRecovery,
  type ChatRecoveryContext,
  type ChatRecoveryDecision,
  type ChatRecovery,
  type Incident,
  type RecoverySchedule,
  type RecoveryPolicy,
  type TurnInputSnapshot,
} from "../domain/reliability/recovery/recovery.js";
import {
  createOverflowGuard,
  defaultContextOverflowClassifier,
  type ChatErrorClassification,
  type OverflowGuard,
} from "../domain/reliability/recovery/overflow.js";
import { createWorkspace, type Workspace } from "../domain/workspace/workspace.js";
import { createWorkspaceTools } from "../domain/workspace/tools.js";
import { createFetchTools, type FetchToolConfig } from "../domain/fetch/fetch-tool.js";
import { createSkillRegistry, type SkillRegistry, type SkillSource } from "../domain/skills/skills.js";
import {
  createChannelService,
  type ChannelDefinition,
  type ChannelService,
  type DeliverNoticeOptions,
} from "../domain/channels/channels.js";
import { assembleTurn } from "../domain/conversation/assembly.js";
import type { AssembledTools, ToolHooks } from "../domain/tools/registry.js";
import type { Tool, ToolSet } from "../domain/tools/types.js";
import {
  agentTool as buildAgentTool,
  createAgentToolRunService,
  type AgentToolRun,
  type AgentToolRunService,
  type RunStatus,
} from "../domain/delegation/runs.js";
import { createSubAgentRegistry } from "../domain/delegation/registry.js";
import type { FiberRecoveryContext, FiberRecoveryResult } from "../domain/runtime/fibers/fibers.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ContextOverflowConfig {
  reactive?: boolean;
  maxRetries?: number;
  proactive?: { maxInputTokens: number; maxCompactions?: number };
}

// Re-exported for API compatibility: these moved to chat-agent.ts (ADR-0002
// migration, ChatAgent = essence layer) but every ported/adapter/test import
// still points at "./think.js" — see the ADR's "Import compatibility" note.
export type {
  ChatErrorContext,
  ChatResponseResult,
  StreamCallback,
  TurnResult,
  WaitUntilStableOptions,
} from "./chat-agent.js";
export type { SessionBuilder } from "../domain/session/builder.js";

// ---------------------------------------------------------------------------
// Think
// ---------------------------------------------------------------------------

/**
 * Think (ADR-0002 layer 3, `docs/adr/0002-three-layers-agent-chatagent-think.md`):
 * `extends ChatAgent`. One opinionated composition over the conversing
 * essence — compaction/overflow guard, chat-recovery policy, channels,
 * branching sessions, HITL approvals, submissions, skills,
 * delegation-as-tools. It never speaks a wire protocol — only typed methods
 * and `ConversationEvent`s (audit 25). Like ChatAgent, it owns no domain
 * language of its own — every behavioral term belongs to a wired domain
 * module; Think only decides which ones compose and plugs them into
 * ChatAgent's turn-pipeline seams.
 */
export class Think<State = unknown> extends ChatAgent<State> implements ApprovalApi, RecoveryIntrospection {
  // --- configuration surface: plain overridable values (audit 23 table) ----
  chatRecovery: boolean | RecoveryPolicy = true;
  contextOverflow: ContextOverflowConfig | undefined;
  classifyChatError: ((error: unknown) => ChatErrorClassification | void) | undefined;
  actionLedgerPendingRetryLeaseMs: number | false = 300_000;
  workspaceTools = true;
  fetchTools: FetchToolConfig | false = false;

  // --- configuration surface: hooks -----------------------------------------
  authorizeTurn?: (ctx: ActionTurnContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeAction?: (ctx: ActionAuthorizationContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  onChatRecovery?: (ctx: ChatRecoveryContext) => void | ChatRecoveryDecision | Promise<void | ChatRecoveryDecision>;
  renderAttachment?: (att: ReplyAttachment) => unknown;
  onAgentToolStart?: (run: AgentToolRun) => void;
  onAgentToolFinish?: (run: AgentToolRun) => void;
  onProgress?: (runId: string, progress: unknown) => void;

  // --- eagerly-built services (safe: only capture callbacks, never bare config values) ---
  private readonly submissionService: SubmissionService;
  private readonly channelService: ChannelService;
  private readonly scheduledTaskService: ScheduledTaskService;
  private readonly workspace: Workspace;
  private readonly agentRunsService?: AgentToolRunService;

  // --- lazily-built on first use so subclass field overrides (which only
  // apply once the subclass's own constructor has finished) are seen. ---
  private thinkRuntimeInitialized = false;
  private actionService!: ActionService;
  private overflowGuardService!: OverflowGuard;
  private chatRecoveryService!: ChatRecovery;

  private skillRegistryInstance?: SkillRegistry;

  constructor(host: AgentRuntime) {
    super(host);

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

  protected getActions(): Record<string, Action> {
    return {};
  }

  protected getSkills(): SkillSource[] {
    return [];
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

  /**
   * Builds Think's own services BEFORE calling `super.ensureRuntime()` (the
   * reverse of the naive "super first" order): `super.ensureRuntime()`
   * constructs `pendingInteractions`, which reads `interactionActions()`
   * (seam 9) ONCE, eagerly, at construction time — so `actionService` must
   * already exist by then, or `pendingInteractions` would be permanently
   * wired to "no actions". (The alternative — a thunked `actions` dep on
   * `createPendingInteractions` — was rejected: it would have required
   * changing the ActionService dep on `domain/conversation/continuation.ts`
   * from a plain optional value to a function, breaking
   * `continuation.test.ts`'s existing (unmodified) fixtures.)
   */
  protected override ensureRuntime(): void {
    if (this.thinkRuntimeInitialized) return;
    this.thinkRuntimeInitialized = true;

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
      declaredActions: () => this.getActions(),
    });

    this.overflowGuardService = createOverflowGuard({
      config: () => this.contextOverflow,
      classify: (e) => this.classifyChatError?.(e) ?? defaultContextOverflowClassifier(e),
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
          // #1645: retain the terminal so a client reconnecting AFTER the
          // exhaustion can still receive it over the resume handshake
          // (adapters read it via pendingChatTerminal()).
          this.turnState.recordTerminal(incident.requestId, terminalText);
          if (this.onChatError) {
            await this.onChatError(new Error(terminalText), { requestId: incident.requestId, stage: "recovery" });
          }
        },
        onRecovery: (ctx) => this.onChatRecovery?.(ctx),
      },
    });

    super.ensureRuntime();
  }

  private get recoveryEnabled(): boolean {
    return this.chatRecovery !== false;
  }

  private resolvedRecoveryPolicy(): RecoveryPolicy {
    if (this.chatRecovery === true || this.chatRecovery === false) return {};
    return this.chatRecovery;
  }

  protected override async onStart(): Promise<void> {
    await super.onStart();
    // Audit 13: declared scheduled tasks reconcile on startup. Invalid
    // declarations throw here, before any schedule rows are persisted.
    await this.reconcileScheduledTasks();
  }

  protected override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    this.ensureRuntime();
    return this.chatRecoveryService.onFiberRecovered(ctx);
  }

  // ==========================================================================
  // Session / skills (lazy)
  // ==========================================================================

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

  // ==========================================================================
  // Tool + system-prompt assembly (seam 1 — ChatAgent's base has no opinion)
  // ==========================================================================

  protected override async assembleTurnResources(
    channelId: string | undefined,
    clientTools: ToolSet | undefined,
  ): Promise<{ system: string; tools: AssembledTools; maxSteps?: number }> {
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

    return { system, tools, maxSteps: policy.maxTurns };
  }

  // ==========================================================================
  // Turn-pipeline seam overrides (opinions plugged into ChatAgent's pipeline)
  // ==========================================================================

  protected override async runInTurnScope<T>(spec: AdmittedTurnSpec, fn: () => Promise<T>): Promise<T> {
    const resolved = this.channelService.resolve(spec.channelId);
    return this.channelService.runWithActive(resolved, fn);
  }

  protected override async onTurnAdmitted(turnCtx: TurnContext): Promise<void> {
    await this.actionService.authorizeTurnOnce(turnCtx);
  }

  protected override onTurnFinished(requestId: string): void {
    this.actionService.clearTurn(requestId);
  }

  protected override async runTurnExecutable(args: {
    requestId: string;
    snapshot: TurnInputSnapshot;
    queueSignal: AbortSignal;
    execute: (signal: AbortSignal) => Promise<TurnOutcome>;
  }): Promise<TurnOutcome> {
    if (!this.recoveryEnabled) return args.execute(args.queueSignal);
    return this.chatRecoveryService.runRecoverable({
      requestId: args.requestId,
      input: args.snapshot,
      execute: (fiberSignal) => args.execute(combineSignals(args.queueSignal, fiberSignal)),
    });
  }

  protected override async onStepSettled(step: StepResult, requestId: string): Promise<void> {
    await this.overflowGuardService.maybeCompactBeforeStep(step.usage, requestId);
  }

  protected override async handleTurnError(
    outcome: Extract<TurnOutcome, { kind: "error" }>,
    spec: AdmittedTurnSpec,
  ): Promise<"return-early" | "retry" | "pass"> {
    if (outcome.stalled && this.recoveryEnabled) {
      const result = await this.chatRecoveryService.handleStall(spec.requestId);
      if (result === "recovering") return "return-early";
      // terminal: chatRecoveryService already persisted a terminal message via conversation.terminalize().
      return "pass";
    }
    const action = await this.overflowGuardService.handleTurnError(outcome.error, spec.requestId);
    return action === "retry" ? "retry" : "pass";
  }

  protected override turnAttachments(requestId: string): ReplyAttachment[] {
    return this.actionService.attachments(requestId);
  }

  protected override onAttachmentsReady(attachments: ReplyAttachment[]): void {
    if (this.renderAttachment) for (const att of attachments) this.renderAttachment(att);
  }

  protected override parkSuspension(args: {
    requestId: string;
    pending: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
    tools: AssembledTools;
  }): { parked: boolean } {
    return this.actionService.maybeParkSuspension(args);
  }

  protected override classifyTurnError(error: unknown): ChatErrorClassification | undefined {
    return this.classifyChatError?.(error) || undefined;
  }

  protected override interactionActions(): ActionService | undefined {
    return this.actionService;
  }

  protected override async submitTurn(messages: ChatMessage[]): Promise<SubmissionRecord & { accepted: boolean }> {
    return this.submitMessages(messages);
  }

  protected override onConversationCleared(): void {
    this.submissionService.markAllPendingSkipped();
  }

  protected override extraStabilityWaiters(): Array<{ quiet: boolean; wait(): Promise<void> }> {
    return [
      {
        quiet: !this.chatRecoveryService.isRecovering(),
        wait: () => this.chatRecoveryService.waitUntilStable(),
      },
    ];
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
  // Entry points (audit 23 "Entry points") — opinions beyond ChatAgent's essence
  // ==========================================================================

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

  /**
   * #1645, adapter-facing (same family as activeTurn/isRecovering): a turn
   * that terminalized while no client was connected, retained until a new
   * turn is submitted or the conversation is cleared. Adapters deliver it
   * over the resume handshake — a raw on-connect frame is dropped by real
   * clients.
   */
  pendingChatTerminal(): { requestId: string; body: string } | null {
    return this.turnState.pendingTerminal();
  }

  /** Test seam for #1645 fixtures: simulate an exhaustion recorded out-of-band. */
  protected recordChatTerminal(requestId: string, body: string): void {
    this.turnState.recordTerminal(requestId, body);
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

  chatRecoveryIncidents(): Incident[] {
    this.ensureRuntime();
    return this.chatRecoveryService.incidents();
  }

  chatRecoverySchedule(): RecoverySchedule[] {
    this.ensureRuntime();
    return this.chatRecoveryService.scheduledRecoveries();
  }

  // ==========================================================================
  // Client-tool / approval resolution (audit 25 §2; delegates to PendingInteractions)
  // ==========================================================================

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
