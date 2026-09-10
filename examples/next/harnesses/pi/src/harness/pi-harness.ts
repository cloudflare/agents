import {
  AgentHarness as createAgentHarness,
  awaitWithContext,
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
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
import { shellExecAdapter } from "./env";
import {
  createLaneUiBridges,
  describeTools,
  piSlashCommands,
  PiExtensionRuntime,
  resolveSubmission,
  slashCommandInfos,
  type PiExtensionHandlerError,
  type PiLaneUiBridges
} from "./extensions";
import {
  OperationStreamWriter,
  projectHarnessEvent,
  SUBSCRIBED_EVENT_TYPES
} from "./events";
import {
  PiSubmissions,
  type PiDisposition,
  type QueuedSubmission
} from "./intake";
import {
  projectCustomEntries,
  projectMessages,
  projectQueue,
  projectAgentMessage,
  projectToolResult
} from "./messages";
import { resolveModel, type PiModelRegistry } from "../providers/models";
import { resolveSkillSources, type ResolvedSkills } from "./skills";
import { PiTransport, type PiTransportHost } from "./transport";
import type {
  PiAbortResult,
  PiBuiltinToolName,
  PiExtension,
  PiContext,
  PiCustomEntry,
  PiEvent,
  PiEventContext,
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
  PiPromptTemplate,
  PiQueueReceipt,
  PiExtensionUiResponse,
  PiResources,
  PiSkill,
  PiSlashCommand,
  PiSubmissionReceipt,
  PiSubmitOptions,
  PiTool,
  PiTranscriptOptions
} from "./types";

/** Task definition that drives one lane's operations to settlement. */
export const LANE_DRIVER_DEFINITION = "__cf_pi_harness_lane@v1";

/** Pi's own execution tools, keyed by the name the config selects them with. */
const BUILTIN_TOOL_FACTORIES: Record<
  PiBuiltinToolName,
  () => UpstreamAgentHarnessTool<object | undefined>
> = {
  // SAFETY: each factory produces a tool over pi's ExecutionToolContext; the
  // harness's opaque context carries `env` for them.
  bash: () => createBashTool() as UpstreamAgentHarnessTool<object | undefined>,
  edit: () => createEditTool() as UpstreamAgentHarnessTool<object | undefined>,
  read: () => createReadTool() as UpstreamAgentHarnessTool<object | undefined>,
  write: () => createWriteTool() as UpstreamAgentHarnessTool<object | undefined>
};

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
/** Default wait for a client's answer to a blocking extension UI dialog. */
const DEFAULT_UI_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Durable key prefix for one lane's tool registry baseline.
 *
 * The registry is process-local and the lane's active set is durable, so the
 * reconciliation in {@link PiHarness.#refreshProcessLocal} needs a third
 * durable fact: which tools the registry held the last time it reconciled.
 * Held in isolate memory alone, that baseline is reborn empty after every
 * deploy, and a lane that already carries a selection is then never told
 * about a tool the deploy added.
 */
const TOOL_BASELINE_KEY = "cf_agents_pi:tool_baseline:";

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
  /** Absent when the harness runs without extensions. */
  readonly extensions: PiExtensionRuntime | undefined;
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

/**
 * Keep the first entry of each name, in order.
 *
 * Resources arrive from several places — the configuration, resolved skill
 * sources, a resource loader — and a name that appears twice is one command
 * offered twice. The earlier source wins, so the configuration's own entry
 * is never displaced by one a loader happens to share a name with.
 */
function byName<T extends { readonly name: string }>(
  entries: readonly T[]
): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
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

/**
 * The settled result of a submission that never became an operation.
 *
 * An `input` handler or an extension slash command consumes the submission
 * where it stands, so pi records no operation and there is nothing to wait
 * for. Callers still get a terminal result — the work is over — flagged by
 * `handled` or `command` so they can tell it apart from a model run.
 */
function outOfBandResult(operationId: string): PiOperationResult {
  const now = Date.now();
  return {
    operationId,
    kind: "run",
    status: "completed",
    fromTipId: null,
    tipId: null,
    startedAt: now,
    endedAt: now
  };
}

/**
 * The receipt a retried out-of-band submission gets: the same one its first
 * attempt returned, with no handler re-run.
 *
 * A claim that never reached a terminal kind — the isolate died between the
 * claim and the handler's return — is reported as handled. The handler may
 * have run in part and there is no operation to wait for either way, so the
 * retry is answered rather than replayed: out-of-band submissions are
 * at-most-once.
 */
function dispositionReceipt(disposition: PiDisposition): PiSubmissionReceipt {
  const base = {
    operationId: disposition.operationId,
    lane: disposition.lane,
    accepted: false as const
  };
  return disposition.kind === "command" && disposition.command !== undefined
    ? { ...base, command: disposition.command }
    : { ...base, handled: true };
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
  #extensions: PiExtensionRuntime | undefined;
  #toolInfos: ReturnType<typeof describeTools> = [];
  #refreshingTools: Promise<void> | undefined;
  #skills: Promise<ResolvedSkills> | undefined;
  #transport: PiTransport | undefined;
  #uiBridges: PiLaneUiBridges | undefined;
  #resources: {
    readonly skills: readonly PiSkill[];
    readonly promptTemplates: readonly PiPromptTemplate[];
  } = { skills: [], promptTemplates: [] };
  readonly #listeners = new Set<PiEventListener>();
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #laneWriters = new Map<string, OperationStreamWriter>();
  readonly #settlementWaiters = new Map<string, Set<() => void>>();
  readonly #rejections = new Map<string, PiOperationRejectedError>();
  readonly #ensuring = new Map<string, Promise<void>>();
  /**
   * The tool registry as each lane last saw it, for {@link
   * PiHarness.#refreshProcessLocal}. Process-local like the registry itself:
   * a new attachment starts from the durable selection again.
   */
  readonly #registeredTools = new Map<string, ReadonlySet<string>>();

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
    const extensions = this.#extensions;
    this.#attaching = undefined;
    this.#extensions = undefined;
    for (const writer of this.#writers.values()) writer.flush();
    this.#uiBridges?.abortAll("The pi harness is closing");
    await extensions?.stop().catch(() => {});
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
    // Idempotency is settled before anything observable happens. A retried
    // submission carries the operation id of the first one, and an `input`
    // handler or a slash command is a side effect that must not run twice
    // for it — so this check comes ahead of both, not after them.
    //
    // A queued operation is its own record: pi keeps its result forever and
    // the intake row covers the window before it starts. A submission
    // consumed out of band queues nothing, so it leaves a disposition row
    // instead — without one, a retry would replay the handler.
    const disposition = submissions.disposition(operationId);
    if (disposition) return dispositionReceipt(disposition);
    if (
      submissions.has(operationId) ||
      (await upstream.getResult(operationId, context)) !== undefined ||
      (await upstream.inspectExecution(context)).current?.id === operationId
    ) {
      return { operationId, lane, accepted: false };
    }
    // Only a typed prompt can be consumed out of band: every other kind is
    // queued verbatim, and pays for no claim.
    if (request.kind !== "prompt" || this.#extensions === undefined) {
      return this.#queue(lane, operationId, request);
    }
    if (!submissions.claim(lane, operationId)) {
      // A concurrent submission of the same id holds the claim; it, not this
      // one, runs whatever the submission turns out to be.
      return { operationId, lane, accepted: false };
    }
    let queued: PiOperationRequest;
    try {
      const admitted = await this.#interceptInput(lane, request);
      if (admitted === undefined) {
        submissions.settle(operationId, "handled");
        return { operationId, lane, accepted: false, handled: true };
      }
      const resolved = resolveSubmission(admitted, {
        hasCommand: (name) => this.#extensions?.hasCommand(name) ?? false,
        promptTemplates: this.#resources.promptTemplates,
        skills: this.#resources.skills
      });
      if (resolved.kind === "command") {
        // Extension commands are not operations: they run here, against the
        // same lane actions an event handler uses, and queue nothing. The
        // disposition is terminal before the handler runs, so an eviction
        // mid-command cannot replay its side effects on the retry.
        submissions.settle(operationId, "command", resolved.name);
        await this.#extensions?.runCommand(lane, resolved.name, resolved.args);
        return { operationId, lane, accepted: false, command: resolved.name };
      }
      queued = resolved.request;
    } catch (error) {
      // Nothing was consumed, so the id goes back to being free.
      submissions.release(operationId);
      throw error;
    }
    // An ordinary operation after all: the queue row is its record from here.
    submissions.release(operationId);
    return this.#queue(lane, operationId, queued);
  }

  /** Durably enqueue one resolved request and wake the lane's driver. */
  async #queue(
    lane: string,
    operationId: string,
    request: PiOperationRequest
  ): Promise<PiSubmissionReceipt> {
    this.#requireSubmissions().insert(lane, operationId, request);
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
    const messages = () => this.getMessages(options);
    // An `input` handler or a slash command consumes the submission without
    // queueing an operation, so there is no result to wait for and waiting
    // would never end. The transcript is still read: both can write to it.
    if (receipt.handled === true || receipt.command !== undefined) {
      return {
        ...outOfBandResult(receipt.operationId),
        ...(receipt.handled === true ? { handled: true } : {}),
        ...(receipt.command === undefined ? {} : { command: receipt.command }),
        messages: await messages()
      };
    }
    const result = await this.waitForResult(receipt.operationId, options);
    return { ...result, messages: await messages() };
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

  /**
   * Read the custom entries extensions appended to one lane's transcript.
   * They hold extension state, so they are absent from `getMessages`.
   */
  async getCustomEntries(
    options: PiTranscriptOptions = {}
  ): Promise<PiCustomEntry[]> {
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(
      options.lane ?? this.#defaultLane,
      context
    );
    const entries: Entry[] = await upstream.findEntries(
      { order: options.order ?? "oldestFirst" },
      context
    );
    return projectCustomEntries(entries);
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

  // ── Extension surface ────────────────────────────────────────────────────

  /**
   * Every slash command one lane offers: extension commands, then prompt
   * templates, then skills. Pi's terminal built-ins are not among them.
   */
  async getCommands(): Promise<PiSlashCommand[]> {
    await this.lifecycle.ready();
    await this.#attached();
    const extensions = this.#extensions;
    if (extensions) return extensions.slashCommands();
    return piSlashCommands(
      slashCommandInfos({
        extension: [],
        promptTemplates: this.#resources.promptTemplates,
        skills: this.#resources.skills
      })
    );
  }

  /**
   * Run one extension slash command by name, exactly as submitting
   * `/name args` would. The receipt reports the command that ran; no
   * operation is queued for it.
   */
  async runCommand(
    name: string,
    args: string | undefined,
    options: PiSubmitOptions = {}
  ): Promise<PiSubmissionReceipt> {
    const text =
      args === undefined || args === "" ? `/${name}` : `/${name} ${args}`;
    return this.submit({ kind: "prompt", prompt: text }, options);
  }

  /**
   * Set one extension flag and return every flag's current value. Throws
   * when no extension registered that flag, or when the value is not of the
   * type it was registered with.
   */
  async setFlag(
    name: string,
    value: boolean | string
  ): Promise<Record<string, boolean | string>> {
    await this.lifecycle.ready();
    await this.#attached();
    const extensions = this.#extensions;
    if (!extensions) {
      throw new Error("This pi harness has no extensions, so it has no flags");
    }
    extensions.setFlag(name, value);
    const flags = extensions.flagValues();
    this.#transport?.flagsChanged(this.#defaultLane, flags);
    return flags;
  }

  /** Current values of every extension-registered flag. */
  async getFlags(): Promise<Record<string, boolean | string>> {
    await this.lifecycle.ready();
    await this.#attached();
    return this.#extensions?.flagValues() ?? {};
  }

  /**
   * Answer one open extension UI dialog. False when nothing is waiting on
   * that request id, which includes a dialog already settled by its timeout.
   */
  resolveExtensionUi(
    requestId: string,
    response: PiExtensionUiResponse
  ): boolean {
    return this.#uiBridges?.resolve(requestId, response) ?? false;
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
    // Extensions load first: their tools have to be registered before the
    // harness is created so the model is offered them on the first turn
    // after every wake.
    const extensions = await this.#createExtensionRuntime(context, metadata.id);
    this.#extensions = extensions;
    const tools = await this.#resolveTools(context);
    const resources = await this.#resolveResources(context);
    const toolContextSource = this.#toolContextSource();
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
        ...(toolContextSource === undefined
          ? {}
          : {
              // SAFETY: the tool context is opaque to the harness; PiContext
              // projects the Chord Context a resolver receives.
              toolContext: toolContextSource as UpstreamAgentHarnessOptions<
                object | undefined
              >["toolContext"]
            }),
        systemPrompt: (toolContext, upstreamContext) =>
          this.#systemPrompt(toolContext, upstreamContext),
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
      // Extension actions, hooks, and notifications need the live harness,
      // so they bind here; the application's own hooks go on last.
      extensions?.attach(attached.hooks);
      // SAFETY: PiHookRegistry is the public structural projection of pi's
      // hook registry.
      await config.configure?.(
        attached.hooks as PiHookRegistry,
        context as PiContext
      );
      // Registration is complete: publish the command set this attachment
      // offers to whoever is already connected.
      this.#broadcastCommands();
      return { harness: attached, open: created.open, extensions };
    } catch (error) {
      this.#extensions = undefined;
      await extensions?.stop().catch(() => {});
      if (attached) await attached.close(context).catch(() => {});
      else await session.close(context).catch(() => {});
      throw error;
    }
  }

  /**
   * Build the process-local extension runtime for this attachment, or
   * nothing when the configuration names no extensions.
   */
  async #createExtensionRuntime(
    context: UpstreamContext,
    sessionId: string
  ): Promise<PiExtensionRuntime | undefined> {
    const config = this.#config;
    const source = config.extensions;
    const extensions =
      typeof source === "function"
        ? await source(context as PiContext)
        : source;
    if (!extensions || extensions.length === 0) return undefined;
    const env = config.executionEnv;
    return PiExtensionRuntime.create({
      extensions: extensions as readonly PiExtension[],
      cwd: config.cwd ?? "/",
      defaultLane: this.#defaultLane,
      sessionId,
      // SAFETY: PiModels is the opaque projection of the same registry
      // `createModels` returns.
      models: config.models as PiModelRegistry,
      ...(config.flags === undefined ? {} : { flags: config.flags }),
      promptTemplates: () => this.#resources.promptTemplates,
      skills: () => this.#resources.skills,
      ...(typeof config.systemPrompt === "string"
        ? { systemPrompt: config.systemPrompt }
        : {}),
      // `before_agent_start` is handed the prompt pi is about to send, not
      // the configured one: a dynamic `systemPrompt` and the skills catalog
      // both only exist once assembled.
      resolveSystemPrompt: (lane) => this.#resolveSystemPrompt(lane),
      // The lane driver opens an operation's stream writer on its lane
      // before every pass of `drive`, and a tool call only ever runs inside
      // one — a call recovered after an eviction included, because the pass
      // that recovers it opens the writer first. The map is therefore
      // derived from durable state on every wake rather than maintained as
      // a table of its own, which would cost a write per operation.
      laneForInvocation: (invocation) =>
        this.#writers.get(invocation.operationId)?.lane,
      ...(config.resourceLoader === undefined
        ? {}
        : { resourceLoader: config.resourceLoader }),
      // The blocking UI surface `ctx.ui` exposes, one bridge per lane over
      // this harness's WebSocket protocol.
      uiContext: this.#uiBridgeSet().ui,
      // `pi.exec` runs on the same shell pi's own bash tool uses.
      ...(env === undefined ? {} : { shell: shellExecAdapter(env) }),
      lane: (name) => this.#upstreamLane(name, BACKGROUND_CONTEXT),
      setSessionName: async (name) => {
        const { harness } = await this.#attached();
        await harness.setName(name, BACKGROUND_CONTEXT);
      },
      setLabel: async (entryId, label) => {
        const { harness } = await this.#attached();
        await harness.setLabel(entryId, label, BACKGROUND_CONTEXT);
      },
      refreshTools: () => this.#scheduleToolRefresh(),
      // Commands can be registered long after load — from a `session_start`
      // handler, say — and clients autocomplete from what was published.
      commandsChanged: () => this.#broadcastCommands(),
      allTools: () => this.#toolInfos,
      compact: async (lane, options) => {
        await this.submit(
          {
            kind: "compaction",
            ...(options?.customInstructions === undefined
              ? {}
              : { customInstructions: options.customInstructions })
          },
          { lane }
        );
      },
      navigate: async (lane, targetId, options) => {
        await this.submit(
          {
            kind: "navigation",
            targetId,
            ...(options?.summarize === undefined
              ? {}
              : { summarize: options.summarize }),
            ...(options?.label === undefined ? {} : { label: options.label }),
            ...(options?.customInstructions === undefined
              ? {}
              : { customInstructions: options.customInstructions })
          },
          { lane }
        );
      },
      report: (error) => this.#reportHandlerError(error)
    });
  }

  /**
   * Run pi's `input` event over one submission. Returns the request to queue,
   * or nothing when an extension consumed it.
   */
  async #interceptInput(
    lane: string,
    request: PiOperationRequest
  ): Promise<PiOperationRequest | undefined> {
    const { extensions } = await this.#attached();
    if (!extensions || request.kind !== "prompt") return request;
    // The submitting lane is named rather than inferred: a submission can
    // arrive while some other lane's handler is the current scope.
    const outcome = await extensions.emitInput(
      request.prompt,
      request.images?.map(
        (image): ImageContent => ({ type: "image", ...image })
      ),
      "rpc",
      lane
    );
    switch (outcome.action) {
      case "handled":
        // A consumed submission answers the caller, so whatever the handler
        // wrote to the lane has to be durable before the receipt is: a
        // client that reads the transcript on the receipt must see it.
        await extensions.drain(lane);
        return undefined;
      case "transform":
        await extensions.drain(lane);
        return {
          ...request,
          prompt: outcome.text,
          ...(outcome.images === undefined
            ? {}
            : {
                images: outcome.images.map(({ type: _type, ...image }) => image)
              })
        };
      default:
        return request;
    }
  }

  /** Re-resolve process-local tools after an extension registered one. */
  #scheduleToolRefresh(): void {
    if (this.#refreshingTools) return;
    this.#refreshingTools = (async () => {
      const { harness } = await this.#attached();
      const lane = await harness.lane(this.#defaultLane, BACKGROUND_CONTEXT);
      await this.#refreshProcessLocal(harness, lane, BACKGROUND_CONTEXT);
      // A registration change can add commands as easily as tools.
      this.#broadcastCommands();
    })()
      .catch((error: unknown) => {
        console.warn("PiHarness failed to refresh extension tools", error);
      })
      .finally(() => {
        this.#refreshingTools = undefined;
      });
  }

  /**
   * The per-lane extension UI bridges, created with the harness's first
   * attachment and reused across them: a dialog is answered by request id,
   * which outlives any one attachment.
   */
  #uiBridgeSet(): PiLaneUiBridges {
    this.#uiBridges ??= createLaneUiBridges({
      // Dialogs belong to the lane whose hook, event or tool raised them.
      lane: () => this.#extensions?.currentLane ?? this.#defaultLane,
      broadcast: (lane, request) =>
        this.#transport?.extensionUiRequest(lane, request) ?? 0,
      onSettled: (lane, requestId) =>
        this.#transport?.extensionUiSettled(lane, requestId),
      timeoutMs:
        this.#config.uiRequestTimeoutMs ?? DEFAULT_UI_REQUEST_TIMEOUT_MS
    });
    return this.#uiBridges;
  }

  /** Tell a lane's clients which slash commands it now offers. */
  #broadcastCommands(lane = this.#defaultLane): void {
    const transport = this.#transport;
    if (!transport) return;
    void this.getCommands()
      .then((commands) => {
        transport.commandsChanged(lane, commands);
      })
      .catch((error: unknown) => {
        console.warn("PiHarness failed to publish slash commands", error);
      });
  }

  /** Surface one hook, event, or extension failure on its lane. */
  #reportHandlerError(error: PiExtensionHandlerError): void {
    const event: PiEvent = {
      type: "handler_error",
      kind: error.kind,
      source: error.source,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack })
    };
    const writer = this.#laneWriters.get(error.lane);
    if (writer && !writer.closed) {
      // Inside an operation the failure belongs on its durable stream, where
      // clients replaying that operation see it in order.
      this.#emitLaneEvent(error.lane, event, undefined, writer);
      return;
    }
    // Outside one there is no stream to carry it: the dedicated frame does,
    // and the lane event path is skipped so clients see it once.
    this.#transport?.handlerError(error.lane, {
      kind: error.kind,
      source: error.source,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack })
    });
    this.#notifyListeners(event, { lane: error.lane });
  }

  /** Drop the current attachment and tear its extension runtime down. */
  #discardAttachment(): void {
    this.#attaching = undefined;
    this.#registeredTools.clear();
    const extensions = this.#extensions;
    this.#extensions = undefined;
    // Nothing will answer the dialogs this attachment left open.
    this.#uiBridges?.abortAll("The pi harness detached");
    if (extensions) void extensions.stop().catch(() => {});
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
    const tools = [
      ...this.#builtinTools(),
      ...asUpstreamTools<object | undefined>([
        ...(own as readonly PiTool<object | undefined>[]),
        ...skillTools
      ]),
      // Third source: whatever the loaded extensions registered.
      ...(this.#extensions?.tools() ?? [])
    ];
    this.#toolInfos = describeTools(tools);
    return tools;
  }

  /**
   * Pi's own `read`/`write`/`edit`/`bash` tools over the configured execution
   * environment. They read it from `toolContext.env`, which
   * {@link PiHarness.#toolContextSource} supplies.
   */
  #builtinTools(): UpstreamAgentHarnessTool<object | undefined>[] {
    const config = this.#config;
    if (config.executionEnv === undefined) return [];
    const selection = config.builtinTools ?? [];
    return selection.map((name) => BUILTIN_TOOL_FACTORIES[name]());
  }

  /**
   * Resolve the tool context each turn receives. With an execution
   * environment configured, `env` is merged over the application's own
   * context so pi's built-in tools find what they require.
   */
  #toolContextSource():
    | UpstreamAgentHarnessOptions<object | undefined>["toolContext"]
    | undefined {
    const config = this.#config;
    const source = config.toolContext;
    const env = config.executionEnv;
    if (env === undefined) {
      return source as
        | UpstreamAgentHarnessOptions<object | undefined>["toolContext"]
        | undefined;
    }
    return async (context: UpstreamContext) => {
      const base =
        typeof source === "function"
          ? await (
              source as (
                context: PiContext
              ) => object | undefined | Promise<object | undefined>
            )(context as PiContext)
          : source;
      return { ...(base ?? {}), env };
    };
  }

  /**
   * The system prompt a turn is given: the application's own prompt, with the
   * skills catalog appended when skills are configured.
   *
   * It lives on the harness rather than inside the `AgentHarness` options so
   * that the extension runtime can ask for the same string pi is about to
   * send — `before_agent_start` receives the prompt as it will actually be
   * assembled, not a stale copy of the configured one.
   */
  async #systemPrompt(
    toolContext: object | undefined,
    upstreamContext: UpstreamContext
  ): Promise<string> {
    const config = this.#config;
    const base =
      typeof config.systemPrompt === "function"
        ? await config.systemPrompt(
            toolContext as ToolContext,
            upstreamContext as PiContext
          )
        : (config.systemPrompt ?? "");
    const catalog = (await this.#resolvedSkills())?.catalog;
    return catalog ? [base, catalog].filter(Boolean).join("\n\n") : base;
  }

  /**
   * {@link PiHarness.#systemPrompt} resolved for one lane's tool context.
   *
   * The prompt this harness assembles does not vary by lane — the lane is
   * part of the contract because an extension asks per invocation, and a
   * harness whose prompt did vary would need it.
   */
  async #resolveSystemPrompt(_lane: string): Promise<string> {
    const context = BACKGROUND_CONTEXT;
    const source = this.#toolContextSource();
    const toolContext =
      typeof source === "function" ? await source(context) : source;
    return this.#systemPrompt(toolContext, context);
  }

  async #resolveResources(
    context: UpstreamContext
  ): Promise<UpstreamResources> {
    const source = this.#config.resources;
    const own =
      typeof source === "function"
        ? await source(context as PiContext)
        : (source ?? {});
    const resolved = (await this.#resolvedSkills())?.skills ?? [];
    const loaded = this.#loaderResources();
    const skills = byName([
      ...(own.skills ?? []),
      ...resolved,
      ...loaded.skills
    ]);
    const promptTemplates = byName([
      ...(own.promptTemplates ?? []),
      ...(this.#config.promptTemplates ?? []),
      ...loaded.promptTemplates
    ]);
    // Cached for the synchronous command surfaces: pi's `getCommands` and the
    // slash resolver both list skills and templates without awaiting.
    this.#resources = { skills, promptTemplates };
    return asUpstreamResources({ ...own, skills, promptTemplates });
  }

  /**
   * Skills and prompt templates a configured resource loader serves.
   *
   * The loader replaces the in-memory surface pi's extension runtime reads,
   * so its resources have to reach the harness's own resources and the
   * command cache too. Otherwise a `/deploy` the loader supplies is neither
   * listed by `getCommands` nor resolvable when submitted — the runtime
   * knows about it and nothing else does.
   *
   * pi's `Skill` names a file rather than carrying its body, and a Durable
   * Object has no filesystem to read one from. A loader skill therefore
   * counts only when it carries its own `content`; listing one without a
   * body would offer a command no run could execute.
   */
  #loaderResources(): {
    readonly skills: readonly PiSkill[];
    readonly promptTemplates: readonly PiPromptTemplate[];
  } {
    const loader = this.#config.resourceLoader;
    if (loader === undefined) return { skills: [], promptTemplates: [] };
    const skills: PiSkill[] = [];
    for (const skill of loader.getSkills().skills) {
      const content = "content" in skill ? skill.content : undefined;
      if (typeof content !== "string") continue;
      skills.push({
        name: skill.name,
        description: skill.description,
        content,
        filePath: skill.filePath,
        ...(skill.disableModelInvocation === true
          ? { disableModelInvocation: true }
          : {})
      });
    }
    const promptTemplates = loader.getPrompts().prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      content: prompt.content
    }));
    return { skills, promptTemplates };
  }

  /**
   * Re-supply process-local configuration pi does not persist.
   *
   * The tool registry is process-local and the lane's selection is durable,
   * so the two are reconciled rather than one overwriting the other. A pass
   * that wrote the whole registry back every time would undo
   * `pi.setActiveTools([...])` before the next drive: an extension narrows
   * the set, and the next refresh widens it again. Only a registry that
   * actually changed since the last pass moves the selection — newly
   * registered tools join it, withdrawn ones leave it, and whatever the lane
   * selected in between stays selected.
   *
   * The baseline the comparison needs is durable, not process-local. A
   * deploy that registers a new tool starts every isolate with an empty
   * memory; a purely in-memory baseline would read that first pass as "first
   * time this lane was seen", leave the stored selection untouched, and the
   * new tool would never become active on any lane that had one.
   */
  async #refreshProcessLocal(
    harness: UpstreamAgentHarness<object | undefined>,
    lane: UpstreamAgentLane,
    context: UpstreamContext
  ): Promise<void> {
    const tools = await this.#resolveTools(context);
    await harness.setTools(tools, context);
    await harness.setResources(await this.#resolveResources(context), context);
    if (this.#config.activeToolNames !== undefined) return;
    const names = tools.map((tool) => tool.name);
    const previous =
      this.#registeredTools.get(lane.name) ??
      (await this.#storedToolBaseline(lane.name));
    this.#registeredTools.set(lane.name, new Set(names));
    await this.#storeToolBaseline(lane.name, names, previous);
    const active = await lane.getActiveTools(context);
    if (previous === undefined) {
      // First pass for this lane, ever. A lane that carries a selection
      // keeps it — it is the durable one, extension edits and all; a lane
      // with none is offered every registered tool.
      if (active.length > 0) return;
      await lane.setActiveTools(names, context);
      return;
    }
    // Newly registered names join the selection, names that vanished from
    // the registry leave it, and the rest of the lane's selection stands.
    const next = names.filter(
      (name) => !previous.has(name) || active.includes(name)
    );
    if (
      next.length === active.length &&
      next.every((name) => active.includes(name))
    ) {
      return;
    }
    await lane.setActiveTools(next, context);
  }

  /** The tool registry as this lane last reconciled against it, if ever. */
  async #storedToolBaseline(
    lane: string
  ): Promise<ReadonlySet<string> | undefined> {
    const stored = await this.lifecycle.storage.get<string[]>(
      `${TOOL_BASELINE_KEY}${lane}`
    );
    return stored === undefined ? undefined : new Set(stored);
  }

  /**
   * Record the registry this lane just reconciled against, when it moved.
   *
   * Writes are ~1000× the cost of reads here, and the registry is the same
   * on every pass of a stable deployment, so the common case writes nothing.
   */
  async #storeToolBaseline(
    lane: string,
    names: readonly string[],
    previous: ReadonlySet<string> | undefined
  ): Promise<void> {
    if (
      previous !== undefined &&
      previous.size === names.length &&
      names.every((name) => previous.has(name))
    ) {
      return;
    }
    await this.lifecycle.storage.put(`${TOOL_BASELINE_KEY}${lane}`, [...names]);
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
      this.#discardAttachment();
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
    this.#extensions?.dispatch(event);
    if (event.type === "fault") {
      // The harness sealed itself; the next pass attaches a fresh one.
      this.#discardAttachment();
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
    this.#notifyListeners(event, {
      lane,
      ...(operationId === undefined ? {} : { operationId })
    });
  }

  #notifyListeners(event: PiEvent, context: PiEventContext): void {
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
      steer: (message, options) => this.steer(message, options),
      resolveUi: (requestId, response) =>
        this.resolveExtensionUi(requestId, response),
      commands: () => this.getCommands(),
      flags: () => this.getFlags(),
      setFlag: (name, value) => this.setFlag(name, value),
      runCommand: (name, args, options) => this.runCommand(name, args, options)
    };
  }
}
