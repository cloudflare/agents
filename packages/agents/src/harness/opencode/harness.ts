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

// OpenCode allocates session IDs; "root" is an alias for the first session.
export const ROOT_SESSION: OpenCodeSessionId = "root";

export type OpenCodeConfig = OpenCodeWorkerd.Configuration;

export type OpenCodeSessionDefaults = {
  readonly model?: OpenCodeModel;
  readonly agent?: string;
};

export type OpenCodeHarnessOptions = {
  readonly streams: Streams;
  readonly providers?: readonly OpenCodeProvider[];
  readonly plugins?: readonly Plugin[];
  readonly config?: OpenCodeConfig;
  readonly defaults?: OpenCodeSessionDefaults;
  readonly workerd?: Omit<
    OpenCodeWorkerd.CreateOptions,
    "storage" | "config" | "plugins"
  >;
  readonly lease?: {
    readonly ttlMs?: number;
    readonly stallLimit?: number;
  };
};

type EventContext = {
  readonly session?: OpenCodeSessionId;
  readonly operationId?: string;
  readonly streamId?: string;
};

type Listener = (event: OpenCodeEvent, context: EventContext) => void;

type DeclineCode = "aborted" | "not_admitted";

const DECLINE_MESSAGE: Record<DeclineCode, string> = {
  aborted: "Turn aborted",
  not_admitted: "Prompt was never admitted"
};

const RESNAPSHOT = new Set<OpenCodeEvent["type"]>([
  "operation_start",
  "operation_end",
  "transcript_reset"
]);

