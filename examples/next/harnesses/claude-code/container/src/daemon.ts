/**
 * `DaemonRoot`: the one Cap'n Web capability the container exports. The
 * Durable Object dials `/rpc`, gets this object, and drives the engine
 * through it; nothing is exported the other way, so a Worker eviction
 * cannot leave a dangling stub inside the container.
 *
 * Everything here is fenced on `runtimeId`, the id of this container
 * generation. A second Durable Object incarnation, or a stale one the
 * platform has demoted, gets `E_RUNTIME_FENCED` rather than a silent double
 * drive. Frames are durable before they are announced, `deliver()` is
 * idempotent on the row key, and the frame stream has exactly one live
 * subscriber: a second `subscribe()` errors the first.
 */
import { timingSafeEqual } from "node:crypto";
import { RpcTarget } from "capnweb";
import {
  HARNESS_MAX_BATCH_BYTES,
  HARNESS_MAX_BATCH_FRAMES,
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
} from "../../../shared/src/protocol.ts";
import type {
  HarnessEventBody,
  HarnessInput,
  HarnessPreviewBody,
  HarnessPromptPayload,
  HarnessReply,
  HarnessReplyPayload,
  HarnessRequestDraft,
  JsonValue
} from "../../../shared/src/types.ts";
import type { Engine, EngineContext } from "./engine.ts";
import { RequestRegistry } from "./engine.ts";
import type { Doorbell } from "./doorbell.ts";
import type { Outbox, OutboxFrame } from "./outbox.ts";

/** How many applied keys `hello()` reports, newest last. */
const APPLIED_KEYS_LIMIT = 1000;
/** How often expired requests are auto-denied. */
const SWEEP_INTERVAL_MS = 5_000;

/** An error carrying one of the wire's own codes. */
export class WireError extends Error {
  constructor(
    readonly code: HarnessWireErrorCode,
    message: string
  ) {
    // The code rides the message and the name because a Cap'n Web error
    // reaches the other side as a plain `Error`.
    super(`${code}: ${message}`);
    this.name = code;
  }
}

type PendingPreview = {
  readonly operationId: string | null;
  readonly body: HarnessPreviewBody;
};

/**
 * One live frame stream. Replay and tail are the same code path: every frame
 * is in the outbox before it is announced, so the subscription only ever
 * drains forward from its cursor.
 */
class Subscription {
  readonly stream: ReadableStream<HarnessWireBatch>;
  previews: boolean;
  #controller: ReadableStreamDefaultController<HarnessWireBatch> | undefined;
  #cursor: number;
  #pending: PendingPreview[] = [];
  #closed = false;

  constructor(
    private readonly outbox: Outbox,
    fromSeq: number,
    previews: boolean,
    private readonly maxFrames: number,
    private readonly maxBytes: number
  ) {
    this.#cursor = fromSeq;
    this.previews = previews;
    this.stream = new ReadableStream<HarnessWireBatch>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => {
          this.#drain();
        },
        cancel: () => {
          this.#closed = true;
        }
      },
      { highWaterMark: 1 }
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** New frames, or a flipped previews flag, are waiting. */
  wake(): void {
    this.#drain();
  }

  pushPreview(preview: PendingPreview): void {
    if (!this.previews || this.#closed) return;
    this.#pending.push(preview);
    this.#drain();
  }

  close(error?: WireError): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (error) this.#controller?.error(error);
      else this.#controller?.close();
    } catch {
      // Already closed by the reader.
    }
  }

  #drain(): void {
    const controller = this.#controller;
    if (this.#closed || controller === undefined) return;
    while ((controller.desiredSize ?? 1) > 0) {
      const frames = this.outbox.replay(
        this.#cursor,
        this.maxFrames,
        this.maxBytes
      );
      const previews = this.#pending;
      if (frames.length === 0 && previews.length === 0) return;
      this.#pending = [];
      const last = frames.at(-1);
      if (last) this.#cursor = last.seq;
      controller.enqueue({
        frames: frames.map(toWireFrame),
        previews,
        highWaterSeq: this.outbox.highWaterSeq,
        floorSeq: this.outbox.floorSeq
      });
      // Previews alone cannot refill the queue, so stop rather than spin.
      if (frames.length === 0) return;
    }
  }
}

function toWireFrame(frame: OutboxFrame): HarnessWireFrame {
  return {
    seq: frame.seq,
    operationId: frame.operationId,
    at: frame.at,
    // SAFETY: only the daemon writes frames, and it only writes these bodies.
    body: frame.body as unknown as HarnessEventBody | HarnessWireControl
  };
}

