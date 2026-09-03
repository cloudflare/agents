import {
  AgentHarness as createAgentHarness,
  awaitWithContext,
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
  type LaneSnapshot,
  type OpenOperation,
  type OperationRequest as UpstreamOperationRequest,
  type OperationResultRecord,
  type Resources as UpstreamResources,
  type Skill as UpstreamSkill
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import { SqliteStorage } from "@earendil-works/pi-session-backend-sqlite-node/storage";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import type { Streams } from "agents/streams";
import type { Tasks, TaskStep } from "agents/tasks";
import type { WebSocketsOptions } from "agents/websockets";
import { DurableObjectPiDatabase, ensurePiSession } from "./do-sqlite";
import {
  OperationStreamWriter,
  projectHarnessEvent,
  SUBSCRIBED_EVENT_TYPES
} from "./events";
import { PiSubmissions, type QueuedSubmission } from "./intake";
import {
  projectMessages,
  projectQueue,
  projectAgentMessage,
  projectToolResult
} from "./messages";
import { resolveModel } from "../providers/models";
import { resolveSkillSources, type ResolvedSkills } from "./skills";
import { PiTransport, type PiTransportHost } from "./transport";
import type {
  PiAbortResult,
  PiContext,
  PiEvent,
  PiEventListener,
  PiHarnessConfig,
  PiHookRegistry,
  PiJson,
  PiLaneOptions,
  PiLaneSnapshot,
  PiMessage,
  PiMessageInput,
  PiOperationKind,
  PiOperationRequest,
  PiOperationResult,
  PiOperationStatus,
  PiOperationStream,
  PiPendingSubmission,
  PiPromptResponse,
  PiQueueReceipt,
  PiResources,
  PiSubmissionReceipt,
  PiSubmitOptions,
  PiTool,
  PiTranscriptOptions
} from "./types";

/** Task definition that drives one lane's operations to settlement. */
export const LANE_DRIVER_DEFINITION = "__cf_pi_harness_lane@v1";

const RECONCILE_JOB_ID = "reconcile";
const RECONCILE_FN = "reconcile";
const ENSURE_DRIVER_FN = "ensure-driver";
const DRIVE_STEP_TIMEOUT = "7 days";
const DRIVE_STEP_RETRIES = 100;
/** Each pass and each wait is a journaled step; Tasks caps steps per run. */
const MAX_PASSES_PER_DRIVER = 4_000;
const DRIVER_ROTATION_DELAY_MS = 2_000;
const DEFERRED_POLL_MS = 30_000;
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;
const RESULT_POLL_MS = 500;

type LaneDriverInput = { readonly version: 1; readonly lane: string };

type DrivePassOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "settled"; readonly operationId: string }
  | { readonly kind: "rejected"; readonly operationId: string }
  | { readonly kind: "retry"; readonly notBefore: number }
  | { readonly kind: "deferred"; readonly pollAfterMs: number }
  | { readonly kind: "error"; readonly message: string };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLaneDriverInput(value: unknown): LaneDriverInput {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.lane !== "string"
  ) {
    throw new Error("Invalid pi lane driver input");
  }
  return { version: 1, lane: value.lane };
}

function asUpstreamContext(context: PiContext | undefined): UpstreamContext {
  // SAFETY: PiContext is the public structural projection of Chord Context.
  return (context ?? BACKGROUND_CONTEXT) as UpstreamContext;
}

function asUpstreamRequest(
  request: PiOperationRequest,
  operationId: string
): UpstreamOperationRequest {
  switch (request.kind) {
    case "prompt":
      return {
        kind: "prompt",
        operationId,
        prompt: request.prompt,
        ...(request.images === undefined
          ? {}
          : {
              images: request.images.map(
                (image): ImageContent => ({ type: "image", ...image })
              )
            })
      };
    case "skill":
      return {
        kind: "skill",
        operationId,
        name: request.name,
        ...(request.additionalInstructions === undefined
          ? {}
          : { additionalInstructions: request.additionalInstructions })
      };
    case "prompt_template":
      return {
        kind: "prompt_template",
        operationId,
        name: request.name,
        ...(request.args === undefined ? {} : { args: [...request.args] })
      };
    case "compaction":
      return {
        kind: "compaction",
        operationId,
        ...(request.customInstructions === undefined
          ? {}
          : { customInstructions: request.customInstructions })
      };
    case "navigation":
      return {
        kind: "navigation",
        operationId,
        targetId: request.targetId,
        options: {
          ...(request.summarize === undefined
            ? {}
            : { summarize: request.summarize }),
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.customInstructions === undefined
            ? {}
            : { customInstructions: request.customInstructions })
        }
      };
  }
}

