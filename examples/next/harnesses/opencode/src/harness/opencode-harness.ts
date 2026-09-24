import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import {
  LifecycleCapability,
  type CapabilityStartContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import { StateMachine, type MachineRunSnapshot } from "agents/state-machine";
import type { Streams } from "agents/streams";
import type { WebSocketsOptions } from "agents/websockets";
import { OperationStreamWriter, projectEvent, sessionIdOf } from "./events";
import { OpenCodeSubmissions } from "./intake";
import {
  createOpenCodeDriveRuntime,
  type OpenCodeDriveHost,
  type OpenCodeTurnLookup
} from "./drive-runtime";
import {
  OPENCODE_DRIVE_EFFECT,
  OPENCODE_RUN_DEFINITION,
  openCodeRunMachine,
  type OpenCodeDriveInput,
  type OpenCodeDriveOutput,
  type OpenCodeRequest,
  type OpenCodeRunResult,
  type OpenCodeRunState
} from "./machine";
import { projectMessages } from "./messages";
import { SettlementWaiters } from "./settlement";
import { OpenCodeTransport, type OpenCodeTransportHost } from "./transport";
import type {
  OCEvent,
  OCMessage,
  OCPendingSubmission,
  OCPermission,
  OCSnapshot,
  OCSubmissionReceipt,
  OpenCodeHarnessConfig
} from "./types";

const RECONCILE_JOB_ID = "reconcile";
const RECONCILE_FN = "reconcile";
const RESULT_POLL_MS = 500;
const SESSION_BUSY_WAIT_MS = 250;
const DEFAULT_PASS_BUDGET_MS = 20_000;
/** A parked permission prompt re-checks at most this often. */
const PERMISSION_PARK_MS = 30_000;

type Host = Awaited<ReturnType<typeof OpenCodeWorkerd.create>>;

/** A submission OpenCode refused. */
export class OpenCodeRejectedError extends Error {
  readonly operationId: string;
  readonly code: string;

  constructor(operationId: string, code: string, message: string) {
    super(message);
    this.name = "OpenCodeRejectedError";
    this.operationId = operationId;
    this.code = code;
  }
}

/**
 * Hosts OpenCode's embedded server inside a Lifecycle Durable Object.
 *
 * OpenCode owns the transcript, the inbox, tool calls and their results,
 * permissions, and its own boot-time replay of a suspended session, all in
 * this object's SQLite database via `@opencode/sdk/workerd`. Around it the
 * capability composes the SDK's durable primitives: submissions queue in a
 * small intake table, each turn runs as one `StateMachine` run whose
 * checkpoint wraps OpenCode's turn loop as a reconciled effect, and every
 * turn's live events land in one `Streams` stream clients replay.
 *
 * This is the same wrapped-runtime shape as the pi harness in
 * cloudflare/agents#2338, and deliberately so: the value of the pattern is
 * that a second third-party harness drops into it without inventing a new
 * integration story.
 *
 * @experimental Proof of concept against `@opencode/sdk` 2.0.x.
 */
export class OpenCodeHarness extends LifecycleCapability {
  readonly #config: OpenCodeHarnessConfig;
  readonly #streams: Streams;
  /**
   * The turn machines. The harness owns this capability rather than
   * receiving it, because the definition and its effect runtime are bound to
   * this harness's OpenCode host. Install it beside the harness with
   * `.use(harness.stateMachine)`.
   */
  readonly #machines = new StateMachine({
    definitions: { [OPENCODE_RUN_DEFINITION]: openCodeRunMachine },
    effects: {
      [OPENCODE_DRIVE_EFFECT]: createOpenCodeDriveRuntime(this.#driveHost())
    }
  });
  #submissions: OpenCodeSubmissions | undefined;
  #booting: Promise<Host> | undefined;
  #eventPump: AbortController | undefined;
  #transport: OpenCodeTransport | undefined;
  #defaultSession: string | undefined;
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #bySession = new Map<string, OperationStreamWriter>();
  readonly #settlement = new SettlementWaiters(RESULT_POLL_MS);
  readonly #rejections = new Map<string, OpenCodeRejectedError>();
  readonly #permissions = new Map<string, OCPermission>();
  readonly #listeners = new Set<(event: OCEvent) => void>();
  /** Sessions whose execution has finished since the last pass checked. */
  readonly #idle = new Set<string>();

  constructor(config: OpenCodeHarnessConfig) {
    super("opencode-harness");
    this.#config = config;
    this.#streams = config.streams;
  }

  get stateMachine(): StateMachine<{
    [OPENCODE_RUN_DEFINITION]: typeof openCodeRunMachine;
  }> {
    return this.#machines;
  }

  get streams(): Streams {
    return this.#streams;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Boot OpenCode against this object's SQLite state and re-derive runs.
   *
   * `OpenCodeWorkerd.create()` replays its own suspended sessions here, and
   * `StateMachine` reconciles its runs on startup, so this hook only needs to
   * cover the gap the two leave: a submission written to intake whose machine
   * run never started.
   */
  override async onStart(_context: CapabilityStartContext): Promise<void> {
    this.#submissions = new OpenCodeSubmissions(this.lifecycle.storage);
    this.#submissions.ensureTable();
    await this.#host();
    if (this.#submissions.list().length === 0) return;
    await this.lifecycle.jobs.push({
      id: RECONCILE_JOB_ID,
      fn: RECONCILE_FN,
      time: Date.now()
    });
  }

  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== RECONCILE_FN) return;
    // `run()` is idempotent on the operation id, so a submission whose run
    // already exists is a no-op.
    for (const submission of this.#requireSubmissions().list()) {
      await this.#startRun(
        submission.sessionId,
        submission.operationId,
        submission.request
      );
    }
  }

  /** Close process-local OpenCode resources without changing durable state. */
  async dispose(): Promise<void> {
    this.#eventPump?.abort();
    this.#eventPump = undefined;
    const booting = this.#booting;
    this.#booting = undefined;
    for (const writer of this.#writers.values()) writer.flush();
    if (booting) {
      const host = await booting.catch(() => undefined);
      await host?.close();
    }
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  /**
   * Durably queue a turn and return a receipt without waiting for the model.
   * The submission is durable before this resolves, and its machine run
   * delivers it to OpenCode in order.
   */
  async submit(
    request: OpenCodeRequest,
    options: { sessionId?: string; operationId?: string } = {}
  ): Promise<OCSubmissionReceipt> {
    await this.lifecycle.ready();
    const sessionId = options.sessionId ?? (await this.sessionId());
    const operationId = options.operationId ?? crypto.randomUUID();
    const submissions = this.#requireSubmissions();
    if (submissions.has(operationId)) {
      return { operationId, sessionId, accepted: false };
    }
    // Intake first: the row is the evidence that survives a crash between
    // here and the machine run, and the reconcile job repairs it.
    submissions.insert(sessionId, operationId, request);
    await this.#startRun(sessionId, operationId, request);
    return { operationId, sessionId, accepted: true };
  }

  /** Submit a prompt and wait for its outcome and the updated transcript. */
  async prompt(
    text: string,
    options: { sessionId?: string; agent?: string } = {}
  ): Promise<{ result: OpenCodeRunResult; messages: readonly OCMessage[] }> {
    const receipt = await this.submit(
      { kind: "prompt", text, agent: options.agent ?? this.#config.agent },
      options
    );
    const result = await this.waitForResult(receipt.operationId);
    return {
      result,
      messages: await this.getMessages({ sessionId: receipt.sessionId })
    };
  }

  /** Wait for one turn's terminal result. */
  async waitForResult(operationId: string): Promise<OpenCodeRunResult> {
    for (;;) {
      const run = await this.#machines.get(
        this.#runIdFor(operationId),
        OPENCODE_RUN_DEFINITION
      );
      if (run?.status === "completed") return run.result;
      if (run?.status === "cancelled") return { operationId, status: "aborted" };
      if (run?.status === "failed") {
        return {
          operationId,
          status: "failed",
          error: { code: run.error.name, message: run.error.message }
        };
      }
      const rejection = this.#rejections.get(operationId);
      if (rejection) {
        this.#rejections.delete(operationId);
        throw rejection;
      }
      await this.#settlement.wait(operationId);
    }
  }

  /**
   * Durably request that the session's current turn stop. A queued
   * submission is withdrawn instead. Returns null when nothing matched.
   */
  async abort(
    options: { sessionId?: string; operationId?: string } = {}
  ): Promise<{ operationId: string } | null> {
    await this.lifecycle.ready();
    const sessionId = options.sessionId ?? (await this.sessionId());
    const operationId = options.operationId ?? this.#bySession.get(sessionId)?.operationId;
    if (!operationId) return null;

    if (this.#requireSubmissions().deleteOperation(operationId)) {
      // Withdrawn before OpenCode took it: cancel the run that would have
      // delivered it, then publish the rejection.
      await this.#machines.cancel(this.#runIdFor(operationId), "aborted");
      this.#reject(
        sessionId,
        operationId,
        new OpenCodeRejectedError(
          operationId,
          "aborted",
          "Turn withdrawn before it started"
        )
      );
      return { operationId };
    }

    const host = await this.#host();
    await host.sessions.interrupt({ sessionID: sessionId });
    // OpenCode's interrupt is durable. Record the cancellation on the machine
    // too, so the run stops admitting passes and settles as cancelled.
    await this.#machines.cancel(this.#runIdFor(operationId), "aborted");
    return { operationId };
  }

  /** Queue a message the running turn reads at its next step boundary. */
  async steer(
    text: string,
    options: { sessionId?: string } = {}
  ): Promise<void> {
    const sessionId = options.sessionId ?? (await this.sessionId());
    const host = await this.#host();
    await host.sessions.prompt({
      sessionID: sessionId,
      text,
      delivery: "steer"
    });
    const running = this.#bySession.get(sessionId);
    if (running) {
      // Wake a parked run so the steer is read at the next boundary instead
      // of waiting out the park deadline.
      await this.#machines.notify(
        this.#runIdFor(running.operationId),
        { type: "oc:steered", key: running.operationId },
        { eventId: `steer:${crypto.randomUUID()}` }
      );
    }
  }

  /** Reply to a permission prompt and wake the run parked on it. */
  async replyPermission(
    permissionId: string,
    decision: "once" | "always" | "reject",
    options: { sessionId?: string } = {}
  ): Promise<void> {
    const host = await this.#host();
    const sessionId =
      options.sessionId ??
      this.#permissions.get(permissionId)?.sessionId ??
      (await this.sessionId());
    await host.permission.reply({
      sessionID: sessionId,
      requestID: permissionId,
      decision
    });
    this.#permissions.delete(permissionId);
    const running = this.#bySession.get(sessionId);
    if (!running) return;
    await this.#machines.notify(
      this.#runIdFor(running.operationId),
      { type: "oc:permission-replied", key: running.operationId },
      { eventId: `permission:${permissionId}` }
    );
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** The durable session id this object owns, created on first use. */
  async sessionId(): Promise<string> {
    if (this.#defaultSession) return this.#defaultSession;
    const stored = await this.lifecycle.storage.get<string>("oc:session-id");
    if (stored) {
      this.#defaultSession = stored;
      return stored;
    }
    const host = await this.#host();
    const created = await host.sessions.create({});
    await this.lifecycle.storage.put("oc:session-id", created.id);
    this.#defaultSession = created.id;
    return created.id;
  }

  async getMessages(
    options: { sessionId?: string } = {}
  ): Promise<readonly OCMessage[]> {
    const sessionId = options.sessionId ?? (await this.sessionId());
    const host = await this.#host();
    const response = await host.message.list({ sessionID: sessionId });
    return projectMessages(response);
  }

  async pending(
    options: { sessionId?: string } = {}
  ): Promise<readonly OCPendingSubmission[]> {
    await this.lifecycle.ready();
    const sessionId = options.sessionId ?? (await this.sessionId());
    return this.#requireSubmissions()
      .list(sessionId)
      .map(({ seq: _seq, ...rest }) => rest);
  }

  /** A point-in-time view of one session. */
  async snapshot(options: { sessionId?: string } = {}): Promise<OCSnapshot> {
    const sessionId = options.sessionId ?? (await this.sessionId());
    const host = await this.#host();
    const [messages, active, session] = await Promise.all([
      this.getMessages({ sessionId }),
      host.sessions.active(),
      host.sessions.get({ sessionID: sessionId })
    ]);
    const writer = this.#bySession.get(sessionId);
    const stream = writer
      ? await this.#streams.status(writer.streamId)
      : undefined;
    return {
      sessionId,
      messages,
      running: active[sessionId]?.type === "running",
      operationId: writer?.operationId ?? null,
      stream: stream
        ? { streamId: writer!.streamId, cursor: stream.cursor }
        : null,
      pending: await this.pending({ sessionId }),
      permissions: [...this.#permissions.values()].filter(
        (permission) => permission.sessionId === sessionId
      ),
      agent:
        (session as { agent?: string }).agent ?? this.#config.agent ?? null,
      model: (session as { model?: OCSnapshot["model"] }).model ?? null
    };
  }

  /** The durable stream id of one turn's live events. */
  streamId(operationId: string, sessionId: string): string {
    return `oc:${sessionId}:${operationId}`;
  }

  /**
   * The durable machine checkpoint driving one turn — the outer control
   * state. OpenCode's transcript is read with {@link getMessages} instead.
   */
  async inspect(
    operationId: string
  ): Promise<MachineRunSnapshot<OpenCodeRunState, OpenCodeRunResult> | null> {
    await this.lifecycle.ready();
    return this.#machines.get(
      this.#runIdFor(operationId),
      OPENCODE_RUN_DEFINITION
    );
  }

  /** Observe projected events in this isolate. Returns an unsubscribe. */
  on(listener: (event: OCEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Options for a `WebSockets` capability serving this harness's protocol. */
  webSockets(): WebSocketsOptions {
    this.#transport ??= new OpenCodeTransport(
      this.#transportHost(),
      () => this.lifecycle.sockets
    );
    return this.#transport.webSocketOptions();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  #host(): Promise<Host> {
    this.#booting ??= this.#boot().catch((error: unknown) => {
      this.#booting = undefined;
      throw error;
    });
    return this.#booting;
  }

  /**
   * Boot the embedded OpenCode application graph on this object's storage.
   *
   * One host lives for the lifetime of the Durable Object instance, as the
   * SDK's Cloudflare guide requires. The event pump starts here and dies with
   * the isolate; durability comes from the Streams log it writes into, not
   * from the subscription.
   */
  async #boot(): Promise<Host> {
    const host = await OpenCodeWorkerd.create({
      storage: this.lifecycle.storage,
      config: this.#config.config as never,
      plugins: this.#config.plugins as never
    });
    this.#startEventPump(host);
    return host;
  }

  #startEventPump(host: Host): void {
    const controller = new AbortController();
    this.#eventPump = controller;
    void (async () => {
      try {
        for await (const raw of host.events.subscribe({
          signal: controller.signal
        })) {
          this.#onOpenCodeEvent(raw as never);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("OpenCodeHarness event pump stopped", error);
        }
      }
    })();
  }

  /**
   * Fan one OpenCode event out to the durable stream and to listeners.
   *
   * Settlement signals are recorded rather than acted on: the drive pass that
   * owns the turn observes them, so there is exactly one writer of the run's
   * outcome.
   */
  #onOpenCodeEvent(raw: { type: string; data?: Record<string, unknown> }): void {
    const sessionId = sessionIdOf(raw);
    if (
      raw.type === "session.idle" ||
      raw.type === "session.execution.succeeded" ||
      raw.type === "session.execution.failed" ||
      raw.type === "session.execution.interrupted"
    ) {
      if (sessionId) {
        this.#idle.add(sessionId);
        const writer = this.#bySession.get(sessionId);
        if (writer) this.#settlement.notify(writer.operationId);
      }
    }
    const projected = projectEvent(raw);
    if (!projected) return;
    if (projected.type === "permission_asked") {
      this.#permissions.set(projected.permission.id, projected.permission);
    }
    if (projected.type === "permission_replied") {
      this.#permissions.delete(projected.permissionId);
    }
    this.#emit(sessionId, projected);
  }

  #emit(sessionId: string | undefined, event: OCEvent): void {
    const writer = sessionId ? this.#bySession.get(sessionId) : undefined;
    if (writer && !writer.closed) writer.push(event);
    else this.#transport?.sessionEvent(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("OpenCodeHarness listener failed", error);
      }
    }
  }

  // ── Machine drive host ───────────────────────────────────────────────────

  /**
   * The OpenCode-side surface the machine's reconciled effect drives. Built
   * once in the field initializer so the runtime registered with StateMachine
   * stays stable across wakes.
   */
  #driveHost(): OpenCodeDriveHost {
    return {
      drive: (input, signal) => this.#drivePass(input, signal),
      lookup: (sessionId, operationId) => this.#lookup(sessionId, operationId),
      requestAbort: (sessionId) => this.#requestAbort(sessionId)
    };
  }

  async #startRun(
    sessionId: string,
    operationId: string,
    request: OpenCodeRequest
  ): Promise<void> {
    await this.#machines.run(
      OPENCODE_RUN_DEFINITION,
      {
        sessionId,
        operationId,
        request,
        streamId: this.streamId(operationId, sessionId)
      },
      { runId: this.#runIdFor(operationId), idempotencyKey: operationId }
    );
  }

  #runIdFor(operationId: string): string {
    return `oc:${operationId}`;
  }

  /**
   * The user message id a turn delivers under.
   *
   * Deriving it from the operation id is what makes delivery idempotent:
   * OpenCode dedupes on the message id, so a redelivery after a crash is its
   * own duplicate rather than a second turn. It is also how `#settledResult`
   * finds the turn's reply without keeping process-local state.
   */
  #messageIdFor(operationId: string): string {
    return `msg_${operationId}`;
  }

  /**
   * Run one bounded pass over OpenCode's durable turn loop.
   *
   * The first pass delivers the message; later passes re-attach by session.
   * The pass is bounded two ways — by `session.wait()` resolving, and by a
   * wall-clock budget — so a long turn parks on a durable deadline instead of
   * holding a Durable Object invocation open past its limits.
   */
  async #drivePass(
    input: OpenCodeDriveInput,
    signal: AbortSignal
  ): Promise<OpenCodeDriveOutput> {
    const { sessionId, operationId } = input;
    try {
      const host = await this.#host();

      // A settled turn is terminal evidence; report it without driving.
      const settled = await this.#settledResult(host, sessionId, operationId);
      if (settled) {
        this.#settle(sessionId, settled);
        return { kind: "settled", result: settled };
      }

      const active = await host.sessions.active();
      const running = active[sessionId]?.type === "running";

      if (!running && input.request) {
        const writer = await this.#writerFor(sessionId, operationId);
        this.#emit(sessionId, {
          type: "operation_start",
          operationId,
          startedAt: Date.now()
        });
        try {
          await this.#deliver(host, sessionId, operationId, input.request);
        } catch (error) {
          const rejection = new OpenCodeRejectedError(
            operationId,
            "rejected",
            error instanceof Error ? error.message : String(error)
          );
          this.#reject(sessionId, operationId, rejection);
          return {
            kind: "settled",
            result: {
              operationId,
              status: "declined",
              error: { code: rejection.code, message: rejection.message }
            }
          };
        }
        this.#requireSubmissions().deleteOperation(operationId);
        writer.flush();
      } else if (!running && !input.request) {
        // OpenCode has no live turn and no request to start one with. Either
        // it settled between passes (checked above) or the message never
        // landed; let the machine report it interrupted.
        return { kind: "settled", result: { operationId, status: "failed",
          error: { code: "lost", message: "The turn is no longer known to OpenCode" } } };
      } else if (running && input.request) {
        // Another turn holds the session. Park; OpenCode delivers in order.
        return {
          kind: "waiting",
          notBefore: Date.now() + SESSION_BUSY_WAIT_MS,
          reason: "busy"
        };
      }

      // Wait for the turn to go idle, bounded by the pass budget and by a
      // permission prompt, whichever comes first.
      const budget = this.#config.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS;
      const parked = await this.#waitForIdle(host, sessionId, budget, signal);

      if (parked === "permission") {
        this.#emit(sessionId, {
          type: "operation_wait",
          operationId,
          reason: "permission",
          notBefore: Date.now() + PERMISSION_PARK_MS
        });
        return {
          kind: "waiting",
          notBefore: Date.now() + PERMISSION_PARK_MS,
          reason: "permission"
        };
      }

      if (parked === "budget") {
        return { kind: "waiting", notBefore: Date.now(), reason: "budget" };
      }

      const result =
        (await this.#settledResult(host, sessionId, operationId)) ??
        ({ operationId, status: "completed" } as OpenCodeRunResult);
      this.#settle(sessionId, result);
      return { kind: "settled", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycle.events.emit("operation:error", { sessionId, message });
      // A faulted host is not reused; the next pass boots a fresh one.
      this.#eventPump?.abort();
      this.#eventPump = undefined;
      this.#booting = undefined;
      throw error;
    }
  }

  /** Deliver one request into OpenCode's inbox. */
  async #deliver(
    host: Host,
    sessionId: string,
    operationId: string,
    request: OpenCodeRequest
  ): Promise<void> {
    const agent = request.kind === "prompt" ? request.agent : undefined;
    const wanted = agent ?? this.#config.agent;
    // The agent is session state in OpenCode, not a per-message field, so it
    // is selected before the message is delivered.
    if (wanted) {
      await host.sessions.switchAgent({ sessionID: sessionId, agent: wanted });
    }
    switch (request.kind) {
      case "prompt":
        // The message id is derived from the operation id, so a repeated
        // delivery after a crash is OpenCode's own duplicate, not a new turn.
        await host.sessions.prompt({
          sessionID: sessionId,
          id: this.#messageIdFor(operationId),
          text: request.text
        });
        return;
      case "command":
        await host.sessions.command({
          sessionID: sessionId,
          name: request.command,
          text: request.args ?? ""
        });
        return;
      case "skill":
        await host.sessions.skill({
          sessionID: sessionId,
          id: request.skill
        });
        return;
      case "compact":
        await host.sessions.compact({
          sessionID: sessionId,
          id: this.#messageIdFor(operationId)
        });
        return;
    }
  }

  /**
   * Park until the session goes idle, a permission is asked, or the pass
   * budget expires. Returns what ended the wait.
   */
  async #waitForIdle(
    host: Host,
    sessionId: string,
    budgetMs: number,
    signal: AbortSignal
  ): Promise<"idle" | "permission" | "budget"> {
    const deadline = Date.now() + budgetMs;
    const idle = host.sessions
      .wait({ sessionID: sessionId })
      .then(() => "idle" as const);
    for (;;) {
      if (signal.aborted) return "idle";
      if (this.#idle.delete(sessionId)) return "idle";
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "budget";
      const pendingPermission = [...this.#permissions.values()].some(
        (permission) => permission.sessionId === sessionId
      );
      if (pendingPermission) return "permission";
      const tick = new Promise<"tick">((resolve) =>
        setTimeout(() => resolve("tick"), Math.min(remaining, 250))
      );
      const raced = await Promise.race([idle, tick]);
      if (raced === "idle") return "idle";
    }
  }

  /**
   * Read OpenCode's own record for one turn.
   *
   * This is the recovery authority: after eviction the machine asks OpenCode
   * what happened rather than repeating a prompt.
   */
  async #lookup(
    sessionId: string,
    operationId: string
  ): Promise<OpenCodeTurnLookup> {
    try {
      const host = await this.#host();
      const settled = await this.#settledResult(host, sessionId, operationId);
      if (settled) {
        this.#settle(sessionId, settled);
        return { status: "settled", result: settled };
      }
      const active = await host.sessions.active();
      if (active[sessionId]?.type === "running") return { status: "running" };
      return { status: "not-found" };
    } catch {
      // Treat an unreadable host as still running; the machine parks and asks
      // again rather than inventing a terminal outcome.
      return { status: "running" };
    }
  }

  /**
   * Whether OpenCode holds a finished assistant reply for this turn.
   *
   * The turn's user message carries `msg_<operationId>`, so its successor
   * assistant message is the turn's durable outcome. This is the OpenCode
   * analogue of pi's `getResult()`.
   */
  async #settledResult(
    host: Host,
    sessionId: string,
    operationId: string
  ): Promise<OpenCodeRunResult | undefined> {
    const response = (await host.message.list({
      sessionID: sessionId
    })) as unknown as ReadonlyArray<{
      info: { id: string; role: string; time?: { completed?: number } };
    }>;
    const index = response.findIndex(
      (entry) => entry.info.id === this.#messageIdFor(operationId)
    );
    if (index < 0) return undefined;
    const reply = response
      .slice(index + 1)
      .find((entry) => entry.info.role === "assistant");
    if (!reply?.info.time?.completed) return undefined;
    return {
      operationId,
      status: "completed",
      messageId: reply.info.id
    };
  }

  async #requestAbort(sessionId: string): Promise<void> {
    try {
      const host = await this.#host();
      await host.sessions.interrupt({ sessionID: sessionId });
    } catch {
      // Best-effort: the durable machine cancellation is already recorded.
    }
  }

  // ── Settlement and streams ───────────────────────────────────────────────

  #settle(sessionId: string, result: OpenCodeRunResult): void {
    const writer = this.#writers.get(result.operationId);
    this.#emit(sessionId, {
      type: "operation_end",
      operationId: result.operationId,
      status: result.status,
      error: result.error,
      endedAt: Date.now()
    });
    if (writer) {
      writer.close();
      this.#writers.delete(result.operationId);
      if (this.#bySession.get(sessionId) === writer) {
        this.#bySession.delete(sessionId);
      }
    }
    this.lifecycle.events.emit("operation:settled", {
      sessionId,
      operationId: result.operationId,
      status: result.status
    });
    this.#settlement.notify(result.operationId);
  }

  #reject(
    sessionId: string,
    operationId: string,
    error: OpenCodeRejectedError
  ): void {
    this.#rejections.set(operationId, error);
    this.#emit(sessionId, {
      type: "operation_end",
      operationId,
      status: "declined",
      error: { code: error.code, message: error.message },
      endedAt: Date.now()
    });
    this.#settlement.notify(operationId);
  }

  async #writerFor(
    sessionId: string,
    operationId: string
  ): Promise<OperationStreamWriter> {
    const existing = this.#writers.get(operationId);
    if (existing) return existing;
    const streamId = this.streamId(operationId, sessionId);
    let writer: Awaited<ReturnType<Streams["open"]>> | undefined;
    try {
      writer = await this.#streams.open(streamId, {
        tag: sessionId,
        metadata: { sessionId, operationId }
      });
    } catch {
      // Already settled by a previous attempt: events have nowhere to go.
      writer = undefined;
    }
    const operationWriter = new OperationStreamWriter({
      streamId,
      operationId,
      writer
    });
    this.#writers.set(operationId, operationWriter);
    this.#bySession.set(sessionId, operationWriter);
    this.#transport?.streamOpened(streamId, operationId, writer?.cursor ?? 0);
    return operationWriter;
  }

  #requireSubmissions(): OpenCodeSubmissions {
    if (!this.#submissions) {
      throw new Error("OpenCodeHarness is not attached to its Durable Object");
    }
    return this.#submissions;
  }

  #transportHost(): OpenCodeTransportHost {
    return {
      streams: this.#streams,
      snapshot: (options) => this.snapshot(options),
      submit: (request, options) => this.submit(request, options),
      abort: (options) => this.abort(options),
      steer: (text, options) => this.steer(text, options),
      replyPermission: (id, reply) => this.replyPermission(id, reply)
    };
  }
}