export type DaemonOptions = {
  readonly sessionId: string;
  readonly secret: string;
  readonly runtimeId: string;
  readonly daemonVersion: string;
  readonly engine: Engine;
  readonly outbox: Outbox;
  readonly doorbell: Doorbell;
  readonly priorExit: {
    readonly code: number | null;
    readonly reason: string;
  } | null;
  readonly log: (...args: readonly unknown[]) => void;
  /** Called once `shutdown()` has replied. The process exits from here. */
  readonly onShutdown: (reason: string) => void;
};

export class DaemonRoot extends RpcTarget implements HarnessDaemonApi {
  readonly #options: DaemonOptions;
  readonly #requests: RequestRegistry;
  readonly #sweep: NodeJS.Timeout;
  #subscription: Subscription | undefined;
  #previews = true;
  #pending: { operationId: string | null; body: JsonValue }[] = [];
  #flushScheduled = false;
  #started = false;

  constructor(options: DaemonOptions) {
    super();
    this.#options = options;
    this.#requests = new RequestRegistry({
      onOpen: (draft, expiresAt) => {
        this.#options.outbox.openRequest({
          requestId: draft.requestId,
          operationId: draft.operationId ?? null,
          payload: draft as unknown as JsonValue,
          expiresAt
        });
        this.#emit(draft.operationId ?? null, {
          type: "request_open",
          request: { ...draft, expiresAt }
        });
      },
      onClose: (requestId, by, reply) => {
        this.#options.outbox.closeRequest(requestId);
        this.#emit(null, {
          type: "request_close",
          requestId,
          by,
          ...(reply === undefined ? {} : { reply })
        });
      }
    });
    this.#sweep = setInterval(() => {
      this.#requests.sweep(Date.now());
    }, SWEEP_INTERVAL_MS);
    this.#sweep.unref?.();
  }

  /** The context the engine drives the outside world through. */
  engineContext(): EngineContext {
    return {
      emit: (operationId, body) => {
        this.#emit(operationId, body);
      },
      preview: (operationId, body) => {
        this.#preview(operationId, body);
      },
      openRequest: (draft) => this.#requests.open(draft),
      log: (...args) => {
        this.#options.log(...args);
      }
    };
  }

  /** Re-park the requests a previous generation left open in the outbox. */
  restoreOpenRequests(): void {
    for (const request of this.#options.outbox.openRequests()) {
      void this.#requests.open({
        ...(request.payload as unknown as HarnessRequestDraft),
        expiresAt: request.expiresAt
      });
    }
  }

  async hello(req: HarnessHelloRequest): Promise<HarnessHelloResponse> {
    if (req.protocol !== HARNESS_PROTOCOL_VERSION) {
      throw new WireError(
        "E_PROTOCOL",
        `This daemon speaks protocol ${HARNESS_PROTOCOL_VERSION}, not ${req.protocol}`
      );
    }
    if (!this.#secretMatches(req.secret)) {
      throw new WireError("E_UNAUTHORIZED", "Bad harness secret");
    }
    if (req.sessionId !== this.#options.sessionId) {
      throw new WireError(
        "E_PROTOCOL",
        `This daemon serves session ${JSON.stringify(this.#options.sessionId)}`
      );
    }
    this.#started = true;
    const { engine, outbox } = this.#options;
    return {
      runtimeId: this.#options.runtimeId,
      engineId: engine.id,
      engineVersion: engine.version,
      daemonVersion: this.#options.daemonVersion,
      capabilities: engine.capabilities,
      highWaterSeq: outbox.highWaterSeq,
      floorSeq: outbox.floorSeq,
      openRequestIds: this.#requests.openIds(),
      appliedKeys: outbox.appliedKeys(APPLIED_KEYS_LIMIT),
      engineSession: engine.engineSession,
      priorExit: this.#options.priorExit,
      activeOperationId: engine.activeOperationId
    };
  }

  async subscribe(req: {
    readonly runtimeId: string;
    readonly fromSeq: number;
    readonly previews: boolean;
    readonly maxBatchFrames?: number;
    readonly maxBatchBytes?: number;
  }): Promise<ReadableStream<HarnessWireBatch>> {
    this.#fence(req.runtimeId);
    this.#subscription?.close(
      new WireError("E_SUPERSEDED", "A newer subscriber took the stream")
    );
    const subscription = new Subscription(
      this.#options.outbox,
      req.fromSeq,
      req.previews && this.#previews,
      req.maxBatchFrames ?? HARNESS_MAX_BATCH_FRAMES,
      req.maxBatchBytes ?? HARNESS_MAX_BATCH_BYTES
    );
    this.#subscription = subscription;
    return subscription.stream;
  }

  async deliver(req: {
    readonly runtimeId: string;
    readonly row: HarnessDeliverRow;
  }): Promise<{
    readonly accepted: boolean;
    readonly seq: number;
    readonly code?: HarnessWireErrorCode;
  }> {
    this.#fence(req.runtimeId);
    const { outbox } = this.#options;
    if (!outbox.markApplied(req.row.key, req.row.seq)) {
      return {
        accepted: false,
        seq: outbox.highWaterSeq,
        code: "E_ALREADY_APPLIED"
      };
    }
    let code: HarnessWireErrorCode | undefined;
    try {
      code = await this.#route(req.row);
    } catch (error) {
      // The row was never applied, so let the Durable Object redeliver it.
      outbox.unmarkApplied(req.row.key);
      throw error;
    }
    return {
      accepted: code === undefined,
      seq: outbox.highWaterSeq,
      ...(code === undefined ? {} : { code })
    };
  }

  async ack(req: {
    readonly runtimeId: string;
    readonly seq: number;
  }): Promise<void> {
    this.#fence(req.runtimeId);
    this.#options.outbox.prune(req.seq);
  }

  async configure(req: HarnessConfigureRequest): Promise<void> {
    this.#fence(req.runtimeId);
    if (req.previews !== undefined) {
      this.#previews = req.previews;
      if (this.#subscription) this.#subscription.previews = req.previews;
    }
    for (const deadline of req.requestDeadlines ?? []) {
      this.#requests.setDeadline(deadline.requestId, deadline.expiresAt);
      this.#options.outbox.setRequestDeadline(
        deadline.requestId,
        deadline.expiresAt
      );
    }
    // A malformed restore is refused rather than half-applied: resuming a
    // conversation from a transcript with a hole in it is worse than
    // starting a fresh one, and `E_PROTOCOL` tells the Durable Object at
    // once rather than one turn later.
    if (req.engineLog !== undefined && !isEngineLog(req.engineLog)) {
      throw new WireError("E_PROTOCOL", "Malformed engineLog chunk");
    }
    if (req.resume !== undefined && !isResume(req.resume)) {
      throw new WireError("E_PROTOCOL", "Malformed resume");
    }
    const patch = {
      ...(req.remainingBudgetUsd === undefined
        ? {}
        : { remainingBudgetUsd: req.remainingBudgetUsd }),
      ...(req.engineOptions === undefined
        ? {}
        : { engineOptions: req.engineOptions }),
      ...(req.engineLog === undefined ? {} : { engineLog: req.engineLog }),
      ...(req.resume === undefined ? {} : { resume: req.resume })
    };
    // Always forwarded, even empty: an engine that waits for its transcript
    // before the first turn learns from this call that the runtime has said
    // everything it is going to say.
    await this.#options.engine.configure?.(patch);
  }

  async probe(): Promise<{
    readonly runtimeId: string;
    readonly highWaterSeq: number;
    readonly floorSeq: number;
    readonly outboxBytes: number;
    readonly openRequests: number;
    readonly busy: boolean;
    readonly engine?: JsonValue;
  }> {
    const { outbox, engine } = this.#options;
    const diagnostics = engine.diagnostics?.();
    return {
      runtimeId: this.#options.runtimeId,
      highWaterSeq: outbox.highWaterSeq,
      floorSeq: outbox.floorSeq,
      outboxBytes: outbox.bytes,
      openRequests: this.#requests.size,
      ...(diagnostics === undefined ? {} : { engine: diagnostics }),
      busy: engine.activeOperationId !== null
    };
  }

  async shutdown(req: {
    readonly runtimeId: string;
    readonly reason: string;
  }): Promise<void> {
    this.#fence(req.runtimeId);
    await this.dispose(req.reason);
    this.#options.onShutdown(req.reason);
  }

  /** Stop the engine, flush, and let go of every live resource. */
  async dispose(reason: string): Promise<void> {
    clearInterval(this.#sweep);
    await this.#options.engine.shutdown();
    this.#requests.drain(`Daemon is shutting down: ${reason}`);
    this.#flush();
    this.#options.doorbell.close();
    this.#subscription?.close();
  }

  /** True once a Durable Object has said hello on this generation. */
  get started(): boolean {
    return this.#started;
  }

  async #route(
    row: HarnessDeliverRow
  ): Promise<HarnessWireErrorCode | undefined> {
    const { engine } = this.#options;
    switch (row.kind) {
      case "prompt": {
        if (row.operationId === null) return "E_PROTOCOL";
        const payload = row.payload as unknown as HarnessPromptPayload;
        await engine.prompt(
          row.operationId,
          payload.input as HarnessInput,
          payload.delivery ?? "queue"
        );
        return undefined;
      }
      case "interrupt": {
        const payload = row.payload as unknown as {
          readonly operationId: string;
        };
        await engine.interrupt(payload.operationId ?? row.operationId ?? "");
        return undefined;
      }
      case "reply": {
        const payload = row.payload as unknown as HarnessReplyPayload;
        const settled = this.#requests.settle(
          payload.requestId,
          payload.reply as HarnessReply,
          payload.by ?? "client"
        );
        await engine.reply?.(payload.requestId, payload.reply, payload.by);
        // The request is gone for good, so the row stays applied: a
        // redelivery would answer nothing either.
        return settled ? undefined : "E_UNKNOWN_REQUEST";
      }
      case "compact": {
        if (engine.compact === undefined) return "E_PROTOCOL";
        if (row.operationId === null) return "E_PROTOCOL";
        const payload = row.payload as unknown as {
          readonly instructions?: string;
        };
        await engine.compact(row.operationId, {
          ...(payload?.instructions === undefined
            ? {}
            : { instructions: payload.instructions })
        });
        return undefined;
      }
      default: {
        if (engine.submit === undefined) return "E_PROTOCOL";
        await engine.submit(row.kind, row.payload, row.operationId);
        return undefined;
      }
    }
  }

  #emit(
    operationId: string | null,
    body: HarnessEventBody | HarnessWireControl
  ): void {
    this.#pending.push({
      operationId,
      body: body as unknown as JsonValue
    });
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    // node:sqlite is synchronous, so one commit per drain rather than one
    // per frame: a streaming turn appends in bursts.
    queueMicrotask(() => {
      this.#flush();
    });
  }

  #flush(): void {
    this.#flushScheduled = false;
    if (this.#pending.length === 0) return;
    const entries = this.#pending;
    this.#pending = [];
    const appended = this.#options.outbox.append(entries);
    if (appended.length === 0) return;
    if (this.#subscription && !this.#subscription.closed) {
      this.#subscription.wake();
      return;
    }
    // Nobody is listening: ring the doorbell so the Durable Object wakes up
    // and re-subscribes from its own cursor.
    this.#options.doorbell.ring(
      this.#options.runtimeId,
      this.#options.outbox.highWaterSeq,
      "frames"
    );
  }

  #preview(operationId: string | null, body: HarnessPreviewBody): void {
    if (!this.#previews) return;
    // Frames buffered before this preview must reach the wire first.
    this.#flush();
    this.#subscription?.pushPreview({ operationId, body });
  }

  #fence(runtimeId: string): void {
    if (runtimeId !== this.#options.runtimeId) {
      throw new WireError(
        "E_RUNTIME_FENCED",
        `This container generation is ${this.#options.runtimeId}`
      );
    }
  }

  #secretMatches(candidate: string): boolean {
    const expected = Buffer.from(this.#options.secret);
    const given = Buffer.from(candidate);
    if (expected.length !== given.length) return false;
    return timingSafeEqual(expected, given);
  }
}

