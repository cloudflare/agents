/**
 * TinyHarness: the loop, composed as a Lifecycle capability.
 *
 * This class owns the things a harness owns — accepting prompts, dispatching
 * tools, and projecting capability-owned state — and
 * delegates everything durable to the capabilities the host installed:
 *
 *   Tasks    the turn engine. One run per turn, every effect journaled.
 *   Streams  the turn's output log, cursor-addressed and replayable.
 *   Sessions the transcript, with compaction.
 *   State    the UI-visible status, synced to connections.
 *
 * `LifecycleCapability` gives it storage, readiness, a job queue, and an
 * event bus without granting it the host object, which is why the same class
 * works on a plain Durable Object and on an Agent.
 */
import type { Workspace } from "@cloudflare/computer";
import { chat, modelMessagesToUIMessages } from "@tanstack/ai";
import type { ModelMessage, UIMessage } from "@tanstack/ai";
import { LifecycleCapability } from "agents/lifecycle";
import type { CapabilityStartContext } from "agents/lifecycle";
import { createCompactFunction } from "agents/sessions";
import type { Session, SessionMessage, Sessions } from "agents/sessions";
import type { StreamWriter, Streams } from "agents/streams";
import type { TaskRunSnapshot, TaskStep, Tasks, TaskValue } from "agents/tasks";
import type { State } from "agents/state";
import {
  authorizationEvent,
  authorizationId,
  awaitApproval,
  pendingApprovalFromMetadata
} from "./approval";
import type { ApprovalMode } from "./approval";
import {
  PROTOCOL_VERSION,
  BufferedEventWriter,
  approvalRequestedEvent,
  runFinishedEvent
} from "./events";
import type {
  ApprovalDecision,
  HarnessRole,
  HarnessState,
  JSON,
  PendingApproval,
  SessionSnapshot,
  TurnReceipt,
  TurnSnapshot,
  TurnStatus
} from "./protocol";
import { normalizeToolOutput, validateToolInput } from "./tools/types";
import type { ServerTool } from "./tools/types";
import { PROMPT_BYTES, TURN_DEFINITION, turnDefinitions } from "./turn";
import type { PendingCall, RoundOutcome, TurnDeps } from "./turn";


/** Estimated tokens on the branch before Sessions compacts it. */
const DEFAULT_COMPACT_AFTER_TOKENS = 120_000;
/** Tokens kept verbatim at the tail after a compaction. */
const DEFAULT_KEEP_RECENT_TOKENS = 40_000;
const PROMPT_PREVIEW_BYTES = 4 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;

type TurnTaskMetadata = {
  turnId: string;
  streamId: string;
  userMessageId: string;
  role: HarnessRole;
  promptPreview: string;
};

export type TinyHarnessOptions = {
  /**
   * The Tasks capability. Typed loosely on purpose: the host declares the
   * definitions map, so its instance type is narrower than a bare `Tasks`,
   * and a capability that only needs to enqueue should accept any of them.
   */
  readonly tasks: Tasks<never>;
  readonly streams: Streams;
  readonly sessions: Sessions;
  readonly workspace: Workspace;
  /** Per-role model adapters, from `harnessModels(env)`. */
  readonly models: Record<HarnessRole | "compact", unknown>;
  readonly state?: State<HarnessState>;
  readonly role?: HarnessRole;
  readonly maxRounds?: number;
  readonly approval?: ApprovalMode;
  readonly extraTools?: readonly ServerTool[];
  readonly delegation?: {
    readonly namespace: DurableObjectNamespace<never>;
    readonly depth?: number;
    readonly maxDepth?: number;
  };
  readonly compaction?:
    | false
    | { readonly afterTokens?: number; readonly keepRecentTokens?: number };
  /** Root the tools operate under, for the prompt. */
  readonly root?: string;
  /**
   * Skills to seed and advertise. Defaults to the bundled ones.
   *
   * An empty array disables the feature: nothing is written and the prompt
   * has no Skills section.
   */
  /** Seed project-owned files. Remote read-only explorers disable this. */
  /** Emit structured operational logs. Defaults to true. */
  readonly logging?: boolean;
};

/**
 * Delivery outcomes where the run has already moved past the named wait, so
 * the caller's intent is satisfied and only its view is stale.
 */
