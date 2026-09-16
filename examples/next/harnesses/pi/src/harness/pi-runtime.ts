/**
 * Pi as a `HarnessRuntime`.
 *
 * The shared `Harness` capability owns admission, the inbox, operation and
 * request rows, the durable logs and the browser link. This runtime owns the
 * agent loop: it attaches pi's `AgentHarness` to this Durable Object's SQLite
 * state once per isolate, admits inbox rows into pi with the same operation
 * ids the base minted, drives the lane to settlement, and projects pi's
 * events onto the shared vocabulary.
 *
 * One pi lane is one harness session: the lane name is the session id.
 *
 * @experimental This is a v0.3 integration with pi's pinned `dev` API.
 */
import {
  AgentHarness as createAgentHarness,
  BACKGROUND_CONTEXT,
  StorageBackedSession,
  type AgentHarness as UpstreamAgentHarness,
  type AgentHarnessOptions as UpstreamAgentHarnessOptions,
  type AgentHarnessTool as UpstreamAgentHarnessTool,
  type AgentLane as UpstreamAgentLane,
  type Context as UpstreamContext,
  type CurrentOperationInfo,
  type Entry,
  type HarnessEvent as UpstreamHarnessEvent,
  type OperationRequest as UpstreamOperationRequest,
  type OperationResultRecord,
  type Resources as UpstreamResources,
  type Skill as UpstreamSkill
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import { SqliteStorage } from "@earendil-works/pi-session-backend-sqlite-node/storage";
import {
  HarnessOperationNotFoundError,
  type HarnessCapability,
  type HarnessCompactPayload,
  type HarnessDriveContext,
  type HarnessInboxRow,
  type HarnessInput,
  type HarnessRuntimeMessagePage,
  type HarnessMessagesOptions,
  type HarnessOperationHandle,
  type HarnessPromptPayload,
  type HarnessRuntime,
  type HarnessRuntimeStartContext,
  type HarnessSettlement,
  type HarnessStopReason,
  type HarnessUsage
} from "@cloudflare/agents-next-harness";
import type { SessionMessage } from "agents/sessions";
import { DurableObjectPiDatabase, ensurePiSession } from "./do-sqlite";
import {
  projectPiEvent,
  SUBSCRIBED_EVENT_TYPES,
  toHarnessUsage
} from "./events";
import { projectMessages, toSessionMessage } from "./messages";
import { resolveModel } from "../providers/models";
import { resolveSkillSources, type ResolvedSkills } from "./skills";
import type {
  PiContext,
  PiHookRegistry,
  PiOperationRequest,
  PiOperationResult,
  PiProtocol,
  PiResources,
  PiRuntimeConfig,
  PiTool
} from "./types";

/** Inbox kinds this runtime admits into pi, in the order pi accepts them. */
const DRIVE_KINDS = [
  "prompt",
  "compact",
  "skill",
  "prompt_template",
  "navigation"
] as const;

/** Poll interval for deferred provider requests pi has no deadline for. */
const DEFERRED_POLL_MS = 30_000;
/** Delay before re-admitting a head row pi refused because the lane was busy. */
const LANE_BUSY_RETRY_MS = 250;
/**
 * How often a running pass looks for steered input. Steering has to reach pi
 * while its operation runs, and the inbox has no change notification, so the
 * pass polls beside the drive promise rather than after it.
 */
/** Newest-first byte budget `messages()` falls back to. */
const DEFAULT_MESSAGE_BYTES = 262_144;

type Attached = {
  readonly harness: UpstreamAgentHarness<object | undefined>;
};

/** The live drive context of one session, for routing pi's events. */
type Bound = {
  readonly ctx: HarnessDriveContext<PiProtocol>;
  readonly sessionLog: HarnessOperationHandle<PiProtocol>;
};

type AdmissionOutcome = "admitted" | "busy" | "settled";

/** An inbox row that carries the operation id pi will run it under. */
type AdmittableRow = HarnessInboxRow<PiProtocol> & {
  readonly operationId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function stopReasonOf(record: OperationResultRecord): HarnessStopReason {
  switch (record.status) {
    case "completed":
      return { type: "end_turn" };
    case "aborted":
      return { type: "interrupted" };
    case "declined":
      return {
        type: "declined",
        ...(record.error === undefined ? {} : { raw: record.error.code })
      };
    case "failed":
      return {
        type: "error",
        ...(record.error === undefined ? {} : { raw: record.error.code })
      };
  }
}

/** One base64 `data:` URL as a pi image, or undefined when it is not one. */
function dataUrlImage(url: string): ImageContent | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { type: "image", mimeType: match[1], data: match[2] };
}

/** A harness input as the text and images pi's prompt API takes. */
function harnessInput(input: HarnessInput): {
  readonly text: string;
  readonly images: ImageContent[] | undefined;
} {
  if (typeof input === "string") return { text: input, images: undefined };
  const parts = input.parts ?? [];
  const text =
    input.text ??
    parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  const images = parts.flatMap((part) => {
    const image =
      part.type === "file" && part.url ? dataUrlImage(part.url) : undefined;
    return image ? [image] : [];
  });
  return { text, images: images.length > 0 ? images : undefined };
}

/** Trim the oldest messages until the page fits its byte budget. */
function withinBytes(
  messages: readonly SessionMessage[],
  maxBytes: number
): SessionMessage[] {
  const page = [...messages];
  while (page.length > 1 && JSON.stringify(page).length > maxBytes) {
    page.shift();
  }
  return page;
}

/**
 * Pi's durable `AgentHarness` behind the shared runtime port.
 *
 * Pi owns the transcript, operation state, tool intents and outcomes,
 * retries and crash recovery, all in this object's SQLite database. The base
 * owns everything a client sees.
 */
export class PiRuntime<
  ToolContext extends object | undefined = object | undefined
> implements HarnessRuntime<PiProtocol> {
  readonly id = "in-do:pi";
  /**
   * `sessions`: a pi lane is a harness session. `steer`: pi folds a steered
   * message into the running turn. `compact`: pi compacts on request.
   * `usage`: pi keeps the session's token ledger.
   */
  readonly capabilities: ReadonlySet<HarnessCapability> = new Set([
    "sessions",
    "steer",
    "compact",
    "usage"
  ]);

  readonly #config: PiRuntimeConfig<ToolContext>;
  readonly #bound = new Map<string, Bound>();
  readonly #usage = new Map<string, HarnessUsage>();
  #storage: DurableObjectStorage | undefined;
  #attaching: Promise<Attached> | undefined;
  #skills: Promise<ResolvedSkills> | undefined;

  constructor(config: PiRuntimeConfig<ToolContext>) {
    this.#config = config;
  }

  onStart(context: HarnessRuntimeStartContext): void {
    this.#storage = context.storage;
  }

  /** Close pi's process-local resources without changing durable state. */
  async dispose(): Promise<void> {
    const attaching = this.#attaching;
    this.#attaching = undefined;
    if (!attaching) return;
    const attached = await attaching.catch(() => undefined);
    await attached?.harness.close(BACKGROUND_CONTEXT);
  }

  // ── Driving ──────────────────────────────────────────────────────────────

  async drive(ctx: HarnessDriveContext<PiProtocol>): Promise<void> {
    const context = BACKGROUND_CONTEXT;
    const sessionLog = await ctx.session();
    this.#bound.set(ctx.sessionId, { ctx, sessionLog });
    try {
      for (;;) {
        if (ctx.signal.aborted) return;
        const { harness } = await this.#attached();
        const lane = await harness.lane(ctx.sessionId, context);
        // Steered input folds into the running turn, so it goes first.
        if (await this.#deliverSteer(ctx, lane, context)) continue;
        const current = (await lane.inspectExecution(context)).current;
        if (current) {
          const settled = await this.#driveCurrent(
            ctx,
            harness,
            lane,
            current,
            context
          );
          if (!settled) return;
          continue;
        }
        const head = this.#head(ctx);
        if (!head) return;
        const outcome = await this.#admit(ctx, lane, head, context);
        if (outcome === "busy") {
          // Raced a lane that was idle a moment ago; look again shortly.
          ctx.wake(LANE_BUSY_RETRY_MS);
          return;
        }
      }
    } catch (error) {
      // A faulted pi harness is sealed; drop it so the next pass re-attaches.
      this.#attaching = undefined;
      throw error;
    } finally {
      this.#bound.delete(ctx.sessionId);
    }
  }

  /** The oldest inbox row pi can start as a new operation. */
  #head(ctx: HarnessDriveContext<PiProtocol>): AdmittableRow | undefined {
    return ctx.inbox
      .peek({ kinds: [...DRIVE_KINDS] })
      .find(
        (row): row is AdmittableRow => row.operationId !== null && !isSteer(row)
      );
  }

  /**
   * Hand one steered prompt to pi and settle its operation as soon as pi has
   * taken it: a steer is a message for the running turn, not a turn.
   */
  async #deliverSteer(
    ctx: HarnessDriveContext<PiProtocol>,
    lane: UpstreamAgentLane,
    context: UpstreamContext
  ): Promise<boolean> {
    const row = ctx.inbox.peek({ kinds: ["prompt"] }).find(isSteer);
    if (!row?.operationId) return false;
    const operationId = row.operationId;
    await ctx.begin(operationId, { delivery: "steer" });
    const payload = row.payload as unknown as HarnessPromptPayload;
    const { text, images } = harnessInput(payload.input);
    const queued = await lane.steer(text, images, context);
    if (!queued.ok) {
      await ctx.settle(operationId, {
        status: "failed",
        stopReason: { type: "error", raw: queued.error._tag },
        error: { code: queued.error._tag, message: queued.error.message }
      });
      return true;
    }
    await ctx.settle(operationId, {
      status: "completed",
      stopReason: { type: "end_turn" },
      raw: { kind: "steer", entryId: queued.value.entryId }
    });
    return true;
  }

  /** Admit one inbox row into pi under the operation id the base minted. */
  async #admit(
    ctx: HarnessDriveContext<PiProtocol>,
    lane: UpstreamAgentLane,
    head: AdmittableRow,
    context: UpstreamContext
  ): Promise<AdmissionOutcome> {
    const operationId = head.operationId;
    const settled = await lane.getResult(operationId, context);
    if (settled) {
      // Admitted before a crash: pi already has the outcome.
      await ctx.begin(operationId);
      await ctx.settle(operationId, this.#settlement(settled));
      return "settled";
    }
    const request = requestOf(head);
    if (!request) {
      await ctx.begin(operationId);
      await ctx.settle(operationId, {
        status: "declined",
        stopReason: { type: "declined", raw: "unsupported" },
        error: {
          code: "E_UNSUPPORTED",
          message: `Pi cannot run a ${head.kind} operation`
        }
      });
      return "settled";
    }
    const admission = await lane.accept(
      asUpstreamRequest(request, operationId),
      context
    );
    if (admission.ok) return "admitted";
    if (admission.error._tag === "LaneBusy") return "busy";
    await ctx.begin(operationId);
    await ctx.settle(operationId, {
      status: "declined",
      stopReason: { type: "declined", raw: admission.error._tag },
      error: { code: admission.error._tag, message: admission.error.message }
    });
    return "settled";
  }

  /**
   * Drive the lane's current operation. Resolves true once it settled, false
   * when pi is waiting on a retry or a deferred provider request and asked to
   * be woken later.
   */
  async #driveCurrent(
    ctx: HarnessDriveContext<PiProtocol>,
    harness: UpstreamAgentHarness<object | undefined>,
    lane: UpstreamAgentLane,
    current: CurrentOperationInfo,
    context: UpstreamContext
  ): Promise<boolean> {
    const operationId = current.id;
    await this.#begin(ctx, operationId);
    await this.#refreshProcessLocal(harness, lane, context);
    const interrupted = ctx.interrupted(operationId);
    const onAbort = () => {
      void lane.requestAbort(operationId, BACKGROUND_CONTEXT);
    };
    if (interrupted.aborted) onAbort();
    else interrupted.addEventListener("abort", onAbort, { once: true });
    try {
      const driven = await this.#untilSettled(ctx, lane, operationId, context);
      if (!driven.ok) {
        if (driven.error._tag === "OperationMismatch") {
          const settled = await lane.getResult(operationId, context);
          if (settled) {
            await ctx.settle(operationId, this.#settlement(settled));
          }
          return true;
        }
        throw driven.error;
      }
      const outcome = driven.value;
      if (outcome.kind === "settled") {
        await ctx.settle(operationId, this.#settlement(outcome.outcome));
        return true;
      }
      if (outcome.reason === "retry") {
        ctx.setRunState("retrying");
        ctx.wake(Math.max(0, outcome.notBefore - Date.now()));
        return false;
      }
      ctx.wake(outcome.deferred.pollAfterMs ?? DEFERRED_POLL_MS);
      return false;
    } finally {
      interrupted.removeEventListener("abort", onAbort);
    }
  }

  /** Pi's drive, with the inbox polled for steered input beside it. */
  async #untilSettled(
    ctx: HarnessDriveContext<PiProtocol>,
    lane: UpstreamAgentLane,
    operationId: string,
    context: UpstreamContext
  ): Promise<Awaited<ReturnType<UpstreamAgentLane["drive"]>>> {
    type Driven = Awaited<ReturnType<UpstreamAgentLane["drive"]>>;
    let outcome:
      | { readonly ok: true; readonly value: Driven }
      | { readonly ok: false; readonly error: unknown }
      | undefined;
    // The outcome is recorded before anything else observes the promise, so
    // the loop below never mistakes a settled turn for a new inbox row.
    const done = lane
      .drive({ operationId, waitForRetry: false, pollDeferred: true }, context)
      .then(
        (value) => {
          outcome = { ok: true, value };
        },
        (error: unknown) => {
          outcome = { ok: false, error };
        }
      );
    for (;;) {
      if (outcome) {
        if (outcome.ok) return outcome.value;
        throw outcome.error;
      }
      // Steered input must reach pi while its turn runs: wake on the next
      // admitted inbox row, or when the turn settles.
      const stop = new AbortController();
      await Promise.race([
        done.then(() => stop.abort()),
        ctx.inbox.wait(stop.signal)
      ]);
      if (!outcome) await this.#deliverSteer(ctx, lane, context);
    }
  }

  /**
   * Mark an operation running on the base. Undefined when the base does not
   * know it: pi started it on its own, and its frames belong to the session
   * log rather than an operation the base can settle.
   */
  async #begin(
    ctx: HarnessDriveContext<PiProtocol>,
    operationId: string
  ): Promise<HarnessOperationHandle<PiProtocol>> {
    try {
      return await ctx.begin(operationId);
    } catch (error) {
      // Pi started this one on its own (a queued follow-up, a compaction it
      // decided on): adopt it so it settles like an admitted operation.
      if (error instanceof HarnessOperationNotFoundError) {
        return ctx.adopt(operationId, { kind: "adopted" });
      }
      throw error;
    }
  }

  #settlement(record: OperationResultRecord): HarnessSettlement<PiProtocol> {
    return {
      status: record.status,
      stopReason: stopReasonOf(record),
      ...(record.error === undefined
        ? {}
        : {
            error: { code: record.error.code, message: record.error.message }
          }),
      raw: projectResult(record)
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async messages(
    sessionId: string,
    options: HarnessMessagesOptions
  ): Promise<HarnessRuntimeMessagePage> {
    const lane = await this.#lane(sessionId);
    const entries: Entry[] = await lane.findEntries(
      { order: "oldestFirst" },
      BACKGROUND_CONTEXT
    );
    const messages = projectMessages(entries).map(toSessionMessage);
    return {
      messages: withinBytes(messages, options.maxBytes ?? DEFAULT_MESSAGE_BYTES)
    };
  }

  /** Pi's own token ledger, kept current by its usage events. */
  async usage(sessionId: string): Promise<HarnessUsage | undefined> {
    const known = this.#usage.get(sessionId);
    if (known) return known;
    const lane = await this.#lane(sessionId);
    const watch = await lane.watch(BACKGROUND_CONTEXT);
    watch.unsubscribe();
    const usage = toHarnessUsage(watch.snapshot.stats.usage);
    this.#usage.set(sessionId, usage);
    return usage;
  }

  // ── Attachment ───────────────────────────────────────────────────────────

  #attached(): Promise<Attached> {
    this.#attaching ??= this.#attach().catch((error: unknown) => {
      this.#attaching = undefined;
      throw error;
    });
    return this.#attaching;
  }

  async #lane(sessionId: string): Promise<UpstreamAgentLane> {
    const { harness } = await this.#attached();
    return harness.lane(sessionId, BACKGROUND_CONTEXT);
  }

  async #attach(): Promise<Attached> {
    const storage = this.#storage;
    if (!storage) throw new Error("PiRuntime has not started");
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
              // SAFETY: the tool context is opaque to the runtime; PiContext
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
        attached.events.on(type, (event) => this.#dispatch(event));
      }
      // SAFETY: PiHookRegistry is the public structural projection of pi's
      // hook registry.
      await config.configure?.(
        attached.hooks as PiHookRegistry,
        context as PiContext
      );
      return { harness: attached };
    } catch (error) {
      if (attached) await attached.close(context).catch(() => {});
      else await session.close(context).catch(() => {});
      throw error;
    }
  }

  #resolvedSkills(): Promise<ResolvedSkills> | undefined {
    const sources = this.#config.skills;
    if (!sources || sources.length === 0) return undefined;
    // Sources are read once per isolate lifetime: pi's resources are
    // process-local anyway, so every wake sees the current skills.
    this.#skills ??= resolveSkillSources(sources).then((resolved) => {
      for (const warning of resolved.warnings) {
        console.warn(`PiRuntime skills: ${warning}`);
      }
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

  // ── Events ───────────────────────────────────────────────────────────────

  /** Route one pi event to the log of the operation it belongs to. */
  #dispatch(event: UpstreamHarnessEvent): void {
    if (event.type === "fault") {
      // The harness sealed itself; the next pass attaches a fresh one.
      this.#attaching = undefined;
    }
    if (event.type === "usage") {
      this.#usage.set(event.lane, toHarnessUsage(event.totals));
    }
    const projected = projectPiEvent(event);
    if (!projected) return;
    const lane =
      "lane" in event && typeof event.lane === "string"
        ? event.lane
        : undefined;
    const bound =
      lane === undefined ? this.#onlyBound() : this.#bound.get(lane);
    // Nothing is driving this lane: the event has no log to land in, and
    // whatever produced it is durable in pi regardless.
    if (!bound) return;
    const handle =
      (projected.operationId === undefined
        ? undefined
        : bound.ctx.operation(projected.operationId)) ?? bound.sessionLog;
    if (projected.kind === "preview") {
      handle.preview(projected.body);
      return;
    }
    handle.append(
      projected.kind === "core"
        ? projected.body
        : { type: "extension", body: projected.body }
    );
  }

  /** The one live session, when an event names no lane and only one is driving. */
  #onlyBound(): Bound | undefined {
    if (this.#bound.size !== 1) return undefined;
    return [...this.#bound.values()][0];
  }
}

