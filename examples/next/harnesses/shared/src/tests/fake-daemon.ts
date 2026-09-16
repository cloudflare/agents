/**
 * A `HarnessDaemonApi` implementation that runs inside the test Durable
 * Object instead of a container: the same wire, no Docker.
 *
 * `FakeDaemonState` is the container: it outlives the RPC session (a
 * reconnect makes a new `FakeDaemon` over the same state) and it outlives a
 * Durable Object eviction, because the test worker keeps it in a
 * module-level registry. `FakeDaemon` is the per-socket Cap'n Web root.
 *
 * The engine is an echo: a prompt becomes `begin`, an assistant message and
 * `settle`; a prompt starting with `ask` parks on a permission request until
 * a `reply` row arrives; `slow` parks until the test says `finish()`; `tool`
 * runs one tool; `bulk` writes a transcript too big for one restore chunk.
 *
 * It also keeps an engine session, exactly as a real engine does: an id it
 * announces on the wire, a transcript mirror it emits as `engine_log` frames,
 * and a resume that only succeeds when a restore handed the transcript back.
 */
import { RpcTarget } from "capnweb";
import {
  HARNESS_PROTOCOL_VERSION,
  type HarnessConfigureRequest,
  type HarnessDaemonApi,
  type HarnessDeliverRow,
  type HarnessHelloRequest,
  type HarnessHelloResponse,
  type HarnessWireBatch,
  type HarnessWireControl,
  type HarnessWireErrorCode,
  type HarnessWireFrame
} from "../protocol";
import type {
  HarnessEventBody,
  HarnessInput,
  HarnessPromptPayload,
  HarnessReplyPayload
} from "../types";

/** The vocabulary the wire-side echo engine adds to the core. */
export type EchoWireProtocol = {
  event: { type: "echo_permission"; decision: string };
  submit: { kind: "note"; payload: { text: string } };
  result: { echoed: string };
};

type Frame = HarnessWireFrame<EchoWireProtocol>;
type Batch = HarnessWireBatch<EchoWireProtocol>;
type Body =
  | HarnessEventBody<EchoWireProtocol>
  | HarnessWireControl<EchoWireProtocol>;

/** One entry of the engine's own transcript mirror, shaped like the SDK's. */
type Entry = {
  readonly type: string;
  readonly uuid: string;
  readonly text: string;
};

type Subscriber = {
  readonly controller: ReadableStreamDefaultController<Batch>;
  readonly fromSeq: number;
  readonly previews: boolean;
  closed: boolean;
};

/** One `configure()` the daemon was given, as the test reads it back. */
export type FakeConfigureRecord = {
  readonly chunks: readonly {
    readonly engineSessionId: string;
    readonly subpath: string | null;
    readonly uuids: readonly string[];
    readonly chunk: number;
    readonly chunks: number;
  }[];
  readonly resume: string | null;
};

/** What a test asserts about the daemon's side of the wire. */
export type FakeDaemonStats = {
  readonly delivered: number;
  readonly alreadyApplied: number;
  readonly fenced: number;
  readonly superseded: number;
  readonly subscribes: number;
  readonly helloCount: number;
  readonly acked: number;
  /** The engine session as the daemon holds it now. */
  readonly engineSessionId: string | null;
  readonly resumed: boolean;
  /** Every `configure()` since the generation started, in order. */
  readonly configures: readonly FakeConfigureRecord[];
  /** The restored transcript, by subpath ("" is the main one), in arrival order. */
  readonly restored: readonly {
    readonly subpath: string;
    readonly uuids: readonly string[];
  }[];
  readonly shutdownReason: string | null;
};

/** The uuid an engine entry carries, or "" for one that carries none. */
function uuidOf(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) return "";
  const uuid = (entry as { readonly uuid?: unknown }).uuid;
  return typeof uuid === "string" ? uuid : "";
}

function textOf(input: HarnessInput): string {
  return typeof input === "string" ? input : (input.text ?? "");
}

/**
 * One container generation's durable state, plus the knobs a test uses to
 * break it: `drop()` kills the socket, `crash()` replaces the generation,
 * `truncate()` prunes the outbox.
 */
export class FakeDaemonState {
  runtimeId = `rt-${crypto.randomUUID()}`;
  secret: string | undefined;
  priorExit: { readonly code: number | null; readonly reason: string } | null =
    null;