const SETTLED_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  "duplicate",
  "terminal",
  "not-waiting"
]);

/** An approval id that names no wait this run has. */
export class ApprovalNotDeliveredError extends Error {
  readonly approvalId: string;
  readonly status: string;

  constructor(approvalId: string, status: string) {
    super(`Authorization was not delivered: ${status}`);
    this.name = "ApprovalNotDeliveredError";
    this.approvalId = approvalId;
    this.status = status;
  }
}

/** Events a host can subscribe to without subclassing. */
export class SessionBusyError extends Error {
  readonly activeTurnId: string;

  constructor(activeTurnId: string) {
    super(`Session already has active turn ${activeTurnId}`);
    this.name = "SessionBusyError";
    this.activeTurnId = activeTurnId;
  }
}

export type HarnessEvents = {
  "turn:accepted": { turnId: string };
  "turn:settled": { turnId: string; status: TurnStatus };
  "turn:cancelled": { turnId: string };
  "tool:before": { turnId: string; call: PendingCall };
  "tool:after": { turnId: string; call: PendingCall; ok: boolean };
  "approval:requested": PendingApproval;
  "approval:resolved": { approvalId: string; approved: boolean };
};

export class TinyHarness extends LifecycleCapability {
  readonly #tasks: Tasks<never>;
  readonly #streams: Streams;
  readonly #session: Session;
  readonly #workspace: Workspace;
  readonly #models: Record<HarnessRole | "compact", unknown>;
  #state: State<HarnessState> | undefined;
  readonly #role: HarnessRole;
  readonly #maxRounds: number;
  readonly #approval: ApprovalMode;
  readonly #extraTools: readonly ServerTool[];
  readonly #delegation: TinyHarnessOptions["delegation"];
  readonly #root: string;
  readonly #logging: boolean;
  readonly #listeners = new Map<string, Set<(payload: never) => void>>();
  readonly #writers = new Map<string, StreamWriter>();
  #submissionTail: Promise<void> = Promise.resolve();
  /** Skills bundled with this harness, parsed once. */
  /** Resolves when AGENTS.md and the skill files have been written. */

  /**
   * The Task definitions this harness needs.
   *
   * The host spreads these into `new Tasks({ definitions })`. That is
   * deliberate: `tasks.register()` is a framework aperture reserved for
   * `__cf`-prefixed names, and routing through the host's constructor keeps
   * "the loop is a Task" visible in server.ts instead of hidden in here.
   */
  readonly taskDefinitions: ReturnType<typeof turnDefinitions>;

  constructor(options: TinyHarnessOptions) {
    super("tiny-harness");
    this.#tasks = options.tasks;
    this.#streams = options.streams;
    this.#workspace = options.workspace;
    this.#models = options.models;
    this.#state = options.state;
    this.#role = options.role ?? "lead";
    this.#maxRounds = options.maxRounds ?? 16;
    this.#approval = options.approval ?? { kind: "interactive" };
    this.#extraTools = options.extraTools ?? [];
    this.#delegation = options.delegation;
    this.#root = options.root ?? "/workspace";
    this.#logging = options.logging ?? true;
    this.#session = options.sessions.session();

    // Pruning is a read policy over durable history. Configured
    // once here; the loop never thinks about it again.
    if (options.compaction !== false) {
      const policy = options.compaction ?? {};
      this.#session
        .onCompaction(
          createCompactFunction({
            summarize: (prompt) => this.#summarize(prompt),
            keepRecentTokens:
              policy.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
          })
        )
        .compactAfter(policy.afterTokens ?? DEFAULT_COMPACT_AFTER_TOKENS);
    }


    this.taskDefinitions = turnDefinitions(this.#deps());
  }


  // ── Public surface ──────────────────────────────────────────────────────

  /** Attach the optional connection-state projection after host construction. */
  attachState(state: State<HarnessState>): void {
    if (this.#state && this.#state !== state) {
      throw new Error("TinyHarness State projection is already attached");
    }
    this.#state = state;
  }

  /** Rebuild the disposable connection projection from authoritative Tasks. */
  rebuildState(): Promise<void> {
    return this.#syncState();
  }

  /** Durably accept one single-flight turn. */
  submit(input: {
    prompt: string;
    turnId?: string;
    role?: HarnessRole;
  }): Promise<TurnReceipt> {
    const accepted = this.#submissionTail.then(() => this.#submit(input));
    this.#submissionTail = accepted.then(
      () => undefined,
      () => undefined
    );
    return accepted;
  }