/** True for a prompt row the client asked to fold into the running turn. */
function isSteer(row: HarnessInboxRow<PiProtocol>): boolean {
  return (
    row.kind === "prompt" &&
    isRecord(row.payload) &&
    row.payload.delivery === "steer"
  );
}

/** The pi operation one inbox row asks for. */
function requestOf(
  row: HarnessInboxRow<PiProtocol>
): PiOperationRequest | undefined {
  switch (row.kind) {
    case "prompt": {
      const payload = row.payload as unknown as HarnessPromptPayload;
      const { text, images } = harnessInput(payload.input);
      return {
        kind: "prompt",
        prompt: text,
        ...(images === undefined
          ? {}
          : {
              images: images.map((image) => ({
                data: image.data,
                mimeType: image.mimeType
              }))
            })
      };
    }
    case "compact": {
      const payload = row.payload as unknown as HarnessCompactPayload;
      return {
        kind: "compaction",
        ...(payload.instructions === undefined
          ? {}
          : { customInstructions: payload.instructions })
      };
    }
    case "skill": {
      const payload = row.payload as unknown as {
        readonly name: string;
        readonly additionalInstructions?: string;
      };
      return {
        kind: "skill",
        name: payload.name,
        ...(payload.additionalInstructions === undefined
          ? {}
          : { additionalInstructions: payload.additionalInstructions })
      };
    }
    case "prompt_template": {
      const payload = row.payload as unknown as {
        readonly name: string;
        readonly args?: readonly string[];
      };
      return {
        kind: "prompt_template",
        name: payload.name,
        ...(payload.args === undefined ? {} : { args: payload.args })
      };
    }
    case "navigation": {
      const payload = row.payload as unknown as {
        readonly targetId: string | null;
        readonly summarize?: boolean;
        readonly label?: string;
        readonly customInstructions?: string;
      };
      return { kind: "navigation", ...payload };
    }
    default:
      return undefined;
  }
}
