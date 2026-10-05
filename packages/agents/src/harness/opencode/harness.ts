import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "../../lifecycle";
import type { Streams } from "../../streams";
import { OperationStreamWriter, projectEvent, sessionIdOf } from "./events";
import { captureOpenCodeFetch } from "./fetch-capture";
import { openCodeStorage } from "./storage";
import {
  LEASE_FN,
  SessionLeases,
  leasePayload,
  type LeasePayload
} from "./lease";
import {
  LogReaders,
  followLog,
  type OpenCodeDurableEvent
} from "./log-readers";
import {
  inboxOperations,
  inspectOperation,
  messageIdOf,
  messageText,
  projectMessages,
  rawMessages,
  type RawMessage,
  type SettledResult
} from "./messages";
import { SettlementWaiters } from "./settlement";
import type {
  OpenCodeEvent,
  OpenCodeEventStream,
  OpenCodeMessage,
  OpenCodeModel,
  OpenCodeOperationResult,
  OpenCodePendingOperation,
  OpenCodePermission,
  OpenCodePromptResponse,
  OpenCodeProvider,
  OpenCodeReceipt,
  OpenCodeSessionId,
  OpenCodeSessionInfo,
  OpenCodeSessionOptions,
  OpenCodeSnapshot,
  OpenCodeSubmitOptions
} from "./types";

const RESULT_POLL_MS = 500;
const MESSAGE_PAGE = 100;
const ROOT_SESSION_KEY = "oc:session-id";

type Host = Awaited<ReturnType<typeof OpenCodeWorkerd.create>>;
type HostFetch = (request: Request) => Promise<Response>;
type Opened = { readonly host: Host; readonly fetch: HostFetch };
type Plugin = NonNullable<OpenCodeWorkerd.CreateOptions["plugins"]>[number];

/**
 * The root session. OpenCode names sessions itself, so this is an alias the
 * harness resolves to the object's first session, created on first use.
 */
export const ROOT_SESSION: OpenCodeSessionId = "root";

/** OpenCode's own config, as `OpenCodeWorkerd.create` takes it. */
export type OpenCodeConfig = OpenCodeWorkerd.Configuration;

/** What a new session starts with. */
export type OpenCodeSessionDefaults = {
  /**
   * Model for new sessions. It must be one a provider serves: `ai(id)`
   * from `agents/models/opencode`, with `ai.provider` in `providers`.
   */
  readonly model?: OpenCodeModel;
  /** The OpenCode agent prompts run as, unless a submission names one. */
  readonly agent?: string;
};

/** `OpenCodeHarness`'s options. Only `streams` is required. */
export type OpenCodeHarnessOptions = {
  /**
   * Where each operation's events are recorded. An operation's stream is
   * its record: open while it runs, closed or errored once it settles.
   */
  readonly streams: Streams;
  /** Model providers, such as `ai.provider` from `agents/models/opencode`. */
  readonly providers?: readonly OpenCodeProvider[];
  /** OpenCode plugins: tools, hooks, agents. */
  readonly plugins?: readonly Plugin[];
  /** OpenCode's own config: permissions, agents, instructions. */
  readonly config?: OpenCodeConfig;
  readonly defaults?: OpenCodeSessionDefaults;
  /** Options for OpenCode's workerd profile, other than what the harness sets. */
  readonly workerd?: Omit<
    OpenCodeWorkerd.CreateOptions,
    "storage" | "config" | "plugins"
  >;
  /**
   * The per-session lease: one Lifecycle job whose only work is to bring the
   * object back after an unplanned death, so OpenCode can resume the turn.
   */
  readonly lease?: {
    /** Silence before the lease fires, in ms. Default 60_000. */
    readonly ttlMs?: number;
    /** Fires with no log progress before giving up. Default 5. */
    readonly stallLimit?: number;
  };
};

/** What an emitted event belongs to. */
type EventContext = {
  readonly session?: OpenCodeSessionId;
  readonly operationId?: string;
  /** Set when the event was also written to the operation's stream. */
  readonly streamId?: string;
};

type Listener = (event: OpenCodeEvent, context: EventContext) => void;

/** Why an operation was declined, recorded on its stream. */
type DeclineCode = "aborted" | "not_admitted";

const DECLINE_MESSAGE: Record<DeclineCode, string> = {
  aborted: "Turn aborted",
  not_admitted: "Prompt was never admitted"
};

/** Events after which a watcher gets a fresh snapshot. */
const RESNAPSHOT = new Set<OpenCodeEvent["type"]>([
  "operation_start",
  "operation_end",
  "transcript_reset"
]);