function requestKind(request: PiOperationRequest): PiOperationKind {
  switch (request.kind) {
    case "compaction":
      return "compaction";
    case "navigation":
      return "navigation";
    default:
      return "run";
  }
}

function messageInput(input: PiMessageInput): {
  text: string;
  images: ImageContent[] | undefined;
} {
  if (typeof input === "string") return { text: input, images: undefined };
  return {
    text: input.text,
    images: input.images?.map((image) => ({ type: "image", ...image }))
  };
}

function asUpstreamTools<ToolContext extends object | undefined>(
  tools: readonly PiTool<ToolContext>[]
): UpstreamAgentHarnessTool<ToolContext>[] {
  // SAFETY: PiTool is the public structural projection of AgentHarnessTool.
  return tools as unknown as UpstreamAgentHarnessTool<ToolContext>[];
}

function asUpstreamResources(resources: PiResources): UpstreamResources {
  // SAFETY: PiSkill and PiPromptTemplate mirror pi's Skill and PromptTemplate.
  return {
    ...(resources.skills === undefined
      ? {}
      : { skills: [...resources.skills] as UpstreamSkill[] }),
    ...(resources.promptTemplates === undefined
      ? {}
      : { promptTemplates: [...resources.promptTemplates] })
  };
}

function projectResult(record: OperationResultRecord): PiOperationResult {
  return {
    operationId: record.operationId,
    kind: record.kind,
    status: record.status,
    ...(record.error === undefined
      ? {}
      : { error: { code: record.error.code, message: record.error.message } }),
    fromTipId: record.fromTipId,
    tipId: record.tipId,
    startedAt: record.startedAt,
    endedAt: record.endedAt
  };
}

function operationStatus(
  operation: NonNullable<LaneSnapshot["operation"]>
): PiOperationStatus {
  const streaming = operation.streamingMessage
    ? projectAgentMessage(operation.streamingMessage, `pending:${operation.id}`)
    : undefined;
  return {
    operationId: operation.id,
    kind: operation.kind,
    status: operation.status === "aborting" ? "aborting" : "running",
    startedAt: operation.startedAt,
    ...(streaming === undefined ? {} : { streaming }),
    runningTools: operation.runningTools.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      // SAFETY: pi validated these arguments against the tool schema.
      arguments: tool.args as PiJson,
      ...(tool.partialResult === undefined
        ? {}
        : { partial: projectToolResult(tool.partialResult) })
    })),
    ...(operation.retry === undefined ? {} : { retry: operation.retry }),
    ...(operation.deferred === undefined
      ? {}
      : { deferred: operation.deferred.handle })
  };
}

function errorBackoffMs(consecutiveErrors: number): number {
  return Math.min(
    ERROR_BACKOFF_MAX_MS,
    ERROR_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveErrors - 1)
  );
}

/**
 * Hosts pi's durable AgentHarness inside a Lifecycle Durable Object.
 *
 * Pi owns the transcript, operation state, tool intents and outcomes,
 * retries, and crash recovery, all in this object's SQLite database. Around
 * it the capability composes the SDK's durable primitives: submissions queue
 * in a small intake table, each lane's work runs as one `Tasks` run whose
 * replay resumes pi from its own durable state, and every operation's live
 * events land in one `Streams` stream that clients replay and tail.
 *
 * @experimental This is a v0.2 integration with pi-mono's pinned `dev` API.
 */
export class PiHarness<
  ToolContext extends object | undefined = object | undefined