/**
 * OpenCode owns the run, inbox, and crash recovery. This capability wakes a
 * stopped object with a lease and records operations in durable streams.
 * @beta
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
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #current = new Map<string, string>();
  readonly #admitting = new Map<string, number>();
  readonly #settlement = new SettlementWaiters(RESULT_POLL_MS);
  readonly #permissions = new Map<string, OpenCodePermission>();
  readonly #listeners = new Set<Listener>();
  // CLI turns bypass harness operations but still need to refresh UI watches.
  readonly #changes = new Set<(session: string) => void>();

  constructor(options: OpenCodeHarnessOptions) {
    super("opencode-harness");
    this.#options = options;
    this.#streams = options.streams;
    this.sessions = new OpenCodeSessions(this);
  }

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

  session(id: OpenCodeSessionId = ROOT_SESSION): OpenCodeSession {
    return new OpenCodeSession(this, id);
  }

  prompt(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodePromptResponse> {
    return this.session(options.session).prompt(input, options);
  }

  submit(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodeReceipt> {
    return this.session(options.session).submit(input, options);
  }

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

  messages(options: OpenCodeSessionOptions = {}): Promise<OpenCodeMessage[]> {
    return this.session(options.session).messages();
  }

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

  async opencode(): Promise<Host> {
    return this.#host();
  }

  async fetch(request: Request): Promise<Response> {
    await this.lifecycle.ready();
    return (await this.#open()).fetch(request);
  }

  async resolve(id: OpenCodeSessionId | undefined): Promise<string> {
    if (id === undefined || id === ROOT_SESSION) return this.#root();
    return id;
  }

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
      // Arm the lease before OpenCode sees the prompt: a crash after admission
      // must leave a durable way to restart the object.
      await this.#lease().arm(
        session,
        "admitting",
        await this.#position(session)
      );
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

  async transcript(id: OpenCodeSessionId): Promise<OpenCodeMessage[]> {
    const session = await this.resolve(id);
    return [...projectMessages(await this.#listMessages(session))];
  }

  async busy(id: OpenCodeSessionId): Promise<boolean> {
    const session = await this.resolve(id);
    const active = await (await this.#host()).sessions.active();
    return active[session]?.type === "running";
  }

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

  async setModel(id: OpenCodeSessionId, model: OpenCodeModel): Promise<void> {
    const session = await this.resolve(id);
    await (
      await this.#host()
    ).sessions.switchModel({
      sessionID: session,
      model: { id: model.id, providerID: model.providerID }
    });
  }

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

  async #listMessages(session: string): Promise<RawMessage[]> {
    const host = await this.#host();
    const messages: RawMessage[] = [];
    let cursor: string | undefined;
    do {
      // OpenCode rejects an explicit order or limit when a cursor is passed.
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

  async #configure(session: string): Promise<void> {
    const model = this.#options.defaults?.model;
    if (model) await this.setModel(session, model);
  }

  #lease(): SessionLeases {
    this.#leases ??= new SessionLeases({
      jobs: this.lifecycle.jobs,
      ttlMs: this.#options.lease?.ttlMs,
      stallLimit: this.#options.lease?.stallLimit
    });
    return this.#leases;
  }

  async #onLeaseFired(held: LeasePayload): Promise<LifecycleJobOutcome> {
    const session = held.session;
    const host = await this.#host();

    await this.#readLog(session);
    await this.#reconcile(session, {
      inFlightOperationId: this.#current.get(session)
    });

    const active = await host.sessions.active();
    const position = await this.#position(session);
    if (active[session]) {
      await this.#lease().renew(session, held.kind, position, 0);
      return undefined;
    }

    const queued = inboxOperations(
      await host.sessions.inbox.list({ sessionID: session })
    );
    if (queued.length > 0) {
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

  async #release(session: string): Promise<void> {
    // The terminal event can precede the reply's message write. Keep the
    // current operation open until durable state can settle it.
    await this.#reconcile(session, {
      inFlightOperationId: this.#current.get(session)
    });
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

  #streamId(operationId: string, session: string): string {
    return `oc:${session}:${operationId}`;
  }

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

  async #reconcile(
    session: string,
    options: { readonly inFlightOperationId?: string | undefined } = {}
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

      // Delivery removes an item from the inbox before writing the user
      // message. Do not decline the operation in that handoff window.
      if (operationId === options.inFlightOperationId) continue;
      if (this.#admitting.has(session)) continue;
      await this.#decline(session, operationId, "not_admitted");
    }
  }

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

  // Live deltas are for display. Only the durable log may settle an
  // operation or change its lease, since those events survive eviction.
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
        const operationId = this.#operationOf(data.inboxID);
        if (!operationId) return;
        await this.#reconcile(session, { inFlightOperationId: operationId });
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

export class OpenCodeSession {
  readonly #harness: OpenCodeHarness;
  readonly id: OpenCodeSessionId;

  constructor(harness: OpenCodeHarness, id: OpenCodeSessionId) {
    this.#harness = harness;
    this.id = id;
  }

  submit(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodeReceipt> {
    return this.#harness.enqueue(this.id, input, options);
  }

  async prompt(
    input: string,
    options: OpenCodeSubmitOptions = {}
  ): Promise<OpenCodePromptResponse> {
    const receipt = await this.submit(input, options);
    const result = await this.wait(receipt.operationId);
    return { ...result, messages: await this.messages() };
  }

  steer(
    input: string,
    options: Omit<OpenCodeSubmitOptions, "whenBusy"> = {}
  ): Promise<OpenCodeReceipt> {
    return this.submit(input, { ...options, whenBusy: "steer" });
  }

  wait(
    operationId: string,
    signal?: AbortSignal
  ): Promise<OpenCodeOperationResult> {
    return this.#harness.settled(this.id, operationId, signal);
  }

  abort(operationId?: string): Promise<boolean> {
    return operationId === undefined
      ? this.#harness.interrupt(this.id)
      : this.#harness.withdraw(this.id, operationId);
  }

  setModel(model: OpenCodeModel): Promise<void> {
    return this.#harness.setModel(this.id, model);
  }

  replyPermission(
    permissionId: string,
    decision: "once" | "always" | "reject"
  ): Promise<void> {
    return this.#harness.replyPermission(this.id, permissionId, decision);
  }

  messages(): Promise<OpenCodeMessage[]> {
    return this.#harness.transcript(this.id);
  }

  events(): Promise<OpenCodeEventStream> {
    return this.#harness.events(this.id);
  }

  busy(): Promise<boolean> {
    return this.#harness.busy(this.id);
  }
}

export class OpenCodeSessions {
  readonly #harness: OpenCodeHarness;

  constructor(harness: OpenCodeHarness) {
    this.#harness = harness;
  }

  get(id: OpenCodeSessionId): OpenCodeSession {
    return this.#harness.session(id);
  }

  async create(): Promise<OpenCodeSession> {
    return this.get(await this.#harness.create());
  }

  async fork(from: OpenCodeSessionId): Promise<OpenCodeSession> {
    return this.get(
      await this.#harness.create(await this.#harness.resolve(from))
    );
  }

  list(): Promise<OpenCodeSessionInfo[]> {
    return this.#harness.list();
  }
}
