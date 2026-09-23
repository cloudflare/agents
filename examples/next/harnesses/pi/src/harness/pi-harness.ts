import {
  AgentHarness as createAgentHarness,
  BACKGROUND_CONTEXT,
  StorageBackedSession,
  uuidv7,
  type AgentHarness as UpstreamAgentHarness,
  type AgentHarnessOptions as UpstreamAgentHarnessOptions,
  type AgentHarnessTool as UpstreamAgentHarnessTool,
  type AgentLane as UpstreamAgentLane,
  type Context as UpstreamContext,
  type Entry,
  type HarnessEvent,
  type OpenOperation,
  type OperationResultRecord,
  type Resources as UpstreamResources
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { SqliteStorage } from "@earendil-works/pi-session-backend-sqlite-node";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import type { Streams } from "agents/streams";
import { StateMachine, type MachineRunSnapshot } from "agents/state-machine";
import type { WebSocketsOptions } from "agents/websockets";
import { DurableObjectPiDatabase, ensurePiSession } from "./do-sqlite";
import {
  OperationStreamWriter,
  projectHarnessEvent,
  SUBSCRIBED_EVENT_TYPES
} from "./events";
import {
  asUpstreamContext,
  asUpstreamRequest,
  asUpstreamResources,
  asUpstreamTools,
  messageInput,
  operationStatus,
  projectResult,
  projectRunResult,
  requestKind
} from "./adapters";
import { PiSubmissions, type QueuedSubmission } from "./intake";
import { SettlementWaiters } from "./settlement";
import { projectMessages, projectQueue } from "./messages";
import { resolveModel } from "../providers/models";
import { resolveSkillSources, type ResolvedSkills } from "./skills";
import { PiTransport, type PiTransportHost } from "./transport";
import {
  createPiDriveRuntime,
  type PiDriveHost,
  type PiOperationLookup
} from "./drive-runtime";
import {
  PI_DRIVE_EFFECT,
  PI_RUN_DEFINITION,
  piRunMachine,
  type PiDriveInput,
  type PiDriveOutput,
  type PiRunResult,
  type PiRunState
} from "./machine";
import type {
  PiAbortResult,
  PiContext,
  PiEvent,
  PiEventListener,
  PiHarnessConfig,
  PiHookRegistry,
  PiLaneOptions,
  PiLaneSnapshot,
  PiMessage,
  PiMessageInput,
  PiOperationKind,
  PiOperationRequest,
  PiOperationResult,
  PiOperationStream,
  PiPendingSubmission,
  PiPromptResponse,
  PiQueueReceipt,
  PiSubmissionReceipt,
  PiSubmitOptions,
  PiTool,
  PiTranscriptOptions
} from "./types";

/** The StateMachine definition name for one pi operation. */
export const PI_OPERATION_DEFINITION = PI_RUN_DEFINITION;

const RECONCILE_JOB_ID = "reconcile";
const RECONCILE_FN = "reconcile";
const ADMIT_FN = "admit";
const DEFERRED_POLL_MS = 30_000;
const RESULT_POLL_MS = 500;
/** How long a run parks when another operation holds its lane. */
const LANE_BUSY_WAIT_MS = 250;

type Attached = {
  readonly harness: UpstreamAgentHarness<object | undefined>;
  readonly open: readonly OpenOperation[];
};

/** A submission pi refused to admit. */
export class PiOperationRejectedError extends Error {
  readonly operationId: string;
  readonly code: string;

  constructor(operationId: string, code: string, message: string) {
    super(message);
    this.name = "PiOperationRejectedError";
    this.operationId = operationId;
    this.code = code;
  }
}

/**
 * Hosts pi's durable AgentHarness inside a Lifecycle Durable Object.
 *
 * Pi owns the transcript, operation state, tool intents and outcomes,
 * retries, and crash recovery, all in this object's SQLite database. Around
 * it the capability composes the SDK's durable primitives: submissions queue
 * in a small intake table, each operation runs as one `StateMachine` run
 * whose checkpoint wraps pi's drive loop as a reconciled effect, and every
 * operation's live events land in one `Streams` stream clients replay.
 *
 * Because pi is already a durable state machine, the outer machine follows
 * the SDK's wrapped-runtime shape: it owns admission, parking, cancellation,
 * and observation, and never replays pi's model or tool effects.
 *
 * @experimental This is a v0.3 integration with pi's published API.
 */
export class PiHarness<
  ToolContext extends object | undefined = object | undefined
> extends LifecycleCapability {
  readonly #config: PiHarnessConfig<ToolContext>;
  readonly #streams: Streams;
  /**
   * The operation machines. PiHarness owns this capability rather than
   * receiving it, because the definition and its effect runtime are bound to
   * this harness's pi attachment. Install it beside the harness with
   * `.use(harness.stateMachine)`.
   */
  readonly #machines = new StateMachine({
    definitions: { [PI_RUN_DEFINITION]: piRunMachine },
    effects: {
      [PI_DRIVE_EFFECT]: createPiDriveRuntime(this.#driveHost())
    }
  });
  readonly #defaultLane: string;
  #submissions: PiSubmissions | undefined;
  #attaching: Promise<Attached> | undefined;
  #skills: Promise<ResolvedSkills> | undefined;
  #transport: PiTransport | undefined;
  readonly #listeners = new Set<PiEventListener>();
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #laneWriters = new Map<string, OperationStreamWriter>();
  readonly #settlement = new SettlementWaiters(RESULT_POLL_MS);
  readonly #rejections = new Map<string, PiOperationRejectedError>();
  readonly #lanesOf = new Map<string, string>();

  constructor(config: PiHarnessConfig<ToolContext>) {
    super("pi-harness");
    this.#config = config;
    this.#streams = config.streams;
    this.#defaultLane = config.defaultLane ?? "main";
  }

  /**
   * The StateMachine capability driving this harness's operations. Install
   * it on the same Lifecycle before the harness itself.
   */
  get stateMachine(): StateMachine<{
    [PI_RUN_DEFINITION]: typeof piRunMachine;
  }> {
    return this.#machines;
  }

  /** The lane used when a call names none. */
  get defaultLane(): string {
    return this.#defaultLane;
  }

  /** The Streams capability holding operation output. */
  get streams(): Streams {
    return this.#streams;
  }

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  /**
   * Attach pi to this object's SQLite state and re-derive operation runs.
   *
   * StateMachine reconciles its own runs and jobs on startup, so this hook
   * only needs to cover operations pi knows about that never reached a
   * machine run: a crash between the intake write and `run()`.
   */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    this.#submissions = new PiSubmissions(this.lifecycle.storage);
    this.#submissions.ensureTable();
    const attached = await this.#attached();
    for (const operation of attached.open) {
      this.#lanesOf.set(operation.operationId, operation.lane);
    }
    const pending = this.#submissions.list();
    if (pending.length === 0 && attached.open.length === 0) return;
    // Admission runs after startup completes so StateMachine is ready no
    // matter the installation order.
    await this.lifecycle.jobs.push({
      id: RECONCILE_JOB_ID,
      fn: RECONCILE_FN,
      time: Date.now()
    });
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    switch (context.job.fn) {
      case RECONCILE_FN:
      case ADMIT_FN:
        await this.#admitPending();
        return;
      default:
        this.lifecycle.events.emit("operation:invalid_job", {
          jobId: context.job.id,
          fn: context.job.fn
        });
        return;
    }
  }

  /**
   * Ensure every durably queued submission owns a machine run.
   *
   * `run()` is idempotent on the operation id, so a submission whose run
   * already exists is a no-op and a crash between the two writes is repaired
   * on the next wake.
   */
  async #admitPending(): Promise<void> {
    for (const submission of this.#requireSubmissions().list()) {
      await this.#startOperationRun(
        submission.lane,
        submission.operationId,
        submission.request
      );
    }
  }

  /** Close process-local pi resources without changing durable state. */
  async dispose(): Promise<void> {
    const attaching = this.#attaching;
    this.#attaching = undefined;
    for (const writer of this.#writers.values()) writer.flush();
    if (attaching) {
      const attached = await attaching.catch(() => undefined);
      await attached?.harness.close(BACKGROUND_CONTEXT);
    }
  }

  // ── Operations ───────────────────────────────────────────────────────────

  /**
   * Durably queue an operation and return a receipt without waiting for the
   * model. The submission is durable before this resolves, and its machine
   * run admits it into pi in order.
   */
  async submit(
    request: PiOperationRequest,
    options: PiSubmitOptions = {}
  ): Promise<PiSubmissionReceipt> {
    await this.lifecycle.ready();
    const lane = options.lane ?? this.#defaultLane;
    const operationId = options.operationId ?? request.operationId ?? uuidv7();
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(lane, context);
    const submissions = this.#requireSubmissions();
    if (
      submissions.has(operationId) ||
      (await upstream.getResult(operationId, context)) !== undefined ||
      (await upstream.inspectExecution(context)).current?.id === operationId
    ) {
      return { operationId, lane, accepted: false };
    }
    // Intake first: the submission is the evidence that survives a crash
    // between here and the machine run, and `#admitPending()` repairs it.
    submissions.insert(lane, operationId, request);
    await this.#startOperationRun(lane, operationId, request);
    return { operationId, lane, accepted: true };
  }

  /** Submit a prompt and wait for its outcome and the updated transcript. */
  async prompt(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    const { text, images } = messageInput(input);
    const receipt = await this.submit(
      {
        kind: "prompt",
        prompt: text,
        images
      },
      options
    );
    const result = await this.waitForResult(receipt.operationId, options);
    const messages = await this.getMessages(options);
    return { ...result, messages };
  }

  /** Wait for one operation's terminal result. */
  async waitForResult(
    operationId: string,
    options: PiLaneOptions = {}
  ): Promise<PiOperationResult> {
    const lane = options.lane ?? this.#defaultLane;
    const context = asUpstreamContext(options.context);
    for (;;) {
      const upstream = await this.#upstreamLane(lane, context);
      const settled = await upstream.getResult(operationId, context);
      if (settled) return projectResult(settled);
      const rejection = this.#rejections.get(operationId);
      if (rejection) {
        this.#rejections.delete(operationId);
        throw rejection;
      }
      await this.#settlement.wait(operationId, context);
    }
  }

  /**
   * Durably request that the lane's current operation stop. A queued
   * submission is withdrawn instead. Returns null when nothing matched.
   */
  async abort(
    options: PiLaneOptions & { readonly operationId?: string } = {}
  ): Promise<PiAbortResult> {
    await this.lifecycle.ready();
    const lane = options.lane ?? this.#defaultLane;
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(lane, context);
    const current = (await upstream.inspectExecution(context)).current;
    const operationId = options.operationId ?? current?.id;
    if (operationId === undefined) return null;
    if (current?.id !== operationId) {
      if (!this.#requireSubmissions().deleteOperation(operationId)) return null;
      // Withdrawn before pi admitted it: cancel the machine run that was
      // going to admit it, then publish the rejection.
      await this.#machines.cancel(this.#runIdFor(operationId), "aborted");
      this.#reject(
        lane,
        operationId,
        "run",
        new PiOperationRejectedError(
          operationId,
          "aborted",
          "Operation withdrawn before it started"
        )
      );
      return { operationId, newlyRequested: true };
    }
    const requested = await upstream.requestAbort(operationId, context);
    if (!requested.ok) {
      if (requested.error._tag === "OperationMismatch") return null;
      throw requested.error;
    }
    // Pi's marker is durable. Record the cancellation on the machine too, so
    // the run stops admitting new passes and settles as cancelled.
    await this.#machines.cancel(this.#runIdFor(operationId), "aborted");
    return { operationId, newlyRequested: requested.value.newlyRequested };
  }

  /** Queue a message the running operation reads at its next turn boundary. */
  async steer(
    message: PiMessageInput,
    options: PiLaneOptions = {}
  ): Promise<PiQueueReceipt> {
    const { text, images } = messageInput(message);
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(
      options.lane ?? this.#defaultLane,
      context
    );
    const queued = await upstream.steer(text, images, context);
    if (!queued.ok) throw queued.error;
    // Wake a parked run so the steer is read at the next turn boundary
    // instead of waiting out the park deadline.
    const current = (await upstream.inspectExecution(context)).current;
    if (current) {
      await this.#machines.notify(
        this.#runIdFor(current.id),
        { type: "pi:steered", key: current.id },
        { eventId: `steer:${queued.value.entryId}` }
      );
    }
    return { entryId: queued.value.entryId };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** Read one lane's durable transcript as display-ready chat messages. */
  async getMessages(options: PiTranscriptOptions = {}): Promise<PiMessage[]> {
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(
      options.lane ?? this.#defaultLane,
      context
    );
    const entries: Entry[] = await upstream.findEntries(
      { order: options.order ?? "oldestFirst" },
      context
    );
    return projectMessages(entries);
  }

  /** Read one immutable terminal operation result. */
  async getResult(
    operationId: string,
    options: PiLaneOptions = {}
  ): Promise<PiOperationResult | undefined> {
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(
      options.lane ?? this.#defaultLane,
      context
    );
    const result = await upstream.getResult(operationId, context);
    return result ? projectResult(result) : undefined;
  }

  /** Submissions the lane driver has not yet admitted into pi. */
  async pending(options: PiLaneOptions = {}): Promise<PiPendingSubmission[]> {
    await this.lifecycle.ready();
    return this.#requireSubmissions()
      .list(options.lane ?? this.#defaultLane)
      .map(({ seq: _seq, ...submission }) => submission);
  }

  /** A point-in-time view of one lane: transcript, live operation, queues. */
  async snapshot(options: PiLaneOptions = {}): Promise<PiLaneSnapshot> {
    const lane = options.lane ?? this.#defaultLane;
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(lane, context);
    const handle = await upstream.watch(context);
    handle.unsubscribe();
    const snapshot = handle.snapshot;
    const operation = snapshot.operation
      ? operationStatus(snapshot.operation)
      : null;
    return {
      lane,
      messages: projectMessages(snapshot.transcript),
      operation,
      stream: operation
        ? await this.#operationStream(lane, operation.operationId)
        : null,
      pending: await this.pending({ lane }),
      queue: projectQueue(snapshot.queues),
      model: snapshot.configuration.model,
      thinkingLevel: snapshot.configuration.thinkingLevel,
      activeTools: snapshot.configuration.activeToolNames,
      tools: (await this.#resolveTools(context)).map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description
      })),
      usage: snapshot.stats.usage
    };
  }

  /** The durable stream id of one operation's live events. */
  streamId(operationId: string, lane = this.#defaultLane): string {
    return `pi:${lane}:${operationId}`;
  }

  /**
   * The durable machine checkpoint driving one operation.
   *
   * This is the outer control state — phase, revision, current wait, and the
   * reconciled drive effect. Pi's transcript and tool records are read with
   * {@link getMessages} and {@link getResult} instead.
   */
  async inspect(
    operationId: string
  ): Promise<MachineRunSnapshot<PiRunState, PiRunResult> | null> {
    await this.lifecycle.ready();
    return this.#machines.get(this.#runIdFor(operationId), PI_RUN_DEFINITION);
  }

  /**
   * The machine run id that owns one operation.
   *
   * Exposed so a host can correlate an operation with StateMachine's own
   * control surface, and so tests can seed recovery states directly.
   */
  runIdFor(operationId: string): string {
    return this.#runIdFor(operationId);
  }

  /** Resume a paused machine run. */
  resume(operationId: string): Promise<boolean> {
    return this.#machines.resume(this.#runIdFor(operationId));
  }

  // ── Live ─────────────────────────────────────────────────────────────────

  /** Observe projected events in this isolate. Returns an unsubscribe. */
  on(listener: PiEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Options for a `WebSockets` capability serving this harness's protocol:
   * `new WebSockets(this.pi.webSockets())`. Clients receive a lane snapshot
   * on connect and replay-then-tail operation streams from their cursor.
   */
  webSockets(): WebSocketsOptions {
    this.#transport ??= new PiTransport(
      this.#transportHost(),
      () => this.lifecycle.sockets
    );
    return this.#transport.webSocketOptions();
  }

  // ── Attachment ───────────────────────────────────────────────────────────

  #attached(): Promise<Attached> {
    this.#attaching ??= this.#attach().catch((error: unknown) => {
      this.#attaching = undefined;
      throw error;
    });
    return this.#attaching;
  }

  async #attach(): Promise<Attached> {
    const storage = this.lifecycle.storage;
    const metadata = await ensurePiSession(storage);
    const database = new DurableObjectPiDatabase(storage);
    const session = new StorageBackedSession(
      metadata,
      new SqliteStorage(database, { sessionId: metadata.id })
    );
    const context = BACKGROUND_CONTEXT;
    const config = this.#config;
    const tools = await this.#resolveTools(context);
    const resources = await this.#resolveResources(context);
    const model = resolveModel(
      // SAFETY: the registry is pi-ai's Models; the opaque public type hides
      // the pinned upstream shape.
      config.models as never,
      config.model
    );

    let attached: UpstreamAgentHarness<object | undefined> | undefined;
    try {
      const options: UpstreamAgentHarnessOptions<object | undefined> = {
        session,
        // SAFETY: PiModels and PiModel are narrow public projections.
        models: config.models as Models,
        model: model as Model<Api>,
        thinkingLevel: config.thinkingLevel,
        activeToolNames:
          config.activeToolNames === undefined
            ? tools.map((tool) => tool.name)
            : [...config.activeToolNames],
        tools,
        resources,
        ...(config.toolContext === undefined
          ? {}
          : {
              // SAFETY: the tool context is opaque to the harness; PiContext
              // projects the Chord Context a resolver receives.
              toolContext: config.toolContext as UpstreamAgentHarnessOptions<
                object | undefined
              >["toolContext"]
            }),
        systemPrompt: async (toolContext, upstreamContext) => {
          const base =
            typeof config.systemPrompt === "function"
              ? await config.systemPrompt(
                  toolContext as ToolContext,
                  upstreamContext as PiContext
                )
              : (config.systemPrompt ?? "");
          const catalog = (await this.#resolvedSkills())?.catalog;
          return catalog ? [base, catalog].filter(Boolean).join("\n\n") : base;
        },
        streamOptions: config.streamOptions,
        retry: config.retry,
        compaction: config.compaction,
        steeringMode: config.steeringMode,
        followUpMode: config.followUpMode,
        toolExecution: config.toolExecution
      };
      const created = await createAgentHarness.create(options, context);
      attached = created.harness;
      for (const type of SUBSCRIBED_EVENT_TYPES) {
        attached.events.on(type, (event) => this.#dispatchEvent(event));
      }
      // SAFETY: PiHookRegistry is the public structural projection of pi's
      // hook registry.
      await config.configure?.(
        attached.hooks as PiHookRegistry,
        context as PiContext
      );
      return { harness: attached, open: created.open };
    } catch (error) {
      if (attached) await attached.close(context).catch(() => {});
      else await session.close(context).catch(() => {});
      throw error;
    }
  }

  async #upstreamLane(
    name: string,
    context: UpstreamContext
  ): Promise<UpstreamAgentLane> {
    await this.lifecycle.ready();
    const { harness } = await this.#attached();
    return harness.lane(name, context);
  }

  #requireSubmissions(): PiSubmissions {
    if (!this.#submissions) {
      throw new Error("PiHarness is not attached to its Durable Object");
    }
    return this.#submissions;
  }

  #resolvedSkills(): Promise<ResolvedSkills> | undefined {
    const sources = this.#config.skills;
    if (!sources || sources.length === 0) return undefined;
    // Sources are read once per isolate lifetime: pi's resources are
    // process-local anyway, so every wake sees the current skills.
    this.#skills ??= resolveSkillSources(sources).then((resolved) => {
      for (const warning of resolved.warnings)
        console.warn(`PiHarness skills: ${warning}`);
      return resolved;
    });
    return this.#skills;
  }

  async #resolveTools(
    context: UpstreamContext
  ): Promise<UpstreamAgentHarnessTool<object | undefined>[]> {
    const source = this.#config.tools;
    const own =
      typeof source === "function"
        ? await source(context as PiContext)
        : (source ?? []);
    const skillTools = (await this.#resolvedSkills())?.tools ?? [];
    return asUpstreamTools<object | undefined>([
      ...(own as readonly PiTool<object | undefined>[]),
      ...skillTools
    ]);
  }

  async #resolveResources(
    context: UpstreamContext
  ): Promise<UpstreamResources> {
    const source = this.#config.resources;
    const own =
      typeof source === "function"
        ? await source(context as PiContext)
        : (source ?? {});
    const skills = (await this.#resolvedSkills())?.skills ?? [];
    return asUpstreamResources({
      ...own,
      skills: [...(own.skills ?? []), ...skills]
    });
  }

  /** Re-supply process-local configuration pi does not persist. */
  async #refreshProcessLocal(
    harness: UpstreamAgentHarness<object | undefined>,
    lane: UpstreamAgentLane,
    context: UpstreamContext
  ): Promise<void> {
    const tools = await this.#resolveTools(context);
    await harness.setTools(tools, context);
    await harness.setResources(await this.#resolveResources(context), context);
    if (this.#config.activeToolNames !== undefined) return;
    // Without an explicit selection the lane offers every registered tool;
    // keep pi's durable selection aligned when the registry changes.
    const names = tools.map((tool) => tool.name);
    const active = await lane.getActiveTools(context);
    if (
      active.length !== names.length ||
      names.some((name) => !active.includes(name))
    ) {
      await lane.setActiveTools(names, context);
    }
  }

  // ── Machine drive host ───────────────────────────────────────────────────

  /**
   * The pi-side surface the machine's reconciled effect drives.
   *
   * Built once in the field initializer, so the effect runtime registered
   * with StateMachine stays stable across wakes.
   */
  #driveHost(): PiDriveHost {
    return {
      drive: (input, signal) => this.#drivePass(input, signal),
      lookup: (operationId) => this.#lookupOperation(operationId),
      requestAbort: (operationId) => this.#requestAbort(operationId)
    };
  }

  /** Start, or re-attach to, the machine run that owns one operation. */
  async #startOperationRun(
    lane: string,
    operationId: string,
    request: PiOperationRequest
  ): Promise<void> {
    this.#lanesOf.set(operationId, lane);
    await this.#machines.run(
      PI_RUN_DEFINITION,
      {
        lane,
        operationId,
        request,
        streamId: this.streamId(operationId, lane)
      },
      { runId: this.#runIdFor(operationId), idempotencyKey: operationId }
    );
  }

  /** The machine run id owning one pi operation. */
  #runIdFor(operationId: string): string {
    return `pi:${operationId}`;
  }

  /**
   * Run one bounded pass over pi's durable loop.
   *
   * The first pass admits the operation; later passes re-attach by id. Any
   * failure is thrown so the machine's effect records it, rather than being
   * folded into a private retry loop.
   */
  async #drivePass(
    input: PiDriveInput,
    signal: AbortSignal
  ): Promise<PiDriveOutput> {
    const { lane, operationId } = input;
    const context = BACKGROUND_CONTEXT;
    this.#lanesOf.set(operationId, lane);
    try {
      const { harness } = await this.#attached();
      const upstream = await harness.lane(lane, context);

      // A settled operation is terminal evidence; report it without driving.
      const already = await upstream.getResult(operationId, context);
      if (already) {
        this.#settleOperation(lane, already);
        return { kind: "settled", result: projectRunResult(already) };
      }

      let execution = await upstream.inspectExecution(context);
      if (execution.current?.id !== operationId) {
        if (execution.current) {
          // Another operation holds the lane. Park; pi admits in order.
          return { kind: "waiting", notBefore: Date.now() + LANE_BUSY_WAIT_MS };
        }
        if (!input.request) {
          // Pi has no record and no request to admit it with.
          throw new PiOperationRejectedError(
            operationId,
            "lost",
            "The operation is no longer known to pi"
          );
        }
        const request = input.request;
        const admission = await upstream.accept(
          asUpstreamRequest(request, operationId),
          context
        );
        if (!admission.ok) {
          if (admission.error._tag === "LaneBusy") {
            return {
              kind: "waiting",
              notBefore: Date.now() + LANE_BUSY_WAIT_MS
            };
          }
          const rejection = new PiOperationRejectedError(
            operationId,
            admission.error._tag,
            admission.error.message
          );
          this.#reject(lane, operationId, requestKind(request), rejection);
          return {
            kind: "settled",
            result: {
              operationId,
              status: "declined",
              error: { code: rejection.code, message: rejection.message }
            }
          };
        }
        this.#requireSubmissions().deleteOperation(operationId);
        const writer = await this.#writerFor(
          lane,
          operationId,
          admission.value.kind
        );
        this.#emitLaneEvent(
          lane,
          {
            type: "operation_start",
            operationId,
            kind: admission.value.kind,
            startedAt: admission.value.startedAt
          },
          operationId,
          writer
        );
        execution = await upstream.inspectExecution(context);
      }

      const current = execution.current;
      if (!current || current.id !== operationId) {
        // Admission raced with settlement; the next pass reads the record.
        return { kind: "waiting", notBefore: Date.now() };
      }

      await this.#refreshProcessLocal(harness, upstream, context);
      const writer = await this.#writerFor(
        lane,
        current.id,
        current.kind,
        current.startedAt
      );
      const onAbort = () => {
        void upstream.requestAbort(current.id, BACKGROUND_CONTEXT);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const driven = await upstream.drive(
          { operationId: current.id, waitForRetry: false, pollDeferred: true },
          context
        );
        if (!driven.ok) {
          if (driven.error._tag === "OperationMismatch") {
            const settled = await upstream.getResult(current.id, context);
            if (settled) {
              this.#settleOperation(lane, settled);
              return { kind: "settled", result: projectRunResult(settled) };
            }
          }
          throw driven.error;
        }
        const outcome = driven.value;
        if (outcome.kind === "settled") {
          this.#settleOperation(lane, outcome.outcome);
          return { kind: "settled", result: projectRunResult(outcome.outcome) };
        }
        writer.flush();
        return {
          kind: "waiting",
          notBefore:
            outcome.reason === "retry"
              ? outcome.notBefore
              : Date.now() + (outcome.deferred.pollAfterMs ?? DEFERRED_POLL_MS)
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycle.events.emit("operation:error", { lane, message });
      // A faulted harness is sealed; the next pass attaches a fresh one.
      this.#attaching = undefined;
      throw error;
    }
  }

  /**
   * Read pi's own durable record for one operation.
   *
   * This is the recovery authority: after eviction the machine asks pi what
   * happened rather than repeating a model request.
   */
  async #lookupOperation(operationId: string): Promise<PiOperationLookup> {
    const lane = this.#lanesOf.get(operationId) ?? this.#defaultLane;
    const context = BACKGROUND_CONTEXT;
    try {
      const upstream = await this.#upstreamLane(lane, context);
      const settled = await upstream.getResult(operationId, context);
      if (settled) {
        this.#settleOperation(lane, settled);
        return { status: "settled", result: projectRunResult(settled) };
      }
      const execution = await upstream.inspectExecution(context);
      if (execution.current?.id === operationId) return { status: "running" };
      // Pi neither retains a result nor holds it live: the pass never took.
      return { status: "not-found" };
    } catch {
      // Treat an unreadable attachment as still running; the machine parks
      // and asks again rather than inventing a terminal outcome.
      return { status: "running" };
    }
  }

  /** Durably ask pi to stop one operation, whichever lane owns it. */
  async #requestAbort(operationId: string): Promise<void> {
    const lane = this.#lanesOf.get(operationId) ?? this.#defaultLane;
    try {
      const upstream = await this.#upstreamLane(lane, BACKGROUND_CONTEXT);
      await upstream.requestAbort(operationId, BACKGROUND_CONTEXT);
    } catch {
      // The abort marker is best-effort here; the durable machine
      // cancellation has already been recorded.
    }
  }

  /** Publish one operation's terminal record to streams and listeners. */
  #settleOperation(lane: string, record: OperationResultRecord): void {
    const writer = this.#writers.get(record.operationId);
    if (!writer) return;
    this.#settle(lane, writer, record);
  }

  #settle(
    lane: string,
    writer: OperationStreamWriter,
    record: OperationResultRecord
  ): void {
    const result = projectResult(record);
    this.#emitLaneEvent(
      lane,
      { type: "operation_end", ...result },
      record.operationId,
      writer
    );
    writer.close();
    this.#writers.delete(record.operationId);
    if (this.#laneWriters.get(lane) === writer) this.#laneWriters.delete(lane);
    this.lifecycle.events.emit("operation:settled", {
      lane,
      operationId: record.operationId,
      status: record.status
    });
    this.#settlement.notify(record.operationId);
  }

  #reject(
    lane: string,
    operationId: string,
    kind: PiOperationKind,
    error: PiOperationRejectedError,
    submission?: QueuedSubmission
  ): void {
    this.#rejections.set(operationId, error);
    const now = Date.now();
    const event: PiEvent = {
      type: "operation_end",
      operationId,
      kind,
      status: "declined",
      error: { code: error.code, message: error.message },
      fromTipId: null,
      tipId: null,
      startedAt: submission?.submittedAt ?? now,
      endedAt: now
    };
    this.#emitLaneEvent(lane, event, operationId);
    this.lifecycle.events.emit("operation:rejected", {
      lane,
      operationId,
      code: error.code,
      message: error.message
    });
    this.#settlement.notify(operationId);
  }

  // ── Streams ──────────────────────────────────────────────────────────────

  async #writerFor(
    lane: string,
    operationId: string,
    kind: PiOperationKind,
    startedAt?: number
  ): Promise<OperationStreamWriter> {
    const existing = this.#writers.get(operationId);
    if (existing) return existing;
    const streamId = this.streamId(operationId, lane);
    let writer: Awaited<ReturnType<Streams["open"]>> | undefined;
    try {
      writer = await this.#streams.open(streamId, {
        tag: lane,
        metadata: { lane, operationId, kind }
      });
    } catch {
      // Already settled by a previous attempt: events have nowhere to go.
      writer = undefined;
    }
    const cursor = writer?.cursor ?? 0;
    const operationWriter = new OperationStreamWriter({
      streamId,
      operationId,
      lane,
      writer
    });
    this.#writers.set(operationId, operationWriter);
    this.#laneWriters.set(lane, operationWriter);
    if (writer && cursor === 0 && startedAt !== undefined) {
      // Admitted before a crash reached the stream: start it from pi's record.
      this.#emitLaneEvent(
        lane,
        { type: "operation_start", operationId, kind, startedAt },
        operationId,
        operationWriter
      );
    }
    this.#transport?.streamOpened(lane, streamId, operationId, cursor);
    return operationWriter;
  }

  async #operationStream(
    lane: string,
    operationId: string
  ): Promise<PiOperationStream | null> {
    const streamId = this.streamId(operationId, lane);
    const status = await this.#streams.status(streamId);
    return status ? { streamId, operationId, cursor: status.cursor } : null;
  }

  #dispatchEvent(event: HarnessEvent): void {
    if (event.type === "fault") {
      // The harness sealed itself; the next pass attaches a fresh one.
      this.#attaching = undefined;
    }
    const projected = projectHarnessEvent(event);
    if (!projected) return;
    const lane =
      "lane" in event && typeof event.lane === "string"
        ? event.lane
        : undefined;
    if (lane === undefined) {
      for (const writer of this.#laneWriters.values()) {
        this.#emitLaneEvent(
          writer.lane,
          projected.event,
          projected.operationId,
          writer
        );
      }
      if (this.#laneWriters.size === 0) {
        this.#emitLaneEvent(
          this.#defaultLane,
          projected.event,
          projected.operationId
        );
      }
      return;
    }
    const writer =
      (projected.operationId
        ? this.#writers.get(projected.operationId)
        : undefined) ?? this.#laneWriters.get(lane);
    this.#emitLaneEvent(lane, projected.event, projected.operationId, writer);
  }

  #emitLaneEvent(
    lane: string,
    event: PiEvent,
    operationId: string | undefined,
    writer?: OperationStreamWriter
  ): void {
    if (writer && !writer.closed) writer.push(event);
    else this.#transport?.laneEvent(lane, event);
    const context = {
      lane,
      operationId
    };
    for (const listener of this.#listeners) {
      try {
        listener(event, context);
      } catch (error) {
        console.error("PiHarness event listener failed", error);
      }
    }
  }

  // ── Waiters ──────────────────────────────────────────────────────────────

  #transportHost(): PiTransportHost {
    return {
      defaultLane: this.#defaultLane,
      streams: this.#streams,
      snapshot: (options) => this.snapshot(options),
      submit: (request, options) => this.submit(request, options),
      abort: (options) => this.abort(options),
      steer: (message, options) => this.steer(message, options)
    };
  }
}
