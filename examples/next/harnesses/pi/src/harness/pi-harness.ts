import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal
} from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import {
  ConversationConfig,
  createRegistry,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationRetryPolicy,
  type ModelRef,
  type Registry,
  type SettledSubmissionRecord,
  type ToolRegistration,
  type Tx,
  type UserInput
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import type { SkillSource } from "agents/skills";
import { assistantText, projectEntries } from "./messages";
import {
  openPiSessionStore,
  type PiSessionStoreOptions
} from "./session-store";
import { resolveSkillSources } from "./skills";
import type {
  PiMessage,
  PiMessageInput,
  PiOperationResult,
  PiPendingOperation,
  PiPromptResponse,
  PiReceipt,
  PiSessionId,
  PiSessionInfo,
  PiSessionOptions,
  PiSubmitOptions
} from "./types";

const BG = BACKGROUND_CONTEXT;

/** The root session's id, as the example addresses sessions. */
export const ROOT_SESSION: PiSessionId = String(ROOT_CONVERSATION_ID);

/**
 * Defaults for the three wake timings; a host overrides them with
 * `timing`, which is what the tests do to avoid the real heartbeat.
 *
 * A pi long wait further away than this is handed to the alarm, so the
 * alarm, not pi's in-memory timer, is what wakes the object.
 */
const SLEEP_THRESHOLD_MS = 60_000;

/**
 * Longest one wake waits on pi. It waits inside an alarm invocation, which
 * has a 15 minute wall-time limit, so a longer run is waited on across
 * several alarms.
 */
const WAIT_BUDGET_MS = 10 * 60_000;

/**
 * The wake job's heartbeat while it waits, and how often it re-checks work
 * it cannot wait on, such as background tasks. If the object is evicted, the
 * job is still due and its alarm restarts the object.
 */
const HEARTBEAT_MS = 30_000;

const WAKE_FN = "wake";

function wakeJobId(session: PiSessionId): string {
  return `pi-wake:${session}`;
}

function sessionOfJob(payload: unknown): PiSessionId | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    "session" in payload &&
    typeof payload.session === "string"
    ? payload.session
    : undefined;
}

/**
 * What the harness factory is handed. The store is already open and pi's
 * migrations have run, so a factory only has to decide how to call
 * `Harness.open` — or call something else that satisfies the same contract.
 */
export type PiHarnessContext = {
  /** pi's storage over this object's SQLite, tables under the store prefix. */
  readonly storage: SqliteStorage;
  /**
   * The registry this harness built from `tools`, `systemPrompt`, `skills`
   * and `configure`. A factory may register more onto it, or ignore it and
   * supply its own.
   */
  readonly registry: Registry;
  /** Background context, for the open itself. */
  readonly context: Context;
};

/**
 * Builds pi's `Harness`. Return value is adopted as-is: the caller owns
 * `models`, `env`, `onReport` and anything else `HarnessOptions` grows.
 */
export type PiHarnessFactory = (
  context: PiHarnessContext
) => Harness | Promise<Harness>;

/** Applied to a session the first time it is created. */
export type PiSessionDefaults = {
  /** Model for new sessions. Change one session's with `session.setModel`. */
  readonly model: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  /** pi's generation retries for new sessions. */
  readonly retry?: ConversationRetryPolicy;
};

/**
 * How long the wake waits and when it hands a wait to the alarm. Defaults
 * suit a real deployment; a test shortens them so a suite does not sit on
 * the real heartbeat.
 */
export type PiWakeTiming = {
  /** A pi wait further away than this goes to the alarm. Default 60_000. */
  readonly sleepThresholdMs?: number;
  /** Longest one wake waits inside an alarm. Default 600_000. */
  readonly waitBudgetMs?: number;
  /** Heartbeat while waiting, and the re-check for background work. Default 30_000. */
  readonly heartbeatMs?: number;
};

