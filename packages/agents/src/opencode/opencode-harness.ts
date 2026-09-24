import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { HarnessDriver } from "../driver";
import { LifecycleCapability, type CapabilityStartContext } from "../lifecycle";
import type { Streams } from "../streams";
import type { WebSocketsOptions } from "../websockets";
import { OperationStreamWriter, projectEvent, sessionIdOf } from "./events";
import {
  OpenCodeRuntimeAdapter,
  type OpenCodeRuntimeClient
} from "./runtime-adapter";
import { replayOpenCodeLog } from "./log";
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
  OpenCodeHarnessConfig,
  OpenCodeRequest,
  OpenCodeResult
} from "./types";

const RESULT_POLL_MS = 500;

type Host = Awaited<ReturnType<typeof OpenCodeWorkerd.create>>;

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

export class OpenCodeHarness extends LifecycleCapability {
  readonly #config: OpenCodeHarnessConfig;
  readonly #streams: Streams;
  readonly driver: HarnessDriver<OpenCodeRequest, OpenCodeResult>;
  #booting: Promise<Host> | undefined;
  #eventPump: AbortController | undefined;
  readonly #sessionPumps = new Map<string, AbortController>();
  #transport: OpenCodeTransport | undefined;
  #defaultSession: string | undefined;
  readonly #writers = new Map<string, OperationStreamWriter>();
  readonly #bySession = new Map<string, OperationStreamWriter>();
  readonly #settlement = new SettlementWaiters(RESULT_POLL_MS);
  readonly #rejections = new Map<string, OpenCodeRejectedError>();
  readonly #permissions = new Map<string, OCPermission>();
  readonly #listeners = new Set<(event: OCEvent) => void>();

  constructor(config: OpenCodeHarnessConfig) {
    super("opencode-harness");
    this.#config = config;
    this.#streams = config.streams;
    this.driver = new HarnessDriver({
      id: "opencode",
      runtime: new OpenCodeRuntimeAdapter({
        client: this.#runtimeClient(),
        passBudgetMs: config.passBudgetMs,
        defaultAgent: config.agent,
        afterAdmit: (sessionId, operationId) =>
          this.#openOperation(sessionId, operationId),
        beforeDrive: async (sessionId, operationId) => {
          await this.#writerFor(sessionId, operationId);
        }
      }),
      settle: (submission, result) => this.#settle(submission.scope, result)
    });
  }

  get streams(): Streams {
    return this.#streams;
  }

  override async onStart(_context: CapabilityStartContext): Promise<void> {
    await this.#host();
  }

  async dispose(): Promise<void> {
    this.#eventPump?.abort();
    this.#eventPump = undefined;
    for (const controller of this.#sessionPumps.values()) controller.abort();
    this.#sessionPumps.clear();
    const booting = this.#booting;
    this.#booting = undefined;
    for (const writer of this.#writers.values()) writer.flush();
    if (booting) {
      const host = await booting.catch(() => undefined);
      await host?.close();
    }
  }

  async submit(
    request: OpenCodeRequest,
    options: { sessionId?: string; operationId?: string } = {}
  ): Promise<OCSubmissionReceipt> {
    await this.lifecycle.ready();
    const sessionId = options.sessionId ?? (await this.sessionId());
    await this.#ensureSessionPump(sessionId);
    const operationId = options.operationId ?? crypto.randomUUID();
    const receipt = await this.driver.submit(sessionId, request, {
      operationId,
      streamId: this.streamId(operationId, sessionId)
    });
    return {
      operationId: receipt.operationId,
      sessionId: receipt.scope,
      accepted: receipt.accepted
    };
  }

  async prompt(
    text: string,
    options: { sessionId?: string; agent?: string } = {}
  ): Promise<{ result: OpenCodeResult; messages: readonly OCMessage[] }> {
    const receipt = await this.submit(
      { kind: "prompt", text, agent: options.agent ?? this.#config.agent },
      options
    );
    const result = await this.waitForResult(receipt.operationId, {
      sessionId: receipt.sessionId
    });
    return {
      result,
      messages: await this.getMessages({ sessionId: receipt.sessionId })
    };
  }

  async waitForResult(
    operationId: string,
    options: { sessionId?: string } = {}
  ): Promise<OpenCodeResult> {
    const sessionId = options.sessionId ?? (await this.sessionId());
    for (;;) {
      const host = await this.#host();
      const result = await this.#settledResult(host, sessionId, operationId);
      if (result) return result;
      const rejection = this.#rejections.get(operationId);
      if (rejection) {
        this.#rejections.delete(operationId);
        throw rejection;
      }
      await this.#settlement.wait(operationId);
    }
  }

  async abort(
    options: { sessionId?: string; operationId?: string } = {}
  ): Promise<{ operationId: string } | null> {
    await this.lifecycle.ready();
    const sessionId = options.sessionId ?? (await this.sessionId());
    const operationId =
      options.operationId ?? this.#bySession.get(sessionId)?.operationId;
    if (!operationId) return null;

    const cancelled = await this.driver.cancel(operationId);
    if (!cancelled) return null;
    this.#reject(
      sessionId,
      operationId,
      new OpenCodeRejectedError(operationId, "aborted", "Turn aborted")
    );
    return { operationId };
  }

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
    await this.driver.wake(sessionId);
  }

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
    await this.driver.wake(sessionId);
  }

