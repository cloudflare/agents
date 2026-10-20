import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  ROOT_CONVERSATION_ID,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type AgentChange,
  type EntryRecord,
  type Harness,
  type ModelRef,
  type SettledSubmissionRecord,
  type UserInput,
  type Wake
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../../lifecycle";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context
} from "@earendil-works/chord/context";
import { openPiSessionStore } from "./session-store";
import type {
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

/** The root session's id. */
export const ROOT_SESSION: PiSessionId = String(ROOT_CONVERSATION_ID);

/**
 * The wake timings. They suit a real deployment; only tests change them,
 * with `setWakeTimingForTests`, so a suite does not sit on the real
 * heartbeat.
 *
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

/** How often a wait on pi's running work re-reads `pi.wake()`. */
const POLL_MS = 1_000;

let setWakeTiming: (harness: PiHarness, timing: WakeTiming) => void;

/**
 * @internal Shorten a harness's wake timings, so a test suite does not sit
 * on the real heartbeat. Not exported from `agents/harness/pi`.
 */
export function setWakeTimingForTests(
  harness: PiHarness,
  timing: WakeTiming
): void {
  setWakeTiming(harness, timing);
}

const WAKE_FN = "wake";

/**
 * The one wake job. Before Pi 1.4 there was one per session, with ids
 * `pi-wake:<session>`; a left-over one hands over to this one.
 */
const WAKE_JOB_ID = "pi-wake";

/**
 * What the factory is handed: the two things only the harness can build.
 * Everything else `Harness.open` takes (models, registry, settings, env,
 * onReport) the factory builds itself.
 */
export type PiHarnessContext = {
  /** pi's storage over this object's SQLite, its migrations already run. */
  readonly storage: SqliteStorage;
  /** Background context, for the open itself. */
  readonly context: Context;
};

/**
 * Opens pi's `Harness`. The harness adopts what it returns.
 *
 * ```ts
 * harness: async ({ storage, context }) => {
 *   const registry = createRegistry();
 *   registry.install(await skills(sources));
 *   return Harness.open(storage, { models, registry }, context);
 * }
 * ```
 */
export type PiHarnessFactory = (
  context: PiHarnessContext
) => Harness | Promise<Harness>;

/**
 * A model, as pi-ai describes one: `createAI`'s `ai("@cf/…")` returns one.
 *
 * Only its `provider` and `id` are used. pi stores that reference with
 * the session and resolves it, at each request, against the `Models` the
 * factory opened pi with. So the model must be one those `Models` list,
 * and options passed to `ai(id, options)` here, such as `fallback`, are not
 * applied.
 */
export type PiModel = Pick<Model<Api>, "provider" | "id">;

/**
 * Applied to a session the first time it is created. Without a model, a
 * session's generation fails as unanswered until `session.setModel` sets one.
 */
export type PiSessionDefaults = {
  /**
   * Model for new sessions, by its `provider` and `id`; it must be on the
   * `Models` the factory opens pi with (see `PiModel`). Change one
   * session's with `session.setModel`.
   */
  readonly model?: PiModel;
  readonly thinkingLevel?: ModelThinkingLevel;
};

/** How long the wake waits on pi, and how often it checks. */
type WakeTiming = {
  /** Longest one wake waits inside an alarm. Default 600_000. */
  readonly waitBudgetMs?: number;
  /** Heartbeat while waiting. Default 30_000. */
  readonly heartbeatMs?: number;
  /** How often a wait re-reads `pi.wake()`. Default 1_000. */
  readonly pollMs?: number;
};

/** `PiHarness`'s options. Only `harness`, which opens pi, is required. */
export type PiHarnessOptions = {
  /** Opens pi's `Harness` over the storage this object prepared. */
  readonly harness: PiHarnessFactory;
  /** What a new session starts with. */
  readonly defaults?: PiSessionDefaults;
};

type Opened = {
  readonly pi: Harness;
  readonly storage: SqliteStorage;
};

/** pi-durable's stored reference to a pi-ai model. */
function modelRef(model: PiModel): ModelRef {
  return { provider: model.provider, modelId: model.id };
}

function conversationId(session: PiSessionId): ConversationId {
  const id = Number(session);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }
  return id as ConversationId;
}

/** The text of an assistant entry, for an operation's result. */
function assistantText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function signalContext(signal: AbortSignal | undefined): Context {
  return signal ? withAbortSignal(signal, BG) : BG;
}