  async #submit(input: {
    prompt: string;
    turnId?: string;
    role?: HarnessRole;
  }): Promise<TurnReceipt> {
    return this.#accept(input, "warm");
  }

  async #prepare(input: {
    prompt: string;
    turnId?: string;
    role?: HarnessRole;
  }): Promise<TurnReceipt> {
    return this.#accept(input, "queued");
  }

  /**
   * One body so the streaming and plain paths cannot drift apart in their
   * durable side effects; `start` decides only who drives the first attempt.
   */
  async #accept(
    input: {
      prompt: string;
      turnId?: string;
      role?: HarnessRole;
    },
    start: "warm" | "queued"
  ): Promise<TurnReceipt> {
    await this.lifecycle.ready();
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new Error("Prompt must not be empty");
    if (new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
    }

    const turnId = input.turnId ?? crypto.randomUUID();
    const role = input.role ?? this.#role;
    const taskRunId = taskRunIdFor(turnId);
    const streamId = streamIdFor(turnId);
    const userMessageId = userMessageIdFor(turnId);
    const existing = await this.#tasks.get(taskRunId);
    if (existing) {
      return { turnId, streamId, accepted: false };
    }

    const active = await this.#activeTask();
    if (active) {
      const metadata = turnMetadata(active);
      throw new SessionBusyError(metadata?.turnId ?? active.runId);
    }

    const parent = await this.#session.getLatestLeaf();
    await this.#session.appendMessage(
      {
        id: userMessageId,
        role: "user",
        parts: [{ type: "text", text: prompt }],
        metadata: { kind: "turn", turnId, role }
      },
      { parentId: parent?.id ?? null }
    );
    await this.#streams.open(streamId, {
      tag: turnId,
      metadata: {
        protocol: "ag-ui",
        version: PROTOCOL_VERSION,
        threadId: this.lifecycle.name,
        runId: turnId
      }
    });

    await this.#enqueue(
      { turnId, threadId: this.lifecycle.name, role, userMessageId },
      {
        turnId,
        streamId,
        userMessageId,
        role,
        promptPreview: preview(prompt, PROMPT_PREVIEW_BYTES)
      },
      start
    );
    this.#emit("turn:accepted", { turnId });
    await this.#syncState();
    return { turnId, streamId, accepted: true };
  }

  /**
   * Durably accept a turn without running it, for callers that must attach
   * to the log first.
   *
   * A Durable Object runs one block at a time and `Tasks.run()` starts the
   * first attempt in this isolate, so {@link submit} does not resolve until
   * that attempt yields — for a gated tool, not until a human answers.
   */
  prepareTurn(input: {
    prompt: string;
    turnId?: string;
    role?: HarnessRole;
  }): Promise<TurnReceipt> {
    const accepted = this.#submissionTail.then(() => this.#prepare(input));
    this.#submissionTail = accepted.then(
      () => undefined,
      () => undefined
    );
    return accepted;
  }

  /** Run one turn to completion. The RPC entry point for subagents. */
  async runToCompletion(input: {
    role: HarnessRole;
    goal: string;
  }): Promise<{ text: string; rounds: number }> {
    // Native RPC does not pass through fetch, so the lifecycle has not
    // necessarily started. `ready()` is the capability-side boundary that
    // guarantees startup hooks have run.
    await this.lifecycle.ready();
    // The role travels with the turn: this object was constructed with the
    // safe default and is told its real role per run.
    const receipt = await this.submit({
      prompt: input.goal,
      role: input.role
    });
    // Drain the turn's stream: it ends when the turn settles, which makes
    // this an await-for-completion without polling the run.
    for await (const _ of this.#streams.read(receipt.streamId)) {
      // The chunks are already persisted; we only need the completion edge.
    }
    for (;;) {
      const turn = await this.turn(receipt.turnId);
      if (turn?.status === "completed") {
        return { text: turn.text ?? "", rounds: turn.rounds };
      }
      if (
        turn &&
        turn.status !== "queued" &&
        turn.status !== "running" &&
        turn.status !== "awaiting-approval"
      ) {
        throw new Error(
          `Subagent turn ${receipt.turnId} did not complete: ${turn.status}${
            turn.error ? ` (${turn.error})` : ""
          }`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Point-in-time view of one turn. */
  async turn(turnId: string): Promise<TurnSnapshot | null> {
    await this.lifecycle.ready();
    const task = await this.#tasks.get(taskRunIdFor(turnId));
    return task ? this.#projectTask(task) : null;
  }

  /** Every retained turn in this session, oldest first. */
  async turns(): Promise<TurnSnapshot[]> {
    await this.lifecycle.ready();
    const tasks = await this.#tasks.list({
      definition: TURN_DEFINITION,
      limit: 100
    });
    const turns = await Promise.all(
      tasks.map((task) => this.#projectTask(task))
    );
    return turns
      .filter((turn): turn is TurnSnapshot => turn !== null)
      .sort(
        (a, b) => a.startedAt - b.startedAt || a.turnId.localeCompare(b.turnId)
      );
  }

  /** Server-authoritative transcript page for TanStack AI's chat client. */
  async chatHydration(options: { limit?: number; before?: string }): Promise<{
    messages: UIMessage[];
    activeRun: { runId: string } | null;
    interrupts: null;
    page: { truncated: false } | { truncated: true; cursor: string };
  }> {
    await this.lifecycle.ready();
    const limit = options.limit;
    const newest: SessionMessage[] = [];
    let reachedCursor = options.before === undefined;

    for await (const message of this.#session.history({ newestFirst: true })) {
      if (!reachedCursor) {
        if (message.id === options.before) reachedCursor = true;
        continue;
      }
      newest.push(message);
      if (limit !== undefined && newest.length > limit) break;
    }

    const truncated = limit !== undefined && newest.length > limit;
    if (truncated) newest.pop();
    const history = newest.reverse();
    const active = await this.#activeTask();
    const metadata = active ? turnMetadata(active) : null;

    return {
      messages: sessionMessagesToUIMessages(history),
      activeRun: metadata ? { runId: metadata.turnId } : null,
      interrupts: null,
      page:
        truncated && history[0]
          ? { truncated: true, cursor: history[0].id }
          : { truncated: false }
    };
  }

  /** Everything a connecting client needs. */
  async snapshot(): Promise<SessionSnapshot> {
    await this.#syncState();
    const files = await this.#workspace.fs
      .readdir(this.#root)
      .catch(() => [] as { name: string }[]);
    return {
      name: this.lifecycle.name,
      role: this.#role,
      turns: await this.turns(),
      files: files.map((entry) => entry.name)
    };
  }

  /**
   * Resolve a pending approval. Wakes the parked turn.
   *
   * Writing the decision is all this does: the turn is parked on a durable
   * Task event and replays from its journal when delivery wakes it.
   */
  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    await this.lifecycle.ready();
    const separator = approvalId.indexOf(":");
    if (separator <= 0) throw new Error("Invalid approval id");
    const turnId = approvalId.slice(0, separator);
    const delivered = await this.#tasks.sendEvent(
      `harness:${turnId}`,
      authorizationEvent(approvalId),
      decision as never
    );
    if (delivered.status !== "delivered") {
      if (!SETTLED_DELIVERY_STATUSES.has(delivered.status)) {
        throw new ApprovalNotDeliveredError(approvalId, delivered.status);
      }
      // A double-click, a retry, or a second tab answering the same
      // approval: the sender's view is stale, so re-sync rather than fail.
      await this.#syncState();
      return;
    }
    this.#emit("approval:resolved", {
      approvalId,
      approved: decision.approved
    });
    await this.#syncState();
  }

  /** The approval a client should render, if any. */
  async pendingApproval(): Promise<PendingApproval | null> {
    const task = await this.#activeTask();
    return task?.state === "waiting" && task.reason === "event"
      ? pendingApprovalFromMetadata(task.event?.metadata)
      : null;
  }

  /** Cancel a turn. Parked turns settle now; live ones at the next step. */
  async cancel(turnId: string, reason = "cancelled by user"): Promise<void> {
    await this.lifecycle.ready();
    const cancelled = await this.#tasks
      .cancel(taskRunIdFor(turnId), reason)
      .catch(() => false);
    // A run that already settled cannot be cancelled; leave its stream and
    // diagnostics untouched.
    if (!cancelled) {
      await this.#syncState();
      return;
    }
    const writer =
      this.#writers.get(turnId) ??
      (await this.#streams
        .open(`turn:${turnId}`, { tag: turnId })
        .catch(() => null));
    if (writer) {
      writer.append(
        runFinishedEvent(
          this.lifecycle.name,
          turnId,
          { reason },
          { type: "cancelled" }
        )
      );
      writer.close();
    }
    this.#writers.delete(turnId);
    this.#emit("turn:cancelled", { turnId });
    await this.#syncState();
  }

  /** Subscribe to harness events. Events, not inheritance. */
  on<E extends keyof HarnessEvents>(
    type: E,
    listener: (payload: HarnessEvents[E]) => void
  ): () => void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.#listeners.set(type, set);
    return () => set.delete(listener as (payload: never) => void);
  }

  // ── Loop dependencies ───────────────────────────────────────────────────

  /**
   * Everything turn.ts needs, as plain functions.
   *
   * Assembling this here keeps the loop free of `this` and makes the
   * harness's contract with the loop explicit and readable.
   */
  #deps(): TurnDeps {
    return {
      maxRounds: this.#maxRounds,

      // The byte budget is a hard ceiling with no message-count floor: the
      // read returns the longest recent suffix that fits, and always at
      // least the newest message. A floor that admitted rows regardless of
      // size would defeat the bound it sits under, which is why Sessions
      // dropped `minRecentMessages`.
      recentHistory: (bytes, leafId) =>
        this.#session.getRecentHistory(bytes, { leafId }) as Promise<{
          messages: readonly unknown[];
        }>,

      latestLeafId: async () =>
        (await this.#session.getLatestLeaf())?.id ?? null,

      buildSystemPrompt: (role) => this.#systemPrompt(role),

      tools: (role) => this.#bundle(role).tools,

      adapter: (role) => this.#models[role],

      observe: (event, fields) => {
        if (!this.#logging) return;
        const turnId =
          typeof fields.turnId === "string" ? fields.turnId : undefined;
        console.log(
          JSON.stringify({
            component: "tiny-harness",
            event,
            sessionId: this.lifecycle.name,
            ...(turnId
              ? {
                  turnId,
                  taskRunId: taskRunIdFor(turnId),
                  AGUIRunId: turnId
                }
              : {}),
            ...fields
          })
        );
      },

      start: async (turnId) => {
        if (this.#state) {
          this.#state.set({
            busy: true,
            activeTurnId: turnId,
            status: "running",
            pendingApproval: null
          });
        }
      },

      openStream: async (turnId) => {
        const cached = this.#writers.get(turnId);
        if (cached) return cached;
        // Reopening a live stream returns a writer at its cursor, so a
        // replayed producer resumes the log instead of duplicating it.
        const writer = new BufferedEventWriter(
          await this.#streams.open(`turn:${turnId}`, { tag: turnId })
        );
        this.#writers.set(turnId, writer);
        return writer;
      },

      commitAssistant: async (turnId, round, outcome) => {
        const message = {
          id: `assistant:${turnId}:${round}`,
          role: "assistant" as const,
          parts: [
            ...(outcome.text
              ? [{ type: "text" as const, text: outcome.text }]
              : []),
            ...outcome.calls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.callKey,
              toolName: call.name,
              input: call.input
            }))
          ],
          metadata: { turnId, round }
        };
        // Return the synchronous writer so the caller commits the canonical
        // message before emitting AG-UI RUN_FINISHED. `upsert` hands back an
        // `after` callback for the change feed; firing it without awaiting
        // keeps the commit synchronous while still notifying subscribers.
        const sync = this.#session.__DO_NOT_USE_WILL_BREAK__sync();
        return {
          messageId: message.id,
          commit: () => {
            const { after } = sync.upsert(message as never);
            void after();
          }
        };
      },

      appendToolResult: async (turnId, call, result, ok) => {
        const id = `tool:${turnId}:${call.callKey}`;
        await this.#session.appendMessage({
          id,
          role: "tool",
          parts: [
            {
              type: "tool-result",
              toolCallId: call.callKey,
              toolName: call.name,
              input: call.input,
              ...(ok ? { output: result } : { errorText: stringify(result) })
            } as never
          ],
          metadata: {
            turnId,
            round: call.round,
            callKey: call.callKey,
            providerCallId: call.callId
          }
        });
        return id;
      },

      runTool: async (call, ctx) => {
        this.#emit("tool:before", { turnId: ctx.turnId, call });
        // Resolve against the *turn's* role, not the harness default: a
        // subagent run overrides its role per run, and dispatching from the
        // wrong bundle would offer tools the model was never shown.
        const bundle = this.#bundle(ctx.role);
        const tool = bundle.tools.find((t) => t.name === call.name);
        if (!tool?.execute) {
          this.#emit("tool:after", { turnId: ctx.turnId, call, ok: false });
          // The loop records thrown tool errors as explicit failed results.
          throw new Error(
            `Unknown tool ${JSON.stringify(call.name)}. Available: ${bundle.tools
              .map((t) => t.name)
              .join(", ")}`
          );
        }
        try {
          const validated = await validateToolInput(tool, call.input);
          if (!validated.ok) throw new Error(validated.error);
          const output = await tool.execute(validated.value, {
            toolCallId: call.callKey,
            abortSignal: ctx.signal
          });
          this.#emit("tool:after", { turnId: ctx.turnId, call, ok: true });
          return normalizeToolOutput(output);
        } catch (error) {
          this.#emit("tool:after", { turnId: ctx.turnId, call, ok: false });
          throw error;
        }
      },

      needsApproval: async (call, role) => {
        if (this.#approval.kind === "auto") return false;
        return this.#bundle(role).gated.includes(call.name);
      },

      awaitApproval: (call, turnId, step) =>
        this.#awaitApproval(call, turnId, step),

      finish: (turnId, status) => {
        this.#emit("turn:settled", { turnId, status });
        if (this.#state) {
          this.#state.set({
            busy: false,
            activeTurnId: null,
            status: "idle",
            pendingApproval: null
          });
        }
      }
    };
  }

  /**
   * Park the turn until a human decides.
   *
   * The mechanics live in `approval.ts`; this method only projects the
   * durable Task event wait into stream and connection state.
   */
  async #awaitApproval(
    call: PendingCall,
    turnId: string,
    step: TaskStep
  ): Promise<ApprovalDecision> {
    const approval: PendingApproval = {
      approvalId: authorizationId(turnId, call.callKey),
      turnId,
      toolName: call.name,
      input: call.input as JSON,
      requestedAt: Date.now()
    };
    await step.do(`announce-authorization:${call.callKey}`, () => {
      this.#writers
        .get(turnId)
        ?.append(approvalRequestedEvent(approval) as unknown as JSON);
      this.#emit("approval:requested", approval);
      if (this.#state) {
        this.#state.set({
          busy: true,
          activeTurnId: turnId,
          status: "awaiting-approval",
          pendingApproval: approval
        });
      }
      return true;
    });
    const waiting = awaitApproval(this.#approval, call, turnId, step);
    const decision = await waiting;
    if (this.#state) {
      this.#state.set({
        busy: true,
        activeTurnId: turnId,
        status: "running",
        pendingApproval: null
      });
    }
    return decision;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #enqueue(
    input: {
      turnId: string;
      threadId: string;
      role: HarnessRole;
      userMessageId: string;
    },
    metadata: TurnTaskMetadata,
    start: "warm" | "queued" = "warm"
  ): Promise<unknown> {
    const options = {
      runId: taskRunIdFor(input.turnId),
      metadata: metadata as never
    };
    // The reserved aperture is the only way to accept a run without
    // warm-starting it here; `ai-chat` uses it for the same reason.
    return start === "queued"
      ? this.#tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
          TURN_DEFINITION as never,
          input as never,
          options
        )
      : this.#tasks.run(TURN_DEFINITION as never, input as never, options);
  }

  /**
   * The tools available to a role.
   *
   * Only host-registered tools for now. `assembleTools()` and the built-in
   * filesystem, exec, planning and delegation layers arrive with the tools
   * they assemble.
   */
  #bundle(_role: HarnessRole): {
    tools: readonly ServerTool[];
    gated: readonly string[];
  } {
    return {
      tools: this.#extraTools,
      gated: this.#extraTools.filter((t) => t.needsApproval).map((t) => t.name)
    };
  }

  /**
   * Build the system prompt for a role.
   *
   * Deliberately *not* cached in memory. Freezing is the loop's job and it
   * does it with `step.do("prompt")`, which is journaled: every round in one
   * turn replays the identical string, while the next turn renders afresh.
   *
   * An in-memory cache here looked like the same thing and was not. It
   * outlived the turn, so a plan written by `todo` never reached the prompt
   * again and an edited AGENTS.md only took effect after an eviction — while
   * the journaled step stayed per-turn, meaning identical durable inputs
   * produced different prompts depending on when the isolate happened to be
   * recycled.
   */
  async #systemPrompt(role: HarnessRole): Promise<string> {
    const bundle = this.#bundle(role);
    const names = bundle.tools.map((tool) => tool.name);
    return [
      `You are the ${role}.`,
      names.length > 0 ? `Tools available: ${names.join(", ")}.` : null
    ]
      .filter((line): line is string => line !== null)
      .join("\n\n");
  }

  /** Summarizer for compaction. Uses the cheap model, never user-facing. */
  async #summarize(prompt: string): Promise<string> {
    const text = await chat({
      adapter: this.#models.compact as never,
      messages: [{ role: "user", content: prompt }],
      stream: false
    } as never);
    return typeof text === "string" ? text : String(text);
  }

  async #activeTask(): Promise<TaskRunSnapshot<TaskValue> | undefined> {
    return (
      await this.#tasks.list({
        definition: TURN_DEFINITION,
        status: ["pending", "running", "waiting"],
        limit: 1
      })
    )[0];
  }

  async #projectTask(
    task: TaskRunSnapshot<TaskValue>
  ): Promise<TurnSnapshot | null> {
    const metadata = turnMetadata(task);
    if (!metadata) return null;
    const user = await this.#session.getMessage(metadata.userMessageId);
    const result = turnResult(task);
    const response = result
      ? await this.#session.getMessage(result.responseMessageId)
      : null;
    const pendingApproval =
      task.state === "waiting" && task.reason === "event"
        ? pendingApprovalFromMetadata(task.event?.metadata)
        : null;
    return {
      turnId: metadata.turnId,
      streamId: metadata.streamId,
      status: taskStatus(task),
      role: metadata.role,
      prompt: messageText(user) || metadata.promptPreview,
      promptMessageId: metadata.userMessageId,
      rounds: result?.rounds ?? modelRound(task),
      startedAt: task.state === "running" ? task.startedAt : task.createdAt,
      ...("settledAt" in task ? { completedAt: task.settledAt } : {}),
      ...(response ? { text: messageText(response) } : {}),
      ...(task.state === "failed" ? { error: task.error.message } : {}),
      ...(task.state === "cancelled" && task.reason
        ? { error: task.reason }
        : {}),
      ...(pendingApproval ? { pendingApproval } : {})
    };
  }

  /** Rebuild connection state from Tasks. */
  async #syncState(): Promise<void> {
    if (!this.#state) return;
    const active = await this.#activeTask();
    const metadata = active ? turnMetadata(active) : null;
    const pendingApproval =
      active?.state === "waiting" && active.reason === "event"
        ? pendingApprovalFromMetadata(active.event?.metadata)
        : null;
    this.#state.set({
      busy: active !== undefined,
      activeTurnId: metadata?.turnId ?? null,
      status: active ? taskStatus(active) : "idle",
      pendingApproval
    });
  }

  #emit<E extends keyof HarnessEvents>(
    type: E,
    payload: HarnessEvents[E]
  ): void {
    if (this.#logging) {
      logHarnessEvent(this.lifecycle.name, type, payload);
    }
    // Best-effort: a throwing listener must not fail the turn that emitted.
    for (const listener of this.#listeners.get(type) ?? []) {
      try {
        (listener as (value: HarnessEvents[E]) => void)(payload);
      } catch (error) {
        console.error(`harness: listener for ${type} threw`, error);
      }
    }
    this.lifecycle.events.emit(`harness:${type}`, payload as never);
  }
}