/** What every `PiHarness` takes, however pi itself is built. */
type PiHarnessCommon = {
  /** Applied to new sessions. */
  readonly defaults: PiSessionDefaults;
  /** First system prompt section. */
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolRegistration[];
  /** `agents/skills` sources, offered through `activate_skill`. */
  readonly skills?: readonly SkillSource[];
  /** Add hooks, prompt sections, tasks, or more tools to pi's registry. */
  readonly configure?: (registry: Registry) => void;
  readonly store?: PiSessionStoreOptions;
  readonly timing?: PiWakeTiming;
};

/**
 * `PiHarness`'s options, in two forms.
 *
 * The declarative form is the one to reach for: give `models` and
 * `defaults`, and the harness opens pi itself.
 *
 * ```ts
 * new PiHarness({
 *   models: createModels({ providers: [workersAI(env.AI)] }),
 *   defaults: { model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID } },
 *   tools: createTools()
 * });
 * ```
 *
 * The `harness` factory form takes over the open. Use it when a caller needs
 * a `HarnessOptions` field this type does not forward, wants to wrap the
 * `Harness`, or builds its own registry. `models`, `env` and `onReport` move
 * to the factory, because it is the thing calling `Harness.open`.
 *
 * ```ts
 * new PiHarness({
 *   defaults: { model },
 *   harness: ({ storage, registry, context }) =>
 *     Harness.open(storage, { models, registry, hooks }, context)
 * });
 * ```
 *
 * The two are exclusive: `models` and `harness` cannot both be given, so
 * there is never a question of which one built pi.
 */
export type PiHarnessOptions = PiHarnessCommon &
  (
    | {
        readonly models: Models;
        /** Execution environment for pi's `read`/`bash`/`edit`/`write` tools. */
        readonly env?: ExecutionEnv;
        /** Extension failures pi reports without failing the operation. */
        readonly onReport?: (error: unknown) => void;
        readonly harness?: never;
      }
    | {
        readonly harness: PiHarnessFactory;
        readonly models?: never;
        readonly env?: never;
        readonly onReport?: never;
      }
  );

type Opened = {
  readonly pi: Harness;
  readonly storage: SqliteStorage;
};

function conversationId(session: PiSessionId): ConversationId {
  const id = Number(session);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }
  return id as ConversationId;
}

function userInput(input: PiMessageInput): UserInput {
  if (typeof input === "string") return input;
  if (!input.images?.length) return input.text;
  return [
    { type: "text", text: input.text },
    ...input.images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType
    }))
  ];
}

function signalContext(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, BG) : BG;
}

/**
 * pi-durable hosted in a Durable Object, behind the harness interface the
 * other `examples/next/harnesses` share: `harness.prompt()`,
 * `harness.sessions`, `harness.session(id)`. How a session reaches a
 * client (sockets, SSE, RPC) is the host's glue, built on `session.events()`.
 *
 * pi owns everything about a run: the transcript, the inbox of steers and
 * follow-ups, generation and tool tasks, retries, crash recovery, and the
 * live view. It keeps all of it in its own tables in this object's SQLite
 * database (see `session-store.ts`).
 *
 * What pi cannot do on a Durable Object is wake itself: its scheduler runs
 * in memory, and an evicted object has no memory. The harness is that wake,
 * with one Lifecycle job per session. Input goes to pi once, in `submit()`,
 * after the session's job is scheduled. The job waits while pi has live
 * tasks in the session, rescheduling itself as a heartbeat, and completes
 * when there are none. An eviction mid-run leaves the job due, so its alarm
 * restarts the object, pi reopens and resumes its own tasks, and the job
 * waits again.
 *
 * @experimental Example-local. Nothing here is exported from `agents`.
 */
export class PiHarness extends LifecycleCapability {
  /** pi's registry. Registrations may change while the harness runs. */
  readonly registry: Registry;
  readonly sessions: PiSessions;
  readonly #options: PiHarnessOptions;
  /** In-memory waits on pi, per session, each inside an alarm's work. */
  readonly #waits = new Map<PiSessionId, Promise<void>>();
  /** Submissions between their wake and pi's admission, per session. */
  readonly #admitting = new Map<PiSessionId, number>();
  readonly #sleepThresholdMs: number;
  readonly #waitBudgetMs: number;
  readonly #heartbeatMs: number;
  #opening: Promise<Opened> | undefined;