/**
 * pi-durable hosted in a Durable Object, behind a small harness interface:
 * `harness.prompt()`, `harness.sessions`, `harness.session(id)`. How a session reaches a
 * client (sockets, SSE, RPC) is the host's glue, built on `session.events()`.
 *
 * pi owns everything about a run: the transcript, the inbox of steers and
 * follow-ups, generation and tool tasks, retries, crash recovery, and the
 * live view. It keeps all of it in its own tables in this object's SQLite
 * database (see `session-store.ts`).
 *
 * What pi cannot do on a Durable Object is wake itself: its scheduler runs
 * in memory, and an evicted object has no memory. The harness is that wake,
 * with one Lifecycle job driven by `pi.wake()`. Input goes to pi once, in
 * `submit()`, after the job is scheduled. While pi has work running, the
 * job waits on it, rescheduling itself as a heartbeat. While pi's tasks
 * sleep, the job is due when the first one wakes, in case the object is
 * evicted before pi's own timer fires. When pi has nothing to do, the job
 * completes. An eviction mid-run leaves the job due,
 * so its alarm restarts the object, pi reopens and resumes its own tasks,
 * and the job waits again.
 *
 * @beta The API may change between releases.
 */
export class PiHarness extends LifecycleCapability {
  readonly sessions: PiSessions;
  readonly #options: PiHarnessOptions;
  /** The in-memory wait on pi's running work, inside an alarm's work. */
  #waiting: Promise<void> | undefined;
  /** Submissions between their wake and pi's admission. */
  #admitting = 0;
  #waitBudgetMs = WAIT_BUDGET_MS;
  #heartbeatMs = HEARTBEAT_MS;
  #pollMs = POLL_MS;
  #opening: Promise<Opened> | undefined;

  static {
    setWakeTiming = (harness, timing) => harness.#setWakeTiming(timing);
  }

  constructor(options: PiHarnessOptions) {
    super("pi-harness");
    this.#options = options;
    this.sessions = new PiSessions(this);
  }

