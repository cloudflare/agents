import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../../lifecycle";
import { prefixTables } from "../table-prefix";
import type {
  OpenCode,
  OpenCodeEvent,
  OpenCodeInput,
  OpenCodeLogEvent,
  OpenCodeMessage,
  OpenCodeOperationResult,
  OpenCodePendingOperation,
  OpenCodePromptResponse,
  OpenCodeReceipt,
  OpenCodeSessionId,
  OpenCodeSessionInfo,
  OpenCodeSessionOptions,
  OpenCodeSubmitOptions
} from "./types";

/** The root session's id. OpenCode session ids start with `ses`. */
export const ROOT_SESSION: OpenCodeSessionId = "ses_root";

/** Every table and index OpenCode creates is stored under this prefix. */
const TABLE_PREFIX = "opencode_";

/**
 * Longest one wake waits on OpenCode. It waits inside an alarm invocation,
 * which has a 15 minute wall-time limit, so a longer run is waited on across
 * several alarms.
 */
const WAIT_BUDGET_MS = 10 * 60_000;

/**
 * The wake job's heartbeat while it waits. If the object is evicted, the job
 * is still due and its alarm restarts the object.
 */
const HEARTBEAT_MS = 30_000;

/**
 * How long OpenCode stays open after the harness last used it. An open
 * OpenCode host runs periodic background work (catalog refreshes, local
 * provider discovery, cleanups) whose timers keep the object in memory, so
 * the harness closes it once nothing is running and reopens it on the next
 * call.
 */
const IDLE_CLOSE_MS = 30_000;

/** Messages read per page when looking an operation up. */
const MESSAGE_PAGE = 50;

let setWakeTiming: (harness: OpenCodeHarness, timing: WakeTiming) => void;

/**
 * @internal Shorten a harness's wake timings, so a test suite does not sit
 * on the real heartbeat. Not exported from `agents/harness/opencode`.
 */
export function setWakeTimingForTests(
  harness: OpenCodeHarness,
  timing: WakeTiming
): void {
  setWakeTiming(harness, timing);
}

const WAKE_FN = "wake";
const CLOSE_FN = "close";
const CLOSE_JOB_ID = "opencode-close";

function wakeJobId(session: OpenCodeSessionId): string {
  return `opencode-wake:${session}`;
}

function sessionOfJob(payload: unknown): OpenCodeSessionId | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    "session" in payload &&
    typeof payload.session === "string"
    ? payload.session
    : undefined;
}

/** How long the wake waits. */
type WakeTiming = {
  /** Longest one wake waits inside an alarm. Default 600_000. */
  readonly waitBudgetMs?: number;
  /** Heartbeat while waiting. Default 30_000. */
  readonly heartbeatMs?: number;
  /** Close OpenCode after this long unused. Default 30_000. */
  readonly idleCloseMs?: number;
};

/** What the factory is handed: the one thing only the harness can build. */
export type OpenCodeHarnessContext = {
  /**
   * This object's storage, with OpenCode's tables moved under the
   * `opencode_` prefix so they cannot collide with the SDK's or the host's.
   * Pass it as `OpenCodeWorkerd.create({ storage })`.
   */
  readonly storage: DurableObjectStorage;
};

/**
 * Opens OpenCode. The harness adopts what it returns and closes it on
 * `dispose()`.
 *
 * ```ts
 * opencode: ({ storage }) =>
 *   OpenCodeWorkerd.create({ storage, plugins: [ai.plugin] })
 * ```
 */
export type OpenCodeHarnessFactory = (
  context: OpenCodeHarnessContext
) => OpenCode | Promise<OpenCode>;

/** A model, as OpenCode references one; `agents/models/opencode` makes them. */
export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
};

/**
 * Applied to a session when the harness creates it. Without a model, a
 * session uses OpenCode's default model, if its config names one.
 */
export type OpenCodeSessionDefaults = {
  /** Model for new sessions. Change one session's with `session.setModel`. */
  readonly model?: OpenCodeModel;
  /** OpenCode agent for new sessions, such as `build`. */
  readonly agent?: string;
};

/** `OpenCodeHarness`'s options. Only `opencode`, which opens it, is required. */
export type OpenCodeHarnessOptions = {
  /** Opens OpenCode over the storage this object prepared. */
  readonly opencode: OpenCodeHarnessFactory;
  /** What a new session starts with. */
  readonly defaults?: OpenCodeSessionDefaults;
};