function logHarnessEvent(
  sessionId: string,
  event: keyof HarnessEvents,
  payload: HarnessEvents[keyof HarnessEvents]
): void {
  const value = payload as {
    turnId?: string;
    approvalId?: string;
    toolName?: string;
    call?: PendingCall;
    ok?: boolean;
    status?: TurnStatus;
  };
  const turnId =
    value.turnId ??
    (value.approvalId ? value.approvalId.split(":", 1)[0] : undefined);
  console.log(
    JSON.stringify({
      component: "tiny-harness",
      event,
      sessionId,
      ...(turnId
        ? {
            turnId,
            taskRunId: taskRunIdFor(turnId),
            AGUIRunId: turnId
          }
        : {}),
      ...(value.approvalId ? { approvalId: value.approvalId } : {}),
      ...(value.toolName ? { toolName: value.toolName } : {}),
      ...(value.call
        ? {
            toolName: value.call.name,
            callKey: value.call.callKey,
            round: value.call.round
          }
        : {}),
      ...(value.ok !== undefined ? { ok: value.ok } : {}),
      ...(value.status ? { status: value.status } : {})
    })
  );
}

function taskRunIdFor(turnId: string): string {
  return `harness:${turnId}`;
}

function streamIdFor(turnId: string): string {
  return `turn:${turnId}`;
}