/**
 * OpenCode's embedded SDK hosted in a Durable Object, behind the same small
 * interface as `PiHarness`: `harness.prompt()`, `harness.sessions`,
 * `harness.session(id)`. How a session reaches a client (sockets, SSE, RPC)
 * is the host's glue, built on `session.events()`; `harness.fetch()` serves
 * OpenCode's own HTTP API, which is what the OpenCode CLI speaks.
 *
 * OpenCode owns the run: admission through its inbox, the durable execution
 * claim, the boot sweep that resumes a claimed turn, and retries. The
 * harness owns the two things it cannot do here: waking the object after an
 * unplanned death (the lease, see `lease.ts`), and projecting its event log
 * onto durable streams so a turn can be read back after an eviction.
 *
 * One operation is one prompt, and an operation's stream is its record:
 * while the stream is `streaming` the operation is open, and closing or
 * erroring it settles the operation exactly once.
 *
 * @beta The API may change between releases.
 */
export class OpenCodeHarness extends LifecycleCapability {
  readonly sessions: OpenCodeSessions;
  readonly #options: OpenCodeHarnessOptions;
  readonly #streams: Streams;
  #opening: Promise<Opened> | undefined;
  #live: AbortController | undefined;
  readonly #readers = new LogReaders();
  #rootSession: string | undefined;
  #leases: SessionLeases | undefined;
  /** One writer per open operation. */
  readonly #writers = new Map<string, OperationStreamWriter>();
  /** The operation a session's events currently belong to. */
  readonly #current = new Map<string, string>();
  /** Submits between arming the lease and OpenCode's `started`, per session. */
  readonly #admitting = new Map<string, number>();
  readonly #settlement = new SettlementWaiters(RESULT_POLL_MS);
  readonly #permissions = new Map<string, OpenCodePermission>();
  readonly #listeners = new Set<Listener>();
  /** Told when a session starts or stops running, whoever started it. */
  readonly #changes = new Set<(session: string) => void>();