/** Where an operation is, read from OpenCode's inbox and transcript. */
type OperationState =
  | { readonly _tag: "missing" }
  | { readonly _tag: "queued" }
  | { readonly _tag: "running" }
  | {
      readonly _tag: "settled";
      readonly outcome: "succeeded" | "failed" | "interrupted";
      readonly text: string;
      readonly error: string | undefined;
    };

type InboxItem = Awaited<
  ReturnType<OpenCode["sessions"]["inbox"]["list"]>
>[number];

const OPERATION_ID = /^[A-Za-z0-9._~-]+$/;

/** OpenCode's id for the user message an operation submits. */
function messageIdOf(operationId: string): string {
  if (!OPERATION_ID.test(operationId)) {
    throw new TypeError(
      `Invalid operation id ${JSON.stringify(operationId)}: use letters, digits, ".", "_", "~" and "-"`
    );
  }
  return `msg_${operationId}`;
}

/** The operation id of a message or inbox item, the inverse of `messageIdOf`. */
function operationIdOf(messageId: string): string {
  return messageId.startsWith("msg_") ? messageId.slice(4) : messageId;
}

/** Whether an OpenCode client error is the tagged error `tag`. */
function isTagged(error: unknown, tag: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === tag
  );
}

/** OpenCode's client errors are tagged objects; give them a message. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error ? String(error._tag) : "Error";
    const message =
      "message" in error && typeof error.message === "string"
        ? `: ${error.message}`
        : "";
    return `${tag}${message}`;
  }
  return String(error);
}

function textOf(message: OpenCodeMessage | undefined): string {
  if (message?.type !== "assistant") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function sessionIdOf(
  event: OpenCodeEvent | OpenCodeLogEvent
): string | undefined {
  if (!("data" in event)) return undefined;
  const data: unknown = event.data;
  return typeof data === "object" &&
    data !== null &&
    "sessionID" in data &&
    typeof data.sessionID === "string"
    ? data.sessionID
    : undefined;
}

/**
 * OpenCode v2 hosted in a Durable Object, behind the same harness interface
 * as `PiHarness`: `harness.prompt()`, `harness.sessions`, `harness.session(id)`.
 * How a session reaches a client (sockets, SSE, RPC) is the host's glue,
 * built on `session.events()` and `session.log()`.
 *
 * OpenCode owns everything about a run: the transcript, the inbox of steers
 * and follow-ups, model and tool steps, retries, and crash recovery. It keeps
 * all of it in its own tables in this object's SQLite database, under the
 * `opencode_` prefix.
 *
 * What OpenCode cannot do on a Durable Object is wake itself: it resumes an
 * interrupted turn when it boots, but an evicted object does not boot until
 * something calls it. The harness is that wake, with one Lifecycle job per
 * session. Input goes to OpenCode once, in `submit()`, after the session's
 * job is scheduled. The job waits while the session runs, rescheduling itself
 * as a heartbeat, and completes when the session is idle with nothing left
 * to do. An eviction mid-run leaves the job due, so its alarm restarts the
 * object, OpenCode boots and resumes the turn, and the job waits again.
 *
 * @experimental The API may change between releases.
 */
export class OpenCodeHarness extends LifecycleCapability {
  /** Every session in this object. */
  readonly sessions: OpenCodeSessions;
  readonly #options: OpenCodeHarnessOptions;
  /** In-memory waits on OpenCode, per session, each inside an alarm's work. */
  readonly #waits = new Map<OpenCodeSessionId, Promise<void>>();
  /** Submissions between their wake and OpenCode's admission, per session. */
  readonly #admitting = new Map<OpenCodeSessionId, number>();
  #waitBudgetMs = WAIT_BUDGET_MS;
  #heartbeatMs = HEARTBEAT_MS;
  #idleCloseMs = IDLE_CLOSE_MS;
  /** Harness calls and event streams using OpenCode right now. */
  #leases = 0;
  #opening: Promise<OpenCode> | undefined;

  static {
    setWakeTiming = (harness, timing) => harness.#setWakeTiming(timing);
  }

  /**
   * @param options - How to open OpenCode, and what new sessions start with.
   */
  constructor(options: OpenCodeHarnessOptions) {
    super("opencode-harness");
    this.#options = options;
    this.sessions = new OpenCodeSessions(this);
  }