  async sessionId(): Promise<string> {
    if (this.#defaultSession) return this.#defaultSession;
    const stored = await this.lifecycle.storage.get<string>("oc:session-id");
    if (stored) {
      this.#defaultSession = stored;
      await this.#ensureSessionPump(stored);
      return stored;
    }
    const host = await this.#host();
    const created = await host.sessions.create({});
    await this.lifecycle.storage.put("oc:session-id", created.id);
    this.#defaultSession = created.id;
    await this.#ensureSessionPump(created.id);
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
    const rows = await this.driver.pending(sessionId);
    return rows.map((row) => ({
      operationId: row.operationId,
      sessionId: row.scope,
      request: row.input,
      submittedAt: row.submittedAt
    }));
  }

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

  streamId(operationId: string, sessionId: string): string {
    return `oc:${sessionId}:${operationId}`;
  }

  on(listener: (event: OCEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  webSockets(): WebSocketsOptions {
    this.#transport ??= new OpenCodeTransport(
      this.#transportHost(),
      () => this.lifecycle.sockets
    );
    return this.#transport.webSocketOptions();
  }

  #host(): Promise<Host> {
    this.#booting ??= this.#boot().catch((error: unknown) => {
      this.#booting = undefined;
      throw error;
    });
    return this.#booting;
  }

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
          if ("durable" in raw && raw.durable) continue;
          this.#onOpenCodeEvent(raw);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("OpenCodeHarness event pump stopped", error);
        }
      }
    })();
  }

  async #ensureSessionPump(sessionId: string): Promise<void> {
    if (this.#sessionPumps.has(sessionId)) return;
    const controller = new AbortController();
    this.#sessionPumps.set(sessionId, controller);
    const host = await this.#host();
    const key = `oc:log-cursor:${sessionId}`;
    const after = (await this.lifecycle.storage.get<number>(key)) ?? -1;
    const source = host.sessions.log(
      {
        sessionID: sessionId,
        after: after >= 0 ? after : undefined,
        follow: true
      },
      { signal: controller.signal }
    );
    const work = replayOpenCodeLog({
      after,
      source,
      project: async (event) => {
        this.#onOpenCodeEvent(event);
        this.#bySession.get(sessionId)?.flush();
      },
      save: (seq) => this.lifecycle.storage.put(key, seq)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        this.lifecycle.events.emit("opencode:log_error", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    void work.finally(() => {
      if (this.#sessionPumps.get(sessionId) === controller) {
        this.#sessionPumps.delete(sessionId);
      }
    });
  }

  #onOpenCodeEvent(raw: {
    type: string;
    data?: Record<string, unknown>;
    created?: number;
  }): void {
    const sessionId = sessionIdOf(raw);
    if (
      raw.type === "session.idle" ||
      raw.type === "session.execution.succeeded" ||
      raw.type === "session.execution.failed" ||
      raw.type === "session.execution.interrupted"
    ) {
      if (sessionId) {
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

  #runtimeClient(): OpenCodeRuntimeClient {
    return {
      listMessages: async (sessionId) => {
        const host = await this.#host();
        return host.message.list({ sessionID: sessionId });
      },
      prompt: async (input) => {
        const host = await this.#host();
        await host.sessions.prompt(input);
      },
      switchAgent: async (input) => {
        const host = await this.#host();
        await host.sessions.switchAgent(input);
      },
      wait: async (sessionId, signal) => {
        const host = await this.#host();
        await host.sessions.wait({ sessionID: sessionId }, { signal });
      },
      interrupt: async (sessionId) => {
        const host = await this.#host();
        await host.sessions.interrupt({ sessionID: sessionId });
      }
    };
  }

  async #openOperation(sessionId: string, operationId: string): Promise<void> {
    await this.#writerFor(sessionId, operationId);
    this.#emit(sessionId, {
      type: "operation_start",
      operationId,
      startedAt: Date.now()
    });
  }

  async #settledResult(
    host: Host,
    sessionId: string,
    operationId: string
  ): Promise<OpenCodeResult | undefined> {
    const response = (await host.message.list({
      sessionID: sessionId
    })) as unknown as ReadonlyArray<{
      info: {
        id: string;
        role: string;
        time?: { completed?: number };
        error?: { type?: string; message?: string };
      };
    }>;
    const index = response.findIndex(
      (entry) => entry.info.id === `msg_${operationId}`
    );
    if (index < 0) return undefined;
    const nextUser = response.findIndex(
      (entry, entryIndex) => entryIndex > index && entry.info.role === "user"
    );
    const boundary = nextUser < 0 ? response.length : nextUser;
    const reply = response
      .slice(index + 1, boundary)
      .find((entry) => entry.info.role === "assistant");
    if (!reply?.info.time?.completed) return undefined;
    const error = reply.info.error;
    return {
      operationId,
      status: error ? "failed" : "completed",
      messageId: reply.info.id,
      error: error
        ? {
            code: error.type ?? "error",
            message: error.message ?? "OpenCode execution failed"
          }
        : undefined
    };
  }

  async #settle(sessionId: string, result: OpenCodeResult): Promise<void> {
    const writer = await this.#writerFor(sessionId, result.operationId);
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
