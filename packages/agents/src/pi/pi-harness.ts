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
  type Resources as UpstreamResources
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { SqliteStorage } from "@earendil-works/pi-session-backend-sqlite-node";
import { HarnessDriver } from "../driver";
import { LifecycleCapability, type CapabilityStartContext } from "../lifecycle";
import type { Streams } from "../streams";
import type { WebSocketsOptions } from "../websockets";
import { DurableObjectPiDatabase, ensurePiSession } from "./storage";
import {
  OperationStreamWriter,
  projectHarnessEvent,
  SUBSCRIBED_EVENT_TYPES
} from "./events";
import {
  asUpstreamContext,
  asUpstreamResources,
  asUpstreamTools,
  messageInput,
  operationStatus,
  projectResult
} from "./adapters";
import { SettlementWaiters } from "./settlement";
import { projectMessages, projectQueue } from "./messages";
import { resolveModel } from "./models";
import { resolveSkillSources, type ResolvedSkills } from "./skills";
import { PiTransport, type PiTransportHost } from "./transport";
import { PiRuntimeAdapter } from "./runtime-adapter";
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

const RESULT_POLL_MS = 500;

type Attached = {
  readonly harness: UpstreamAgentHarness<object | undefined>;
  readonly open: readonly OpenOperation[];
};

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

export class PiHarness<
  ToolContext extends object | undefined = object | undefined
> extends LifecycleCapability {
  readonly #config: PiHarnessConfig<ToolContext>;
  readonly #streams: Streams;
  readonly #defaultLane: string;
  readonly driver: HarnessDriver<PiOperationRequest, PiOperationResult>;
  #attaching: Promise<Attached> | undefined;
  #skills: Promise<ResolvedSkills> | undefined;
  #transport: PiTransport | undefined;
  readonly #listeners = new Set<PiEventListener>();
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #laneWriters = new Map<string, OperationStreamWriter>();
  readonly #settlement = new SettlementWaiters(RESULT_POLL_MS);
  readonly #rejections = new Map<string, PiOperationRejectedError>();

  constructor(config: PiHarnessConfig<ToolContext>) {
    super("pi-harness");
    this.#config = config;
    this.#streams = config.streams;
    this.#defaultLane = config.defaultLane ?? "main";
    this.driver = new HarnessDriver({
      id: "pi",
      runtime: new PiRuntimeAdapter({
        lane: (name, context) => this.#upstreamLane(name, context),
        beforeDrive: (lane, operationId) =>
          this.#prepareDrive(lane, operationId)
      }),
      settle: (submission, result) =>
        this.#settleResult(submission.scope, result)
    });
  }

  get defaultLane(): string {
    return this.#defaultLane;
  }

  get streams(): Streams {
    return this.#streams;
  }

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    await this.#attached();
  }

  async dispose(): Promise<void> {
    const attaching = this.#attaching;
    this.#attaching = undefined;
    for (const writer of this.#writers.values()) writer.flush();
    if (attaching) {
      const attached = await attaching.catch(() => undefined);
      await attached?.harness.close(BACKGROUND_CONTEXT);
    }
  }

  async submit(
    request: PiOperationRequest,
    options: PiSubmitOptions = {}
  ): Promise<PiSubmissionReceipt> {
    await this.lifecycle.ready();
    const lane = options.lane ?? this.#defaultLane;
    const operationId = options.operationId ?? request.operationId ?? uuidv7();
    const context = asUpstreamContext(options.context);
    const upstream = await this.#upstreamLane(lane, context);
    if (
      (await upstream.getResult(operationId, context)) !== undefined ||
      (await upstream.inspectExecution(context)).current?.id === operationId
    ) {
      return { operationId, lane, accepted: false };
    }
    const receipt = await this.driver.submit(lane, request, {
      operationId,
      streamId: this.streamId(operationId, lane)
    });
    return {
      operationId: receipt.operationId,
      lane: receipt.scope,
      accepted: receipt.accepted
    };
  }

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
    const cancelled = await this.driver.cancel(operationId);
    if (!cancelled) return null;
    this.#reject(
      lane,
      operationId,
      current?.kind ?? "run",
      new PiOperationRejectedError(operationId, "aborted", "Operation aborted")
    );
    return { operationId, newlyRequested: true };
  }

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
    await this.driver.wake(options.lane ?? this.#defaultLane);
    return { entryId: queued.value.entryId };
  }

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

  async pending(options: PiLaneOptions = {}): Promise<PiPendingSubmission[]> {
    await this.lifecycle.ready();
    const rows = await this.driver.pending(options.lane ?? this.#defaultLane);
    return rows.map((row) => ({
      operationId: row.operationId,
      lane: row.scope,
      request: row.input,
      submittedAt: row.submittedAt
    }));
  }

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

  streamId(operationId: string, lane = this.#defaultLane): string {
    return `pi:${lane}:${operationId}`;
  }

  on(listener: PiEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  webSockets(): WebSocketsOptions {
    this.#transport ??= new PiTransport(
      this.#transportHost(),
      () => this.lifecycle.sockets
    );
    return this.#transport.webSocketOptions();
  }

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
    const model = resolveModel(config.models as never, config.model);

    let attached: UpstreamAgentHarness<object | undefined> | undefined;
    try {
      const options: UpstreamAgentHarnessOptions<object | undefined> = {
        session,
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

  #resolvedSkills(): Promise<ResolvedSkills> | undefined {
    const sources = this.#config.skills;
    if (!sources || sources.length === 0) return undefined;
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
    const active = await lane.getActiveTools(context);
    if (
      active.length !== names.length ||
      names.some((name) => !active.includes(name))
    ) {
      await lane.setActiveTools(names, context);
    }
  }

  async #prepareDrive(lane: string, operationId: string): Promise<void> {
    const context = BACKGROUND_CONTEXT;
    const { harness } = await this.#attached();
    const upstream = await harness.lane(lane, context);
    await this.#refreshProcessLocal(harness, upstream, context);
    const current = (await upstream.inspectExecution(context)).current;
    if (current?.id !== operationId) return;
    await this.#writerFor(lane, operationId, current.kind, current.startedAt);
  }

  async #settleResult(lane: string, result: PiOperationResult): Promise<void> {
    const writer = await this.#writerFor(
      lane,
      result.operationId,
      result.kind,
      result.startedAt
    );
    this.#emitLaneEvent(
      lane,
      { type: "operation_end", ...result },
      result.operationId,
      writer
    );
    writer.close();
    this.#writers.delete(result.operationId);
    if (this.#laneWriters.get(lane) === writer) this.#laneWriters.delete(lane);
    this.lifecycle.events.emit("operation:settled", {
      lane,
      operationId: result.operationId,
      status: result.status
    });
    this.#settlement.notify(result.operationId);
  }

  #reject(
    lane: string,
    operationId: string,
    kind: PiOperationKind,
    error: PiOperationRejectedError
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
      startedAt: now,
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