  constructor(options: PiHarnessOptions) {
    super("pi-harness");
    this.#options = options;
    this.#sleepThresholdMs =
      options.timing?.sleepThresholdMs ?? SLEEP_THRESHOLD_MS;
    this.#waitBudgetMs = options.timing?.waitBudgetMs ?? WAIT_BUDGET_MS;
    this.#heartbeatMs = options.timing?.heartbeatMs ?? HEARTBEAT_MS;
    for (const [name, value] of [
      ["sleepThresholdMs", this.#sleepThresholdMs],
      ["waitBudgetMs", this.#waitBudgetMs],
      ["heartbeatMs", this.#heartbeatMs]
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`PiHarness timing.${name} must be a positive number`);
      }
    }
    this.registry = createRegistry();
    this.registry.batch(() => {
      if (options.systemPrompt !== undefined) {
        const prompt = options.systemPrompt;
        this.registry.systemPrompt.section("preamble", () => prompt, {
          tag: false
        });
      }
      for (const tool of options.tools ?? []) this.registry.tools.add(tool);
      options.configure?.(this.registry);
    });
    this.sessions = new PiSessions(this);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const { pi } = await this.#open();
    // Every session with live work gets a wake, including ones whose wake
    // failed out or that a subagent created without going through submit().
    const inspection = await pi.inspect(BG);
    const sessions = new Set(
      inspection.tasks.map((task) => String(task.record.conversationId))
    );
    for (const session of sessions) await this.#wake(session);
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== WAKE_FN) return;
    const session = sessionOfJob(context.job.payload);
    if (session !== undefined) return this.#wakeStep(session);
  }

  /** Close pi's in-memory resources. Durable state is untouched. */
  async dispose(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    await opened?.pi.close(BG);
  }

  // ── The harness interface ────────────────────────────────────────────────

  /** A handle on one session. No I/O until you call it. */
  session(id: PiSessionId = ROOT_SESSION): PiSession {
    return new PiSession(this, id);
  }

  /** Submit a prompt and wait for its answer. */
  prompt(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiReceipt> {
    return this.session(options.session).submit(input, options);
  }

  /** Stop one operation, or everything running in a session. */
  abort(
    options: PiSessionOptions & { readonly operationId?: string } = {}
  ): Promise<boolean> {
    return this.session(options.session).abort(options.operationId);
  }

  wait(
    operationId: string,
    options: PiSessionOptions & { readonly signal?: AbortSignal } = {}
  ): Promise<PiOperationResult> {
    return this.session(options.session).wait(operationId, options.signal);
  }

  messages(options: PiSessionOptions = {}): Promise<PiMessage[]> {
    return this.session(options.session).messages();
  }

  /** Submissions pi has not settled yet, oldest first. */
  async pending(options: PiSessionOptions = {}): Promise<PiPendingOperation[]> {
    const { pi } = await this.#open();
    const id =
      options.session === undefined
        ? undefined
        : conversationId(options.session);
    return (await pi.inspect(BG)).submissions
      .filter(
        (record) =>
          record.requestId !== undefined &&
          (id === undefined || record.conversationId === id)
      )
      .map((record) => ({
        operationId: record.requestId as string,
        session: String(record.conversationId),
        status: record.status === "queued" ? "queued" : "running"
      }));
  }

  /** The opened pi Harness, for anything the interface does not cover. */
  async pi(): Promise<Harness> {
    return (await this.#open()).pi;
  }

  // ── Used by PiSession and PiSessions ─────────────────────────────────────

  /** @internal */
  async conversation(session: PiSessionId): Promise<Conversation> {
    const { pi } = await this.#open();
    const conversation = await pi.conversation(conversationId(session), BG);
    if (!conversation) throw new Error(`Unknown pi session ${session}`);
    return conversation;
  }

  /** @internal */
  async storage(): Promise<SqliteStorage> {
    return (await this.#open()).storage;
  }

  /** @internal Configure a new session like the root. */
  initSession(tx: Tx, id: ConversationId): Promise<void> {
    return this.#init(tx, id);
  }

  /** @internal */
  async enqueue(
    session: PiSessionId,
    input: PiMessageInput,
    options: PiSubmitOptions
  ): Promise<PiReceipt> {
    const operationId = options.operationId ?? crypto.randomUUID();
    const { storage } = await this.#open();
    const conversation = await this.conversation(session);
    this.#admitting.set(session, (this.#admitting.get(session) ?? 0) + 1);
    let accepted: boolean;
    try {
      // 1. The wake first, so a job is scheduled before pi has the work.
      //    If the object dies after pi admits the input, that job restarts
      //    it. While this admission is in flight the step will not park.
      await this.#wake(session);
      // 2. The one admission. pi deduplicates by request id.
      accepted =
        (await storage.submissionByRequest(
          conversation.id,
          operationId,
          BG
        )) === undefined;
      await conversation.submit(
        {
          type: "input",
          content: userInput(input),
          whenBusy: options.whenBusy ?? "followUp",
          requestId: operationId
        },
        BG
      );
    } finally {
      const left = (this.#admitting.get(session) ?? 1) - 1;
      if (left === 0) this.#admitting.delete(session);
      else this.#admitting.set(session, left);
    }
    // 3. Step now, so the wake sees the work even if it just parked.
    await this.#wake(session);
    return { operationId, session, accepted };
  }

  /** @internal Withdraw a queued input, or abort the run it joined. */
  async withdraw(session: PiSessionId, operationId: string): Promise<boolean> {
    const { pi, storage } = await this.#open();
    const id = conversationId(session);
    const record = await storage.submissionByRequest(id, operationId, BG);
    if (!record || record.status === "done" || record.status === "unanswered") {
      return false;
    }
    const withdrawn = await pi.abortSubmission(record.id, BG, id);
    if (withdrawn === "already_placed") {
      await (await pi.conversation(id, BG))?.abort(BG);
    }
    return withdrawn !== "settled" && withdrawn !== "not_found";
  }

  /** @internal Wait for pi to settle an operation, by its request id. */
  async settled(
    session: PiSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<PiOperationResult> {
    const conversation = await this.conversation(session);
    const context = signalContext(signal);
    const submission = await this.#findSubmission(
      conversation.id,
      operationId,
      context
    );
    if (!submission) {
      return {
        operationId,
        session,
        status: "unanswered",
        reason: "not_found"
      };
    }
    return this.#result(
      session,
      operationId,
      await submission.wait(context),
      context
    );
  }

  // ── The wake ─────────────────────────────────────────────────────────────

  /** Schedule the session's wake job now, or pull it forward. */
  #wake(session: PiSessionId, time = Date.now()): Promise<unknown> {
    // A push made while the job is dispatching supersedes that dispatch's
    // outcome, so a submit is never lost to a wake that is completing.
    return this.lifecycle.jobs.push({
      id: wakeJobId(session),
      fn: WAKE_FN,
      time,
      payload: { session },
      singleflight: true,
      recoveryLoop: true
    });
  }

  /**
   * One run of a session's wake job. It never admits or replays anything:
   * it waits while pi has live tasks in the session and completes when it
   * has none. pi does all the work in between.
   */
  async #wakeStep(session: PiSessionId): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + this.#heartbeatMs };
    if (this.#waits.has(session)) return heartbeat;
    const { pi } = await this.#open();
    const conversation = await pi.conversation(conversationId(session), BG);
    if (!conversation) return undefined;

    const tasks = (await pi.inspect(BG)).tasks.filter(
      (task) => task.record.conversationId === conversation.id
    );
    if (tasks.length === 0) {
      // A submit between its wake and pi's admission: check again later.
      return this.#admitting.has(session) ? heartbeat : undefined;
    }
    const wakeAt = await this.#longWait(pi, conversation.id, BG);
    if (wakeAt !== undefined) return { rescheduleAt: wakeAt };
    // Background tasks are outside the conversation's idle wait.
    if (tasks.every((task) => task.record.background)) return heartbeat;

    const wait = this.#waitForIdle(conversation).finally(() => {
      this.#waits.delete(session);
      // Re-check now: pi may have started more work, such as a follow-up.
      void this.#wake(session);
    });
    this.#waits.set(session, wait);
    // The wait runs past this dispatch, inside the alarm's work, so the
    // object stays alive for it. The heartbeat covers an eviction.
    this.lifecycle.trackAlarmWork(wait);
    return heartbeat;
  }

  async #waitForIdle(conversation: Conversation): Promise<void> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.#waitBudgetMs);
    try {
      // Cancelling the wait never cancels pi's work.
      await conversation.waitForIdle(withAbortSignal(budget.signal, BG));
    } catch (error) {
      if (!budget.signal.aborted) {
        this.lifecycle.events.emit("pi:wake_error", {
          session: String(conversation.id),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── pi ───────────────────────────────────────────────────────────────────

  #open(): Promise<Opened> {
    this.#opening ??= this.#doOpen().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  async #doOpen(): Promise<Opened> {
    const skills = this.#options.skills;
    if (skills?.length) {
      const resolved = await resolveSkillSources(skills);
      for (const warning of resolved.warnings) {
        console.warn(`PiHarness skills: ${warning}`);
      }
      const catalog = resolved.catalog;
      this.registry.batch(() => {
        for (const tool of resolved.tools) this.registry.tools.add(tool);
        if (catalog)
          this.registry.systemPrompt.section("skills", () => catalog);
      });
    }
    const storage = await openPiSessionStore(
      this.lifecycle.storage,
      this.#options.store
    );
    // The factory owns the open when given; otherwise the declarative fields
    // are forwarded to pi. The registry is already built either way, so a
    // factory that ignores it is choosing to.
    const pi =
      this.#options.harness === undefined
        ? await Harness.open(
            storage,
            {
              models: this.#options.models,
              registry: this.registry,
              ...(this.#options.env ? { env: this.#options.env } : {}),
              onReport:
                this.#options.onReport ??
                ((error) => console.warn("pi report", error))
            },
            BG
          )
        : await this.#options.harness({
            storage,
            registry: this.registry,
            context: BG
          });
    await pi.root(BG, { init: (tx, id) => this.#init(tx, id) });
    // Continue whatever the last isolate left: pi reconciles tasks that were
    // running to pending and schedules them again.
    pi.resume();
    return { pi, storage };
  }

  async #init(tx: Tx, id: ConversationId): Promise<void> {
    const config = await tx.doc(ConversationConfig, id);
    const defaults = this.#options.defaults;
    config.model = { ...defaults.model };
    config.thinkingLevel = defaults.thinkingLevel ?? "off";
    if (defaults.retry) config.retry = { ...defaults.retry };
  }

  async #findSubmission(
    id: ConversationId,
    operationId: string,
    context: Context
  ) {
    const { pi, storage } = await this.#open();
    // Read from pi's storage: the Harness only reacquires submissions by id.
    const record = await storage.submissionByRequest(id, operationId, context);
    return record ? pi.submission(record.id, context) : undefined;
  }

  /** When pi's current wait is far enough away to hand to the alarm. */
  async #longWait(
    pi: Harness,
    id: ConversationId,
    context: Context
  ): Promise<number | undefined> {
    const live = await pi.snapshot(LiveDoc, id, context);
    const at =
      live?.generation?.deferred?.pollAt ?? live?.generation?.retry?.at;
    return at !== undefined && at - Date.now() > this.#sleepThresholdMs
      ? at
      : undefined;
  }

  async #result(
    session: PiSessionId,
    operationId: string,
    settled: SettledSubmissionRecord,
    context: Context
  ): Promise<PiOperationResult> {
    if (settled.status === "unanswered") {
      return {
        operationId,
        session,
        status: "unanswered",
        reason: settled.reason
      };
    }
    if (settled.type !== "input")
      return { operationId, session, status: "done" };
    const conversation = await this.conversation(session);
    const page = await conversation.entries(
      { minEntryId: settled.answer, maxEntryId: settled.answer },
      1,
      undefined,
      context
    );
    return {
      operationId,
      session,
      status: "done",
      text: assistantText(page.items[0])
    };
  }
}

/** One pi conversation, addressed through the harness. */
export class PiSession {
  readonly #harness: PiHarness;
  readonly id: PiSessionId;

