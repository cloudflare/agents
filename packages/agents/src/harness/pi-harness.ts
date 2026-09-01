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
  type OpenOperation,
  type OperationRequest as UpstreamOperationRequest
} from "pi-agent-core-dev";
import type { Api, Model, Models } from "pi-ai-dev";
import { SqliteStorage } from "pi-sqlite-dev/storage";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
  type LifecycleRouteContext
} from "agents/lifecycle";
import { DurableObjectPiDatabase, ensurePiSession } from "./do-sqlite";
import { projectMessages } from "./messages";
import type {
  PiContext,
  PiHarnessConfig,
  PiHookRegistry,
  PiLane,
  PiMessage,
  PiOperationRequest,
  PiOperationResult,
  PiPromptOutcome,
  PiPromptResponse,
  PiSubmissionReceipt,
  PiSubmitOptions,
  PiTool,
  PiTranscriptOptions
} from "./types";

const DRIVE_JOB_PREFIX = "operation:";
const DRIVE_JOB_FN = "drive";
const FIRST_WAKE_DELAY_MS = 1_000;
const QUEUED_OPERATION_RETRY_MS = 250;
const DEFERRED_POLL_MS = 1_000;
const JOB_DISPATCH_BUDGET_MS = 5_000;
const JOB_BACKSTOP_MS = 30_000;

type DriveJobPayload = {
  readonly version: 1;
  readonly operationId: string;
  readonly lane: string;
  readonly request?: PiOperationRequest;
};

type AdvanceResult = {
  readonly jobOutcome: LifecycleJobOutcome;
  readonly result?: PiPromptOutcome;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDriveJobPayload(value: unknown): DriveJobPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.lane !== "string"
  ) {
    return undefined;
  }
  const request = value.request;
  if (request === undefined) {
    return {
      version: 1,
      operationId: value.operationId,
      lane: value.lane
    };
  }
  if (
    !isRecord(request) ||
    request.kind !== "prompt" ||
    typeof request.prompt !== "string" ||
    (request.operationId !== undefined &&
      request.operationId !== value.operationId)
  ) {
    return undefined;
  }
  return {
    version: 1,
    operationId: value.operationId,
    lane: value.lane,
    request: {
      kind: "prompt",
      prompt: request.prompt,
      ...(typeof request.operationId === "string"
        ? { operationId: request.operationId }
        : {})
    }
  };
}

function withOperationId(
  request: PiOperationRequest,
  operationId: string
): PiOperationRequest {
  return { ...request, operationId };
}

function driveJobId(operationId: string): string {
  return `${DRIVE_JOB_PREFIX}${operationId}`;
}

function asUpstreamContext(context: PiContext): UpstreamContext {
  // SAFETY: PiContext is the public structural projection of Chord Context.
  // It preserves the abort signal and typed value lookup used by the harness.
  return context as UpstreamContext;
}

function asUpstreamRequest(
  request: PiOperationRequest
): UpstreamOperationRequest {
  // SAFETY: v0.1 accepts only the string-prompt member of the upstream
  // OperationRequest union and preserves its optional operation ID.
  return request as UpstreamOperationRequest;
}

function asUpstreamTools<ToolContext extends object | undefined>(
  tools: readonly PiTool<ToolContext>[]
): UpstreamAgentHarnessTool<ToolContext>[] {
  // SAFETY: PiTool is the public structural projection of AgentHarnessTool.
  // Pi invokes it with the same arguments; readonly declarations restrict
  // callers and do not change the runtime values.
  return tools as UpstreamAgentHarnessTool<ToolContext>[];
}

function wait(delayMs: number, context: UpstreamContext): Promise<void> {
  return awaitWithContext(
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    context
  );
}

/**
 * Hosts pi's durable AgentHarness inside a Lifecycle Durable Object.
 *
 * The capability adapts the host's SQLite storage to a single pi Session and
 * uses Lifecycle jobs only as durable wakes. Pi remains authoritative for
 * transcript state, tool intents and outcomes, retries, and crash recovery.
 *
 * @experimental This is a v0.1 integration with pi-mono's pinned `dev` API.
 */
