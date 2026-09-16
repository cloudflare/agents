/**
 * Wire contracts. This module has no runtime imports and no dependency on
 * `agents`, so the browser bundle and a container daemon can both import it.
 *
 * Two wires live here: the browser link a `WebSockets` capability serves,
 * and the Cap'n Web daemon link a remote runtime dials.
 */
import type {
  HarnessCapability,
  HarnessEvent,
  HarnessEventBody,
  HarnessMessagePage,
  HarnessPreview,
  HarnessPreviewBody,
  HarnessProtocol,
  HarnessReply,
  HarnessRequest,
  HarnessRequestDraft,
  HarnessSettlement,
  HarnessStatus,
  JsonValue
} from "./types";

// Re-exported so the daemon can name everything the wire references
// without importing the package root (which pulls in Workers types).
export type {
  HarnessCapability,
  HarnessCoreEvent,
  HarnessEvent,
  HarnessEventBody,
  HarnessInboxKind,
  HarnessInboxRow,
  HarnessInput,
  HarnessInterruptPayload,
  HarnessPreview,
  HarnessPreviewBody,
  HarnessPromptPayload,
  HarnessProtocol,
  HarnessReply,
  HarnessReplyPayload,
  HarnessRequest,
  HarnessRequestDraft,
  HarnessResult,
  HarnessSettlement,
  HarnessCompactPayload,
  HarnessStatus,
  HarnessStopReason,
  HarnessUsage,
  JsonValue
} from "./types";

// ── The browser link ──────────────────────────────────────────────────────

/** Query parameter naming the session a browser socket attaches to. */
export const HARNESS_SESSION_QUERY = "session";

export type HarnessCallMethod =
  | "prompt"
  | "interrupt"
  | "requests"
  | "reply"
  | "messages"
  | "status"
  | "result"
  | "submit"
  | "compact"
  | "fork"
  | "rewind"
  | "configure"
  | "cancelQueued";

export type HarnessClientMessage =
  | { readonly type: "snapshot"; readonly id: string }
  | {
      /** Replay from `from` (omit for the whole log), then tail live. */
      readonly type: "subscribe";
      readonly from?: string;
      readonly previews?: boolean;
    }
  | { readonly type: "unsubscribe" }
  | {
      readonly type: "call";
      readonly id: string;
      readonly method: HarnessCallMethod;
      readonly args: readonly JsonValue[];
    };

export type HarnessSnapshot = {
  readonly status: HarnessStatus;
  readonly requests: readonly HarnessRequest[];
  readonly messages: HarnessMessagePage;
};

export type HarnessServerMessage<P extends HarnessProtocol = HarnessProtocol> =
  | ({ readonly type: "snapshot"; readonly id?: string } & HarnessSnapshot)
  | {
      readonly type: "events";
      readonly sessionId: string;
      readonly events: readonly HarnessEvent<P>[];
    }
  | {
      readonly type: "preview";
      readonly sessionId: string;
      readonly preview: HarnessPreview;
    }
  | { readonly type: "up_to_date"; readonly sessionId: string }
  | { readonly type: "result"; readonly id: string; readonly value: JsonValue }
  | {
      readonly type: "error";
      readonly id?: string;
      /** `HarnessError.toJSON()` when the error was one. */
      readonly error: {
        readonly name: string;
        readonly code: string;
        readonly message: string;
      };
    };

// ── The daemon link ───────────────────────────────────────────────────────

export const HARNESS_PROTOCOL_VERSION = 1;
export const HARNESS_RPC_PATH = "/rpc";
export const HARNESS_HEALTH_PATH = "/healthz";
export const HARNESS_DOORBELL_PATH = "/_harness/doorbell";
export const HARNESS_SECRET_HEADER = "x-cf-harness-secret";
/** Batches stay well under the 1 MiB the container leg is assumed to cap at. */
export const HARNESS_MAX_BATCH_BYTES = 131_072;
export const HARNESS_MAX_BATCH_FRAMES = 64;
/** Close codes; Cap'n Web's own abort uses 3000. */
export const HARNESS_CLOSE_REPLACED = 4001;
export const HARNESS_CLOSE_SHUTDOWN = 4002;

/** Environment the runtime hands the container at launch. */
export const HARNESS_ENV = {
  sessionId: "CF_HARNESS_SESSION_ID",
  runtimeId: "CF_HARNESS_RUNTIME_ID",
  secret: "CF_HARNESS_SECRET",
  engine: "CF_HARNESS_ENGINE",
  engineOptions: "CF_HARNESS_ENGINE_OPTIONS",
  doorbellUrl: "CF_HARNESS_DOORBELL_URL",
  /** JSON object of extra headers for doorbell POSTs (a Cloudflare Access service token). */
  doorbellHeaders: "CF_HARNESS_DOORBELL_HEADERS",
  port: "CF_HARNESS_PORT"
} as const;

export type HarnessWireErrorCode =
  | "E_UNAUTHORIZED"
  | "E_PROTOCOL"
  | "E_RUNTIME_FENCED"
  | "E_SUPERSEDED"
  | "E_OUTBOX_TRUNCATED"
  | "E_UNKNOWN_REQUEST"
  | "E_ALREADY_APPLIED"
  | "E_ENGINE_LOST";

/**
 * Control bodies the daemon emits beside ordinary event bodies. The remote
 * runtime turns each into the matching base call (`begin`, `settle`,
 * `requests.open`, `requests.close`) and appends everything else as a frame.
 */
