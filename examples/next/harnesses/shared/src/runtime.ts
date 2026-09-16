/**
 * The runtime port: what a harness implementation fills in. This module
 * references Workers globals (`DurableObjectStorage`) and `agents/tasks`, so
 * it stays out of `./types`, which a container daemon can import type-only.
 */
import type { SessionMessage } from "agents/sessions";
import type { TaskStep } from "agents/tasks";
import type {
  HarnessCapability,
  HarnessConfig,
  HarnessConfigPatch,
  HarnessEventBody,
  HarnessForkOptions,
  HarnessInboxKind,
  HarnessInboxRow,
  HarnessMessagesOptions,
  HarnessPreviewBody,
  HarnessProtocol,
  HarnessReply,
  HarnessRequest,
  HarnessRequestDraft,
  HarnessRewindOptions,
  HarnessRewindResult,
  HarnessSessionCreateOptions,
  HarnessSettlement,
  HarnessUsage,
  HarnessWireStamp,
  JsonValue
} from "./types";

export type {
  HarnessCompactPayload,
  HarnessInboxKind,
  HarnessInboxRow,
  HarnessInterruptPayload,
  HarnessPromptPayload,
  HarnessReplyPayload,
  HarnessSettlement
} from "./types";

/** What `runtime.messages()` returns. The base stamps `asOf`. */
export type HarnessRuntimeMessagePage = {
  /** Oldest first, `SessionMessage`-shaped (`id` required, `parts` an array). */
  readonly messages: readonly SessionMessage[];
  /** Opaque anchor for the next page, when the runtime pages. */
  readonly cursor?: string;
  /** Ignored: the base overwrites it with the log head. */
  readonly asOf?: string;
};

/**
 * What a harness implementation fills in. The base owns admission, the
 * inbox, operation rows, request rows, the Streams logs, the browser
 * transport and the Tasks driver; the runtime owns the agent loop and the
 * user-visible transcript.
 */
export interface HarnessRuntime<P extends HarnessProtocol = HarnessProtocol> {
  /** Recorded on every operation row. `"in-do:pi"`, `"container:claude-code"`. */
  readonly id: string;
  readonly capabilities: ReadonlySet<HarnessCapability>;

  /**
   * Called inside the session's Tasks run. First resume `ctx.active()`: an
   * operation that was running when the last isolate died has no inbox row
   * any more (`begin()` consumed it) but carries its kind and payload. Then
   * do the work the inbox asks for and return when there is nothing more
   * this runtime can do right now: the inbox is empty, or the runtime is
   * waiting on something it asked to be woken for through `ctx.wake()`.
   * Everything durable goes through `ctx`.
   */
  drive(ctx: HarnessDriveContext<P>): Promise<void>;

  /**
   * The user-visible transcript, oldest first within a byte budget, from
   * wherever the runtime keeps it.
   */
  messages(
    sessionId: string,
    options: HarnessMessagesOptions
  ): Promise<HarnessRuntimeMessagePage>;

  /** Optional. Inside the capability's `onStart`: create tables, push wakes. Must not dial anything. */
  onStart?(ctx: HarnessRuntimeStartContext): Promise<void> | void;
  /** Optional. Release live resources on dispose or a memory-limit strike. */
  dispose?(reason: "dispose" | "memory-limit"): Promise<void> | void;
  /** Optional. No-ops for local runtimes; a container runtime parks / destroys. */
  close?(sessionId: string): Promise<void>;
  delete?(sessionId: string): Promise<void>;
  /** Optional. Called after a session row is created. */
  create?(
    sessionId: string,
    options: HarnessSessionCreateOptions
  ): Promise<void>;
  /** Optional extensions; absence means the capability is not advertised. */
  fork?(sessionId: string, options: HarnessForkOptions): Promise<string>;
  rewind?(
    sessionId: string,
    toMessageId: string,
    options: HarnessRewindOptions
  ): Promise<HarnessRewindResult>;
  configure?(
    sessionId: string,
    patch: HarnessConfigPatch
  ): Promise<HarnessConfig>;
  cancelQueued?(sessionId: string, operationId: string): Promise<boolean>;
  /** Optional. Reported on `status()` when the runtime tracks it. */
  usage?(sessionId: string): Promise<HarnessUsage | undefined>;
}

export type HarnessRuntimeStartContext = {
  readonly storage: DurableObjectStorage;
  /** Push a Lifecycle job that will re-enter `drive()` for this session. */
  wake(sessionId: string, afterMs?: number): void;
};

/** The running operation of a session, with everything a runtime needs to resume it. */
export type HarnessActiveOperation<
  P extends HarnessProtocol = HarnessProtocol
> = {
  readonly operationId: string;
  /** The inbox kind it was admitted with (`prompt`, `compact`, a submit kind, or `adopted`). */
  readonly kind: HarnessInboxKind<P> | "adopted";
  /** The admission payload, or null for an adopted operation. */
  readonly payload: JsonValue | null;
  readonly delivery: "queue" | "steer";
  readonly startedAt: number;
};