  constructor(options: OpenCodeHarnessOptions) {
    super("opencode-harness");
    this.#options = options;
    this.#streams = options.streams;
    this.sessions = new OpenCodeSessions(this);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Boot OpenCode, which starts its own sweep of claimed sessions, and start
   * a log reader for every session that still holds a lease.
   */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    await this.#host();
    for (const lease of this.#lease().list()) {
      await this.#readLog(lease.session);
    }
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== LEASE_FN) return;
    const held = leasePayload(context.job);
    if (!held) return;
    return this.#onLeaseFired(held);
  }

  /** Close OpenCode's in-memory resources. Durable state is untouched. */
  async dispose(): Promise<void> {
    this.#live?.abort();
    this.#live = undefined;
    this.#readers.stopAll();
    const opening = this.#opening;
    this.#opening = undefined;
    for (const writer of this.#writers.values()) writer.flush();
    const opened = await opening?.catch(() => undefined);
    await opened?.host.close();
  }

  // ── The harness interface ────────────────────────────────────────────────

  /** A handle on one session. No I/O until you call it. */
  session(id: OpenCodeSessionId = ROOT_SESSION): OpenCodeSession {
    return new OpenCodeSession(this, id);
  }

  /** Submit a prompt and wait for its answer. */
  prompt(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodePromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: string,
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

  wait(
    operationId: string,
    options: OpenCodeSessionOptions & { readonly signal?: AbortSignal } = {}
  ): Promise<OpenCodeOperationResult> {
    return this.session(options.session).wait(operationId, options.signal);
  }

  /** The session's transcript. */
  messages(options: OpenCodeSessionOptions = {}): Promise<OpenCodeMessage[]> {
    return this.session(options.session).messages();
  }

  /** Our prompts OpenCode has not settled yet, oldest first. */
  async pending(
    options: OpenCodeSessionOptions = {}
  ): Promise<OpenCodePendingOperation[]> {
    const session = await this.resolve(options.session);
    const host = await this.#host();
    const queued = inboxOperations(
      await host.sessions.inbox.list({ sessionID: session })
    );
    const running = this.#current.get(session);
    return [
      ...(running && !queued.some((item) => item.operationId === running)
        ? [{ operationId: running, session, status: "running" as const }]
        : []),
      ...queued.map((item) => ({
        operationId: item.operationId,
        session,
        status: "queued" as const
      }))
    ];
  }

  /** The opened OpenCode SDK, for anything the interface does not cover. */
  async opencode(): Promise<Host> {
    return this.#host();
  }

  /**
   * OpenCode's own HTTP API, served in-process. Paths are OpenCode's
   * (`/api/session`, `/api/event`, ...); the host strips any prefix it
   * routed the request under. This is what the OpenCode CLI connects to.
   */
  async fetch(request: Request): Promise<Response> {
    await this.lifecycle.ready();
    return (await this.#open()).fetch(request);
  }

  // ── Used by OpenCodeSession and OpenCodeSessions ─────────────────────────

  /** @internal The OpenCode session id a handle's id names. */
  async resolve(id: OpenCodeSessionId | undefined): Promise<string> {
    if (id === undefined || id === ROOT_SESSION) return this.#root();
    return id;
  }

  /** @internal */
  async create(parent?: string): Promise<string> {
    await this.lifecycle.ready();
    const host = await this.#host();
    const created = parent
      ? await host.sessions.fork({ sessionID: parent })
      : await host.sessions.create({});
    await this.#configure(created.id);
    await this.#readLog(created.id);
    return created.id;
  }

  /** @internal */
  async list(): Promise<OpenCodeSessionInfo[]> {
    const root = await this.#root();
    const host = await this.#host();
    const [listed, active] = await Promise.all([
      host.sessions.list({}),
      host.sessions.active()
    ]);
    const infos = listed.data.map((info) => ({
      id: info.id,
      ...(info.parentID ? { parent: info.parentID } : {}),
      ...(info.fork ? { parent: info.fork.sessionID } : {}),
      busy: active[info.id]?.type === "running"
    }));
    return infos.some((info) => info.id === root)
      ? infos
      : [{ id: root, busy: active[root]?.type === "running" }, ...infos];
  }

  /**
   * @internal Admit one prompt as an operation.
   *
   * The ordering is load-bearing: arm the lease, open the stream, then
   * prompt. An eviction at any point after the lease is armed leaves a job
   * whose alarm restarts the object, and the fire reconciles whatever
   * actually happened. Re-submitting the same operation id is a no-op that
   * reports `accepted: false`.
   */
  async enqueue(
    id: OpenCodeSessionId,
    input: string,
    options: OpenCodeSubmitOptions
  ): Promise<OpenCodeReceipt> {
    await this.lifecycle.ready();
    const session = await this.resolve(id);
    const operationId = options.operationId ?? crypto.randomUUID();
    const host = await this.#host();
    const [messages, inbox] = await Promise.all([
      this.#listMessages(session),
      host.sessions.inbox.list({ sessionID: session })
    ]);
    const known =
      inspectOperation(messages, operationId) !== "absent" ||
      inboxOperations(inbox).some((item) => item.operationId === operationId);
    if (known) return { operationId, session, accepted: false };

    await this.#readLog(session);
    this.#admitting.set(session, (this.#admitting.get(session) ?? 0) + 1);
    try {
      // The lease first, so a crash before the prompt still leaves an alarm.
      await this.#lease().arm(
        session,
        "admitting",
        await this.#position(session)
      );
      // Opening the stream is admission: it is the operation's record, so a
      // failure here must fail the submit rather than lose the operation.
      const writer = await this.#openOperation(session, operationId);
      const agent = options.agent ?? this.#options.defaults?.agent;
      if (agent) {
        await host.sessions.switchAgent({ sessionID: session, agent });
      }
      await host.sessions.prompt({
        sessionID: session,
        id: messageIdOf(operationId),
        text: input,
        delivery: options.whenBusy === "steer" ? "steer" : "queue",
        resume: true
      });
      this.#emit(
        { type: "operation_start", operationId, startedAt: Date.now() },
        { session, operationId, streamId: writer.streamId }
      );
      return { operationId, session, accepted: true };
    } finally {
      const count = (this.#admitting.get(session) ?? 1) - 1;
      if (count > 0) this.#admitting.set(session, count);
      else this.#admitting.delete(session);
      await this.#lease().extend(session, await this.#position(session));
    }
  }

  /**
   * @internal Wait for one operation to settle.
   *
   * Reads the messages, so a turn that settled while this isolate was gone
   * still returns, and the operation's own stream, which records a decline
   * or a failure with no reply.
   */
  async settled(
    id: OpenCodeSessionId,
    operationId: string,
    signal?: AbortSignal
  ): Promise<OpenCodeOperationResult> {
    const session = await this.resolve(id);
    for (;;) {
      signal?.throwIfAborted();
      const messages = await this.#listMessages(session);
      const inspected = inspectOperation(messages, operationId);
      if (typeof inspected === "object") {
        return this.#result(session, inspected.result, messages);
      }
      const status = await this.#streams.status(
        this.#streamId(operationId, session)
      );
      if (!status && inspected === "absent") {
        return {
          operationId,
          session,
          status: "unanswered",
          reason: "not_found"
        };
      }
      if (status?.state === "errored") {
        return {
          operationId,
          session,
          status: "unanswered",
          reason: status.error ?? "declined"
        };
      }
      await this.#settlement.wait(operationId, signal);
    }
  }

  /**
   * @internal Withdraw a queued prompt, or interrupt the turn it is.
   *
   * When `interrupt` reports it stopped nothing, the stream is left open and
   * the lease settles the operation from whatever OpenCode publishes next.
   */
  async withdraw(id: OpenCodeSessionId, operationId: string): Promise<boolean> {
    await this.lifecycle.ready();
    const session = await this.resolve(id);
    const host = await this.#host();
    const queued = inboxOperations(
      await host.sessions.inbox.list({ sessionID: session })
    ).find((item) => item.operationId === operationId);
    if (queued) {
      await host.sessions.inbox.cancel({
        sessionID: session,
        inboxID: queued.inboxId
      });
      await this.#decline(session, operationId, "aborted");
      return true;
    }
    if (this.#current.get(session) !== operationId) return false;
    return this.interrupt(session);
  }

  /** @internal Interrupt whatever the session is running. */
  async interrupt(id: OpenCodeSessionId): Promise<boolean> {
    await this.lifecycle.ready();
    const session = await this.resolve(id);
    const host = await this.#host();
    const interrupted = (await host.sessions.interrupt({
      sessionID: session
    })) as { interrupted?: boolean } | undefined;
    const operationId = this.#current.get(session);
    if (interrupted?.interrupted && operationId) {
      await this.#decline(session, operationId, "aborted");
    } else {
      await this.#reconcile(session);
    }
    return interrupted?.interrupted === true;
  }

  /** @internal */
  async transcript(id: OpenCodeSessionId): Promise<OpenCodeMessage[]> {
    const session = await this.resolve(id);
    return [...projectMessages(await this.#listMessages(session))];
  }

  /** @internal */
  async busy(id: OpenCodeSessionId): Promise<boolean> {
    const session = await this.resolve(id);
    const active = await (await this.#host()).sessions.active();
    return active[session]?.type === "running";
  }

  /** @internal */
  async replyPermission(
    id: OpenCodeSessionId,
    permissionId: string,
    decision: "once" | "always" | "reject"
  ): Promise<void> {
    const session = await this.resolve(id);
    await (
      await this.#host()
    ).permission.reply({
      sessionID: session,
      requestID: permissionId,
      decision
    });
    this.#permissions.delete(permissionId);
  }

  /** @internal */
  async setModel(id: OpenCodeSessionId, model: OpenCodeModel): Promise<void> {
    const session = await this.resolve(id);
    await (
      await this.#host()
    ).sessions.switchModel({
      sessionID: session,
      model: { id: model.id, providerID: model.providerID }
    });
  }

  /** @internal A session as a client first sees it. */
  async snapshot(id: OpenCodeSessionId): Promise<OpenCodeSnapshot> {
    const session = await this.resolve(id);
    const host = await this.#host();
    const [messages, active, info, pending] = await Promise.all([
      this.transcript(session),
      host.sessions.active(),
      host.sessions.get({ sessionID: session }),
      this.pending({ session })
    ]);
    return {
      session,
      messages,
      running: active[session]?.type === "running",
      operationId: this.#current.get(session) ?? null,
      pending,
      permissions: [...this.#permissions.values()].filter(
        (permission) => permission.session === session
      ),
      agent: info.agent ?? this.#options.defaults?.agent ?? null,
      model: info.model
        ? { providerID: info.model.providerID, id: info.model.id }
        : null
    };
  }

  /**
   * @internal One session's events: a snapshot now, then each projected
   * event, with a fresh snapshot after every operation starts and ends.
   */
  async events(id: OpenCodeSessionId): Promise<OpenCodeEventStream> {
    const session = await this.resolve(id);
    const snapshot = {
      type: "snapshot" as const,
      ...(await this.snapshot(session))
    };
    let unsubscribe: (() => void) | undefined;
    return {
      snapshot,
      start: (listener) => {
        unsubscribe?.();
        const resnapshot = () =>
          void this.snapshot(session).then(
            (fresh) => listener([{ type: "snapshot", ...fresh }]),
            () => undefined
          );
        const offEvents = this.#on((event, context) => {
          if (context.session !== session) return;
          listener([event]);
          if (RESNAPSHOT.has(event.type)) resnapshot();
        });
        // A turn the CLI started has no operation here; OpenCode's own
        // start and end still refresh the watcher.
        const onChange = (changed: string) => {
          if (changed === session) resnapshot();
        };
        this.#changes.add(onChange);
        unsubscribe = () => {
          offEvents();
          this.#changes.delete(onChange);
        };
      },
      stop: async () => {
        unsubscribe?.();
        unsubscribe = undefined;
      }
    };
  }

  /**
   * Admit a prompt with no lease and no stream, the way a crash between the
   * inbox write and `session.execution.started` leaves one.
   *
   * There is no other way to reach that state from outside: `submit` arms
   * the lease first, by design. Only the lease tests use this.
   *
   * @internal
   */
  async admitWithoutLease(
    session: string,
    operationId: string,
    text: string
  ): Promise<void> {
    const host = await this.#host();
    await host.sessions.prompt({
      sessionID: session,
      id: messageIdOf(operationId),
      text,
      delivery: "queue",
      resume: false
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** Every message in a session, oldest first, across pages. */
  async #listMessages(session: string): Promise<RawMessage[]> {
    const host = await this.#host();
    const messages: RawMessage[] = [];
    let cursor: string | undefined;
    do {
      // A cursor carries its own order and limit.
      const page = await host.message.list(
        cursor
          ? { sessionID: session, cursor }
          : { sessionID: session, order: "asc", limit: MESSAGE_PAGE }
      );
      messages.push(...rawMessages(page));
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    return messages;
  }

  async #root(): Promise<string> {
    if (this.#rootSession) return this.#rootSession;
    await this.lifecycle.ready();
    const stored = await this.lifecycle.storage.get<string>(ROOT_SESSION_KEY);
    if (stored) {
      this.#rootSession = stored;
      await this.#readLog(stored);
      return stored;
    }
    const host = await this.#host();
    const created = await host.sessions.create({});
    await this.#configure(created.id);
    await this.lifecycle.storage.put(ROOT_SESSION_KEY, created.id);
    this.#rootSession = created.id;
    await this.#readLog(created.id);
    return created.id;
  }

  /** Apply the defaults to a session the harness just created. */
  async #configure(session: string): Promise<void> {
    const model = this.#options.defaults?.model;
    if (model) await this.setModel(session, model);
  }

  // ── The lease ────────────────────────────────────────────────────────────

  #lease(): SessionLeases {
    this.#leases ??= new SessionLeases({
      jobs: this.lifecycle.jobs,
      ttlMs: this.#options.lease?.ttlMs,
      stallLimit: this.#options.lease?.stallLimit
    });
    return this.#leases;
  }

  /**
   * One run of a session's lease job, after `ttl` of silence.
   *
   * It never concludes "idle" from memory. Either durable state says there
   * is work (so extend), or it says the prompt was never admitted (so
   * re-send or decline), or there is nothing left (so complete).
   */
  async #onLeaseFired(held: LeasePayload): Promise<LifecycleJobOutcome> {
    const session = held.session;
    const host = await this.#host();
    // A reader that died leaves no retry loop of its own; this is it.
    await this.#readLog(session);
    await this.#reconcile(session, { keep: this.#current.get(session) });

    const active = await host.sessions.active();
    const position = await this.#position(session);
    if (active[session]) {
      // A long silent tool: active with no log progress. Never count these.
      await this.#lease().renew(session, held.kind, position, 0);
      return undefined;
    }

    const queued = inboxOperations(
      await host.sessions.inbox.list({ sessionID: session })
    );
    if (queued.length > 0) {
      // Admitted but never started: re-sending with the same id reconciles
      // to the existing item and rings OpenCode's doorbell again.
      const first = queued[0];
      await host.sessions.prompt({
        sessionID: session,
        id: first.inboxId,
        text: first.text,
        delivery: "queue",
        resume: true
      });
      return this.#renewWithStalls(held, position);
    }

    if (
      held.kind === "claimed" ||
      (await this.#openOperations(session)).length
    ) {
      return this.#renewWithStalls(held, position);
    }
    return undefined;
  }

  async #renewWithStalls(
    held: LeasePayload,
    position: number
  ): Promise<LifecycleJobOutcome> {
    const lease = this.#lease();
    const stalls = lease.nextStalls(held, position);
    if (lease.stalled(stalls)) {
      this.lifecycle.events.emit("opencode:lease_stalled", {
        session: held.session,
        position
      });
      return undefined;
    }
    await lease.renew(held.session, held.kind, position, stalls);
    return undefined;
  }

  /**
   * Drop the lease, but only when durable state agrees there is nothing
   * left. The in-memory `#admitting` count can only hold the lease open,
   * never cancel it: losing it to an eviction costs one extra fire, where
   * trusting it could strand a prompt.
   */
  async #release(session: string): Promise<void> {
    // The session's current operation is never declined here. A terminal
    // event can arrive before the reply is written to the messages, so the
    // operation reads as neither queued nor answered for a moment —
    // declining it then would reject a turn that in fact succeeded.
    await this.#reconcile(session, { keep: this.#current.get(session) });
    const host = await this.#host();
    const [inbox, open] = await Promise.all([
      host.sessions.inbox.list({ sessionID: session }),
      this.#openOperations(session)
    ]);
    if (
      inboxOperations(inbox).length === 0 &&
      !this.#admitting.has(session) &&
      open.length === 0
    ) {
      await this.#lease().release(session);
      return;
    }
    await this.#lease().arm(
      session,
      "admitting",
      await this.#position(session)
    );
  }

  // ── Operations and their streams ─────────────────────────────────────────

  #streamId(operationId: string, session: string): string {
    return `oc:${session}:${operationId}`;
  }

  /** Operation ids whose streams are still open, oldest first. */
  async #openOperations(session: string): Promise<string[]> {
    const rows = await this.#streams.list({
      tag: session,
      state: "streaming"
    });
    const ids: string[] = [];
    for (const row of rows) {
      const operationId = row.metadata?.operationId;
      if (typeof operationId === "string") ids.push(operationId);
    }
    return ids;
  }

  /**
   * Settle or decline every open operation the messages have an answer for.
   *
   * With `whenBusy: "followUp"` several of our prompts can be open at once,
   * so this walks all of them rather than just the current one.
   */
  async #reconcile(
    session: string,
    options: { readonly keep?: string | undefined } = {}
  ): Promise<void> {
    const host = await this.#host();
    const [messages, inbox, open] = await Promise.all([
      this.#listMessages(session),
      host.sessions.inbox.list({ sessionID: session }),
      this.#openOperations(session)
    ]);
    const queued = new Set(
      inboxOperations(inbox).map((item) => item.operationId)
    );
    for (const operationId of open) {
      const inspected = inspectOperation(messages, operationId);
      if (typeof inspected === "object") {
        await this.#settle(session, inspected.result);
        continue;
      }
      if (inspected === "active" || queued.has(operationId)) continue;
      // A prompt being handed to OpenCode is briefly in neither the inbox
      // nor the messages: `inbox.delivered` fires once the item leaves the
      // inbox, before its user message is written. Declining there would
      // kill the turn we just started, so the caller names the operation it
      // is mid-handover for, and an in-flight `submit` protects its own.
      if (operationId === options.keep) continue;
      if (this.#admitting.has(session)) continue;
      await this.#decline(session, operationId, "not_admitted");
    }
  }

  /**
   * Settle an operation from its result. One with a reply closes its
   * stream; one that failed before any reply errors it with the reason, so
   * `wait` can report it after a restart.
   */
  async #settle(session: string, result: SettledResult): Promise<void> {
    const writer = this.#writers.get(result.operationId);
    const streamId = this.#streamId(result.operationId, session);
    this.#emit(
      {
        type: "operation_end",
        operationId: result.operationId,
        status: result.status,
        error: result.error,
        endedAt: Date.now()
      },
      { session, operationId: result.operationId, streamId: writer?.streamId }
    );
    const reason =
      result.messageId === undefined && result.status !== "completed"
        ? (result.error?.code ?? result.status)
        : undefined;
    if (reason !== undefined) {
      if (writer) writer.error(reason);
      else await this.#errorDetached(streamId, reason);
    } else if (writer) {
      writer.close();
    } else {
      await this.#closeDetached(session, result.operationId);
    }
    this.#forget(session, result.operationId);
    this.lifecycle.events.emit("operation:settled", {
      session,
      operationId: result.operationId,
      status: result.status
    });
    this.#settlement.notify(result.operationId);
  }

  /** Record a decline on the operation's own stream. Idempotent. */
  async #decline(
    session: string,
    operationId: string,
    code: DeclineCode
  ): Promise<void> {
    const writer = this.#writers.get(operationId);
    const streamId = this.#streamId(operationId, session);
    const status = await this.#streams.status(streamId);
    if (status && status.state !== "streaming") return;
    this.#emit(
      {
        type: "operation_end",
        operationId,
        status: "declined",
        error: { code, message: DECLINE_MESSAGE[code] },
        endedAt: Date.now()
      },
      { session, operationId, streamId }
    );
    if (writer) writer.error(code);
    else await this.#errorDetached(streamId, code);
    this.#forget(session, operationId);
    this.#settlement.notify(operationId);
  }

  #forget(session: string, operationId: string): void {
    this.#writers.delete(operationId);
    if (this.#current.get(session) === operationId) {
      this.#current.delete(session);
    }
  }

  /** Close a stream this isolate never opened a writer for. */
  async #closeDetached(session: string, operationId: string): Promise<void> {
    const streamId = this.#streamId(operationId, session);
    const status = await this.#streams.status(streamId);
    if (status?.state !== "streaming") return;
    const writer = await this.#streams.open(streamId, {
      tag: session,
      metadata: { session, operationId }
    });
    writer.close();
  }

  async #errorDetached(streamId: string, reason: string): Promise<void> {
    const status = await this.#streams.status(streamId);
    if (status?.state !== "streaming") return;
    const metadata = status.metadata ?? {};
    const writer = await this.#streams.open(streamId, {
      tag: typeof metadata.session === "string" ? metadata.session : undefined,
      metadata
    });
    writer.error(reason);
  }

  /**
   * Open an operation's stream and make it the session's current one.
   *
   * Errors propagate: on the admission path the stream *is* the operation
   * record, so a submit that cannot open one must fail.
   */
  async #openOperation(
    session: string,
    operationId: string
  ): Promise<OperationStreamWriter> {
    const existing = this.#writers.get(operationId);
    if (existing) {
      this.#current.set(session, operationId);
      return existing;
    }
    const streamId = this.#streamId(operationId, session);
    const writer = await this.#streams.open(streamId, {
      tag: session,
      metadata: { session, operationId }
    });
    const operationWriter = new OperationStreamWriter({
      streamId,
      operationId,
      writer
    });
    this.#writers.set(operationId, operationWriter);
    this.#current.set(session, operationId);
    return operationWriter;
  }

  /** The operation a session's events belong to, after a restart. */
  async #owner(session: string): Promise<string | undefined> {
    const current = this.#current.get(session);
    if (current) return current;
    const open = await this.#openOperations(session);
    if (open.length === 0) return undefined;
    const messages = await this.#listMessages(session);
    const active = open.find(
      (operationId) => inspectOperation(messages, operationId) === "active"
    );
    const owner = active ?? open[0];
    await this.#openOperation(session, owner);
    return owner;
  }

  async #result(
    session: string,
    result: SettledResult,
    messages: unknown
  ): Promise<OpenCodeOperationResult> {
    if (result.status !== "completed") {
      return {
        operationId: result.operationId,
        session,
        status: "unanswered",
        reason: result.error?.code ?? result.status
      };
    }
    return {
      operationId: result.operationId,
      session,
      status: "done",
      text: messageText(projectMessages(messages), result.messageId)
    };
  }

  // ── OpenCode and its readers ─────────────────────────────────────────────

  async #host(): Promise<Host> {
    return (await this.#open()).host;
  }

  #open(): Promise<Opened> {
    this.#opening ??= this.#doOpen().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  async #doOpen(): Promise<Opened> {
    const { host, fetch } = await captureOpenCodeFetch(() =>
      OpenCodeWorkerd.create({
        ...this.#options.workerd,
        // OpenCode creates its schema only in a database it thinks is empty.
        storage: openCodeStorage(this.lifecycle.storage),
        config: this.#config(),
        plugins: [
          ...(this.#options.providers ?? []).map(
            (provider) => provider.plugin as Plugin
          ),
          ...(this.#options.plugins ?? [])
        ]
      })
    );
    this.#readLive(host);
    return { host, fetch: (request) => fetch(request) };
  }

  /** OpenCode's config, with the providers and the default model merged in. */
  #config(): OpenCodeConfig {
    const config = this.#options.config ?? {};
    const providers = this.#options.providers ?? [];
    const model = this.#options.defaults?.model;
    return {
      ...config,
      ...(model ? { model: `${model.providerID}/${model.id}` } : {}),
      ...(providers.length > 0
        ? {
            providers: {
              ...config.providers,
              ...Object.fromEntries(
                providers.map((provider) => [provider.id, provider.config])
              )
            }
          }
        : {})
    } as OpenCodeConfig;
  }

  /**
   * The live reader: deltas for the stream and the UI.
   *
   * Durable events are skipped here — the log reader is the one that may
   * touch the lease or settle anything, because its delivery survives a
   * restart.
   */
  #readLive(host: Host): void {
    const controller = new AbortController();
    this.#live = controller;
    void (async () => {
      try {
        for await (const raw of host.events.subscribe({
          signal: controller.signal
        })) {
          if ("durable" in raw && raw.durable) continue;
          await this.#project(raw);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("OpenCodeHarness live reader stopped", error);
        }
      }
    })();
  }

  /**
   * The log reader: durable events, at least once, from a saved position.
   *
   * This is the load-bearing one. It extends the lease on every event,
   * relabels it on `started`, and releases it on a terminal.
   */
  async #readLog(session: string): Promise<void> {
    await this.#readers.start(
      session,
      async (signal) => {
        const host = await this.#host();
        const key = this.#positionKey(session);
        const after = (await this.lifecycle.storage.get<number>(key)) ?? -1;
        const source = host.sessions.log(
          {
            sessionID: session,
            after: after >= 0 ? after : undefined,
            follow: true
          },
          { signal }
        );
        return () =>
          followLog({
            after,
            source,
            handle: (event) => this.#onDurableEvent(session, event),
            advance: (seq) => this.lifecycle.storage.put(key, seq)
          });
      },
      (error) => {
        // The next lease fire restarts the reader.
        this.lifecycle.events.emit("opencode:log_error", {
          session,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    );
  }

  #positionKey(session: string): string {
    return `oc:log-position:${session}`;
  }

  async #position(session: string): Promise<number> {
    return (
      (await this.lifecycle.storage.get<number>(this.#positionKey(session))) ??
      -1
    );
  }

  /**
   * One durable log event.
   *
   * Projection first, so a client sees the turn, then the lease bookkeeping.
   */
  async #onDurableEvent(
    session: string,
    event: OpenCodeDurableEvent
  ): Promise<void> {
    await this.#owner(session);
    await this.#project(event);
    this.#writers.get(this.#current.get(session) ?? "")?.flush();

    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "session.execution.started":
        await this.#lease().arm(
          session,
          "claimed",
          event.durable?.seq ?? (await this.#position(session))
        );
        this.#changed(session);
        return;
      case "session.inbox.delivered": {
        // This prompt is now the turn. Earlier ones may already have an
        // answer, so reconcile before switching.
        const operationId = this.#operationOf(data.inboxID);
        if (!operationId) return;
        await this.#reconcile(session, { keep: operationId });
        if (this.#writers.has(operationId)) {
          this.#current.set(session, operationId);
        }
        return;
      }
      case "session.inbox.cancelled": {
        const operationId = this.#operationOf(data.inboxID);
        if (operationId) await this.#decline(session, operationId, "aborted");
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
        await this.#settleTerminal(session, event.type, data.error);
        return;
      case "session.execution.interrupted":
        // Shutdown keeps the claim: OpenCode's own sweep continues the turn.
        if (data.reason === "shutdown") return;
        await this.#settleTerminal(session, event.type, data.reason);
        return;
      default:
        await this.#lease().extend(
          session,
          event.durable?.seq ?? (await this.#position(session))
        );
    }
  }

  /** Settle whatever is in flight, then decide the lease's fate. */
  async #settleTerminal(
    session: string,
    type: string,
    reason?: unknown
  ): Promise<void> {
    const operationId = this.#current.get(session);
    if (operationId) {
      const messages = await this.#listMessages(session);
      const inspected = inspectOperation(messages, operationId);
      if (typeof inspected === "object") {
        await this.#settle(session, inspected.result);
      } else if (type === "session.execution.interrupted") {
        await this.#decline(session, operationId, "aborted");
      } else if (type === "session.execution.failed") {
        await this.#settle(session, {
          operationId,
          status: "failed",
          error: {
            code: "execution_failed",
            message: failureMessage(reason)
          }
        });
      }
    }
    await this.#release(session);
    this.#changed(session);
  }

  #changed(session: string): void {
    for (const listener of this.#changes) {
      try {
        listener(session);
      } catch (error) {
        console.error("OpenCodeHarness change listener failed", error);
      }
    }
  }

  #operationOf(inboxId: unknown): string | undefined {
    if (typeof inboxId !== "string" || !inboxId.startsWith("msg_")) {
      return undefined;
    }
    return inboxId.slice("msg_".length);
  }

  // ── Projection ───────────────────────────────────────────────────────────

  async #project(raw: {
    type: string;
    data?: Record<string, unknown>;
    created?: number;
  }): Promise<void> {
    const session = sessionIdOf(raw);
    if (
      session &&
      (raw.type === "session.idle" ||
        raw.type === "session.execution.succeeded" ||
        raw.type === "session.execution.failed" ||
        raw.type === "session.execution.interrupted")
    ) {
      const operationId = this.#current.get(session);
      if (operationId) this.#settlement.notify(operationId);
    }
    const projected = projectEvent(raw);
    if (!projected) return;
    if (projected.type === "permission_asked") {
      this.#permissions.set(projected.permission.id, projected.permission);
    }
    if (projected.type === "permission_replied") {
      this.#permissions.delete(projected.permissionId);
    }
    const operationId = session ? this.#current.get(session) : undefined;
    const writer = operationId ? this.#writers.get(operationId) : undefined;
    this.#emit(projected, {
      session,
      operationId,
      streamId: writer && !writer.closed ? writer.streamId : undefined
    });
  }

  #on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: OpenCodeEvent, context: EventContext): void {
    if (context.streamId && context.operationId) {
      const writer = this.#writers.get(context.operationId);
      if (writer && !writer.closed) writer.push(event);
    }
    for (const listener of this.#listeners) {
      try {
        listener(event, context);
      } catch (error) {
        console.error("OpenCodeHarness listener failed", error);
      }
    }
  }
}

function failureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return "OpenCode execution failed";
}

/** One OpenCode session, addressed through the harness. */
export class OpenCodeSession {
  readonly #harness: OpenCodeHarness;
  readonly id: OpenCodeSessionId;

  constructor(harness: OpenCodeHarness, id: OpenCodeSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  /** Durably submit a prompt. Resolves before the model runs. */
  submit(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodeReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  /** Submit and wait for the answer and the updated transcript. */
  async prompt(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodePromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  /** Join the running turn. */
  steer(
    input: string,
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
   * Withdraw one queued operation (or interrupt the turn it is), or, with
   * no id, interrupt whatever the session is running.
   */
  abort(operationId?: string): Promise<boolean> {
    return operationId === undefined
      ? this.#harness.interrupt(this.id)
      : this.#harness.withdraw(this.id, operationId);
  }

  /** Change this session's model, to one a provider serves. */
  setModel(model: OpenCodeModel): Promise<void> {
    return this.#harness.setModel(this.id, model);
  }

  /** Answer a permission OpenCode asked for. */
  replyPermission(
    permissionId: string,
    decision: "once" | "always" | "reject"
  ): Promise<void> {
    return this.#harness.replyPermission(this.id, permissionId, decision);
  }

  /** The session's transcript. */
  messages(): Promise<OpenCodeMessage[]> {
    return this.#harness.transcript(this.id);
  }

  /** This session's events: a snapshot, then a batch per event. */
  events(): Promise<OpenCodeEventStream> {
    return this.#harness.events(this.id);
  }

  busy(): Promise<boolean> {
    return this.#harness.busy(this.id);
  }
}

/** Every OpenCode session in this object. */
export class OpenCodeSessions {
  readonly #harness: OpenCodeHarness;

  constructor(harness: OpenCodeHarness) {
    this.#harness = harness;
  }

  get(id: OpenCodeSessionId): OpenCodeSession {
    return this.#harness.session(id);
  }

  /** A new top-level session, configured like the root. */
  async create(): Promise<OpenCodeSession> {
    return this.get(await this.#harness.create());
  }

  /** A new session that starts with a copy of another's transcript. */
  async fork(from: OpenCodeSessionId): Promise<OpenCodeSession> {
    return this.get(
      await this.#harness.create(await this.#harness.resolve(from))
    );
  }

  /** Every session, the root first. */
  list(): Promise<OpenCodeSessionInfo[]> {
    return this.#harness.list();
  }
}