  #setWakeTiming(timing: WakeTiming): void {
    for (const [name, value] of Object.entries(timing)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `OpenCodeHarness timing.${name} must be a positive number`
        );
      }
    }
    this.#waitBudgetMs = timing.waitBudgetMs ?? this.#waitBudgetMs;
    this.#heartbeatMs = timing.heartbeatMs ?? this.#heartbeatMs;
    this.#idleCloseMs = timing.idleCloseMs ?? this.#idleCloseMs;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Open OpenCode, which resumes interrupted turns, and wake running sessions. */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    const opencode = await this.#open();
    for (const session of Object.keys(await opencode.sessions.active())) {
      await this.#wake(session);
    }
    await this.#scheduleClose();
  }

  /** Run one step of a session's wake job. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn === CLOSE_FN) return this.#closeStep();
    if (context.job.fn !== WAKE_FN) return;
    const session = sessionOfJob(context.job.payload);
    if (session !== undefined) return this.#wakeStep(session);
  }

  /** Close OpenCode's in-memory resources. Durable state is untouched. */
  async dispose(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    const opencode = await opening?.catch(() => undefined);
    await opencode?.close();
  }

  // ── The harness interface ────────────────────────────────────────────────

  /**
   * A handle on one session. No I/O until you call it.
   *
   * @param id - The session; default the root session.
   */
  session(id: OpenCodeSessionId = ROOT_SESSION): OpenCodeSession {
    return new OpenCodeSession(this, id);
  }

  /** Submit a prompt and wait for its answer. */
  prompt(
    input: OpenCodeInput,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodePromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: OpenCodeInput,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodeReceipt> {
    return this.session(options.session).submit(input, options);
  }

  /** Stop one operation, or everything running in a session. */
  abort(
    options: OpenCodeSessionOptions & { readonly operationId?: string } = {}
  ): Promise<boolean> {
    return this.session(options.session).abort(options.operationId);
  }

  /** Wait for an operation to settle. Aborting `signal` stops only the wait. */
  wait(
    operationId: string,
    options: OpenCodeSessionOptions & { readonly signal?: AbortSignal } = {}
  ): Promise<OpenCodeOperationResult> {
    return this.session(options.session).wait(operationId, options.signal);
  }

  /** The session's active transcript, as OpenCode's messages. */
  messages(options: OpenCodeSessionOptions = {}): Promise<OpenCodeMessage[]> {
    return this.session(options.session).messages();
  }

  /** Submissions OpenCode has not settled yet, oldest first. */
  pending(
    options: OpenCodeSessionOptions = {}
  ): Promise<OpenCodePendingOperation[]> {
    return this.use((opencode) => this.#pending(opencode, options.session));
  }

  async #pending(
    opencode: OpenCode,
    only: OpenCodeSessionId | undefined
  ): Promise<OpenCodePendingOperation[]> {
    const sessions =
      only === undefined
        ? (await listSessions(opencode)).map((info) => info.id)
        : [only];
    const active = await opencode.sessions.active();
    const pending: OpenCodePendingOperation[] = [];
    for (const session of sessions) {
      if (
        active[session] !== undefined ||
        (await unsettled(opencode, session))
      ) {
        for (const operationId of await this.#running(opencode, session)) {
          pending.push({ operationId, session, status: "running" });
        }
      }
      for (const item of await opencode.sessions.inbox.list({
        sessionID: session
      })) {
        pending.push({
          operationId: operationIdOf(item.id),
          session,
          status: "queued"
        });
      }
    }
    return pending;
  }

  /**
   * The opened OpenCode host, for anything the interface does not cover.
   * The harness closes an idle host, so call this again each time rather
   * than keeping the result; work done through it does not keep it open.
   */
  opencode(): Promise<OpenCode> {
    return this.use(async (opencode) => opencode);
  }

  /**
   * @internal Run `call` with OpenCode open. The host is not closed while
   * any call holds it.
   */
  async use<T>(call: (opencode: OpenCode) => Promise<T>): Promise<T> {
    const release = this.lease();
    try {
      return await call(await this.#open());
    } finally {
      await release();
    }
  }

  /**
   * @internal Hold OpenCode open until the returned release is called, for
   * work that outlives one call, such as an event stream.
   */
  lease(): () => Promise<void> {
    this.#leases += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.#leases -= 1;
      if (this.#leases === 0) await this.#scheduleClose();
    };
  }

  // ── Used by OpenCodeSession and OpenCodeSessions ─────────────────────────

  /** @internal Admit an input to OpenCode once, behind the session's wake. */
  async enqueue(
    session: OpenCodeSessionId,
    input: OpenCodeInput,
    options: OpenCodeSubmitOptions
  ): Promise<OpenCodeReceipt> {
    const operationId = options.operationId ?? crypto.randomUUID();
    const messageId = messageIdOf(operationId);
    return this.use(async (opencode) => {
      const content = typeof input === "string" ? { text: input } : input;
      this.#admitting.set(session, (this.#admitting.get(session) ?? 0) + 1);
      let accepted: boolean;
      try {
        // 1. The wake first, so a job is scheduled before OpenCode has the
        //    work. If the object dies after OpenCode admits the input, that
        //    job restarts it. While this admission is in flight the step will
        //    not park.
        await this.#wake(session);
        // 2. The one admission. OpenCode deduplicates by message id.
        accepted = !(await this.#known(opencode, session, messageId));
        await this.#call(() =>
          opencode.sessions.prompt({
            ...content,
            sessionID: session,
            id: messageId,
            delivery: options.whenBusy === "steer" ? "steer" : "queue",
            resume: true
          })
        );
      } finally {
        const left = (this.#admitting.get(session) ?? 1) - 1;
        if (left === 0) this.#admitting.delete(session);
        else this.#admitting.set(session, left);
      }
      // 3. Step now, so the wake sees the work even if it just parked.
      await this.#wake(session);
      return { operationId, session, accepted };
    });
  }

  /** @internal Withdraw a queued input, or interrupt the run it joined. */
  async withdraw(
    session: OpenCodeSessionId,
    operationId: string
  ): Promise<boolean> {
    const messageId = messageIdOf(operationId);
    return this.use(async (opencode) => {
      const state = await this.#state(opencode, session, messageId);
      switch (state._tag) {
        case "queued":
          await this.#call(() =>
            opencode.sessions.inbox.cancel({
              sessionID: session,
              inboxID: messageId
            })
          );
          return true;
        case "running":
          return (
            await this.#call(() =>
              opencode.sessions.interrupt({ sessionID: session })
            )
          ).interrupted;
        case "missing":
        case "settled":
          return false;
      }
    });
  }

  /** @internal Withdraw every queued input and interrupt the running work. */
  interrupt(session: OpenCodeSessionId): Promise<void> {
    return this.use(async (opencode) => {
      for (const item of await this.#call(() =>
        opencode.sessions.inbox.list({ sessionID: session })
      )) {
        await this.#call(() =>
          opencode.sessions.inbox.cancel({
            sessionID: session,
            inboxID: item.id
          })
        );
      }
      await this.#call(() =>
        opencode.sessions.interrupt({ sessionID: session })
      );
    });
  }

  /** @internal Wait for OpenCode to settle an operation, by its id. */
  async settled(
    session: OpenCodeSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<OpenCodeOperationResult> {
    const messageId = messageIdOf(operationId);
    return this.use(async (opencode) => {
      for (;;) {
        signal?.throwIfAborted();
        const state = await this.#state(opencode, session, messageId);
        switch (state._tag) {
          case "missing":
            return {
              operationId,
              session,
              status: "unanswered",
              reason: "not_found"
            };
          case "settled":
            return state.outcome === "succeeded"
              ? { operationId, session, status: "done", text: state.text }
              : {
                  operationId,
                  session,
                  status: "unanswered",
                  reason:
                    state.outcome === "failed"
                      ? (state.error ?? "failed")
                      : "interrupted"
                };
          case "queued":
          case "running":
            await this.#call(() =>
              opencode.sessions.wait(
                { sessionID: session },
                signal ? { signal } : undefined
              )
            );
            // Idle while the operation is unsettled: the run is between an
            // eviction and its resume. Let the wake job bring it back.
            if ((await opencode.sessions.active())[session] === undefined) {
              await this.#wake(session);
              await delay(this.#heartbeatMs / 30, signal);
            }
        }
      }
    });
  }

  /** Call OpenCode, turning its tagged errors into `Error`s. */
  async #call<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`OpenCode: ${describe(error)}`, { cause: error });
    }
  }

  /** The session's info, or undefined when it does not exist. */
  async #info(opencode: OpenCode, session: OpenCodeSessionId) {
    try {
      return await opencode.sessions.get({ sessionID: session });
    } catch (error) {
      if (isTagged(error, "SessionNotFoundError")) return undefined;
      throw new Error(`OpenCode: ${describe(error)}`, { cause: error });
    }
  }

  /** @internal Create a session with the harness defaults. */
  async create(
    options: { readonly id?: OpenCodeSessionId } = {}
  ): Promise<OpenCodeSessionId> {
    return this.use((opencode) => this.#createSession(opencode, options.id));
  }

  async #createSession(
    opencode: OpenCode,
    id: OpenCodeSessionId | undefined
  ): Promise<OpenCodeSessionId> {
    const defaults = this.#options.defaults;
    const created = await this.#call(() =>
      opencode.sessions.create({
        ...(id === undefined ? {} : { id }),
        ...(defaults?.model === undefined
          ? {}
          : {
              model: {
                providerID: defaults.model.providerID,
                id: defaults.model.id
              }
            }),
        ...(defaults?.agent === undefined ? {} : { agent: defaults.agent })
      })
    );
    return created.id;
  }

  // ── The wake ─────────────────────────────────────────────────────────────

  /** Schedule the session's wake job now, or pull it forward. */
  #wake(session: OpenCodeSessionId, time = Date.now()): Promise<unknown> {
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
   * One run of a session's wake job. It never admits anything new: it waits
   * while the session runs and completes when it is idle with nothing left
   * to do. OpenCode does all the work in between.
   */
  async #wakeStep(session: OpenCodeSessionId): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + this.#heartbeatMs };
    if (this.#waits.has(session)) return heartbeat;
    const opencode = await this.#open();
    if ((await this.#info(opencode, session)) === undefined) return undefined;

    // Read in this order: OpenCode takes an input off the inbox before it
    // writes the user message, and only while the session is running. So
    // whatever moment the reads straddle, one of them sees the work.
    const inbox = await opencode.sessions.inbox.list({ sessionID: session });
    const open = await unsettled(opencode, session);
    const running = (await opencode.sessions.active())[session] !== undefined;
    if (!running) {
      const first = inbox[0];
      if (first !== undefined) {
        // Admitted but not running: the object died between OpenCode's
        // admission and the turn's start. Ring OpenCode's doorbell again.
        await this.#ring(opencode, session, first);
      } else if (open) {
        // A turn the last isolate left open. OpenCode resumes it on boot,
        // in the background; check again on the next heartbeat.
        return heartbeat;
      } else {
        // A submit between its wake and OpenCode's admission: check later.
        return this.#admitting.has(session) ? heartbeat : undefined;
      }
    }

    const wait = this.#waitForIdle(opencode, session).finally(() => {
      this.#waits.delete(session);
      // Re-check now: OpenCode may have started more work, such as a
      // follow-up.
      void this.#wake(session);
    });
    this.#waits.set(session, wait);
    // The wait runs past this dispatch, inside the alarm's work, so the
    // object stays alive for it. The heartbeat covers an eviction.
    this.lifecycle.trackAlarmWork(wait);
    return heartbeat;
  }

  async #waitForIdle(opencode: OpenCode, session: string): Promise<void> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.#waitBudgetMs);
    try {
      // Cancelling the wait never cancels OpenCode's work.
      await opencode.sessions.wait(
        { sessionID: session },
        { signal: budget.signal }
      );
    } catch (error) {
      if (!budget.signal.aborted) {
        this.lifecycle.events.emit("opencode:wake_error", {
          session,
          error: describe(error)
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Re-admit an inbox item by its id, which starts the session again. */
  async #ring(
    opencode: OpenCode,
    session: OpenCodeSessionId,
    item: InboxItem
  ): Promise<void> {
    switch (item.type) {
      case "user":
        // OpenCode matches the existing item by id and only wakes the
        // session; the text is not admitted again.
        await opencode.sessions.prompt({
          text: item.payload.text,
          sessionID: session,
          id: item.id,
          delivery: item.delivery,
          resume: true
        });
        return;
      case "synthetic":
        await opencode.sessions.synthetic({
          text: item.payload.text,
          sessionID: session,
          id: item.id,
          delivery: item.delivery,
          resume: true
        });
        return;
      case "compaction":
        await opencode.sessions.compact({
          sessionID: session,
          id: item.id,
          delivery: item.delivery
        });
        return;
      case "move":
        // A move is applied by OpenCode between turns; nothing to re-ring.
        return;
    }
  }

  // ── Closing an idle OpenCode ─────────────────────────────────────────────

  /** Schedule the idle close, unless one is already due late enough. */
  async #scheduleClose(): Promise<void> {
    const time = Date.now() + this.#idleCloseMs;
    const pending = this.lifecycle.jobs.get(CLOSE_JOB_ID);
    if (pending !== undefined && pending.time >= time - this.#idleCloseMs / 2) {
      return;
    }
    await this.lifecycle.jobs.push({
      id: CLOSE_JOB_ID,
      fn: CLOSE_FN,
      time,
      payload: {},
      singleflight: true
    });
  }

  /** Close OpenCode if nothing is using it or running in it. */
  async #closeStep(): Promise<LifecycleJobOutcome> {
    const opening = this.#opening;
    if (opening === undefined) return undefined;
    const later = { rescheduleAt: Date.now() + this.#idleCloseMs };
    const busy = () =>
      this.#leases > 0 ||
      this.#waits.size > 0 ||
      this.#admitting.size > 0 ||
      this.lifecycle.jobs.list().some((job) => job.fn === WAKE_FN);
    if (busy()) return later;
    const opencode = await opening.catch(() => undefined);
    if (opencode === undefined) return undefined;
    if (Object.keys(await opencode.sessions.active()).length > 0) return later;
    // Checked again: a call may have started while OpenCode answered.
    if (busy() || this.#opening !== opening) return later;
    this.#opening = undefined;
    await opencode.close();
    return undefined;
  }

  // ── OpenCode ─────────────────────────────────────────────────────────────

  /**
   * OpenCode, opened. Waits for Lifecycle startup first, so it is only ever
   * opened inside it: startup holds the input gate (`blockConcurrencyWhile`)
   * and awaits the open in `onStart`, so an open begun before startup would
   * be awaited behind a closed gate and never finish.
   */
  async #open(): Promise<OpenCode> {
    await this.lifecycle.ready();
    this.#opening ??= this.#doOpen().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  async #doOpen(): Promise<OpenCode> {
    const storage = prefixTables(this.lifecycle.storage, TABLE_PREFIX);
    const opencode = await this.#options.opencode({ storage });
    try {
      await opencode.sessions.get({ sessionID: ROOT_SESSION });
    } catch (error) {
      if (!isTagged(error, "SessionNotFoundError")) {
        await opencode.close();
        throw new Error(`OpenCode: ${describe(error)}`, { cause: error });
      }
      await this.#createSession(opencode, ROOT_SESSION);
    }
    return opencode;
  }

  /** Whether OpenCode has the message, as an inbox item or in the transcript. */
  async #known(
    opencode: OpenCode,
    session: OpenCodeSessionId,
    messageId: string
  ): Promise<boolean> {
    return (await this.#state(opencode, session, messageId))._tag !== "missing";
  }

  /**
   * Where an operation is. Reads the transcript newest first, back to the
   * operation's message, then finds the first idle marker after it: the end
   * of the run that answered it.
   */
  async #state(
    opencode: OpenCode,
    session: OpenCodeSessionId,
    messageId: string
  ): Promise<OperationState> {
    const inbox = await this.#call(() =>
      opencode.sessions.inbox.list({ sessionID: session })
    );
    if (inbox.some((item) => item.id === messageId)) return { _tag: "queued" };

    const after = await this.#messagesAfter(opencode, session, messageId);
    if (after === undefined) return { _tag: "missing" };
    // OpenCode drains queued follow-ups inside one run and marks only the
    // run's end with an idle message. So an operation's answer ends at the
    // next user message, or at the idle marker if none comes first.
    let last: OpenCodeMessage | undefined;
    for (const message of after) {
      if (message.type === "idle") {
        return settledState(message.outcome, last);
      }
      if (message.type === "user" && last !== undefined) {
        return settledState("succeeded", last);
      }
      if (message.type === "assistant") last = message;
    }
    return { _tag: "running" };
  }

  /**
   * The messages after `messageId`, oldest first, or undefined when the
   * transcript has no such message.
   */
  async #messagesAfter(
    opencode: OpenCode,
    session: OpenCodeSessionId,
    messageId: string
  ): Promise<OpenCodeMessage[] | undefined> {
    const newer: OpenCodeMessage[] = [];
    let cursor: string | undefined;
    for (;;) {
      // OpenCode rejects an explicit order or limit alongside a cursor.
      const page = await this.#call(() =>
        opencode.message.list(
          cursor === undefined
            ? { sessionID: session, order: "desc", limit: MESSAGE_PAGE }
            : { sessionID: session, cursor }
        )
      );
      for (const message of page.data) {
        if (message.id === messageId) return newer.reverse();
        newer.push(message);
      }
      const next = page.cursor.next;
      if (next === undefined || next === null) return undefined;
      cursor = next;
    }
  }

  /**
   * Operations the running turn is answering: the newest user messages, back
   * to the assistant message or idle marker before them. Earlier inputs of
   * the same run already have their answer.
   */
  async #running(
    opencode: OpenCode,
    session: OpenCodeSessionId
  ): Promise<string[]> {
    const running: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#call(() =>
        opencode.message.list(
          cursor === undefined
            ? { sessionID: session, order: "desc", limit: MESSAGE_PAGE }
            : { sessionID: session, cursor }
        )
      );
      for (const message of page.data) {
        if (message.type === "user") {
          running.push(operationIdOf(message.id));
        } else if (
          message.type === "idle" ||
          (message.type === "assistant" && running.length > 0)
        ) {
          return running.reverse();
        }
      }
      const next = page.cursor.next;
      if (next === undefined || next === null) return running.reverse();
      cursor = next;
    }
  }
}