  constructor(harness: PiHarness, id: PiSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  /** Submit and wait for the answer and the updated transcript. */
  async prompt(
    input: PiMessageInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /** Join the running work after its current tool round. */
  steer(
    input: PiMessageInput,
    options: Omit<PiSubmitOptions, "whenBusy"> = {}
  ) {
    return this.submit(input, { ...options, whenBusy: "steer" });
  }

  /** Wait for an operation to settle. Aborting `signal` stops only the wait. */
  wait(operationId: string, signal?: AbortSignal): Promise<PiOperationResult> {
    return this.#harness.settled(this.id, operationId, signal);
  }

  /**
   * Withdraw one queued operation (or abort the run it joined), or, with no
   * id, abort the session: pi withdraws queued inputs and aborts the
   * running work.
   */
  async abort(operationId?: string): Promise<boolean> {
    if (operationId !== undefined) {
      return this.#harness.withdraw(this.id, operationId);
    }
    const conversation = await this.#harness.conversation(this.id);
    await conversation.abort(BG);
    return true;
  }

  /** Start a new context, optionally from a handoff note. */
  async reset(handoff?: string): Promise<void> {
    await (await this.#harness.conversation(this.id)).reset(handoff, BG);
  }

  async setModel(model: ModelRef): Promise<void> {
    await (await this.#harness.conversation(this.id)).setModel(model, BG);
  }

  /** The active transcript: entries since the newest reset. */
  async messages(): Promise<PiMessage[]> {
    const view = await (await this.#harness.conversation(this.id)).context(BG);
    return projectEntries(view.entries);
  }

  /** pi's agent events for this session: a snapshot, then one batch per commit. */
  async events(context: Context = BG): Promise<AgentEventStream> {
    const pi = await this.#harness.pi();
    return watchEvents(pi, conversationId(this.id), context);
  }

  async busy(): Promise<boolean> {
    const pi = await this.#harness.pi();
    const live = await pi.snapshot(LiveDoc, conversationId(this.id), BG);
    return live?.run !== undefined;
  }
}

/** Every pi conversation in this object. */
export class PiSessions {
  readonly #harness: PiHarness;

  constructor(harness: PiHarness) {
    this.#harness = harness;
  }

  get(id: PiSessionId): PiSession {
    return this.#harness.session(id);
  }

  /** A new top-level session, configured like the root. */
  async create(): Promise<PiSession> {
    const pi = await this.#harness.pi();
    const conversation = await pi.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: (tx, id) => this.#harness.initSession(tx, id)
      },
      BG
    );
    return this.#harness.session(String(conversation.id));
  }

  /** A new session that sees `from`'s history up to its newest entry. */
  async fork(from: PiSessionId): Promise<PiSession> {
    const conversation = await this.#harness.conversation(from);
    const newest = await conversation.entries({}, 1, undefined, BG);
    const at = newest.items[0];
    if (!at) throw new Error(`Session ${from} has no entries to fork from`);
    const fork = await conversation.fork(
      at.id,
      { ownership: { kind: "ownerless" } },
      BG
    );
    return this.#harness.session(String(fork.id));
  }

  /**
   * Every conversation, including ones subagent tools own. Read from pi's
   * storage directly: the Harness has no conversation listing.
   */
  async list(): Promise<PiSessionInfo[]> {
    const storage = await this.#harness.storage();
    const pi = await this.#harness.pi();
    const sessions: PiSessionInfo[] = [];
    let cursor: Parameters<SqliteStorage["scanConversations"]>[2];
    for (;;) {
      const page = await storage.scanConversations({}, 100, cursor, BG);
      for (const record of page.items) {
        const live = await pi.snapshot(LiveDoc, record.id, BG);
        sessions.push({
          id: String(record.id),
          ...(record.parent
            ? { parent: String(record.parent.conversationId) }
            : {}),
          busy: live?.run !== undefined
        });
      }
      if (page.next === undefined) return sessions;
      cursor = page.next;
    }
  }
}