function userMessageIdFor(turnId: string): string {
  return `user:${turnId}`;
}

function turnMetadata(
  task: TaskRunSnapshot<TaskValue>
): TurnTaskMetadata | null {
  const metadata = task.metadata;
  if (
    typeof metadata?.turnId !== "string" ||
    typeof metadata.streamId !== "string" ||
    typeof metadata.userMessageId !== "string" ||
    (metadata.role !== "lead" && metadata.role !== "explorer") ||
    typeof metadata.promptPreview !== "string"
  ) {
    return null;
  }
  return {
    turnId: metadata.turnId,
    streamId: metadata.streamId,
    userMessageId: metadata.userMessageId,
    role: metadata.role,
    promptPreview: metadata.promptPreview
  };
}

function turnResult(
  task: TaskRunSnapshot<TaskValue>
): { responseMessageId: string; rounds: number } | null {
  if (task.state !== "completed") return null;
  const result = task.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  return typeof result.responseMessageId === "string" &&
    typeof result.rounds === "number"
    ? { responseMessageId: result.responseMessageId, rounds: result.rounds }
    : null;
}

function taskStatus(task: TaskRunSnapshot<TaskValue>): TurnSnapshot["status"] {
  switch (task.state) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return task.reason === "event" ? "awaiting-approval" : "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      throw new Error("Unknown Task state");
  }
}