  #frames: Frame[] = [];
  #nextSeq = 0;
  #floorSeq = 1;
  #subscriber: Subscriber | undefined;
  readonly #applied = new Map<string, number>();
  readonly #openRequests = new Map<
    string,
    { readonly operationId: string; readonly text: string }
  >();
  /** Turns that emitted `begin` and are waiting for the test or a reply. */
  readonly #parked = new Map<string, string>();
  readonly #sockets = new Set<WebSocket>();
  /** Container generations, so each one's engine session has its own id. */
  #generation = 0;
  #engineSessionId: string | undefined;
  #resumed = false;
  /** Test knob: take the transcript and start fresh anyway. Survives a crash. */
  #refuseResume = false;
  /** True once the engine session was announced on this generation's wire. */
  #announced = false;
  #turns = 0;
  readonly #configures: FakeConfigureRecord[] = [];
  readonly #restored: { subpath: string; uuids: string[] }[] = [];
  /** The last turn's mirror, so a test can make the engine re-send it. */
  #lastMirror: readonly { subpath: string | null; entries: Entry[] }[] = [];
  #stats = {
    delivered: 0,
    alreadyApplied: 0,
    fenced: 0,
    superseded: 0,
    subscribes: 0,
    helloCount: 0,
    acked: 0
  };
  #shutdownReason: string | null = null;

  // ── The test's knobs ───────────────────────────────────────────────────

  stats(): FakeDaemonStats {
    return {
      ...this.#stats,
      engineSessionId: this.#engineSessionId ?? null,
      resumed: this.#resumed,
      configures: [...this.#configures],
      restored: this.#restored.map((entry) => ({
        subpath: entry.subpath,
        uuids: [...entry.uuids]
      })),
      shutdownReason: this.#shutdownReason
    };
  }

  /** Remember a socket so `drop()` and `crash()` can cut it. */
  hold(socket: WebSocket): void {
    this.#sockets.add(socket);
    socket.addEventListener("close", () => this.#sockets.delete(socket), {
      once: true
    });
  }

  /** The socket dies; both sides stay alive and the outbox keeps filling. */
  drop(): void {
    this.#closeSubscriber();
    for (const socket of [...this.#sockets]) {
      this.#sockets.delete(socket);
      try {
        socket.close(1006, "dropped");
      } catch {
        // Already closed.
      }
    }
  }

  /** A new container: a new generation id and an empty outbox. */
  crash(reason = "crashed", code: number | null = null): void {
    this.priorExit = { code, reason };
    this.runtimeId = `rt-${crypto.randomUUID()}`;
    this.#frames = [];
    this.#nextSeq = 0;
    this.#floorSeq = 1;
    this.#applied.clear();
    this.#openRequests.clear();
    this.#parked.clear();
    // The container's disk went with it: no engine session until a restore
    // hands the transcript back, or a fresh turn mints a new one.
    this.#generation += 1;
    this.#engineSessionId = undefined;
    this.#resumed = false;
    this.#announced = false;
    this.#configures.length = 0;
    this.#restored.length = 0;
    this.#lastMirror = [];
    this.drop();
  }

  /**
   * Mirror the last turn's entries again, as an engine does when the SDK
   * retries a batch whose `append()` it could not confirm.
   */
  remirror(): void {
    for (const batch of this.#lastMirror) {
      this.#emit(null, {
        type: "engine_log",
        engineSessionId: this.#engineSession(),
        subpath: batch.subpath,
        entries: batch.entries
      });
    }
  }

  /**
   * From now on the engine keeps the transcript it is handed but starts a
   * fresh conversation anyway, as one whose resume target it cannot honour
   * would. The knob outlives `crash()`, because a test sets it first.
   */
  refuseResume(): void {
    this.#refuseResume = true;
  }

  /** Prune the outbox below `throughSeq`, as a disk-bounded daemon would. */
  truncate(throughSeq: number): void {
    this.#frames = this.#frames.filter((frame) => frame.seq > throughSeq);
    this.#floorSeq = throughSeq + 1;
  }

  /**
   * Pretend a row was delivered and applied before this Durable Object ever
   * attached, so its redelivery answers `E_ALREADY_APPLIED`.
   */
  preapply(key: string, operationId: string, text: string): void {
    this.#applied.set(key, this.#nextSeq);
    this.#prompt(operationId, text, "queue");
  }

  /** Finish a turn parked by a `slow` prompt. */
  finish(operationId: string): void {
    const text = this.#parked.get(operationId);
    if (text === undefined) return;
    this.#parked.delete(operationId);
    this.#complete(operationId, text);
  }

  // ── The wire ───────────────────────────────────────────────────────────

  hello(request: HarnessHelloRequest): HarnessHelloResponse {
    this.#stats.helloCount += 1;
    if (request.protocol !== HARNESS_PROTOCOL_VERSION) {
      throw new Error("E_PROTOCOL");
    }
    if (this.secret !== undefined && request.secret !== this.secret) {
      throw new Error("E_UNAUTHORIZED");
    }
    return {
      runtimeId: this.runtimeId,
      engineId: "echo",
      engineVersion: "1.0.0",
      daemonVersion: "0.0.0-test",
      capabilities: ["requests"],
      highWaterSeq: this.#nextSeq,
      floorSeq: this.#floorSeq,
      openRequestIds: [...this.#openRequests.keys()],
      appliedKeys: [...this.#applied.keys()],
      engineSession:
        this.#engineSessionId === undefined
          ? null
          : { id: this.#engineSessionId, resumed: this.#resumed },
      priorExit: this.priorExit,
      activeOperationId: [...this.#parked.keys()][0] ?? null
    };
  }

  subscribe(request: {
    readonly runtimeId: string;
    readonly fromSeq: number;
    readonly previews: boolean;
    readonly maxBatchFrames?: number;
  }): ReadableStream<Batch> {
    if (request.runtimeId !== this.runtimeId) {
      this.#stats.fenced += 1;
      throw new Error("E_RUNTIME_FENCED");
    }
    this.#stats.subscribes += 1;
    // One live subscriber: a second closes the first.
    if (this.#subscriber) {
      this.#stats.superseded += 1;
      this.#closeSubscriber("E_SUPERSEDED");
    }
    const limit = Math.max(1, request.maxBatchFrames ?? 64);
    return new ReadableStream<Batch>({
      start: (controller) => {
        this.#subscriber = {
          controller,
          fromSeq: request.fromSeq,
          previews: request.previews,
          closed: false
        };
        const backlog = this.#frames.filter(
          (frame) => frame.seq > request.fromSeq
        );
        for (let at = 0; at < backlog.length; at += limit) {
          controller.enqueue(this.#batch(backlog.slice(at, at + limit)));
        }
      },
      cancel: () => {
        this.#subscriber = undefined;
      }
    });
  }

  deliver(request: {
    readonly runtimeId: string;
    readonly row: HarnessDeliverRow;
  }): {
    readonly accepted: boolean;
    readonly seq: number;
    readonly code?: HarnessWireErrorCode;
  } {
    if (request.runtimeId !== this.runtimeId) {
      this.#stats.fenced += 1;
      return {
        accepted: false,
        seq: this.#nextSeq,
        code: "E_RUNTIME_FENCED"
      };
    }
    const row = request.row;
    if (this.#applied.has(row.key)) {
      this.#stats.alreadyApplied += 1;
      return {
        accepted: false,
        seq: this.#nextSeq,
        code: "E_ALREADY_APPLIED"
      };
    }
    // The applied key is recorded with the work, exactly once.
    this.#applied.set(row.key, this.#nextSeq);
    this.#stats.delivered += 1;
    this.#apply(row);
    return { accepted: true, seq: this.#nextSeq };
  }

  ack(seq: number): void {
    this.#stats.acked = Math.max(this.#stats.acked, seq);
  }

  configure(request: HarnessConfigureRequest): void {
    const chunks = request.engineLog ?? [];
    this.#configures.push({
      chunks: chunks.map((chunk) => ({
        engineSessionId: chunk.engineSessionId,
        subpath: chunk.subpath,
        uuids: chunk.entries.map(uuidOf),
        chunk: chunk.chunk,
        chunks: chunk.chunks
      })),
      resume: request.resume?.engineSessionId ?? null
    });
    for (const chunk of chunks) {
      const subpath = chunk.subpath ?? "";
      const held = this.#restored.find((entry) => entry.subpath === subpath);
      const target = held ?? { subpath, uuids: [] };
      if (!held) this.#restored.push(target);
      target.uuids.push(...chunk.entries.map(uuidOf));
    }
    const resume = request.resume;
    if (resume === undefined) return;
    // Resume only succeeds on a transcript we were actually given.
    const held = this.#restored.some((entry) => entry.uuids.length > 0);
    this.#engineSessionId = resume.engineSessionId;
    this.#resumed = held && !this.#refuseResume;
    this.#announced = false;
  }

  probe(): {
    readonly runtimeId: string;
    readonly highWaterSeq: number;
    readonly floorSeq: number;
    readonly outboxBytes: number;
    readonly openRequests: number;
    readonly busy: boolean;
  } {
    return {
      runtimeId: this.runtimeId,
      highWaterSeq: this.#nextSeq,
      floorSeq: this.#floorSeq,
      outboxBytes: JSON.stringify(this.#frames).length,
      openRequests: this.#openRequests.size,
      busy: this.#parked.size > 0
    };
  }

  shutdown(reason: string): void {
    this.#shutdownReason = reason;
    this.#closeSubscriber();
  }

  // ── The echo engine ────────────────────────────────────────────────────

  #apply(row: HarnessDeliverRow): void {
    this.#announce();
    switch (row.kind) {
      case "prompt": {
        if (row.operationId === null) return;
        const payload = row.payload as unknown as HarnessPromptPayload;
        this.#prompt(row.operationId, textOf(payload.input), payload.delivery);
        return;
      }
      case "reply": {
        const payload = row.payload as unknown as HarnessReplyPayload;
        const open = this.#openRequests.get(payload.requestId);
        if (!open) return;
        this.#openRequests.delete(payload.requestId);
        this.#emit(open.operationId, {
          type: "request_close",
          requestId: payload.requestId,
          by: payload.by === "client" ? "answered" : payload.by,
          reply: payload.reply
        });
        this.#parked.delete(open.operationId);
        this.#complete(
          open.operationId,
          open.text,
          payload.reply.type === "permission" ? payload.reply.decision : "n/a"
        );
        return;
      }
      case "interrupt": {
        if (row.operationId === null) return;
        this.#parked.delete(row.operationId);
        for (const [requestId, open] of [...this.#openRequests]) {
          if (open.operationId === row.operationId) {
            this.#openRequests.delete(requestId);
          }
        }
        this.#emit(row.operationId, {
          type: "settle",
          operationId: row.operationId,
          settlement: {
            status: "aborted",
            stopReason: { type: "interrupted" },
            raw: { echoed: "(interrupted)" }
          }
        });
        return;
      }
      default: {
        // Any other kind (a `compact` or a runtime submission) is one turn.
        if (row.operationId === null) return;
        this.#emit(row.operationId, {
          type: "begin",
          operationId: row.operationId,
          delivery: "queue"
        });
        this.#complete(row.operationId, row.kind);
      }
    }
  }

  #prompt(
    operationId: string,
    text: string,
    delivery: "queue" | "steer"
  ): void {
    this.#announce();
    this.#emit(operationId, { type: "begin", operationId, delivery });
    if (text.startsWith("ask")) {
      const requestId = `perm:${operationId}`;
      this.#openRequests.set(requestId, { operationId, text });
      this.#parked.set(operationId, text);
      this.#emit(operationId, {
        type: "request_open",
        request: {
          requestId,
          operationId,
          type: "permission",
          action: "Bash",
          resources: [text]
        }
      });
      return;
    }
    if (text.startsWith("slow")) {
      this.#parked.set(operationId, text);
      return;
    }
    this.#complete(operationId, text);
  }

  /** The assistant turn: a message, the engine's own log line, a settlement. */
  #complete(operationId: string, text: string, decision?: string): void {
    const messageId = `assistant:${operationId}`;
    const echoed = `echo: ${text}`;
    this.#emit(operationId, {
      type: "message_start",
      messageId,
      role: "assistant"
    });
    if (decision !== undefined) {
      this.#emit(operationId, {
        type: "extension",
        body: { type: "echo_permission", decision }
      });
    }
    if (text.startsWith("tool")) {
      const toolCallId = `call:${operationId}`;
      this.#emit(operationId, {
        type: "tool_start",
        toolCallId,
        toolName: "echo_tool",
        input: { text }
      });
      this.#emit(operationId, {
        type: "tool_end",
        toolCallId,
        output: { echoed },
        isError: false
      });
    }
    this.#emit(operationId, {
      type: "message_end",
      messageId,
      role: "assistant",
      parts: [{ type: "text", text: echoed }]
    });
    this.#mirror(text);
    this.#emit(operationId, {
      type: "settle",
      operationId,
      settlement: {
        status: "completed",
        stopReason: { type: "end_turn" },
        raw: { echoed }
      }
    });
  }

  /** This generation's engine session, minted the first time it is needed. */
  #engineSession(): string {
    this.#engineSessionId ??= `echo-session-${this.#generation}`;
    return this.#engineSessionId;
  }

  /** Say the session id on the wire, once per generation. */
  #announce(): void {
    if (this.#announced) return;
    this.#announced = true;
    this.#emit(null, {
      type: "engine_session",
      engineSessionId: this.#engineSession(),
      resumed: this.#resumed
    });
  }

  /**
   * The engine's own transcript for one turn: two entries on the main
   * transcript and one on a subagent's, each with a uuid. A `bulk` turn pads
   * the main entries past the chunk ceiling, so a restore has to split.
   */
  #mirror(text: string): void {
    this.#turns += 1;
    const session = this.#engineSession();
    const turn = this.#turns;
    const padding = text.startsWith("bulk") ? "x".repeat(70_000) : "";
    const batches: { subpath: string | null; entries: Entry[] }[] = [
      {
        subpath: null,
        entries: [
          {
            type: "user",
            uuid: `${session}:${turn}:user`,
            text: text + padding
          },
          {
            type: "assistant",
            uuid: `${session}:${turn}:assistant`,
            text: `echo: ${text}${padding}`
          }
        ]
      },
      {
        subpath: "subagents/agent-1",
        entries: [
          {
            type: "assistant",
            uuid: `${session}:${turn}:agent`,
            text: `agent saw ${text}`
          }
        ]
      }
    ];
    this.#lastMirror = batches;
    for (const batch of batches) {
      this.#emit(null, {
        type: "engine_log",
        engineSessionId: session,
        subpath: batch.subpath,
        entries: batch.entries
      });
    }
  }

  #emit(operationId: string | null, body: Body): void {
    this.#nextSeq += 1;
    const frame: Frame = {
      seq: this.#nextSeq,
      operationId,
      at: Date.now(),
      body
    };
    this.#frames.push(frame);
    const subscriber = this.#subscriber;
    if (!subscriber || subscriber.closed) return;
    if (frame.seq <= subscriber.fromSeq) return;
    try {
      subscriber.controller.enqueue(this.#batch([frame]));
    } catch {
      // The consumer went away; the outbox keeps the frame.
    }
  }

  #batch(frames: readonly Frame[]): Batch {
    return {
      frames: [...frames],
      previews: [],
      highWaterSeq: this.#nextSeq,
      floorSeq: this.#floorSeq
    };
  }

  #closeSubscriber(code?: HarnessWireErrorCode): void {
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    if (!subscriber || subscriber.closed) return;
    subscriber.closed = true;
    try {
      if (code === undefined) subscriber.controller.close();
      else subscriber.controller.error(new Error(code));
    } catch {
      // Already closed.
    }
  }
}