/**
 * A restore chunk has to be exactly what the mirror emitted: an ordered
 * slice of one transcript, with the entries still objects. Anything else is
 * a wire bug, not data we can quietly keep.
 */
function isEngineLog(chunks: unknown): boolean {
  if (!Array.isArray(chunks)) return false;
  return chunks.every((value: unknown) => {
    const chunk = asRecord(value);
    if (chunk === undefined) return false;
    if (typeof chunk.engineSessionId !== "string") return false;
    if (chunk.engineSessionId === "") return false;
    if (chunk.subpath !== null && typeof chunk.subpath !== "string") {
      return false;
    }
    if (!Number.isInteger(chunk.chunks) || (chunk.chunks as number) < 1) {
      return false;
    }
    if (!Number.isInteger(chunk.chunk) || (chunk.chunk as number) < 0) {
      return false;
    }
    if ((chunk.chunk as number) >= (chunk.chunks as number)) return false;
    if (!Array.isArray(chunk.entries)) return false;
    return chunk.entries.every(
      (entry: unknown) => asRecord(entry) !== undefined
    );
  });
}

function isResume(resume: unknown): boolean {
  const record = asRecord(resume);
  return (
    record !== undefined &&
    typeof record.engineSessionId === "string" &&
    record.engineSessionId !== ""
  );
}

/** A plain JSON object, or undefined for anything else. */
function asRecord(
  value: unknown
): { readonly [key: string]: unknown } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as { readonly [key: string]: unknown };
}