export type HarnessWireControl<P extends HarnessProtocol = HarnessProtocol> =
  | {
      readonly type: "begin";
      readonly operationId: string;
      readonly delivery: "queue" | "steer";
    }
  | {
      readonly type: "settle";
      readonly operationId: string;
      readonly settlement: HarnessSettlement<P>;
    }
  | { readonly type: "request_open"; readonly request: HarnessRequestDraft }
  | {
      readonly type: "request_close";
      readonly requestId: string;
      readonly by: "answered" | "timeout" | "lost";
      readonly reply?: HarnessReply;
    }
  | {
      /**
       * The engine's own session id became known or changed (a resume that
       * minted a new id, a conversation reset). The Durable Object records
       * it durably; it is the `resume` target on the next container.
       */
      readonly type: "engine_session";
      readonly engineSessionId: string;
      /** True when the engine continued the session the runtime asked it to resume. */
      readonly resumed: boolean;
    }
  | {
      /**
       * One batch of the engine's own transcript mirror, the raw entries the
       * engine needs back to resume with full fidelity (signed thinking
       * included). Opaque to the Durable Object: stored in order, deduped by
       * `uuid` when an entry has one, replayed on a new container through
       * `configure({ engineLog })` before the first delivery.
       */
      readonly type: "engine_log";
      readonly engineSessionId: string;
      /** A subagent transcript or sidecar, else null for the main transcript. */
      readonly subpath: string | null;
      readonly entries: readonly JsonValue[];
    };

export type HarnessWireFrame<P extends HarnessProtocol = HarnessProtocol> = {
  /** Per container generation, monotonic, gap-free. */
  readonly seq: number;
  readonly operationId: string | null;
  readonly at: number;
  readonly body: HarnessEventBody<P> | HarnessWireControl<P>;
};

export type HarnessWireBatch<P extends HarnessProtocol = HarnessProtocol> = {
  readonly frames: readonly HarnessWireFrame<P>[];
  readonly previews: readonly {
    readonly operationId: string | null;
    readonly body: HarnessPreviewBody;
  }[];
  readonly highWaterSeq: number;
  /** Lowest seq still in the outbox. */
  readonly floorSeq: number;
};

export type HarnessHelloRequest = {
  readonly protocol: number;
  readonly sessionId: string;
  readonly secret: string;
  readonly expectRuntimeId: string | null;
};

export type HarnessHelloResponse = {
  readonly runtimeId: string;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly daemonVersion: string;
  readonly capabilities: readonly HarnessCapability[];
  readonly highWaterSeq: number;
  readonly floorSeq: number;
  readonly openRequestIds: readonly string[];
  readonly appliedKeys: readonly string[];
  readonly engineSession: {
    readonly id: string;
    readonly resumed: boolean;
  } | null;
  readonly priorExit: {
    readonly code: number | null;
    readonly reason: string;
  } | null;
  /** Operation the engine is currently executing, if any. */
  readonly activeOperationId: string | null;
};

export type HarnessDeliverRow = {
  readonly seq: number;
  readonly key: string;
  readonly operationId: string | null;
  readonly kind: string;
  readonly payload: JsonValue;
};

export type HarnessConfigureRequest = {
  readonly runtimeId: string;
  readonly previews?: boolean;
  readonly remainingBudgetUsd?: number | null;
  readonly requestDeadlines?: readonly {
    readonly requestId: string;
    readonly expiresAt: number;
  }[];
  readonly engineOptions?: JsonValue;
  /**
   * Restore the engine's transcript mirror before its first turn on this
   * container: every chunk of `engineLog` in order, then `resume` names the
   * engine session to continue. The daemon answers a chunk it already holds
   * idempotently.
   */
  readonly engineLog?: readonly {
    readonly engineSessionId: string;
    readonly subpath: string | null;
    readonly entries: readonly JsonValue[];
    /** Chunk position, so the daemon can tell a restore is complete. */
    readonly chunk: number;
    readonly chunks: number;
  }[];
  /** The engine session the first turn must resume, once `engineLog` is complete. */
  readonly resume?: { readonly engineSessionId: string };
};

/**
 * Implemented by the daemon. The only capability on the wire: the Durable
 * Object exports nothing, and events arrive on the stream `subscribe()`
 * returns.
 */
export interface HarnessDaemonApi<P extends HarnessProtocol = HarnessProtocol> {
  hello(req: HarnessHelloRequest): Promise<HarnessHelloResponse>;
  /** Replay-then-tail from `fromSeq` (exclusive). One live subscriber; a second closes the first. */
  subscribe(req: {
    readonly runtimeId: string;
    readonly fromSeq: number;
    readonly previews: boolean;
    readonly maxBatchFrames?: number;
    readonly maxBatchBytes?: number;
  }): Promise<ReadableStream<HarnessWireBatch<P>>>;
  /** One inbox row, verbatim. Idempotent on `key`. The engine interprets `kind`. */
  deliver(req: {
    readonly runtimeId: string;
    readonly row: HarnessDeliverRow;
  }): Promise<{
    readonly accepted: boolean;
    readonly seq: number;
    readonly code?: HarnessWireErrorCode;
  }>;
  /** Advisory: the daemon may prune its outbox below this seq. */
  ack(req: { readonly runtimeId: string; readonly seq: number }): Promise<void>;
  configure(req: HarnessConfigureRequest): Promise<void>;
  probe(): Promise<{
    readonly runtimeId: string;
    readonly highWaterSeq: number;
    readonly floorSeq: number;
    readonly outboxBytes: number;
    readonly openRequests: number;
    readonly busy: boolean;
    /** Engine-owned diagnostics (session, mirror counters), opaque to the runtime. */
    readonly engine?: JsonValue;
  }>;
  shutdown(req: {
    readonly runtimeId: string;
    readonly reason: string;
  }): Promise<void>;
}

/** What the daemon POSTs to the doorbell. Everything in it is re-derived on reconcile. */
export type HarnessDoorbellBody = {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly highWaterSeq: number;
  readonly reason: string;
};