export type HarnessDriveContext<P extends HarnessProtocol = HarnessProtocol> = {
  readonly sessionId: string;
  /** Journal for the runtime's own idempotent steps. Names must be unique per run. */
  readonly step: TaskStep;
  /** Fires when the capability is disposed or struck by the memory limit, never on wall time. */
  readonly signal: AbortSignal;

  readonly inbox: {
    /** Unconsumed rows in arrival order, optionally filtered by kind. */
    peek(options?: {
      readonly kinds?: readonly string[];
      readonly limit?: number;
    }): readonly HarnessInboxRow<P>[];
    /** Delete-and-return one row. Null when it was already taken. */
    take(seq: number): HarnessInboxRow<P> | null;
    /**
     * Resolves when the next row is admitted to this session in this
     * isolate (rows already present do not resolve it: peek first). Use it
     * instead of polling while an engine turn is in flight and a steer or
     * reply may arrive; pass a signal to stop waiting when the turn ends.
     */
    wait(signal?: AbortSignal): Promise<void>;
  };
  /**
   * Both replay-safe: re-entry on a known state is a no-op. `begin()`
   * marks the operation running, consumes its admission row, opens its
   * log and appends `operation_started`.
   */
  begin(
    operationId: string,
    options?: { readonly delivery?: "queue" | "steer" }
  ): Promise<HarnessOperationHandle<P>>;
  /**
   * Open an operation the engine started on its own (a queued follow-up,
   * an engine-initiated compaction): inserts the operation row when it is
   * missing, then behaves as `begin()`. One row write.
   */
  adopt(
    operationId: string,
    options: { readonly kind: string; readonly delivery?: "queue" | "steer" }
  ): Promise<HarnessOperationHandle<P>>;
  /** Settle the operation, its log and its requests in one transaction. Await it before the next `begin()`. */
  settle(operationId: string, outcome: HarnessSettlement<P>): Promise<void>;
  /** The handle of an operation this driver already began, if any. */
  operation(operationId: string): HarnessOperationHandle<P> | undefined;
  /** The running operation in this session, if any. Resume it before reading the inbox. */
  active(): HarnessActiveOperation<P> | null;

  /**
   * An `AbortSignal` the base aborts when `interrupt()` targets this
   * operation, in this isolate or through a durable `interrupt` inbox row.
   */
  interrupted(operationId: string): AbortSignal;

  /** Durable question and answer without a live promise across any boundary. */
  readonly requests: {
    open(request: HarnessRequestDraft): HarnessRequest;
    close(
      requestId: string,
      by: "answered" | "timeout" | "lost",
      reply?: HarnessReply
    ): Promise<void>;
    list(operationId?: string): readonly HarnessRequest[];
  };
  /**
   * Sugar: open a request and resolve when its reply arrives in THIS
   * isolate. Rejects with `HarnessDetachedError` if the isolate is
   * disposed first; the request row survives for a durable consumer.
   */
  ask(request: HarnessRequestDraft): Promise<HarnessReply>;

  /**
   * Push a Lifecycle job that re-enters `drive()` later. Never `setInterval`.
   * The earliest of several requested wakes wins; a wake is ignored while
   * the inbox still holds a row the runtime made progress on.
   */
  wake(afterMs?: number): void;
  /** The session-scoped log, for frames that belong to no operation. */
  session(): Promise<HarnessOperationHandle<P>>;
  /** True while at least one browser socket is attached to this session. */
  attached(): boolean;
  /** Report a transient runtime state shown on `status()`; reset on every wake. */
  setRunState(state: "running" | "retrying"): void;
};

export type HarnessFrame<P extends HarnessProtocol = HarnessProtocol> = {
  /** Session-monotonic; stamped by the base at flush. */
  readonly seq: number;
  readonly operationId?: string;
  readonly body: HarnessEventBody<P>;
  /** Set by a remote runtime: the daemon's wire seq and the generation that minted it. */
  readonly wire?: HarnessWireStamp;
};

export type HarnessOperationHandle<
  P extends HarnessProtocol = HarnessProtocol
> = {
  readonly streamId: string;
  readonly operationId: string | undefined;
  /** Batched per policy; the flush is the durable write. */
  append(
    body: HarnessEventBody<P>,
    options?: { readonly wire?: HarnessWireStamp }
  ): void;
  /** Browser-only. Never persisted, never replayed. Dropped when nobody is attached. */
  preview(preview: HarnessPreviewBody): void;
  /**
   * Write buffered frames now. `commit` runs synchronously inside the same
   * transaction as the append, so a runtime can make its own cursor durable
   * with the frames it counts. It must not await and must not append.
   */
  flush(options?: { readonly commit?: () => void }): void;
  /** True once the operation settled. */
  readonly closed: boolean;
};

// ── The capability's options ──────────────────────────────────────────────

export type HarnessPolicy = {
  /**
   * Stream append batching. Default 100 ms / 64 frames / 256 KiB. `bytes`
   * must stay below Streams' 1 MiB chunk ceiling.
   */
  readonly batch?: {
    readonly ms?: number;
    readonly frames?: number;
    readonly bytes?: number;
  };
  /** Max unconsumed inbox rows per session before `prompt()` throws. Default 1000. */
  readonly inboxLimit?: number;
  /** Open requests are settled as timed out after this. Default 600_000. */
  readonly requestTimeoutMs?: number;
  /** Driver runs rotate after this many drive passes. Default 4000. */
  readonly rotateAfterPasses?: number;
  /** Consecutive failing passes on the same head row before it is declined. Default 5. */
  readonly maxPassFailures?: number;
};