/**
 * Whether the transcript ends in a turn with no idle marker after it: a run
 * in progress, or one a restart cut off that OpenCode resumes on boot.
 */
async function unsettled(
  opencode: OpenCode,
  session: OpenCodeSessionId
): Promise<boolean> {
  let cursor: string | undefined;
  for (;;) {
    const page = await opencode.message.list(
      cursor === undefined
        ? { sessionID: session, order: "desc", limit: MESSAGE_PAGE }
        : { sessionID: session, cursor }
    );
    for (const message of page.data) {
      if (message.type === "idle") return false;
      if (message.type === "user" || message.type === "synthetic") {
        return true;
      }
    }
    const next = page.cursor.next;
    if (next === undefined || next === null) return false;
    cursor = next;
  }
}

/**
 * Whether the session has work: running, input waiting in its inbox, or a
 * turn a restart cut off, which OpenCode resumes in the background on boot
 * and so is not running yet.
 */
async function sessionBusy(
  opencode: OpenCode,
  session: OpenCodeSessionId,
  active: Readonly<Record<string, unknown>>
): Promise<boolean> {
  if (active[session] !== undefined) return true;
  const inbox = await opencode.sessions.inbox.list({ sessionID: session });
  return inbox.length > 0 || (await unsettled(opencode, session));
}

