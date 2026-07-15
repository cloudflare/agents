import { ValidationError, toErrorValue, type ErrorValue } from "../kernel/errors.js";
import { scoped } from "../ports/storage.js";
import type { ModelChunk, ModelClient, ModelMessage } from "../ports/model.js";

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
import { userMessage, type ChatMessage, type MessagePart, type ToolPart } from "../domain/messages/model.js";
import { repairTranscript } from "../domain/messages/repair.js";
import { reconcileIncoming } from "../domain/messages/reconcile.js";
import { createAccumulator, type UiChunk } from "../domain/conversation/chunks.js";
import { createConversationTurnState, type ConversationTurnState } from "../domain/conversation/turn-state.js";
import { relayTurn } from "../domain/events/relay.js";
import { createPendingInteractions, type PendingInteractions } from "../domain/conversation/continuation.js";
import { assembleTurn } from "../domain/conversation/assembly.js";
import type {
  AfterToolCallContext,
  AssembledTools,
  BeforeToolCallContext,
  ToolCallDecision,
  ToolHooks,
} from "../domain/tools/registry.js";
import type { ToolSet } from "../domain/tools/types.js";
import {
  createSession,
  type ContextBlockConfig,
  type Session,
  type SessionConfig,
  type SessionStatus,
} from "../domain/session/session.js";
import { SessionBuilderImpl, type SessionBuilder } from "../domain/session/builder.js";
/** Type-only: this domain module already names these types on ChatAgent's own
 * public surface (runTurn/submitTurn) — see the module docblock's "type-only
 * imports" note in the ADR. ChatAgent never constructs a SubmissionService. */
import type { SubmissionRecord } from "../domain/reliability/submissions/submissions.js";
/** Type-only: ActionService only appears as the return type of the
 * `interactionActions()` seam (§9) — ChatAgent never constructs one. */
import type { ActionService, ReplyAttachment } from "../domain/actions/actions.js";
/** Type-only: TurnInputSnapshot only appears as a pass-through in the
 * `runTurnExecutable()` seam (§4) — ChatAgent never constructs a recovery
 * service; only Think's override reads its fields. */
import type { TurnInputSnapshot } from "../domain/reliability/recovery/recovery.js";
/** Type-only: ChatErrorClassification only appears in the `classifyTurnError()`
 * seam (§8) and the `onChatError` hook's context — ChatAgent never classifies
 * anything itself (that's Think's overflow-guard opinion). */
import type { ChatErrorClassification } from "../domain/reliability/recovery/overflow.js";

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

export interface ChatResponseResult {
  requestId: string;
  outcome: "completed" | "error" | "aborted";
  status: "completed" | "error" | "aborted";
  message: ChatMessage;
  attachments: ReplyAttachment[];
  continuation: boolean;
  error?: string;
}

export interface ChatErrorContext {
  requestId: string;
  stage: "turn" | "recovery";
  classification?: ChatErrorClassification;
}

export interface WaitUntilStableOptions {
  timeoutMs?: number;
}

