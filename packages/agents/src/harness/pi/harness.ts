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
  type HarnessInspection,
  type ModelRef,
  type SettledSubmissionRecord,
  type TaskId,
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
import { isDurableObjectMemoryLimitReset } from "../../retries";
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

/**
 * How often a wait re-reads `pi.wake()` when the factory did not pass
 * `onWake`, so nothing tells the harness when it changes.
 */
const POLL_MS = 1_000;

/**
 * The longest a wake job whose dispatch keeps failing waits before it tries
 * again. Its delay starts at the heartbeat and doubles up to this.
 */
const MAX_WAKE_BACKOFF_MS = 10 * 60_000;

/**
 * Wake dispatches that failed in a row. Stored, so the backoff holds across
 * restarts, and outside the job: a push that saved it in the job's payload
 * could overwrite a submit's due-now push.
 */
const WAKE_ERRORS_KEY = "pi-harness:wake-errors";

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
 * What the factory is handed: the things only the harness can build.
 * Everything else `Harness.open` takes (models, registry, settings, env,
 * onReport) the factory builds itself.
 */
export type PiHarnessContext = {
  /** pi's storage over this object's SQLite, its migrations already run. */
  readonly storage: SqliteStorage;
  /** Background context, for the open itself. */
  readonly context: Context;
  /**
   * Pass this to `Harness.open` as its `onWake` option. pi calls it when it
   * next needs to run, and the harness sets this object's alarm for then.
   *
   * With it, pi sets no in-memory timer for a sleeping task (a retry
   * backoff, a poll, a `sleepUntil`), so the object can hibernate until the
   * alarm. Without it the harness still works, but pi's timer keeps the
   * object in memory, and billed, while a task sleeps, and the harness logs
   * a warning when it opens pi.
   *
   * The harness reads pi's wake times against `Date.now()`, so do not pass
   * `now` to `Harness.open`.
   */
  readonly onWake: (wake: Wake) => void;
};

/**
 * Opens pi's `Harness`. The harness adopts what it returns. Pass `onWake`
 * through to `Harness.open`.
 *
 * ```ts
 * harness: async ({ storage, context, onWake }) => {
 *   const registry = createRegistry();
 *   registry.install(await skills(sources));
 *   return Harness.open(storage, { models, registry, onWake }, context);
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
  /** How often a wait re-reads `pi.wake()` without `onWake`. Default 1_000. */
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
 * sleep, the job is due when the first one wakes; pi tells the harness
 * through the `onWake` the factory passes to `Harness.open`. When pi has
 * nothing to do, the job completes. An eviction mid-run leaves the job due,
 * so its alarm restarts the object, pi reopens and resumes its own tasks,
 * and the job waits again.
 */