/** Every session, with whether it has work. */
async function listSessions(
  opencode: OpenCode
): Promise<OpenCodeSessionInfo[]> {
  const active = await opencode.sessions.active();
  const sessions: OpenCodeSessionInfo[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await opencode.sessions.list(
      cursor === undefined ? {} : { cursor }
    );
    for (const info of page.data) {
      const parent = info.fork?.sessionID ?? info.parentID;
      sessions.push({
        id: info.id,
        ...(parent === undefined ? {} : { parent }),
        ...(info.title === undefined ? {} : { title: info.title }),
        busy: await sessionBusy(opencode, info.id, active)
      });
    }
    const next = page.cursor.next;
    if (next === undefined || next === null) return sessions;
    cursor = next;
  }
}

/** An operation's end, from the last assistant message of its run. */
function settledState(
  outcome: "succeeded" | "failed" | "interrupted",
  last: OpenCodeMessage | undefined
): OperationState {
  const error = last?.type === "assistant" ? last.error?.message : undefined;
  return {
    _tag: "settled",
    outcome:
      error !== undefined && outcome === "succeeded" ? "failed" : outcome,
    text: textOf(last),
    error
  };
}

/** Resolve after `ms`, or reject when `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

/** One OpenCode session, addressed through the harness. */
export class OpenCodeSession {
  readonly #harness: OpenCodeHarness;
  /** The session's id. */
  readonly id: OpenCodeSessionId;