  #setWakeTiming(timing: WakeTiming): void {
    for (const [name, value] of Object.entries(timing)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`PiHarness timing.${name} must be a positive number`);
      }
    }
    this.#waitBudgetMs = timing.waitBudgetMs ?? this.#waitBudgetMs;
    this.#heartbeatMs = timing.heartbeatMs ?? this.#heartbeatMs;
    this.#pollMs = timing.pollMs ?? this.#pollMs;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const { pi } = await this.#open();
    // Whatever the last isolate left gets a wake, including work whose wake
    // failed out or that a subagent started without going through submit().
    await this.#wakeFor(pi.wake());
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== WAKE_FN) return;
    if (context.job.id !== WAKE_JOB_ID) {
      // A per-session wake from before Pi 1.4: hand over to the one wake.
      await this.#wake();
      return;
    }
    return this.#wakeStep();
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
    input: UserInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(input: UserInput, options: PiSubmitOptions = {}): Promise<PiReceipt> {
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

  /** The session's active transcript, as pi's entries. */
  messages(options: PiSessionOptions = {}): Promise<EntryRecord[]> {
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

  /** @internal */
  async enqueue(
    session: PiSessionId,
    input: UserInput,
    options: PiSubmitOptions
  ): Promise<PiReceipt> {
    const operationId = options.operationId ?? crypto.randomUUID();
    const { storage } = await this.#open();
    const conversation = await this.conversation(session);
    this.#admitting++;
    let accepted: boolean;
    try {
      // 1. The wake first, so a job is scheduled before pi has the work.
      //    If the object dies after pi admits the input, that job restarts
      //    it. While this admission is in flight the step will not park.
      await this.#wake();
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
          content: input,
          whenBusy: options.whenBusy ?? "followUp",
          requestId: operationId,
          ...(options.entry ? { entry: options.entry } : {})
        },
        BG
      );
    } finally {
      this.#admitting--;
    }
    // 3. Step now, so the wake sees the work even if it just parked.
    await this.#wake();
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

  /** Schedule the wake job now, or at `time`. */
  #wake(time = Date.now()): Promise<unknown> {
    // A push made while the job is dispatching supersedes that dispatch's
    // outcome, so a submit is never lost to a wake that is completing.
    return this.lifecycle.jobs.push({
      id: WAKE_JOB_ID,
      fn: WAKE_FN,
      time,
      singleflight: true,
      recoveryLoop: true
    });
  }

  /** Schedule the wake job for what `pi.wake()` says, if pi needs one. */
  async #wakeFor(wake: Wake): Promise<void> {
    if (wake.active) await this.#wake();
    else if (wake.at !== undefined) await this.#wake(wake.at);
  }

  /**
   * One run of the wake job. It never admits or replays anything: it reads
   * `pi.wake()`, which is all of pi's sessions at once. Running work is
   * waited on; a sleep reschedules the job for when it ends; no work
   * completes the job. pi does all the work in between.
   */
  async #wakeStep(): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + this.#heartbeatMs };
    if (this.#waiting) return heartbeat;
    const { pi } = await this.#open();
    // The alarm may be for a sleeping task: make due ones runnable.
    pi.resume();
    const wake = pi.wake();
    if (wake.active) {
      const wait = this.#waitWhileActive(pi).finally(() => {
        this.#waiting = undefined;
        // Step again now: pi may be sleeping, or have nothing left.
        void this.#wake();
      });
      this.#waiting = wait;
      // The wait runs past this dispatch, inside the alarm's work, so the
      // object stays alive for it. The heartbeat covers an eviction.
      this.lifecycle.trackAlarmWork(wait);
      return heartbeat;
    }
    // A submit between its wake and pi's admission: check again later.
    if (this.#admitting > 0) return heartbeat;
    // pi's own timer runs the sleeping task if the object is still in
    // memory then; the alarm restarts it if it is not.
    if (wake.at !== undefined) return { rescheduleAt: wake.at };
    // Nothing to do. A task parked by pi's restart limit is not work: it
    // waits for `pi.retryTask()`.
    return undefined;
  }

  /**
   * Wait while pi has work running, up to the wait budget, re-reading
   * `pi.wake()` every `pollMs`. It is an in-memory read.
   */
  async #waitWhileActive(pi: Harness): Promise<void> {
    const deadline = Date.now() + this.#waitBudgetMs;
    try {
      while (pi.wake().active) {
        const left = deadline - Date.now();
        if (left <= 0) return;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(left, this.#pollMs))
        );
      }
    } catch (error) {
      this.#wakeError(error);
    }
  }

  #wakeError(error: unknown): void {
    this.lifecycle.events.emit("pi:wake_error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // ── pi ───────────────────────────────────────────────────────────────────

  /**
   * pi, opened. Waits for Lifecycle startup first, so pi is only ever
   * opened inside it: startup holds the input gate (`blockConcurrencyWhile`)
   * and awaits the open in `onStart`, so an open begun before startup would
   * be awaited behind a closed gate, with its timers and I/O held back, and
   * never finish.
   */
  async #open(): Promise<Opened> {
    await this.lifecycle.ready();
    this.#opening ??= this.#doOpen().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  async #doOpen(): Promise<Opened> {
    const storage = await openPiSessionStore(this.lifecycle.storage);
    const pi = await this.#options.harness({ storage, context: BG });
    await pi.root(BG, { agent: this.agentDefaults() });
    // Continue whatever the last isolate left: pi reconciles tasks that were
    // running to pending and schedules them again.
    pi.resume();
    return { pi, storage };
  }

  /** @internal The per-conversation defaults supported by pi-durable. */
  agentDefaults(): AgentChange {
    const defaults = this.#options.defaults;
    return {
      ...(defaults?.model === undefined
        ? {}
        : { model: modelRef(defaults.model) }),
      ...(defaults?.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: defaults.thinkingLevel })
    };
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
  submit(input: UserInput, options: PiSubmitOptions = {}): Promise<PiReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  /** Submit and wait for the answer and the updated transcript. */
  async prompt(
    input: UserInput,
    options: PiSubmitOptions = {}
  ): Promise<PiPromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /** Join the running work after its current tool round. */
  steer(input: UserInput, options: Omit<PiSubmitOptions, "whenBusy"> = {}) {
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

  /**
   * Change this session's model, by its `provider` and `id`; it must be on
   * the `Models` the factory opened pi with (see `PiModel`).
   */
  async setModel(model: PiModel): Promise<void> {
    await (
      await this.#harness.conversation(this.id)
    ).configure({ model: modelRef(model) }, BG);
  }

  /** The active transcript, as pi's entries since the newest reset. */
  async messages(): Promise<EntryRecord[]> {
    const view = await (await this.#harness.conversation(this.id)).context(BG);
    return [...view.entries];
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
        agent: this.#harness.agentDefaults()
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