function modelRound(task: TaskRunSnapshot<TaskValue>): number {
  if (task.state !== "running" && task.state !== "waiting") return 0;
  const match = /Model round (\d+)/.exec(task.statusMessage ?? "");
  return match ? Number(match[1]) : 0;
}

function messageText(message: { parts: unknown[] } | null): string {
  if (!message) return "";
  return message.parts
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function preview(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes));
}

function sessionMessagesToUIMessages(
  messages: readonly SessionMessage[]
): UIMessage[] {
  const modelMessages: ModelMessage[] = [];
  for (const message of messages) {
    const createdAt = message.createdAt;
    if (message.role === "user") {
      modelMessages.push({
        id: message.id,
        role: "user",
        content: message.parts
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join(""),
        ...(createdAt ? { createdAt } : {})
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.parts
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("");
      const toolCalls = message.parts.flatMap((part) =>
        part.type === "tool-call" && part.toolCallId && part.toolName
          ? [
              {
                id: part.toolCallId,
                type: "function" as const,
                function: {
                  name: part.toolName,
                  arguments: stringify(part.input)
                }
              }
            ]
          : []
      );
      modelMessages.push({
        id: message.id,
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(createdAt ? { createdAt } : {})
      });
      continue;
    }
    if (message.role !== "tool") continue;
    for (const part of message.parts) {
      if (part.type !== "tool-result" || !part.toolCallId) continue;
      const errorText = (part as { errorText?: unknown }).errorText;
      const error = typeof errorText === "string" ? errorText : undefined;
      const value = error ?? part.output ?? part.result ?? "";
      modelMessages.push({
        id: message.id,
        role: "tool",
        toolCallId: part.toolCallId,
        ...(part.toolName ? { name: part.toolName } : {}),
        content: stringify(value),
        ...(error ? { error } : {}),
        ...(createdAt ? { createdAt } : {})
      });
    }
  }
  return modelMessagesToUIMessages(modelMessages);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export { PROMPT_BYTES };
export type { ApprovalMode };
export type { PendingCall, RoundOutcome };