  /**
   * @param harness - The harness that hosts the session.
   * @param id - The session's id.
   */
  constructor(harness: OpenCodeHarness, id: OpenCodeSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: OpenCodeInput,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodeReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  /** Submit and wait for the answer and the updated transcript. */
  async prompt(
    input: OpenCodeInput,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodePromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /** Join the running work at its next step. */
  steer(
    input: OpenCodeInput,
    options: Omit<OpenCodeSubmitOptions, "whenBusy"> = {}
  ): Promise<OpenCodeReceipt> {
    return this.submit(input, { ...options, whenBusy: "steer" });
  }

  /** Wait for an operation to settle. Aborting `signal` stops only the wait. */
  wait(
    operationId: string,
    signal?: AbortSignal
  ): Promise<OpenCodeOperationResult> {
    return this.#harness.settled(this.id, operationId, signal);
  }

  /**
   * Withdraw one queued operation (or interrupt the run it joined), or, with
   * no id, abort the session: OpenCode's queued inputs are withdrawn and the
   * running work is interrupted.
   */
  async abort(operationId?: string): Promise<boolean> {
    if (operationId !== undefined) {
      return this.#harness.withdraw(this.id, operationId);
    }
    await this.#harness.interrupt(this.id);
    return true;
  }

  /** Change this session's model; `agents/models/opencode` makes them. */
  async setModel(model: {
    readonly providerID: string;
    readonly id: string;
  }): Promise<void> {
    await this.#harness.use((opencode) =>
      opencode.sessions.switchModel({
        sessionID: this.id,
        model: { providerID: model.providerID, id: model.id }
      })
    );
  }

  /** Change this session's OpenCode agent, such as `build` or `plan`. */
  async setAgent(agent: string): Promise<void> {
    await this.#harness.use((opencode) =>
      opencode.sessions.switchAgent({ sessionID: this.id, agent })
    );
  }