> extends LifecycleCapability {
  readonly #config: PiHarnessConfig<ToolContext>;
  readonly #tasks: Tasks;
  readonly #streams: Streams;
  readonly #defaultLane: string;
  #submissions: PiSubmissions | undefined;
  #attaching: Promise<Attached> | undefined;
  #skills: Promise<ResolvedSkills> | undefined;
  #transport: PiTransport | undefined;
  readonly #listeners = new Set<PiEventListener>();
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #laneWriters = new Map<string, OperationStreamWriter>();
  readonly #settlementWaiters = new Map<string, Set<() => void>>();
  readonly #rejections = new Map<string, PiOperationRejectedError>();
  readonly #ensuring = new Map<string, Promise<void>>();

  constructor(config: PiHarnessConfig<ToolContext>) {
    super("pi-harness");
    this.#config = config;
    this.#tasks = config.tasks;
    this.#streams = config.streams;
    this.#defaultLane = config.defaultLane ?? "main";
    config.tasks.register(LANE_DRIVER_DEFINITION, (input, step) =>
      this.#driveLane(parseLaneDriverInput(input), step)
    );
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

  /** Attach pi to this object's SQLite state and re-derive lane drivers. */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    this.#submissions = new PiSubmissions(this.lifecycle.storage);
    this.#submissions.ensureTable();
    const attached = await this.#attached();
    const lanes = new Set<string>([
      ...this.#submissions.lanes(),
      ...attached.open.map((operation) => operation.lane)
    ]);
    if (lanes.size === 0) return;
    // Drivers are re-derived after startup completes so Tasks is ready no
    // matter the installation order; interrupted drivers also replay on
    // their own through Tasks.
    await this.lifecycle.jobs.push({
      id: RECONCILE_JOB_ID,
      fn: RECONCILE_FN,
      time: Date.now(),
      payload: { lanes: [...lanes] }
    });
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const payload = context.job.payload;
    switch (context.job.fn) {
      case RECONCILE_FN: {
        const lanes =
          isRecord(payload) && Array.isArray(payload.lanes)
            ? payload.lanes.filter((lane) => typeof lane === "string")
            : [];
        for (const lane of lanes) await this.#ensureLaneDriver(lane);
        return;
      }
      case ENSURE_DRIVER_FN:
        if (isRecord(payload) && typeof payload.lane === "string") {
          await this.#ensureLaneDriver(payload.lane);
        }
        return;
      default:
        this.lifecycle.events.emit("operation:invalid_job", {
          jobId: context.job.id,
          fn: context.job.fn
        });
        return;
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
   * model. The submission is durable before this resolves; the lane driver
   * admits it into pi in order.
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
    submissions.insert(lane, operationId, request);
    await this.#ensureLaneDriver(lane);
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
        ...(images === undefined ? {} : { images })
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
      await this.#awaitSettlement(operationId, context);
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
    // The marker is durable; a driver reconciles it, now or after a wake.
    await this.#ensureLaneDriver(lane);
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
      usage: snapshot.stats.usage
    };
  }

  /** The durable stream id of one operation's live events. */
  streamId(operationId: string, lane = this.#defaultLane): string {
    return `pi:${lane}:${operationId}`;
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
        ...(config.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: config.thinkingLevel }),
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
        ...(config.streamOptions === undefined
          ? {}
          : { streamOptions: config.streamOptions }),
        ...(config.retry === undefined ? {} : { retry: config.retry }),
        ...(config.compaction === undefined
          ? {}
          : { compaction: config.compaction }),
        ...(config.steeringMode === undefined
          ? {}
          : { steeringMode: config.steeringMode }),
        ...(config.followUpMode === undefined
          ? {}
          : { followUpMode: config.followUpMode }),
        ...(config.toolExecution === undefined
          ? {}
          : { toolExecution: config.toolExecution })
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

  // ── Lane driver ──────────────────────────────────────────────────────────

  async #ensureLaneDriver(lane: string): Promise<void> {
    let ensuring = this.#ensuring.get(lane);
    if (!ensuring) {
      ensuring = this.#startLaneDriver(lane).finally(() => {
        this.#ensuring.delete(lane);
      });
      this.#ensuring.set(lane, ensuring);
    }
    return ensuring;
  }

  async #startLaneDriver(lane: string): Promise<void> {
    const live = await this.#tasks.list({
      definition: LANE_DRIVER_DEFINITION,
      status: ["pending", "running", "waiting"]
    });
    if (live.some((run) => run.metadata?.lane === lane)) return;
    const input: LaneDriverInput = { version: 1, lane };
    await this.#tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      LANE_DRIVER_DEFINITION,
      input,
      { runId: `pi:${lane}:${uuidv7()}`, metadata: { lane }, retain: false }
    );
  }

  async #driveLane(
    input: LaneDriverInput,
    step: TaskStep
  ): Promise<{ lane: string; passes: number; rotated?: true }> {
    const { lane } = input;
    let consecutiveErrors = 0;
    for (let pass = 0; pass < MAX_PASSES_PER_DRIVER; pass++) {
      const outcome = await step.do(
        `pass:${pass}`,
        { timeout: DRIVE_STEP_TIMEOUT, retries: { limit: DRIVE_STEP_RETRIES } },
        ({ signal }) => this.#drivePass(lane, signal)
      );
      if (outcome.kind === "error") {
        consecutiveErrors += 1;
        await step.status(`pi: ${outcome.message}`);
        await step.sleep(`backoff:${pass}`, errorBackoffMs(consecutiveErrors));
        continue;
      }
      consecutiveErrors = 0;
      switch (outcome.kind) {
        case "idle":
          return { lane, passes: pass + 1 };
        case "settled":
        case "rejected":
          continue;
        case "retry":
          await step.sleepUntil(`retry:${pass}`, outcome.notBefore);
          continue;
        case "deferred":
          await step.sleep(`poll:${pass}`, outcome.pollAfterMs);
          continue;
      }
    }
    // Rotate: this run completes, and a fresh driver picks the lane up.
    await this.lifecycle.jobs.push({
      fn: ENSURE_DRIVER_FN,
      time: Date.now() + DRIVER_ROTATION_DELAY_MS,
      payload: { lane }
    });
    return { lane, passes: MAX_PASSES_PER_DRIVER, rotated: true };
  }

  async #drivePass(
    lane: string,
    signal: AbortSignal
  ): Promise<DrivePassOutcome> {
    const context = BACKGROUND_CONTEXT;
    try {
      const { harness } = await this.#attached();
      const upstream = await harness.lane(lane, context);
      let execution = await upstream.inspectExecution(context);

      if (!execution.current) {
        const head = this.#requireSubmissions().head(lane);
        if (!head) return { kind: "idle" };
        if (await upstream.getResult(head.operationId, context)) {
          this.#requireSubmissions().delete(head.seq);
          return { kind: "settled", operationId: head.operationId };
        }
        const admission = await upstream.accept(
          asUpstreamRequest(head.request, head.operationId),
          context
        );
        if (admission.ok) {
          this.#requireSubmissions().delete(head.seq);
          const writer = await this.#writerFor(
            lane,
            head.operationId,
            admission.value.kind
          );
          this.#emitLaneEvent(
            lane,
            {
              type: "operation_start",
              operationId: head.operationId,
              kind: admission.value.kind,
              startedAt: admission.value.startedAt
            },
            head.operationId,
            writer
          );
        } else if (admission.error._tag !== "LaneBusy") {
          this.#requireSubmissions().delete(head.seq);
          this.#reject(
            lane,
            head.operationId,
            requestKind(head.request),
            new PiOperationRejectedError(
              head.operationId,
              admission.error._tag,
              admission.error.message
            ),
            head
          );
          return { kind: "rejected", operationId: head.operationId };
        }
        execution = await upstream.inspectExecution(context);
        if (!execution.current) return { kind: "idle" };
      }

      const current = execution.current;
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
              this.#settle(lane, writer, settled);
              return { kind: "settled", operationId: current.id };
            }
            return { kind: "error", message: driven.error.message };
          }
          throw driven.error;
        }
        const outcome = driven.value;
        switch (outcome.kind) {
          case "settled":
            this.#settle(lane, writer, outcome.outcome);
            return { kind: "settled", operationId: current.id };
          case "waiting":
            writer.flush();
            return outcome.reason === "retry"
              ? { kind: "retry", notBefore: outcome.notBefore }
              : {
                  kind: "deferred",
                  pollAfterMs: outcome.deferred.pollAfterMs ?? DEFERRED_POLL_MS
                };
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycle.events.emit("operation:error", { lane, message });
      // A faulted harness is sealed; the next pass attaches a fresh one.
      this.#attaching = undefined;
      return { kind: "error", message };
    }
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
    this.#notifySettled(record.operationId);
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
    this.#notifySettled(operationId);
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
      ...(operationId === undefined ? {} : { operationId })
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

  #notifySettled(operationId: string): void {
    const waiters = this.#settlementWaiters.get(operationId);
    this.#settlementWaiters.delete(operationId);
    if (waiters) for (const wake of waiters) wake();
  }

  #awaitSettlement(
    operationId: string,
    context: UpstreamContext
  ): Promise<void> {
    return awaitWithContext(
      new Promise<void>((resolve) => {
        let waiters = this.#settlementWaiters.get(operationId);
        if (!waiters) {
          waiters = new Set();
          this.#settlementWaiters.set(operationId, waiters);
        }
        const wake = () => {
          clearTimeout(timer);
          waiters?.delete(wake);
          resolve();
        };
        // The poll is insurance: settlement normally wakes waiters directly.
        const timer = setTimeout(wake, RESULT_POLL_MS);
        waiters.add(wake);
      }),
      context
    );
  }

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