export class PiHarness extends LifecycleCapability {
  readonly sessions: PiSessions;
  readonly #options: PiHarnessOptions;
  /** The in-memory wait on pi's running work, inside an alarm's work. */
  #waiting: Promise<void> | undefined;
  /** Resolves the current wait's sleep early: `pi.wake()` changed. */
  #changed: (() => void) | undefined;
  /** Submissions between their wake and pi's admission. */
  #admitting = 0;
  /** Whether pi has called `onWake`, so the factory passed it. */
  #onWakeWired = false;
  #waitBudgetMs = WAIT_BUDGET_MS;
  #heartbeatMs = HEARTBEAT_MS;
  #pollMs = POLL_MS;
  #opening: Promise<Opened> | undefined;
  /** Settles once the last pi that closed on its own has closed. */
  #lastClose: Promise<unknown> = Promise.resolve();
  /** Every pi that has begun closing, on its own or by `dispose()`. */
  readonly #closing = new WeakSet<Harness>();

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
    await this.#open();
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== WAKE_FN) return;
    let outcome: LifecycleJobOutcome;
    if (context.job.id !== WAKE_JOB_ID) {
      // A per-session wake from before Pi 1.4: hand over to the one wake.
      await this.#wake();
      outcome = undefined;
    } else {
      outcome = await this.#wakeStep();
    }
    // It got through, so a failing wake's backoff starts over.
    const kv = this.lifecycle.storage.kv;
    if (kv.get(WAKE_ERRORS_KEY) !== undefined) kv.delete(WAKE_ERRORS_KEY);
    return outcome;
  }

  /**
   * A wake dispatch that failed through Lifecycle's retries, as when pi
   * cannot be opened. Lifecycle would complete the job, and pi's work would
   * never be woken again, so try again later: at the heartbeat, doubling
   * while the failures continue, up to 10 minutes.
   */
  onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): LifecycleJobOutcome | void {
    if (context.job.fn !== WAKE_FN) return;
    console.error(
      `pi wake job "${context.job.id}" failed after ${context.attempt} ` +
        "attempts; retrying with backoff",
      error
    );
    this.#wakeError(error);
    const kv = this.lifecycle.storage.kv;
    const errors = (kv.get<number>(WAKE_ERRORS_KEY) ?? 0) + 1;
    kv.put(WAKE_ERRORS_KEY, errors);
    const delay = Math.min(
      this.#heartbeatMs * 2 ** (errors - 1),
      MAX_WAKE_BACKOFF_MS
    );
    return { rescheduleAt: Date.now() + delay };
  }

  /** Close pi's in-memory resources. Durable state is untouched. */
  async dispose(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    // Closing calls #piClosing, which also ends a wait sleeping on this pi.
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

  /**
   * Run again the tasks pi's crash-loop guard parked in a session's work.
   * False when nothing was parked.
   */
  retry(options: PiSessionOptions = {}): Promise<boolean> {
    return this.session(options.session).retry();
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
    const inspection = await pi.inspect(BG);
    const parked = await this.#parked(inspection);
    return inspection.submissions
      .filter(
        (record) =>
          record.requestId !== undefined &&
          (id === undefined || record.conversationId === id)
      )
      .map((record) => ({
        operationId: record.requestId as string,
        session: String(record.conversationId),
        status:
          record.status === "queued"
            ? "queued"
            : parked.some((task) => task.sessions.has(record.conversationId))
              ? "parked"
              : "running"
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
    const accepted = await this.#admit(async () => {
      // The one admission. pi deduplicates by request id.
      const accepted =
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
      return accepted;
    });
    return { operationId, session, accepted };
  }

  /** @internal Run again the tasks pi's restart limit parked in a session. */
  async retryParked(session: PiSessionId): Promise<boolean> {
    const { pi } = await this.#open();
    const id = conversationId(session);
    const parked = (await this.#parked(await pi.inspect(BG))).filter((task) =>
      task.sessions.has(id)
    );
    if (parked.length === 0) return false;
    await this.#admit(async () => {
      for (const task of parked) await pi.retryTask(task.id, BG);
    });
    return true;
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

  /**
   * Hand pi work inside the wake. The wake is scheduled first, so if the
   * object dies after pi has the work, that job restarts it; while `hand`
   * is in flight the step will not complete. The wake steps again after, so
   * it sees the work even if it just completed.
   */
  async #admit<T>(hand: () => Promise<T>): Promise<T> {
    this.#admitting++;
    let result: T;
    try {
      await this.#wake();
      result = await hand();
    } finally {
      this.#admitting--;
    }
    await this.#wake();
    return result;
  }

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
   * pi's `onWake`, handed to the factory. pi calls it after open and
   * whenever `pi.wake()` changes. It must not block, so the job push is
   * left running.
   */
  readonly #onWake = (wake: Wake): void => {
    this.#onWakeWired = true;
    this.#changed?.();
    // A running wait re-reads pi.wake() and steps again when it ends.
    if (this.#waiting) return;
    this.#wakeFor(wake).catch((error: unknown) => this.#wakeError(error));
  };

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
      const wait = this.#waitWhileActive(pi).then(
        (ended) => {
          this.#waiting = undefined;
          // Step again now: pi may be sleeping, or have nothing left. After
          // a failed wait, as when pi's Session fails, the heartbeat that is
          // already due steps instead, so a pi that keeps failing is not
          // reopened in a loop.
          if (ended) void this.#wake();
        },
        (error: unknown) => {
          // A memory-limit reset: the alarm's breaker backs the job off.
          this.#waiting = undefined;
          throw error;
        }
      );
      this.#waiting = wait;
      // The wait runs past this dispatch, inside the alarm's work, so the
      // object stays alive for it, and a memory-limit reset it ends with
      // counts against the alarm's breaker. The heartbeat covers an
      // eviction.
      if (!this.lifecycle.trackAlarmWork(wait)) wait.catch(() => {});
      return heartbeat;
    }
    // A submit between its wake and pi's admission: check again later.
    if (this.#admitting > 0) return heartbeat;
    if (wake.at !== undefined) return { rescheduleAt: wake.at };
    // Nothing to do. A task parked by pi's restart limit is not work: it
    // waits for `retry()`.
    return undefined;
  }

  /**
   * Wait while pi has work running, up to the wait budget. With `onWake`, a
   * change ends each sleep early, and so does pi closing; without it, the
   * sleep is `pollMs`. A task sleeping beside the running work, such as a
   * retry backoff, also ends the sleep when it is due, and the wait calls
   * `pi.resume()` to run it: with `onWake`, pi arms no timer for it, and
   * the wake job's alarm is not set for it while the job waits. Whether the
   * wait ended, with pi idle or at the budget, rather than failing. Rejects
   * with a memory-limit reset.
   */
  async #waitWhileActive(pi: Harness): Promise<boolean> {
    const deadline = Date.now() + this.#waitBudgetMs;
    try {
      // Once pi begins closing, pi.wake() throws (SessionFailed after a
      // storage error), which is what ends this loop: a closed pi's wake does
      // not go inactive. Closing kicks `#changed` only so the loop reads it
      // again now rather than at the end of its sleep.
      let wake = pi.wake();
      while (wake.active) {
        const now = Date.now();
        const left = deadline - now;
        if (left <= 0) return true;
        let sleep = this.#onWakeWired ? left : Math.min(left, this.#pollMs);
        // `at` is a sleep not yet due on pi's clock, so this is positive.
        // That holds because pi keeps its default clock, `Date.now`; see
        // `PiHarnessContext`.
        if (wake.at !== undefined) sleep = Math.min(sleep, wake.at - now);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, sleep);
          this.#changed = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#changed = undefined;
        // A sleep beside the running work came due: make it runnable.
        if (wake.at !== undefined && Date.now() >= wake.at) pi.resume();
        wake = pi.wake();
      }
      return true;
    } catch (error) {
      // A pi that began closing is expected to throw; it is no longer the
      // harness's pi, and Pi reports a failure itself (`session_failed`).
      if (!this.#closing.has(pi)) this.#wakeError(error);
      // Only Lifecycle's alarm breaker can act on a memory-limit reset,
      // including one that failed pi's Session (SessionFailed's cause).
      if (isDurableObjectMemoryLimitReset(error)) throw error;
      return false;
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
   *
   * pi stays open until `dispose()`, or until it closes on its own: any
   * storage error fails pi's Session for good. Then the next call, or the
   * wake job's next step, opens pi again once the failed pi has closed, and
   * pi recovers from what it had committed. Closing waits for running task
   * code to return, so code that ignores its abort signal delays the reopen.
   * An open that fails is not kept either, so the next call tries again.
   */
  async #open(): Promise<Opened> {
    await this.lifecycle.ready();
    if (this.#opening === undefined) {
      const opening: Promise<Opened> = this.#doOpen((pi, closed) =>
        this.#piClosing(opening, pi, closed)
      ).catch((error: unknown) => {
        if (this.#opening === opening) this.#opening = undefined;
        throw error;
      });
      this.#opening = opening;
    }
    return this.#opening;
  }

  async #doOpen(
    onClose: (pi: Harness, closed: Promise<unknown>) => void
  ): Promise<Opened> {
    // A pi that closed on its own closes its storage last, after its tasks
    // have returned; let it finish before another opens over the same
    // database.
    await this.#lastClose;
    const storage = await openPiSessionStore(this.lifecycle.storage);
    const pi = await this.#options.harness({
      storage,
      context: BG,
      onWake: this.#onWake
    });
    try {
      const closed = pi.closed;
      // Called synchronously when pi begins closing, unlike `closed`, so a
      // closed pi is never handed out. It must not call pi.
      pi.subscribeClose(() => onClose(pi, closed));
      await pi.root(BG, { agent: this.agentDefaults() });
      // Continue whatever the last pi left, in this isolate or the last one:
      // pi reconciles tasks that were running to pending and schedules them
      // again.
      pi.resume();
      // pi calls onWake right after open, from a microtask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!this.#onWakeWired) {
        console.warn(
          "PiHarness: the harness factory did not pass onWake to Harness.open, " +
            "so pi's timers keep this Durable Object in memory while a task " +
            "sleeps. Pass it: harness: ({ storage, context, onWake }) => " +
            "Harness.open(storage, { ...options, onWake }, context)"
        );
      }
      // Whatever the last pi left gets a wake, including work whose wake
      // failed out. With `onWake`, pi has already said so; this covers a
      // factory without it. The job id is fixed, so this is idempotent.
      await this.#wakeFor(pi.wake());
    } catch (error) {
      // pi is open and running its tasks: close it, so the next open does
      // not start a second pi over the same database beside it.
      pi.close(BG).catch(() => {});
      throw error;
    }
    return { pi, storage };
  }

  /**
   * pi began closing: on its own, as a storage error makes it, or by
   * `dispose()`.
   */
  #piClosing(
    opening: Promise<Opened>,
    pi: Harness,
    closed: Promise<unknown>
  ): void {
    this.#closing.add(pi);
    // End a wait sleeping on this pi now: pi will not call onWake again.
    this.#changed?.();
    // `dispose()` took its pi out of `#opening` already, and an open begun
    // since must stay.
    if (this.#opening !== opening) return;
    // Drop it, so the next call opens pi again once this one has closed.
    this.#opening = undefined;
    this.#lastClose = closed;
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

  /**
   * Tasks pi's restart limit parked, each with the sessions whose work it
   * is: its own, and every session that owns that one, such as the session
   * of a tool that started a subagent.
   */
  async #parked(
    inspection: HarnessInspection
  ): Promise<{ id: TaskId; sessions: Set<ConversationId> }[]> {
    const { storage } = await this.#open();
    const parked: { id: TaskId; sessions: Set<ConversationId> }[] = [];
    for (const { record, state } of inspection.tasks) {
      if (state.kind !== "blocked" || state.reason !== "restart_limit") {
        continue;
      }
      const sessions = new Set<ConversationId>();
      let id: ConversationId | undefined = record.conversationId;
      while (id !== undefined && !sessions.has(id)) {
        sessions.add(id);
        id = (await storage.conversation(id, BG))?.owner?.conversationId;
      }
      parked.push({ id: record.id, sessions });
    }
    return parked;
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

  /**
   * Run again the tasks pi's crash-loop guard (`settings.restartLimit`)
   * parked in this session's work, including subagent sessions it owns.
   * False when nothing was parked.
   */
  retry(): Promise<boolean> {
    return this.#harness.retryParked(this.id);
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