/** Re-exported for API compatibility (moved to domain/session/builder.ts per audit 26 extraction 6). */
export type { SessionBuilder } from "../domain/session/builder.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Combines multiple AbortSignals into one that aborts when any of them does. */
export function combineSignals(...signals: AbortSignal[]): AbortSignal {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Internal turn-admission spec, shared with Think's seam overrides. */
export interface AdmittedTurnSpec {
  requestId: string;
  trigger: TurnContext["trigger"];
  continuation: boolean;
  newMessages: ChatMessage[];
  channelId?: string;
  clientTools?: ToolSet;
}

// ---------------------------------------------------------------------------
// ChatAgent
// ---------------------------------------------------------------------------

/**
 * ChatAgent (ADR-0002 layer 2, `docs/adr/0002-three-layers-agent-chatagent-think.md`):
 * `extends Agent`. The unopinionated essence of conversing — model binding,
 * the turn loop (streaming, tool dispatch), transcript persistence/history,
 * and the conversation event *vocabulary* published onto the substrate's
 * event log. No policies: no compaction, no recovery policy, no channels, no
 * HITL, no submissions, no skills, no delegation-as-tools. Those are Think's
 * opinions (or any other composition's). A userland subclass can converse by
 * extending ChatAgent directly, with none of Think's opinions along for the
 * ride.
 */
export class ChatAgent<State = unknown> extends Agent<State> {
  // --- configuration surface: plain overridable values -----------------------
  maxSteps = 10;
  sendReasoning = true;
  chatStreamStallTimeoutMs = 0;
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
  repairInterruptedToolPart?: (part: ToolPart) => MessagePart;

  // --- eagerly-built services (safe: only capture callbacks, never bare config values) ---
  private readonly turnQueue: TurnQueue;
  private readonly turnEngine: TurnEngine;
  protected readonly turnState: ConversationTurnState;

  // --- lazily-built on first use so subclass field overrides (which only
  // apply once the subclass's own constructor has finished) are seen. ---
  private runtimeInitialized = false;
  /**
   * Protected: Think's own `ensureRuntime()` addition wires its ActionService's
   * `onResolved` callback directly to `this.pendingInteractions.onExecutionResolved`.
   */
  protected pendingInteractions!: PendingInteractions;

  private sessionInstance?: Session;

  /** In-memory only: adapters use this for the resume handshake; not durable across eviction (matches the turn queue's own liveness). */
  private activeTurnInfo: { requestId: string; startOffset: number } | null = null;

  constructor(host: AgentHost) {
    super(host);

    this.turnQueue = createTurnQueue();
    this.turnEngine = createTurnEngine({ clock: host.clock, ids: this.ids, bus: this.bus });
    this.turnState = createConversationTurnState({ store: scoped(host.store, "think:turnstate:") });
  }

  // ==========================================================================
  // Config surface: overridable methods
  // ==========================================================================

  protected getModel(): ModelClient {
    throw new ValidationError("ChatAgent subclasses must override getModel() to provide a ModelClient");
  }

  protected getSystemPrompt(): string {
    return "You are a careful, helpful assistant. Use the tools available to you when they help, think " +
      "before acting, and say plainly when you are unsure.";
  }

  protected getTools(): ToolSet {
    return {};
  }

  protected configureSession(builder: SessionBuilder): SessionBuilder {
    return builder;
  }

  // ==========================================================================
  // Runtime bundle (lazy — see field comment above)
  // ==========================================================================

  /**
   * Builds `pendingInteractions`. Protected + overridable: Think's override
   * builds its own opinion services (channels, actions, overflow guard,
   * chat recovery) *before* calling `super.ensureRuntime()`, so that
   * `interactionActions()` (§9) already resolves the real ActionService by
   * the time this constructs `pendingInteractions` — see chat-agent.test.ts
   * and think.ts's `ensureRuntime()` override for the ordering rationale.
   */
  protected ensureRuntime(): void {
    if (this.runtimeInitialized) return;
    this.runtimeInitialized = true;

    this.pendingInteractions = createPendingInteractions({
      session: () => this.ensureSession(),
      actions: this.interactionActions(),
      tools: async () => {
        const requestId = this.turnState.lastRequestId();
        const channelId = requestId ? this.turnState.channelFor(requestId) : undefined;
        return (await this.assembleTurnResources(channelId, undefined)).tools;
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

  protected override async onStart(): Promise<void> {
    this.ensureRuntime();
  }

  override async destroy(): Promise<void> {
    this.pendingInteractions?.cancelPending();
    await super.destroy();
  }

  // ==========================================================================
  // Session (lazy)
  // ==========================================================================

  protected async ensureSession(): Promise<Session> {
    if (this.sessionInstance) return this.sessionInstance;
    const builder = new SessionBuilderImpl();
    const configured = (this.configureSession(builder) ?? builder) as SessionBuilderImpl;

    const baseBlock: ContextBlockConfig = {
      label: "instructions",
      provider: { get: async () => this.getSystemPrompt() },
    };
    if (configured.baseMaxTokens !== undefined) baseBlock.maxTokens = configured.baseMaxTokens;

    const config: SessionConfig = {
      // Fixed, not `this.ids.newId("session")`: a ChatAgent instance has
      // exactly one conversation over its store, and audit 10 documents the
      // session (frozen prompt included) as surviving recreation over the
      // same KV — which a per-instance-random id would silently break,
      // orphaning all prior history (and the chat-recovery machinery built
      // on top of it) the moment a fresh instance is constructed over the
      // same store.
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

  /**
   * Seam 1 (ADR-0002 migration): base assembly is session system prompt +
   * user tools (getTools()) + clientTools + before/afterToolCall hooks — no
   * skills, no channel policy, no actions, no workspace/fetch tools. Think
   * overrides this with the full buildAssembly (skills, channel policy —
   * `maxSteps` derives from `policy.maxTurns` — actions, workspace, fetch).
   */
  protected async assembleTurnResources(
    _channelId: string | undefined,
    clientTools: ToolSet | undefined,
  ): Promise<{ system: string; tools: AssembledTools; maxSteps?: number }> {
    const session = await this.ensureSession();

    const hooks: ToolHooks = {};
    if (this.beforeToolCall) hooks.beforeToolCall = (ctx) => this.beforeToolCall!(ctx);
    if (this.afterToolCall) hooks.afterToolCall = (ctx) => this.afterToolCall!(ctx);

    const { system, tools } = await assembleTurn({
      session,
      userTools: this.getTools(),
      ...(clientTools ? { clientTools } : {}),
      hooks,
      clock: this.host.clock,
    });

    return { system, tools };
  }

  // ==========================================================================
  // Turn-pipeline seams (ADR-0002 migration; base = no opinion, "pass"/no-op)
  // ==========================================================================

  /** Seam 2: scope a turn's execution (Think: channel active-stack). Base: no scoping. */
  protected async runInTurnScope<T>(_spec: AdmittedTurnSpec, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /** Seam 3a: turn admitted, before it starts streaming (Think: authorizeTurnOnce). Base: no-op. */
  protected async onTurnAdmitted(_turnCtx: TurnContext): Promise<void> {}

  /** Seam 3b: turn finished (all exit paths — completion, early-return, error). Base: no-op. */
  protected onTurnFinished(_requestId: string): void {}

  /**
   * Seam 4: run one execution attempt of the turn. Base: no recoverability —
   * just runs `execute` under the admission queue's own signal. Think wraps
   * this in `chatRecoveryService.runRecoverable`, combining the queue signal
   * with the recovery fiber's own signal (see `combineSignals`, exported
   * above for Think's use).
   */
  protected async runTurnExecutable(args: {
    requestId: string;
    snapshot: TurnInputSnapshot;
    queueSignal: AbortSignal;
    execute: (signal: AbortSignal) => Promise<TurnOutcome>;
  }): Promise<TurnOutcome> {
    return args.execute(args.queueSignal);
  }

  /**
   * Seam 4b (ADR migration addition, not separately numbered in the ADR
   * table): a step just finished, after the caller's own `onStepFinish`
   * hook ran. Base: no-op. Think uses this for the overflow guard's
   * proactive mid-turn compaction — kept out of ChatAgent's base pipeline
   * because compaction/overflow is Think's opinion, not the essence's.
   */
  protected async onStepSettled(_step: StepResult, _requestId: string): Promise<void> {}

  /**
   * Seam 5: decide what to do after an error outcome. Base: always "pass"
   * (finalize as a normal error). Think: "return-early" for an in-flight
   * stall recovery (skip finalizeOutcome entirely — chatRecoveryService
   * already persisted a terminal message on exhaustion, or scheduled a
   * recovery turn), "retry" after the overflow guard compacted. The
   * mechanical retry work (refresh turnCtx.messages, reset accumulator,
   * clearPartial, re-resolve model) is pipeline work and stays here in the
   * caller (runAdmittedTurn) — a "retry" decision re-enters seam 4.
   */
  protected async handleTurnError(
    _outcome: Extract<TurnOutcome, { kind: "error" }>,
    _spec: AdmittedTurnSpec,
  ): Promise<"return-early" | "retry" | "pass"> {
    return "pass";
  }

  /** Seam 6: reply attachments for a request (Think: actionService.attachments). Base: none. */
  protected turnAttachments(_requestId: string): ReplyAttachment[] {
    return [];
  }

  /** Seam 6b: react to a completed turn's attachments (Think: renderAttachment hook loop). Base: no-op. */
  protected onAttachmentsReady(_attachments: ReplyAttachment[]): void {}

  /** Seam 7: maybe park a suspended turn as a durable-pause execution (Think: actionService). Base: never parks. */
  protected parkSuspension(_args: {
    requestId: string;
    pending: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
    tools: AssembledTools;
  }): { parked: boolean } {
    return { parked: false };
  }

  /** Seam 8: classify a turn error (Think: classifyChatError hook / default overflow classifier). Base: unclassified. */
  protected classifyTurnError(_error: unknown): ChatErrorClassification | undefined {
    return undefined;
  }

  /** Seam 9: the ActionService backing client-tool/approval continuation (Think only). Base: none composed. */
  protected interactionActions(): ActionService | undefined {
    return undefined;
  }

  /** Seam 10: `runTurn({ mode: "submit" })`'s implementation (Think: submissionService.submit). Base: unsupported. */
  protected async submitTurn(_messages: ChatMessage[]): Promise<SubmissionRecord & { accepted: boolean }> {
    throw new ValidationError("submissions are not supported on this agent (no SubmissionService composed)");
  }

  /** Seam 11: conversation cleared (Think: mark pending submissions skipped). Base: no-op. */
  protected onConversationCleared(): void {}

  /** Seam 12: extra waiters for waitUntilStable()/isQuiescent() (Think: chat-recovery service). Base: none. */
  protected extraStabilityWaiters(): Array<{ quiet: boolean; wait(): Promise<void> }> {
    return [];
  }

  // ==========================================================================
  // Turn orchestration
  // ==========================================================================

  private toMessages(input: string | ChatMessage[]): ChatMessage[] {
    if (typeof input === "string") return [userMessage(input, this.ids.newId("msg"))];
    return input;
  }

  protected async executeTurn(spec: AdmittedTurnSpec & { admission?: "queue" | "replace" | "reject" }): Promise<TurnOutcome> {
    this.ensureRuntime();
    // #1645, eager clear: submitting a genuinely-new turn supersedes any
    // retained terminal record at SUBMIT time — before the turn streams —
    // so a stale exhaustion can never replay over the new conversation.
    // Continuations resume the recorded turn and must not clear it.
    if (!spec.continuation) this.turnState.clearTerminal();
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

    return this.runInTurnScope(spec, async () => {
      if (spec.newMessages.length > 0) {
        // ISSUE-015: clients round-trip full arrays — collapse optimistic
        // duplicates of server-owned tool calls and never let a stale copy
        // downgrade a settled row.
        const history = await session.getHistory();
        const plan = reconcileIncoming(history, spec.newMessages);
        for (const m of plan.toUpdate) await session.updateMessage(m);
        for (const m of plan.toAppend) await session.appendMessage(m);
      }

      if (!spec.continuation) {
        // ISSUE-015: a NEW turn supersedes any still-unsettled tool call in
        // the transcript (an orphan from a crash or an abandoned interaction)
        // — repair it IN PLACE (preserved, flipped to output-error, inputs
        // normalized) so providers never 400 on replay. Continuations skip
        // this: they resume the interaction that owns those parts.
        const preTurn = await session.getHistory();
        const report = repairTranscript(preTurn, {
          repairPart: this.repairInterruptedToolPart,
          // approval-requested is parked, not orphaned: resolveApproval owns it.
          repairStates: new Set(["input-streaming", "input-available"]),
        });
        if (report.changed) {
          for (let i = 0; i < preTurn.length; i++) {
            if (report.messages[i] !== preTurn[i]) await session.updateMessage(report.messages[i]!);
          }
        }
      }

      const { system, tools: assembled, maxSteps: policyMaxSteps } = await this.assembleTurnResources(
        spec.channelId,
        spec.clientTools,
      );
      const history = await session.getHistory();
      const turnCtx: TurnContext = {
        requestId: spec.requestId,
        trigger: spec.trigger,
        continuation: spec.continuation,
        ...(spec.channelId ? { channelId: spec.channelId } : {}),
        messages: history,
      };

      await this.onTurnAdmitted(turnCtx);

      const started = this.events().publish({
        type: "turn:started",
        requestId: spec.requestId,
        trigger: spec.trigger,
        ...(spec.channelId ? { channelId: spec.channelId } : {}),
      });
      this.activeTurnInfo = { requestId: spec.requestId, startOffset: started.offset };

      let accumulator = createAccumulator();
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
        this.onTurnFinished(spec.requestId);
        return errorOutcome;
      }

      const config: TurnConfig = {
        maxSteps: policyMaxSteps ?? this.maxSteps,
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
        await this.onStepSettled(step, spec.requestId);
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

      let outcome = await this.runTurnExecutable({ requestId: spec.requestId, snapshot, queueSignal, execute: runOnce });

      if (outcome.kind === "error") {
        const decision = await this.handleTurnError(outcome, spec);
        if (decision === "return-early") {
          this.activeTurnInfo = null;
          this.onTurnFinished(spec.requestId);
          return outcome;
        }
        if (decision === "retry") {
          // The guard compacted: the retry must see the POST-compaction
          // transcript (retrying the stale prompt would overflow again with
          // a real provider) and re-resolve the model — getModel() is a
          // per-attempt hook, mirroring the per-turn configuration contract.
          turnCtx.messages = await session.getHistory();
          // The retry's answer IS the message: discard the overflowing
          // attempt's partial chunks rather than concatenating them into the
          // final assistant text (original semantics — the truncated partial
          // is not persisted as a separate orphan either).
          accumulator = createAccumulator();
          this.turnState.clearPartial(spec.requestId);
          try {
            model = this.getModel();
          } catch {
            // Keep the previously-resolved model; resolution errors were
            // already routed through the error pipeline on first resolve.
          }
          outcome = await this.runTurnExecutable({ requestId: spec.requestId, snapshot, queueSignal, execute: runOnce });
        }
      }

      await this.finalizeOutcome(spec, session, accumulator.current(), outcome, assembled);
      this.onTurnFinished(spec.requestId);
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
        const attachments = this.turnAttachments(spec.requestId);
        this.onAttachmentsReady(attachments);
        this.bus.emit("message:response", { requestId: spec.requestId, messageId: message.id });
        if (this.onChatResponse) {
          await this.onChatResponse({
            requestId: spec.requestId,
            outcome: "completed",
            status: "completed",
            message,
            attachments,
            continuation: spec.continuation,
          });
        }
        this.publishEvent({ type: "turn:settled", requestId: spec.requestId, outcome: "completed" });
        break;
      }
      case "suspended": {
        // ChatAgent stays metadata-blind: whichever opinion wrote the
        // durablePause metadata (compile()) also interprets it (audit 26
        // extr. 4) — that's Think's `parkSuspension()` override.
        const parked = this.parkSuspension({
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
        if (this.onChatResponse) {
          await this.onChatResponse({
            requestId: spec.requestId,
            outcome: "aborted",
            status: "aborted",
            message,
            attachments: this.turnAttachments(spec.requestId),
            continuation: spec.continuation,
            error: outcome.reason ?? "aborted",
          });
        }
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
        const classification = this.classifyTurnError(outcome.error);
        const ctx: ChatErrorContext = { requestId: spec.requestId, stage: "turn" };
        if (classification) ctx.classification = classification;
        if (this.onChatError) await this.onChatError(outcome.error, ctx);
        const errorText = toErrorValue(outcome.error).message;
        this.bus.emit("message:error", {
          requestId: spec.requestId,
          error: errorText,
        });
        this.bus.emit("chat:request:failed", {
          requestId: spec.requestId,
          stage: "stream",
          messagesPersisted: spec.newMessages.length > 0 || message.parts.length > 0,
          error: errorText,
        });
        if (this.onChatResponse) {
          await this.onChatResponse({
            requestId: spec.requestId,
            outcome: "error",
            status: "error",
            message,
            attachments: this.turnAttachments(spec.requestId),
            continuation: spec.continuation,
            error: errorText,
          });
        }
        this.publishEvent({
          type: "turn:settled",
          requestId: spec.requestId,
          outcome: "failed",
          errorText,
        });
        break;
      }
    }

    this.activeTurnInfo = null;
  }

  // ==========================================================================
  // Entry points
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
      return this.submitTurn(this.toMessages(args.input));
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
    this.onConversationCleared();
    this.turnQueue.cancelAll("cleared");
    this.pendingInteractions.cancelPending();
    this.turnState.setLastRequestId(undefined);
    this.turnState.clearTerminal(); // #1645: never replay a stale exhaustion onto an emptied chat
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
    // The continuation IS the suspended turn resuming (audit 25 statechart:
    // suspended -> queued is the same turn), so it keeps the requestId — the
    // request stream's identity. Recovery continuations already do the same
    // (incident.requestId); minting a fresh id here orphaned the client's
    // stream at the wire (ISSUE-027).
    return this.executeTurn({
      requestId,
      trigger: "continuation",
      continuation: true,
      newMessages: [],
    });
  }

  /** Lets adapters implement the resume handshake: the currently-streaming turn, if any. */
  activeTurn(): { requestId: string; startOffset: number } | null {
    return this.activeTurnInfo;
  }

  async waitUntilStable(options: WaitUntilStableOptions = {}): Promise<boolean> {
    this.ensureRuntime();
    const timeoutMs = options.timeoutMs ?? 5_000;
    const startedAt = Date.now();

    for (;;) {
      if (this.isQuiescent()) return true;

      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) return false;

      const waiters: Array<Promise<void>> = [sleep(Math.min(remaining, 25))];
      if (this.turnQueue.running() !== null || this.turnQueue.pending() > 0) {
        waiters.push(this.turnQueue.waitUntilStable());
      }
      if (this.pendingInteractions.hasPendingContinuation()) {
        waiters.push(this.pendingInteractions.waitForNoPendingContinuation());
      }
      for (const extra of this.extraStabilityWaiters()) {
        if (!extra.quiet) waiters.push(extra.wait());
      }

      await Promise.race(waiters);
    }
  }

  private isQuiescent(): boolean {
    return (
      this.turnQueue.running() === null &&
      this.turnQueue.pending() === 0 &&
      !this.pendingInteractions.hasPendingContinuation() &&
      this.extraStabilityWaiters().every((w) => w.quiet)
    );
  }

  // ==========================================================================
  // Client-tool result delivery (audit 25 §2; delegates to PendingInteractions)
  // ==========================================================================

  async applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void> {
    this.ensureRuntime();
    await this.pendingInteractions.applyToolResult(args);
  }
}