/**
 * The Cap'n Web root the Durable Object talks to. One per socket; every
 * method delegates to the generation's state, so a reconnect is a new root
 * over the same outbox.
 */
export class FakeDaemon
  extends RpcTarget
  implements HarnessDaemonApi<EchoWireProtocol>
{
  readonly #state: FakeDaemonState;

  constructor(state: FakeDaemonState) {
    super();
    this.#state = state;
  }

  async hello(request: HarnessHelloRequest): Promise<HarnessHelloResponse> {
    return this.#state.hello(request);
  }

  async subscribe(request: {
    readonly runtimeId: string;
    readonly fromSeq: number;
    readonly previews: boolean;
    readonly maxBatchFrames?: number;
    readonly maxBatchBytes?: number;
  }): Promise<ReadableStream<Batch>> {
    return this.#state.subscribe(request);
  }

  async deliver(request: {
    readonly runtimeId: string;
    readonly row: HarnessDeliverRow;
  }): Promise<{
    readonly accepted: boolean;
    readonly seq: number;
    readonly code?: HarnessWireErrorCode;
  }> {
    return this.#state.deliver(request);
  }

  async ack(request: {
    readonly runtimeId: string;
    readonly seq: number;
  }): Promise<void> {
    this.#state.ack(request.seq);
  }

  async configure(request: HarnessConfigureRequest): Promise<void> {
    this.#state.configure(request);
  }

  async probe(): Promise<{
    readonly runtimeId: string;
    readonly highWaterSeq: number;
    readonly floorSeq: number;
    readonly outboxBytes: number;
    readonly openRequests: number;
    readonly busy: boolean;
  }> {
    return this.#state.probe();
  }

  async shutdown(request: {
    readonly runtimeId: string;
    readonly reason: string;
  }): Promise<void> {
    this.#state.shutdown(request.reason);
  }
}