export class PiHarness<
  ToolContext extends object | undefined = object | undefined
> extends LifecycleCapability {
  readonly #config: PiHarnessConfig<ToolContext>;
  readonly #defaultLane: string;
  readonly #active = new Map<string, Promise<AdvanceResult>>();
  #harness: UpstreamAgentHarness<ToolContext> | undefined;

  constructor(config: PiHarnessConfig<ToolContext>) {
    super("pi-harness");
    this.#config = config;
    this.#defaultLane = config.defaultLane ?? "main";
  }

  /** Attach pi to this object's SQLite state and restore durable operations. */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const metadata = await ensurePiSession(this.lifecycle.storage);
    const database = new DurableObjectPiDatabase(this.lifecycle.storage);
    const storage = new SqliteStorage(database, { sessionId: metadata.id });
    const session = new StorageBackedSession(metadata, storage);
    const context = BACKGROUND_CONTEXT;
    const tools = await this.#resolveTools(context);

    let attached: UpstreamAgentHarness<ToolContext> | undefined;
    try {
      const options: UpstreamAgentHarnessOptions<ToolContext> = {
        session,
        // SAFETY: PiModels and PiModel are intentionally narrow public
        // projections. AgentHarness performs model lookup through this object.
        models: this.#config.models as Models,
        model: this.#config.model as Model<Api>,
        ...(this.#config.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: this.#config.thinkingLevel }),
        activeToolNames:
          this.#config.activeToolNames === undefined
            ? tools.map((tool) => tool.name)
            : [...this.#config.activeToolNames],
        tools,
        ...(this.#config.toolContext === undefined
          ? {}
          : {
              // SAFETY: PiContext is structurally compatible with the Chord
              // Context supplied by AgentHarness.
              toolContext: this.#config
                .toolContext as UpstreamAgentHarnessOptions<ToolContext>["toolContext"]
            }),
        ...(this.#config.systemPrompt === undefined
          ? {}
          : {
              // SAFETY: PiContext is structurally compatible with the Chord
              // Context supplied by AgentHarness.
              systemPrompt: this.#config
                .systemPrompt as UpstreamAgentHarnessOptions<ToolContext>["systemPrompt"]
            }),
        ...(this.#config.streamOptions === undefined
          ? {}
          : { streamOptions: this.#config.streamOptions }),
        ...(this.#config.retry === undefined
          ? {}
          : { retry: this.#config.retry }),
        ...(this.#config.compaction === undefined
          ? {}
          : { compaction: this.#config.compaction }),
        ...(this.#config.steeringMode === undefined
          ? {}
          : { steeringMode: this.#config.steeringMode }),
        ...(this.#config.followUpMode === undefined
          ? {}
          : { followUpMode: this.#config.followUpMode }),
        ...(this.#config.toolExecution === undefined
          ? {}
          : { toolExecution: this.#config.toolExecution })
      };
      const created = await createAgentHarness.create(options, context);
      attached = created.harness;
      // SAFETY: PiHookRegistry is the public structural projection of the
      // upstream hook registry. It supports the same hook names and callbacks.
      await this.#config.configure?.(attached.hooks as PiHookRegistry, context);
      this.#harness = attached;
      await this.#restoreOpenJobs(created.open);
    } catch (error) {
      if (attached) await attached.close(context).catch(() => {});
      else await session.close(context).catch(() => {});
      throw error;
    }
  }

  /** Drive one operation wake from Lifecycle's durable job queue. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== DRIVE_JOB_FN) return;
    const payload = parseDriveJobPayload(context.job.payload);
    if (!payload) {
      this.lifecycle.events.emit("operation:invalid_job", {
        jobId: context.job.id
      });
      return;
    }

    const advance = this.#advanceTracked(payload, BACKGROUND_CONTEXT);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), JOB_DISPATCH_BUDGET_MS);
    });
    try {
      const winner = await Promise.race([
        advance.then((result) => ({ kind: "advanced" as const, result })),
        budget
      ]);
      if (winner === "budget") {
        void advance.then(
          (result) => this.#applyJobOutcome(payload, result.jobOutcome),
          (error: unknown) => this.#reportDetachedError(payload, error)
        );
        return { rescheduleAt: Date.now() + JOB_BACKSTOP_MS };
      }
      return winner.result.jobOutcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Preserve an operation wake after Lifecycle exhausts dispatch retries. */
  onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): LifecycleJobOutcome | void {
    const payload = parseDriveJobPayload(context.job.payload);
    this.lifecycle.events.emit("operation:error", {
      operationId: payload?.operationId,
      message: error instanceof Error ? error.message : String(error)
    });
    return { rescheduleAt: Date.now() + JOB_BACKSTOP_MS };
  }

  /** Handle routed result and inspection calls. */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const message = context.payload;
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new TypeError("Invalid PiHarness route message");
    }
    switch (message.type) {
      case "result":
        if (
          typeof message.operationId !== "string" ||
          typeof message.lane !== "string"
        ) {
          throw new TypeError("Invalid PiHarness result route");
        }
        return this.getResult(message.operationId, {
          lane: message.lane,
          context: BACKGROUND_CONTEXT
        });
      case "inspect":
        if (typeof message.lane !== "string") {
          throw new TypeError("Invalid PiHarness inspect route");
        }
        return (
          await this.lane(message.lane, BACKGROUND_CONTEXT)
        ).inspectExecution(BACKGROUND_CONTEXT);
      default:
        throw new TypeError(`Unknown PiHarness route ${message.type}`);
    }
  }

  /** Get or create a pi lane. */
  async lane(
    name = this.#defaultLane,
    context: PiContext = BACKGROUND_CONTEXT
  ): Promise<PiLane> {
    const lane = await this.#upstreamLane(name, asUpstreamContext(context));
    // SAFETY: PiLane is the narrow public projection of AgentLane. It exposes
    // only methods with structurally compatible inputs and outputs.
    return lane as PiLane;
  }

  /**
   * Durably queue an operation and return without waiting for model or tool
   * execution. A Lifecycle job is persisted before pi accepts the operation,
   * closing the crash gap between acceptance and its recovery wake.
   */
  async submit(
    request: PiOperationRequest,
    options: PiSubmitOptions = {}
  ): Promise<PiSubmissionReceipt> {
    await this.lifecycle.ready();
    const operationId = options.operationId ?? uuidv7();
    const laneName = options.lane ?? this.#defaultLane;
    const context = asUpstreamContext(options.context ?? BACKGROUND_CONTEXT);
    const lane = await this.#upstreamLane(laneName, context);
    const existingResult = await lane.getResult(operationId, context);
    const jobId = driveJobId(operationId);
    if (existingResult || this.lifecycle.jobs.get(jobId)) {
      return { operationId, lane: laneName, accepted: false };
    }

    const payload: DriveJobPayload = {
      version: 1,
      operationId,
      lane: laneName,
      request: withOperationId(request, operationId)
    };
    await this.lifecycle.jobs.push({
      id: jobId,
      fn: DRIVE_JOB_FN,
      time: Date.now() + FIRST_WAKE_DELAY_MS,
      payload,
      singleflight: true
    });
    this.#startDetached(payload, context);
    return { operationId, lane: laneName, accepted: true };
  }

  /**
   * Prompt the default lane and return its outcome with the updated messages.
   * Lifecycle startup is automatic when the harness is installed.
   */
  async prompt(
    prompt: string,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    const outcome = await this.#promptOperation(
      { kind: "prompt", prompt },
      options
    );
    const messages = await this.getMessages(options);
    return { ...outcome, messages };
  }

  async #promptOperation(
    request: PiOperationRequest,
    options: PiSubmitOptions
  ): Promise<PiPromptOutcome> {
    const receipt = await this.submit(request, options);
    const context = asUpstreamContext(options.context ?? BACKGROUND_CONTEXT);
    const payload: DriveJobPayload = {
      version: 1,
      operationId: receipt.operationId,
      lane: receipt.lane,
      request: withOperationId(request, receipt.operationId)
    };

    for (;;) {
      const advanced = await this.#advanceTracked(payload, context);
      await this.#applyJobOutcome(payload, advanced.jobOutcome);
      if (advanced.result) return advanced.result;
      const wakeAt =
        typeof advanced.jobOutcome === "object"
          ? advanced.jobOutcome.rescheduleAt
          : Date.now() + QUEUED_OPERATION_RETRY_MS;
      await wait(Math.max(0, wakeAt - Date.now()), context);
    }
  }

  /** Read one lane's durable transcript as display-ready chat messages. */
  async getMessages(options: PiTranscriptOptions = {}): Promise<PiMessage[]> {
    const entries = await this.findEntries({
      ...options,
      order: options.order ?? "oldestFirst"
    });
    // SAFETY: findEntries() reads the Entry values returned by pi's lane. Its
    // unknown return type preserves the low-level escape hatch without leaking
    // the pinned upstream Entry type through our public declarations.
    return projectMessages(entries as Entry[]);
  }

  /** Read one lane's raw durable entries. */
  async findEntries(options: PiTranscriptOptions = {}): Promise<unknown[]> {
    const context = asUpstreamContext(options.context ?? BACKGROUND_CONTEXT);
    const lane = await this.#upstreamLane(
      options.lane ?? this.#defaultLane,
      context
    );
    return lane.findEntries({ order: options.order ?? "newestFirst" }, context);
  }

  /** Read one immutable terminal operation result. */
  async getResult(
    operationId: string,
    options: Pick<PiSubmitOptions, "lane" | "context"> = {}
  ): Promise<PiOperationResult | undefined> {
    const context = asUpstreamContext(options.context ?? BACKGROUND_CONTEXT);
    const lane = await this.#upstreamLane(
      options.lane ?? this.#defaultLane,
      context
    );
    const result = await lane.getResult(operationId, context);
    // SAFETY: PiOperationResult is the exact public projection of the
    // upstream immutable result record.
    return result as PiOperationResult | undefined;
  }

  /** Close process-local pi resources without changing durable operation state. */
  async dispose(): Promise<void> {
    const harness = this.#harness;
    this.#harness = undefined;
    if (harness) await harness.close(BACKGROUND_CONTEXT);
  }

  async #restoreOpenJobs(open: readonly OpenOperation[]): Promise<void> {
    for (const operation of open) {
      const payload: DriveJobPayload = {
        version: 1,
        operationId: operation.operationId,
        lane: operation.lane
      };
      await this.lifecycle.jobs.push({
        id: driveJobId(operation.operationId),
        fn: DRIVE_JOB_FN,
        time: Date.now(),
        payload,
        singleflight: true
      });
    }
  }

  async #resolveTools(
    context: UpstreamContext
  ): Promise<UpstreamAgentHarnessTool<ToolContext>[]> {
    const source = this.#config.tools;
    const tools =
      typeof source === "function" ? await source(context) : (source ?? []);
    return asUpstreamTools(tools);
  }

  async #refreshTools(context: UpstreamContext): Promise<void> {
    await this.#requireHarness().setTools(
      await this.#resolveTools(context),
      context
    );
  }

  #advanceTracked(
    payload: DriveJobPayload,
    context: UpstreamContext
  ): Promise<AdvanceResult> {
    const existing = this.#active.get(payload.operationId);
    if (existing) return existing;
    const started = this.#advance(payload, context).finally(() => {
      if (this.#active.get(payload.operationId) === started) {
        this.#active.delete(payload.operationId);
      }
    });
    this.#active.set(payload.operationId, started);
    return started;
  }

  async #advance(
    payload: DriveJobPayload,
    context: UpstreamContext
  ): Promise<AdvanceResult> {
    await this.lifecycle.ready();
    const lane = await this.#upstreamLane(payload.lane, context);
    const settled = await lane.getResult(payload.operationId, context);
    if (settled) {
      return {
        jobOutcome: undefined,
        result: settled as PiOperationResult
      };
    }

    let execution = await lane.inspectExecution(context);
    if (!execution.current) {
      if (!payload.request) return { jobOutcome: undefined };
      const admission = await lane.accept(
        asUpstreamRequest(payload.request),
        context
      );
      if (!admission.ok) {
        if (admission.error._tag === "LaneBusy") {
          return {
            jobOutcome: {
              rescheduleAt: Date.now() + QUEUED_OPERATION_RETRY_MS
            }
          };
        }
        throw admission.error;
      }
      execution = await lane.inspectExecution(context);
    }

    if (execution.current?.id !== payload.operationId) {
      return {
        jobOutcome: { rescheduleAt: Date.now() + QUEUED_OPERATION_RETRY_MS }
      };
    }

    // The registry is process-local and may change across deployments. Refresh
    // only after this operation owns the lane so a queued submission cannot
    // swap tools beneath the currently running operation.
    await this.#refreshTools(context);
    const driven = await lane.drive(
      {
        operationId: payload.operationId,
        waitForRetry: false,
        pollDeferred: true
      },
      context
    );
    if (!driven.ok) {
      if (driven.error._tag === "OperationMismatch") {
        return {
          jobOutcome: { rescheduleAt: Date.now() + QUEUED_OPERATION_RETRY_MS }
        };
      }
      throw driven.error;
    }
    if (driven.value.kind === "settled") {
      return {
        jobOutcome: undefined,
        result: driven.value.outcome as PiOperationResult
      };
    }
    if (driven.value.reason === "retry") {
      return {
        jobOutcome: { rescheduleAt: driven.value.notBefore }
      };
    }
    return {
      jobOutcome: { rescheduleAt: Date.now() + DEFERRED_POLL_MS },
      result: {
        operationId: payload.operationId,
        status: "suspended",
        deferred: driven.value.deferred
      }
    };
  }

  #startDetached(payload: DriveJobPayload, context: UpstreamContext): void {
    void this.#advanceTracked(payload, context).then(
      (result) => this.#applyJobOutcome(payload, result.jobOutcome),
      (error: unknown) => this.#reportDetachedError(payload, error)
    );
  }

  async #applyJobOutcome(
    payload: DriveJobPayload,
    outcome: LifecycleJobOutcome
  ): Promise<void> {
    const id = driveJobId(payload.operationId);
    if (outcome === undefined) {
      await this.lifecycle.jobs.cancel(id);
      this.lifecycle.events.emit("operation:settled", {
        operationId: payload.operationId,
        lane: payload.lane
      });
      return;
    }
    if (outcome === "yield") {
      await this.lifecycle.jobs.reschedule(id, Date.now());
      return;
    }
    await this.lifecycle.jobs.reschedule(id, outcome.rescheduleAt);
  }

  #reportDetachedError(payload: DriveJobPayload, error: unknown): void {
    this.lifecycle.events.emit("operation:error", {
      operationId: payload.operationId,
      lane: payload.lane,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  async #upstreamLane(
    name: string,
    context: UpstreamContext
  ): Promise<UpstreamAgentLane> {
    await this.lifecycle.ready();
    return this.#requireHarness().lane(name, context);
  }

  #requireHarness(): UpstreamAgentHarness<ToolContext> {
    if (!this.#harness) {
      throw new Error("PiHarness is not attached to its Durable Object");
    }
    return this.#harness;
  }
}