  /** The active transcript: OpenCode's messages since the newest compaction. */
  async messages(): Promise<OpenCodeMessage[]> {
    return this.#harness.use((opencode) =>
      opencode.sessions.context({ sessionID: this.id })
    );
  }

  /**
   * The whole transcript, oldest first, compacted messages included.
   * OpenCode compacts a long session on its own; `messages()` is what the
   * model sees after that, this is everything the session has said.
   */
  history(): Promise<OpenCodeMessage[]> {
    return this.#harness.use(async (opencode) => {
      const messages: OpenCodeMessage[] = [];
      let cursor: string | undefined;
      for (;;) {
        // OpenCode rejects an explicit order or limit alongside a cursor.
        const page = await opencode.message.list(
          cursor === undefined
            ? { sessionID: this.id, order: "asc", limit: 100 }
            : { sessionID: this.id, cursor }
        );
        messages.push(...page.data);
        const next = page.cursor.next;
        if (next === undefined || next === null) return messages;
        cursor = next;
      }
    });
  }

  /**
   * OpenCode's events for this session as they happen, durable and live
   * (text deltas, tool input), until `signal` aborts. Read the transcript
   * with `messages()` first for a snapshot; use `log()` to resume from a
   * durable position instead.
   */
  async *events(signal?: AbortSignal): AsyncIterable<OpenCodeEvent> {
    const release = this.#harness.lease();
    try {
      const opencode = await this.#harness.opencode();
      for await (const event of opencode.events.subscribe(
        signal ? { signal } : {}
      )) {
        if (sessionIdOf(event) === this.id) yield event;
      }
    } finally {
      await release();
    }
  }

  /**
   * The session's durable events after sequence number `after` (from the
   * start by default), then, with `follow`, new ones as they are committed,
   * until `signal` aborts.
   */
  async *log(
    options: {
      readonly after?: number;
      readonly follow?: boolean;
      readonly signal?: AbortSignal;
    } = {}
  ): AsyncIterable<OpenCodeLogEvent> {
    const release = this.#harness.lease();
    try {
      const opencode = await this.#harness.opencode();
      yield* opencode.sessions.log(
        {
          sessionID: this.id,
          ...(options.after === undefined ? {} : { after: options.after }),
          ...(options.follow === undefined ? {} : { follow: options.follow })
        },
        options.signal ? { signal: options.signal } : undefined
      );
    } finally {
      await release();
    }
  }

  /**
   * Whether the session has work: running, input waiting, or a turn a
   * restart cut off that OpenCode is about to resume.
   */
  async busy(): Promise<boolean> {
    return this.#harness.use(async (opencode) =>
      sessionBusy(opencode, this.id, await opencode.sessions.active())
    );
  }
}

/** Every OpenCode session in this object. */
export class OpenCodeSessions {
  readonly #harness: OpenCodeHarness;

  /** @param harness - The harness that hosts the sessions. */
  constructor(harness: OpenCodeHarness) {
    this.#harness = harness;
  }

  /** A handle on one session. No I/O until you call it. */
  get(id: OpenCodeSessionId): OpenCodeSession {
    return this.#harness.session(id);
  }

  /** A new top-level session, configured like the root. */
  async create(): Promise<OpenCodeSession> {
    return this.#harness.session(await this.#harness.create());
  }

  /** A new session that sees `from`'s history up to now. */
  async fork(from: OpenCodeSessionId): Promise<OpenCodeSession> {
    const fork = await this.#harness.use((opencode) =>
      opencode.sessions.fork({ sessionID: from })
    );
    return this.#harness.session(fork.id);
  }

  /** Every session, including subagent sessions OpenCode spawned. */
  list(): Promise<OpenCodeSessionInfo[]> {
    return this.#harness.use(listSessions);
  }
}
