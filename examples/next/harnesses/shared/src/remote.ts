/**
 * `ContainerHarnessRuntime`: a `HarnessRuntime` whose engine runs as a
 * daemon inside a Cloudflare Container, driven over Cap'n Web.
 *
 * This is the only module that touches `ctx.container` and `capnweb`. It
 * knows a wire (`./protocol`), not a vendor: the engine inside the container
 * is whatever the image's daemon hosts.
 *
 * Establishment, in order: read or mint the runtime secret and id, adopt or
 * launch the container, `setInactivityTimeout`, `monitor()`, health probe,
 * dial `/rpc` with `getTcpPort(port).fetch(upgrade)`, `hello()`, reconcile,
 * `subscribe()` and drain. The Durable Object exports nothing over the RPC
 * session; events arrive on the `ReadableStream` that `subscribe()` returns.
 * The socket is closed on purpose whenever nothing is attached and nothing
 * is in flight, and a doorbell POST from the daemon or a renewal job
 * re-enters `drive()`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
export { HARNESS_DOORBELL_PATH } from "./protocol";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { SessionMessagePart, Sessions } from "agents/sessions";
import {
  HARNESS_CLOSE_SHUTDOWN,
  HARNESS_ENV,
  HARNESS_HEALTH_PATH,
  HARNESS_MAX_BATCH_BYTES,
  HARNESS_MAX_BATCH_FRAMES,
  HARNESS_PROTOCOL_VERSION,
  HARNESS_RPC_PATH,
  HARNESS_SECRET_HEADER,
  type HarnessDaemonApi,
  type HarnessDeliverRow,
  type HarnessHelloResponse,
  type HarnessWireBatch,
  type HarnessWireFrame
} from "./protocol";
import {
  DEFAULT_SESSION_ID,
  HarnessDetachedError,
  type HarnessCapability,
  type HarnessEventBody,
  type HarnessInput,
  type HarnessMessagesOptions,
  type HarnessProtocol,
  type JsonValue
} from "./types";
import type {
  HarnessDriveContext,
  HarnessInboxRow,
  HarnessOperationHandle,
  HarnessPromptPayload,
  HarnessRuntime,
  HarnessRuntimeMessagePage,
  HarnessRuntimeStartContext
} from "./runtime";

/** A tool the Durable Object executes on the engine's behalf. */
export type HarnessHostTool = {
  readonly description: string;
  /** JSON Schema for the input, with `$defs` inlined. */
  readonly inputSchema: JsonValue;
  run(input: JsonValue): Promise<JsonValue>;
};

/** What an engine package's factory returns: an id, opaque options, and its capabilities. */
export type HarnessEngineSpec<P extends HarnessProtocol = HarnessProtocol> = {
  /** `"claude-code"`, `"echo"`. Selects the engine inside the daemon. */
  readonly id: string;
  /** Opaque to the wire; the engine parses it. */
  readonly options: JsonValue;
  readonly capabilities: ReadonlySet<HarnessCapability>;
  /** Type carrier only; never set at runtime. */
  readonly __protocol?: P;
};

export type ContainerHarnessIdleOptions = {
  /** Close the control socket when nothing is attached and nothing is in flight. Default 20_000. */
  readonly detachAfterIdleMs?: number;
  /** `setInactivityTimeout` on every attach and renewal. Default 900_000, ceiling 6 h. */
  readonly keepAliveMs?: number;
  /** Renewal job period while an operation runs unattended. Default 300_000. */
  readonly renewIntervalMs?: number;
  /** After the last operation settles with nobody attached: `shutdown()` then `destroy()`. Default 120_000. */
  readonly stopContainerAfterIdleMs?: number;
  /** Auto-resume a lost operation only after a clean exit (code 0 or 143). Default `"on-clean-exit"`. */
  readonly resumePolicy?: "on-clean-exit" | "never";
};

export type ContainerHarnessRuntimeOptions<
  P extends HarnessProtocol = HarnessProtocol
> = {
  /** Recorded on every operation row. `"container:claude-code"`. */
  readonly id: string;
  /** `ctx.container`. A facet shares the root's container, so one session is one top-level object. */
  readonly container: Container;
  /** The port the daemon listens on. Default 8787. */
  readonly port?: number;
  /**
   * The Durable Object's own name, so the doorbell can address it:
   * `ctx.id.name`. Sessions reached by id have no doorbell.
   */
  readonly sessionName?: string;
  readonly launch: {
    readonly enableInternet: boolean;
    /** Extra environment for the container, secrets included (`ANTHROPIC_API_KEY`). */
    readonly env?: { readonly [key: string]: string };
    readonly entrypoint?: readonly string[];
  };
  /**
   * Route one host's outbound HTTPS from the container through a Worker
   * entrypoint instead of the internet (`ctx.exports.<WorkerEntrypoint>`).
   */
  readonly intercept?: {
    readonly host: string;
    readonly binding: Fetcher;
  };
  /** Public URL of the Worker's `HARNESS_DOORBELL_PATH` route. Omit to rely on renewal jobs only. */
  readonly doorbellUrl?: string;
  /**
   * Extra headers the daemon sends with every doorbell POST: a Cloudflare
   * Access service token when the Worker sits behind Access.
   */
  readonly doorbellHeaders?: { readonly [name: string]: string };
  /** The runtime projects the user-visible transcript here. */
  readonly sessions: Sessions;
  /** Host tools the engine may call; each parks as a `tool` request and runs here. */
  readonly tools?: { readonly [name: string]: HarnessHostTool };
  readonly engine: HarnessEngineSpec<P>;
  readonly idle?: ContainerHarnessIdleOptions;
  /**
   * Test seam: how to obtain the control socket. Default dials
   * `container.getTcpPort(port).fetch()` with a WebSocket upgrade.
   */
  readonly dial?: (options: {
    readonly path: string;
    readonly headers: { readonly [name: string]: string };
  }) => Promise<WebSocket>;
  /** Test seam: how to read the health endpoint. Default `getTcpPort(port).fetch(HEAD /healthz)`. */
  readonly probe?: () => Promise<boolean>;
};

/** What `info()` reports about the container generation. */
export type ContainerHarnessInfo = {
  readonly runtimeId: string | null;
  readonly running: boolean;
  readonly attached: boolean;
  /** The daemon build the live link spoke to, when attached. */
  readonly daemonVersion?: string;
  /** Batches of the current engine session's transcript mirror held here. */
  readonly engineLogRows: number;
  /** The daemon's own diagnostics, when attached. */
  readonly engine?: JsonValue;
  readonly engineVersion?: string;
  /** The engine's own session id, the `resume` target of the next container. */
  readonly engineSessionId: string | null;
  /** True while the stored transcript still owes this container a restore. */
  readonly restorePending: boolean;
};

const DEFAULT_PORT = 8787;
const KEEP_ALIVE_CEILING_MS = 6 * 60 * 60_000;
const DEFAULT_IDLE: Required<ContainerHarnessIdleOptions> = {
  detachAfterIdleMs: 20_000,
  keepAliveMs: 900_000,
  renewIntervalMs: 300_000,
  stopContainerAfterIdleMs: 120_000,
  resumePolicy: "on-clean-exit"
};
/** Health probe backoff: 250 ms doubling to 2 s, abandoned after a minute. */
const PROBE_START_MS = 250;
const PROBE_MAX_MS = 2_000;
const PROBE_BUDGET_MS = 60_000;
/** How often a live drain looks at the inbox for rows admitted since it started. */
/** Backstop for the drain loop's periodic checks when nothing else wakes it. */
const DRAIN_TICK_MS = 2_000;
/** How long a detach waits for the daemon to acknowledge a stream cancel. */
const CANCEL_GRACE_MS = 100;
/** Marks a handshake the runtime already settled, so `drive()` propagates it as is. */
class HandshakeFailedError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HandshakeFailedError";
    this.cause = cause;
  }
}

const MAX_DOORBELL_NAME_LENGTH = 256;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** Consecutive attach failures are retried for this long before the operation fails. */
const ATTACH_GIVE_UP_MS = 5 * 60_000;
/** Exit codes that mean the engine stopped on purpose. */
const CLEAN_EXIT_CODES = new Set([0, 143]);
/** Chunks one `configure()` carries; a longer restore is several calls. */
const RESTORE_CHUNKS_PER_CALL = 8;
/** Said on the session log when the engine refused the transcript we shipped. */
const RESUME_FAILED_MESSAGE =
  "The engine started a fresh session; earlier context is in the transcript but not in the model";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_harness_remote (
  session_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  runtime_id TEXT,
  launch_digest TEXT,
  last_wire_seq INTEGER NOT NULL,
  exit_code INTEGER,
  exit_reason TEXT,
  engine_session_id TEXT,
  restore_pending INTEGER NOT NULL DEFAULT 0,
  restore_runtime_id TEXT,
  updated_at INTEGER NOT NULL
);
DROP TABLE IF EXISTS cf_agents_harness_remote_log;
CREATE TABLE IF NOT EXISTS cf_agents_harness_engine_log (
  session_id TEXT NOT NULL,
  engine_session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  wire_seq INTEGER NOT NULL,
  -- Append order across container generations. Assigned here, because a new
  -- container restarts its wire numbering from one.
  ordinal INTEGER NOT NULL,
  -- "" is the main transcript; anything else is a subagent or a sidecar.
  subpath TEXT NOT NULL,
  entries TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  -- Dedupes a batch re-ingested after a reconnect without a second index on
  -- a table every engine batch writes to.
  PRIMARY KEY (session_id, runtime_id, wire_seq)
);
`;

/**
 * Columns added after the state table shipped. Existing objects already have
 * the table, so `CREATE TABLE IF NOT EXISTS` never sees them.
 */
const ADDED_COLUMNS: readonly (readonly [string, string])[] = [
  ["engine_session_id", "engine_session_id TEXT"],
  ["restore_pending", "restore_pending INTEGER NOT NULL DEFAULT 0"],
  ["restore_runtime_id", "restore_runtime_id TEXT"]
];

type RemoteRow = {
  session_id: string;
  secret: string;
  runtime_id: string | null;
  launch_digest: string | null;
  last_wire_seq: number;
  exit_code: number | null;
  exit_reason: string | null;
  /** The engine session the stored transcript belongs to. */
  engine_session_id: string | null;
  /** 1 while a new container still owes the stored transcript a restore. */
  restore_pending: number;
  /** The generation a restore was completed for, so a reconnect does not resend. */
  restore_runtime_id: string | null;
  updated_at: number;
};

type EngineLogRow = { subpath: string; entries: string; bytes: number };

/** One `engine_log` frame, buffered until the batch that carried it commits. */
type PendingEngineLog = {
  readonly engineSessionId: string;
  readonly subpath: string;
  readonly wireSeq: number;
  readonly ordinal: number;
  readonly entries: string;
  readonly bytes: number;
};

/** One `configure({ engineLog })` element: a slice of one transcript. */
type EngineLogChunk = {
  readonly engineSessionId: string;
  readonly subpath: string | null;
  readonly entries: readonly JsonValue[];
  readonly chunk: number;
  readonly chunks: number;
};

/** One live Cap'n Web session with the daemon of one container generation. */
type DaemonLink<P extends HarnessProtocol> = {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly socket: WebSocket;
  readonly api: RpcStub<HarnessDaemonApi<P>>;
  readonly hello: HarnessHelloResponse;
  /** Highest wire seq ingested from this generation. */
  cursor: number;
  reader: ReadableStreamDefaultReader<HarnessWireBatch<P>> | undefined;
  closed: boolean;
  /** The engine session as this link last saw it, and whether it is unwritten. */
  engineSession: string | null;
  engineSessionDirty: boolean;
  /** `engine_log` frames of the batch being applied; written in its commit. */
  readonly pendingLog: PendingEngineLog[];
  /** True once this generation has been handed the stored transcript. */
  restoreSent: boolean;
};

/** What one iteration of the drain loop woke up for. */
type ReadOutcome<P extends HarnessProtocol> =
  | {
      readonly kind: "batch";
      readonly result: ReadableStreamReadResult<HarnessWireBatch<P>>;
    }
  | { readonly kind: "error"; readonly error: unknown };

const TICK = { kind: "tick" } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-independent comparison, so a doorbell cannot be probed byte by byte. */
function secretsMatch(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    diff |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0);
  }
  return diff === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parts a prompt contributes to the transcript. */
function inputParts(input: HarnessInput): SessionMessagePart[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (input.parts && input.parts.length > 0) return [...input.parts];
  return input.text === undefined ? [] : [{ type: "text", text: input.text }];
}

/** Entries the engine stamped with a uuid are deduped on it; the rest are not. */
function entryUuid(entry: JsonValue): string | undefined {
  if (!isRecord(entry)) return undefined;
  const uuid = entry.uuid;
  return typeof uuid === "string" ? uuid : undefined;
}

/** What one JSON value costs on the wire. */
function jsonBytes(value: JsonValue | readonly JsonValue[]): number {
  return JSON.stringify(value).length;
}

function toDeliverRow(row: HarnessInboxRow): HarnessDeliverRow {
  return {
    seq: row.seq,
    key: row.key,
    operationId: row.operationId,
    kind: row.kind,
    payload: row.payload
  };
}

/**
 * A runtime in a Container. Implemented in this module; the public surface
 * below is the contract the examples build against.
 */
export class ContainerHarnessRuntime<
  P extends HarnessProtocol = HarnessProtocol
> implements HarnessRuntime<P> {
  readonly id: string;
  readonly capabilities: ReadonlySet<HarnessCapability>;
  readonly #options: ContainerHarnessRuntimeOptions<P>;
  readonly #idle: Required<ContainerHarnessIdleOptions>;

  #storage: DurableObjectStorage | undefined;
  #pushWake: ((sessionId: string, afterMs?: number) => void) | undefined;
  #link: DaemonLink<P> | undefined;
  #attaching: Promise<DaemonLink<P>> | undefined;
  /** Bumped on every launch; a settle from an older generation is ignored. */
  #generation = 0;
  #lastExit: { readonly code: number | null; readonly reason: string } | null =
    null;
  /** When the container should be shut down, once nothing wants it. */
  #stopAt: number | undefined;
  /** True while `stop()` is closing the link on purpose. */
  #stopping = false;
  #reconnectMs = RECONNECT_MIN_MS;
  /** When the current run of attach failures began, if one is under way. */
  #attachFailingSince: number | undefined;
  /** Highest engine-log ordinal written; derived once per isolate. */
  #logOrdinal: number | undefined;

  constructor(options: ContainerHarnessRuntimeOptions<P>) {
    this.id = options.id;
    this.capabilities = options.engine.capabilities;
    this.#options = options;
    this.#idle = {
      detachAfterIdleMs:
        options.idle?.detachAfterIdleMs ?? DEFAULT_IDLE.detachAfterIdleMs,
      keepAliveMs: Math.min(
        options.idle?.keepAliveMs ?? DEFAULT_IDLE.keepAliveMs,
        KEEP_ALIVE_CEILING_MS
      ),
      renewIntervalMs:
        options.idle?.renewIntervalMs ?? DEFAULT_IDLE.renewIntervalMs,
      stopContainerAfterIdleMs:
        options.idle?.stopContainerAfterIdleMs ??
        DEFAULT_IDLE.stopContainerAfterIdleMs,
      resumePolicy: options.idle?.resumePolicy ?? DEFAULT_IDLE.resumePolicy
    };
  }

  /** @internal The options this runtime was built with. */
  protected get options(): ContainerHarnessRuntimeOptions<P> {
    return this.#options;
  }

  onStart(ctx: HarnessRuntimeStartContext): void {
    this.#storage = ctx.storage;
    ctx.storage.sql.exec(SCHEMA);
    this.#migrate(ctx.storage);
    this.#pushWake = ctx.wake;
  }

  /** Add the columns an object created before they existed is missing. */
  #migrate(storage: DurableObjectStorage): void {
    const present = new Set(
      storage.sql
        .exec<{ name: string }>("PRAGMA table_info(cf_agents_harness_remote)")
        .toArray()
        .map((column) => column.name)
    );
    for (const [name, definition] of ADDED_COLUMNS) {
      if (present.has(name)) continue;
      storage.sql.exec(
        `ALTER TABLE cf_agents_harness_remote ADD COLUMN ${definition}`
      );
    }
  }

  async drive(ctx: HarnessDriveContext<P>): Promise<void> {
    if (!this.#wantsLink(ctx)) {
      await this.#idleStep(ctx);
      return;
    }
    let link: DaemonLink<P>;
    try {
      link = await this.#attach(ctx);
    } catch (error) {
      if (error instanceof HandshakeFailedError) throw error.cause;
      await this.#attachFailed(ctx, error);
      return;
    }
    this.#attachFailingSince = undefined;
    await this.#configure(ctx, link);
    // Subscribe before delivering: frames the daemon produces for a
    // delivery must land on a live subscription, or it rings the doorbell
    // for an object that is already listening. The drain delivers first.
    await this.#drain(ctx, link);
  }

  async messages(
    sessionId: string,
    options: HarnessMessagesOptions
  ): Promise<HarnessRuntimeMessagePage> {
    const page = await this.#options.sessions
      .session(sessionId)
      .getRecentHistory(options.maxBytes ?? 262_144);
    return { messages: page.messages };
  }

  async dispose(reason: "dispose" | "memory-limit"): Promise<void> {
    await this.#detach(reason);
  }

  /** Park the container: the socket closes, the container keeps working. */
  async close(_sessionId: string): Promise<void> {
    await this.#detach("close");
  }

  async delete(sessionId: string): Promise<void> {
    await this.stop("session deleted");
    this.#storage?.sql.exec(
      "DELETE FROM cf_agents_harness_remote WHERE session_id = ?",
      sessionId
    );
    this.#storage?.sql.exec(
      "DELETE FROM cf_agents_harness_engine_log WHERE session_id = ?",
      sessionId
    );
    this.#logOrdinal = undefined;
  }

  /**
   * Verify the secret on a doorbell POST, then push one drive job. The
   * host's `harnessDoorbell(request)` method calls this after
   * `lifecycle.start()`.
   */
  async doorbell(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const secret = request.headers.get(HARNESS_SECRET_HEADER);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!isRecord(body) || typeof body.sessionId !== "string") {
      return new Response("Bad request", { status: 400 });
    }
    const sessionId = body.sessionId;
    const row = this.#row(sessionId);
    if (!row || secret === null || !secretsMatch(secret, row.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    // The body is a hint and nothing else: `highWaterSeq` and `runtimeId`
    // are re-derived by reconcile, and a superseded generation ringing the
    // bell only costs one wake that finds nothing to do.
    this.#pushWake?.(sessionId, 0);
    return new Response(null, { status: 204 });
  }

  async info(): Promise<ContainerHarnessInfo> {
    const link = this.#link;
    // Detached is the normal resting state, so the generation is reported
    // from the durable row rather than from the live session.
    const sessionId = link?.sessionId ?? DEFAULT_SESSION_ID;
    const stored = this.#row(sessionId);
    const engineSessionId = stored?.engine_session_id ?? null;
    let engine: JsonValue | undefined;
    if (link && !link.closed) {
      try {
        engine = (await link.api.probe()).engine;
      } catch {
        // A probe that fails says nothing the rest of the report needs.
      }
    }
    return {
      runtimeId: link?.runtimeId ?? stored?.runtime_id ?? null,
      running: this.#options.container.running,
      attached: link !== undefined && !link.closed,
      engineSessionId,
      restorePending: stored?.restore_pending === 1,
      engineLogRows:
        engineSessionId === null
          ? 0
          : this.#engineLogRows(sessionId, engineSessionId),
      ...(link?.hello.engineVersion === undefined
        ? {}
        : { engineVersion: link.hello.engineVersion }),
      ...(link?.hello.daemonVersion === undefined
        ? {}
        : { daemonVersion: link.hello.daemonVersion }),
      ...(engine === undefined ? {} : { engine })
    };
  }

  /** `shutdown()` the daemon, then `destroy()` the container. */
  async stop(reason: string): Promise<void> {
    const link = this.#link;
    // A stop is ours: the socket closing under a pending read is expected,
    // not a wire failure worth a warning.
    this.#stopping = true;
    if (link && !link.closed) {
      try {
        await link.api.shutdown({ runtimeId: link.runtimeId, reason });
      } catch {
        // The daemon is already gone; destroy() is the mechanism anyway.
      }
    }
    await this.#detach(reason, HARNESS_CLOSE_SHUTDOWN);
    this.#stopping = false;
    this.#stopAt = undefined;
    // Supersede the monitor: this exit is ours and records nothing.
    this.#generation += 1;
    try {
      await this.#options.container.destroy();
    } catch {
      // Already stopped.
    }
  }

  // ── The drive pass ───────────────────────────────────────────────────────

  /** True when something in the durable state needs the daemon right now. */
  #wantsLink(ctx: HarnessDriveContext<P>): boolean {
    if (ctx.inbox.peek({ limit: 1 }).length > 0) return true;
    if (ctx.attached()) return true;
    const active = ctx.active();
    if (!active) return false;
    // A blocked operation waits on a human, not on the engine: let the
    // socket close and let the answer ring the doorbell.
    return ctx.requests.list(active.operationId).length === 0;
  }

  /** Nothing wants the daemon: close the socket, and stop the container when its time comes. */
  async #idleStep(ctx: HarnessDriveContext<P>): Promise<void> {
    await this.#detach("idle");
    if (ctx.active() !== null || !this.#quiet(ctx)) {
      // Something is still running in the container or waiting to be
      // delivered: come back on the renewal period whether or not the
      // doorbell rings, so an evicted object never strands its operation.
      ctx.wake(this.#idle.renewIntervalMs);
      return;
    }
    const stopAt = this.#stopAt;
    if (stopAt === undefined) return;
    if (Date.now() >= stopAt) {
      await this.stop("idle");
      return;
    }
    if (this.#quiet(ctx)) ctx.wake(stopAt - Date.now());
  }

  /** True when no input is waiting, so a long wake cannot strand one. */
  #quiet(ctx: HarnessDriveContext<P>): boolean {
    return ctx.inbox.peek({ limit: 1 }).length === 0;
  }

  #scheduleStop(ctx: HarnessDriveContext<P>): void {
    this.#stopAt = Date.now() + this.#idle.stopContainerAfterIdleMs;
    ctx.wake(this.#idle.stopContainerAfterIdleMs);
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  /** Single-flight: concurrent drive passes share one handshake. */
  async #attach(ctx: HarnessDriveContext<P>): Promise<DaemonLink<P>> {
    const live = this.#link;
    if (live && !live.closed) return live;
    this.#attaching ??= this.#openLink(ctx).finally(() => {
      this.#attaching = undefined;
    });
    return this.#attaching;
  }

  async #openLink(ctx: HarnessDriveContext<P>): Promise<DaemonLink<P>> {
    const sessionId = ctx.sessionId;
    const state = await this.#ensureRow(sessionId);
    await this.#launch(sessionId, state);
    const socket = await this.#dial(state.secret);
    const api = newWebSocketRpcSession<HarnessDaemonApi<P>>(socket);
    let hello: HarnessHelloResponse;
    try {
      hello = await api.hello({
        protocol: HARNESS_PROTOCOL_VERSION,
        sessionId,
        secret: state.secret,
        expectRuntimeId: state.runtime_id
      });
    } catch (error) {
      await this.#failHandshake(ctx, socket, error);
      throw new HandshakeFailedError(error);
    }
    if (hello.engineId !== this.#options.engine.id) {
      const mismatch = new HarnessDetachedError(
        `Container hosts engine ${hello.engineId}, not ${this.#options.engine.id}`
      );
      await this.#failHandshake(ctx, socket, mismatch);
      throw new HandshakeFailedError(mismatch);
    }
    const link: DaemonLink<P> = {
      sessionId,
      runtimeId: hello.runtimeId,
      socket,
      api,
      hello,
      cursor: 0,
      reader: undefined,
      closed: false,
      engineSession: null,
      engineSessionDirty: false,
      pendingLog: [],
      restoreSent: false
    };
    const onGone = () => {
      link.closed = true;
      if (this.#link === link) this.#link = undefined;
    };
    socket.addEventListener("close", onGone, { once: true });
    socket.addEventListener("error", onGone, { once: true });
    link.cursor = await this.#reconcile(ctx, link, state);
    this.#link = link;
    this.#stopAt = undefined;
    this.#reconnectMs = RECONNECT_MIN_MS;
    return link;
  }

  /**
   * The container could not be reached: it is still starting, the port is
   * not listening yet, or the platform hiccupped. Nothing has been lost, so
   * the operation stays running and the pass comes back with backoff. A
   * container that never answers fails the operation after a bounded wait.
   */
  async #attachFailed(
    ctx: HarnessDriveContext<P>,
    error: unknown
  ): Promise<void> {
    if (this.#stopping) return;
    const since = (this.#attachFailingSince ??= Date.now());
    if (Date.now() - since >= ATTACH_GIVE_UP_MS) {
      this.#attachFailingSince = undefined;
      throw error;
    }
    if (ctx.signal.aborted) return;
    ctx.wake(this.#reconnectMs);
    this.#reconnectMs = Math.min(RECONNECT_MAX_MS, this.#reconnectMs * 2);
    console.warn(
      `Harness container for ${ctx.sessionId} is not reachable yet: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  /** A handshake that cannot succeed settles what was running and propagates. */
  async #failHandshake(
    ctx: HarnessDriveContext<P>,
    socket: WebSocket,
    error: unknown
  ): Promise<void> {
    try {
      socket.close(HARNESS_CLOSE_SHUTDOWN, "handshake failed");
    } catch {
      // Already closed.
    }
    const active = ctx.active();
    if (!active) return;
    await ctx.settle(active.operationId, {
      status: "failed",
      stopReason: { type: "error", raw: "handshake" },
      error: {
        code: "E_PROTOCOL",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }

  /** Adopt a running container with a matching launch digest, else launch one. */
  async #launch(sessionId: string, state: RemoteRow): Promise<void> {
    const container = this.#options.container;
    const launch = this.#options.launch;
    const port = this.#options.port ?? DEFAULT_PORT;
    const env: Record<string, string> = {
      ...launch.env,
      [HARNESS_ENV.sessionId]: sessionId,
      [HARNESS_ENV.runtimeId]: state.runtime_id ?? "",
      [HARNESS_ENV.secret]: state.secret,
      [HARNESS_ENV.engine]: this.#options.engine.id,
      [HARNESS_ENV.engineOptions]: JSON.stringify(
        this.#options.engine.options ?? null
      ),
      [HARNESS_ENV.port]: String(port)
    };
    const doorbellUrl = this.#doorbellUrl();
    if (doorbellUrl !== undefined) env[HARNESS_ENV.doorbellUrl] = doorbellUrl;
    const doorbellHeaders = this.#options.doorbellHeaders;
    if (doorbellHeaders && Object.keys(doorbellHeaders).length > 0) {
      env[HARNESS_ENV.doorbellHeaders] = JSON.stringify(doorbellHeaders);
    }
    // Container env is immutable once live, so the digest covers values as
    // well as keys: a rotated credential relaunches. The runtime id is the
    // one value left out, because it names the generation being adopted.
    const { [HARNESS_ENV.runtimeId]: _expected, ...launched } = env;
    const digest = await sha256(
      JSON.stringify({
        engine: this.#options.engine.id,
        options: this.#options.engine.options ?? null,
        enableInternet: launch.enableInternet,
        entrypoint: launch.entrypoint ?? null,
        port,
        env: Object.keys(launched)
          .sort()
          .map((key) => [key, launched[key]])
      })
    );
    if (container.running && state.launch_digest !== digest) {
      // Container env is immutable once live: a different launch is a
      // different container.
      await container.destroy();
    }
    if (!container.running) {
      this.#generation += 1;
      container.start({
        enableInternet: launch.enableInternet,
        env,
        ...(launch.entrypoint === undefined
          ? {}
          : { entrypoint: [...launch.entrypoint] })
      });
      this.#write(sessionId, { launch_digest: digest });
      state.launch_digest = digest;
    }
    // The only reason a container survives an eviction of this object.
    await container.setInactivityTimeout(this.#idle.keepAliveMs);
    this.#monitor(sessionId, this.#generation);
    const intercept = this.#options.intercept;
    if (intercept) {
      await container.interceptOutboundHttps(intercept.host, intercept.binding);
    }
    await this.#probe();
  }

  #doorbellUrl(): string | undefined {
    const url = this.#options.doorbellUrl;
    if (url === undefined) return undefined;
    const name = this.#options.sessionName;
    return name === undefined ? url : `${url}?name=${encodeURIComponent(name)}`;
  }

  /** Record the exit of one generation. A late settle from an older one is dropped. */
  #monitor(sessionId: string, generation: number): void {
    void this.#options.container
      .monitor()
      .then(
        () => ({ code: 0, reason: "exited" }),
        (error: unknown) => ({
          code: null,
          reason: error instanceof Error ? error.message : String(error)
        })
      )
      .then((exit) => {
        if (generation !== this.#generation) return;
        this.#lastExit = exit;
        this.#write(sessionId, {
          exit_code: exit.code,
          exit_reason: exit.reason
        });
        const link = this.#link;
        if (link) {
          link.closed = true;
          this.#link = undefined;
        }
      });
  }

  /** `HEAD /healthz` until it answers, 250 ms doubling to 2 s. */
  async #probe(): Promise<void> {
    const probe =
      this.#options.probe ??
      (async () => {
        const port = this.#options.container.getTcpPort(
          this.#options.port ?? DEFAULT_PORT
        );
        const response = await port.fetch(
          new Request(`http://container${HARNESS_HEALTH_PATH}`, {
            method: "HEAD"
          })
        );
        return response.status === 200;
      });
    const deadline = Date.now() + PROBE_BUDGET_MS;
    let wait = PROBE_START_MS;
    for (;;) {
      try {
        if (await probe()) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() >= deadline) {
        throw new HarnessDetachedError(
          `Container did not answer ${HARNESS_HEALTH_PATH} within ${PROBE_BUDGET_MS} ms`
        );
      }
      await sleep(wait);
      wait = Math.min(PROBE_MAX_MS, wait * 2);
    }
  }

  async #dial(secret: string): Promise<WebSocket> {
    const headers = {
      Upgrade: "websocket",
      [HARNESS_SECRET_HEADER]: secret
    };
    const dial = this.#options.dial;
    if (dial) return dial({ path: HARNESS_RPC_PATH, headers });
    const port = this.#options.container.getTcpPort(
      this.#options.port ?? DEFAULT_PORT
    );
    const response = await port.fetch(
      new Request(`http://container${HARNESS_RPC_PATH}`, { headers })
    );
    const socket = response.webSocket;
    if (!socket) {
      throw new HarnessDetachedError(
        `Container refused the control socket: ${response.status}`
      );
    }
    socket.accept();
    return socket;
  }

  // ── Reconcile ────────────────────────────────────────────────────────────

  /**
   * R0 to R2 and R5 of the RFC: adopt or replace the generation, derive the
   * wire cursor, mark a truncated outbox, and drop requests the daemon has
   * forgotten. Returns the seq to subscribe from.
   */
  async #reconcile(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>,
    state: RemoteRow
  ): Promise<number> {
    const sessionId = ctx.sessionId;
    const hello = link.hello;
    let cursor = 0;
    if (state.runtime_id === hello.runtimeId) {
      cursor = state.last_wire_seq;
    } else {
      // R0: a different container answered. Everything in flight is lost.
      const active = ctx.active();
      if (active) {
        const exit = hello.priorExit ?? this.#lastExit;
        const clean =
          exit !== null &&
          exit.code !== null &&
          CLEAN_EXIT_CODES.has(exit.code);
        await ctx.settle(active.operationId, {
          status: "failed",
          stopReason: {
            type: "runtime_lost",
            raw: exit?.reason ?? "runtime replaced"
          },
          error: {
            code: "E_ENGINE_LOST",
            message: clean
              ? "The container was replaced after a clean exit; re-submit to continue"
              : "The container was replaced mid-operation"
          }
        });
      }
      for (const request of ctx.requests.list()) {
        await ctx.requests.close(request.requestId, "lost");
      }
      // The container that held the engine's transcript is gone: the next
      // `configure()` must ship ours back before the engine's first turn.
      const owed =
        state.engine_session_id !== null &&
        this.#engineLogRows(sessionId, state.engine_session_id) > 0;
      this.#write(sessionId, {
        runtime_id: hello.runtimeId,
        last_wire_seq: 0,
        restore_pending: owed ? 1 : 0,
        restore_runtime_id: null
      });
      state.runtime_id = hello.runtimeId;
      state.last_wire_seq = 0;
      state.restore_pending = owed ? 1 : 0;
      state.restore_runtime_id = null;
    }
    link.engineSession = state.engine_session_id;
    link.restoreSent = state.restore_runtime_id === hello.runtimeId;
    // The `engine_session` frame is authoritative, but a daemon that minted
    // its session before this object ever attached only reports it here.
    if (hello.engineSession !== null && state.engine_session_id === null) {
      this.#write(sessionId, { engine_session_id: hello.engineSession.id });
      state.engine_session_id = hello.engineSession.id;
      link.engineSession = hello.engineSession.id;
    }
    // A reconnect within a generation we already restored, whose engine says
    // it started fresh: the transcript is ours and the model's context is not.
    if (link.restoreSent && hello.engineSession?.resumed === false) {
      const log = await ctx.session();
      this.#reportResumeFailure(sessionId, link, log);
      log.flush();
    }
    // R2: the outbox was pruned past what we ingested. Say so, visibly.
    // `floorSeq` is the lowest seq still held, so the cursor is caught up
    // when it reaches `floorSeq - 1`; an empty outbox reports `floorSeq` 1.
    if (cursor + 1 < hello.floorSeq) {
      const log = await ctx.session();
      log.append({
        type: "gap",
        from: cursor,
        to: hello.floorSeq,
        reason: "remote outbox truncated"
      });
      log.flush();
      cursor = hello.floorSeq - 1;
      this.#write(sessionId, { last_wire_seq: cursor });
    }
    // R5: a request the daemon no longer knows will never be answered.
    const known = new Set(hello.openRequestIds);
    for (const request of ctx.requests.list()) {
      if (!known.has(request.requestId)) {
        await ctx.requests.close(request.requestId, "lost");
      }
    }
    return cursor;
  }

  // ── Deliver ──────────────────────────────────────────────────────────────

  /** R4: every unconsumed inbox row, verbatim, at least once. Returns how many were taken. */
  async #deliverInbox(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>
  ): Promise<number> {
    let taken = 0;
    for (const pending of ctx.inbox.peek()) {
      if (link.closed) return taken;
      const outcome = await link.api.deliver({
        runtimeId: link.runtimeId,
        row: toDeliverRow(pending)
      });
      if (outcome.accepted || outcome.code === "E_ALREADY_APPLIED") {
        const row = ctx.inbox.take(pending.seq);
        taken += 1;
        if (row && row.kind === "prompt" && row.operationId !== null) {
          await this.#projectPrompt(ctx.sessionId, row);
        }
        continue;
      }
      if (
        outcome.code === "E_RUNTIME_FENCED" ||
        outcome.code === "E_SUPERSEDED"
      ) {
        await this.#detach(outcome.code);
        throw new HarnessDetachedError(
          `Daemon refused delivery: ${outcome.code}`
        );
      }
      // Anything else: leave the row for the next pass to retry.
      return taken;
    }
    return taken;
  }

  /** A delivered prompt is the user's turn in the transcript. */
  async #projectPrompt(
    sessionId: string,
    row: HarnessInboxRow<P>
  ): Promise<void> {
    const payload = row.payload as unknown as HarnessPromptPayload;
    await this.#options.sessions.session(sessionId).appendMessage({
      id: `user:${row.operationId}`,
      role: "user",
      parts: inputParts(payload.input),
      metadata: { operationId: row.operationId }
    });
  }

  /**
   * Configure the generation, and on a new one hand back the engine's own
   * transcript before anything is delivered: the engine replays its own
   * history, so a host that skipped this would resume with an empty model.
   */
  async #configure(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>
  ): Promise<void> {
    if (link.closed) return;
    const base = {
      runtimeId: link.runtimeId,
      previews: ctx.attached(),
      requestDeadlines: ctx.requests.list().map((request) => ({
        requestId: request.requestId,
        expiresAt: request.expiresAt
      }))
    };
    const state = this.#row(ctx.sessionId);
    const engineSessionId = state?.engine_session_id ?? null;
    if (state?.restore_pending !== 1 || engineSessionId === null) {
      await link.api.configure(base);
      return;
    }
    const chunks = this.#restoreChunks(ctx.sessionId, engineSessionId);
    if (chunks.length === 0) {
      await link.api.configure(base);
      this.#write(ctx.sessionId, { restore_pending: 0 });
      return;
    }
    // Several calls rather than one enormous one; `resume` rides the last,
    // so the daemon starts the engine only once every chunk has landed. A
    // call that fails leaves the flag set, and the next attach retries.
    for (let at = 0; at < chunks.length; at += RESTORE_CHUNKS_PER_CALL) {
      const slice = chunks.slice(at, at + RESTORE_CHUNKS_PER_CALL);
      const last = at + RESTORE_CHUNKS_PER_CALL >= chunks.length;
      await link.api.configure({
        ...base,
        engineLog: slice,
        ...(last ? { resume: { engineSessionId } } : {})
      });
    }
    this.#write(ctx.sessionId, {
      restore_pending: 0,
      restore_runtime_id: link.runtimeId
    });
    link.restoreSent = true;
  }

  // ── Drain ────────────────────────────────────────────────────────────────

  /**
   * Subscribe from the wire cursor and apply batches until the exit policy
   * says to let go. The far side's flow control is gated by these reads, so
   * nothing is buffered into an unbounded queue.
   */
  async #drain(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>
  ): Promise<void> {
    let stream: ReadableStream<HarnessWireBatch<P>>;
    try {
      stream = await link.api.subscribe({
        runtimeId: link.runtimeId,
        fromSeq: link.cursor,
        previews: ctx.attached(),
        maxBatchFrames: HARNESS_MAX_BATCH_FRAMES,
        maxBatchBytes: HARNESS_MAX_BATCH_BYTES
      });
    } catch (error) {
      await this.#wireFailed(ctx, link, error);
      return;
    }
    const reader = stream.getReader();
    link.reader = reader;
    await this.#deliverInbox(ctx, link);
    const idle = this.#idle;
    const startedAt = Date.now();
    let lastBatchAt = startedAt;
    let idleSince: number | undefined;
    let pending: Promise<ReadOutcome<P>> | undefined;
    try {
      for (;;) {
        // Disposal detaches through `dispose()`; this only stops draining.
        if (ctx.signal.aborted) return;
        if (link.closed) {
          await this.#wireFailed(
            ctx,
            link,
            new HarnessDetachedError("Control socket closed")
          );
          return;
        }
        pending ??= reader.read().then(
          (result): ReadOutcome<P> => ({ kind: "batch", result }),
          (error: unknown): ReadOutcome<P> => ({ kind: "error", error })
        );
        // Wake on the next frame, the next admitted inbox row, or a slow
        // backstop for the timers below. Rows already present are handled
        // by the delivery step, so the inbox wait only arms when it is empty.
        const stopWaiting = new AbortController();
        const waiters: Promise<ReadOutcome<P> | typeof TICK>[] = [
          pending,
          sleep(DRAIN_TICK_MS).then(() => TICK)
        ];
        if (ctx.inbox.peek({ limit: 1 }).length === 0) {
          waiters.push(ctx.inbox.wait(stopWaiting.signal).then(() => TICK));
        }
        const outcome = await Promise.race(waiters);
        stopWaiting.abort();
        if (outcome.kind !== "tick") {
          pending = undefined;
          if (outcome.kind === "error") {
            await this.#wireFailed(ctx, link, outcome.error);
            return;
          }
          if (outcome.result.done) {
            await this.#wireFailed(
              ctx,
              link,
              new HarnessDetachedError("Daemon closed the event stream")
            );
            return;
          }
          await this.#applyBatch(ctx, link, outcome.result.value);
          lastBatchAt = Date.now();
          this.#reconnectMs = RECONNECT_MIN_MS;
        }
        if (ctx.inbox.peek({ limit: 1 }).length > 0) {
          // Anything delivered buys another read: the frames it produces
          // have not arrived yet, so this is not an idle drain.
          if ((await this.#deliverInbox(ctx, link)) > 0) {
            idleSince = undefined;
            continue;
          }
        }

        const now = Date.now();
        const active = ctx.active();
        const blocked =
          active !== null && ctx.requests.list(active.operationId).length > 0;
        const busy = active !== null && !blocked;
        // A run that produces nothing while it should be working is a dead
        // socket the close event never reported.
        if (busy && now - lastBatchAt >= 2 * idle.renewIntervalMs) {
          await this.#wireFailed(
            ctx,
            link,
            new HarnessDetachedError("Daemon stopped sending frames")
          );
          return;
        }
        if (ctx.attached() || ctx.inbox.peek({ limit: 1 }).length > 0) {
          idleSince = undefined;
          continue;
        }
        if (busy) {
          idleSince = undefined;
          if (now - startedAt >= idle.renewIntervalMs) {
            // Rotate the Tasks run: the next pass re-attaches and renews
            // the container's keep-alive.
            await this.#detach("renew");
            ctx.wake(0);
            return;
          }
          continue;
        }
        idleSince ??= now;
        if (now - idleSince >= idle.detachAfterIdleMs) {
          await this.#detach("idle");
          // The earliest requested wake wins and the driver re-enters at
          // once while the inbox holds a row it progressed on, so the stop
          // timer cannot strand an admitted row; the guard only avoids
          // arming a timer that would be superseded anyway.
          if (this.#quiet(ctx) && ctx.active() === null) {
            this.#scheduleStop(ctx);
          }
          return;
        }
      }
    } finally {
      if (link.reader === reader) link.reader = undefined;
    }
  }

  /** The socket or the stream failed mid-drain. Detach; come back if there is work. */
  async #wireFailed(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>,
    error: unknown
  ): Promise<void> {
    const expected = this.#stopping;
    await this.#detach("wire failure");
    if (expected) return;
    const active = ctx.active();
    const resume =
      active !== null ||
      ctx.attached() ||
      ctx.inbox.peek({ limit: 1 }).length > 0;
    if (!resume) return;
    ctx.wake(this.#reconnectMs);
    this.#reconnectMs = Math.min(RECONNECT_MAX_MS, this.#reconnectMs * 2);
    console.warn(
      `Harness container link for ${link.sessionId} dropped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // ── Applying the wire ────────────────────────────────────────────────────

  async #applyBatch(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>,
    batch: HarnessWireBatch<P>
  ): Promise<void> {
    const touched = new Set<HarnessOperationHandle<P>>();
    if (link.cursor + 1 < batch.floorSeq) {
      // The daemon pruned its outbox past our cursor while we were
      // subscribed: say so on the log and continue from what it still has.
      const log = await ctx.session();
      log.append({
        type: "gap",
        from: link.cursor,
        to: batch.floorSeq,
        reason: "remote outbox truncated"
      });
      touched.add(log);
      link.cursor = batch.floorSeq - 1;
    }
    const frames = [...batch.frames].sort(
      (left, right) => left.seq - right.seq
    );
    for (const frame of frames) {
      if (frame.seq <= link.cursor) continue;
      const handle = await this.#applyFrame(ctx, link, frame);
      if (handle) touched.add(handle);
      link.cursor = frame.seq;
    }
    for (const preview of batch.previews) {
      const handle =
        preview.operationId === null
          ? undefined
          : ctx.operation(preview.operationId);
      handle?.preview(preview.body);
    }
    // The wire cursor rides the same transaction as the frames it counts:
    // the session log anchors the flush and the other handles append inside
    // its commit, so an eviction can never leave frames without the cursor.
    const anchor = await ctx.session();
    anchor.flush({
      commit: () => {
        for (const handle of touched) {
          if (handle !== anchor) handle.flush();
        }
        this.#commitEngineLog(link);
        this.#write(link.sessionId, {
          runtime_id: link.runtimeId,
          last_wire_seq: link.cursor,
          ...(link.engineSessionDirty
            ? { engine_session_id: link.engineSession }
            : {})
        });
        link.engineSessionDirty = false;
      }
    });
    try {
      await link.api.ack({ runtimeId: link.runtimeId, seq: link.cursor });
    } catch {
      // `ack` is advisory: the next `hello` re-derives the floor.
    }
  }

  /** One frame: a control transition, or a durable event on some log. */
  async #applyFrame(
    ctx: HarnessDriveContext<P>,
    link: DaemonLink<P>,
    frame: HarnessWireFrame<P>
  ): Promise<HarnessOperationHandle<P> | undefined> {
    const body = frame.body;
    switch (body.type) {
      case "begin": {
        await ctx.begin(body.operationId, { delivery: body.delivery });
        return undefined;
      }
      case "settle": {
        await ctx.settle(body.operationId, body.settlement);
        return undefined;
      }
      case "request_open": {
        ctx.requests.open(body.request);
        return undefined;
      }
      case "request_close": {
        await ctx.requests.close(
          body.requestId,
          body.by,
          ...(body.reply === undefined ? [] : [body.reply])
        );
        return undefined;
      }
      case "engine_session": {
        this.#noteEngineSession(link, body.engineSessionId);
        if (body.resumed || !link.restoreSent) return undefined;
        // We shipped the transcript and the engine started fresh anyway.
        const log = await ctx.session();
        this.#reportResumeFailure(link.sessionId, link, log);
        return log;
      }
      case "engine_log": {
        // Opaque: buffered here and written in this batch's commit, so one
        // batch is still one row write however many frames it carried.
        this.#noteEngineSession(link, body.engineSessionId);
        const entries = JSON.stringify(body.entries);
        link.pendingLog.push({
          engineSessionId: body.engineSessionId,
          subpath: body.subpath ?? "",
          wireSeq: frame.seq,
          ordinal: this.#nextOrdinal(link.sessionId),
          entries,
          bytes: entries.length
        });
        return undefined;
      }
      default: {
        const event = body as HarnessEventBody<P>;
        const handle = await this.#handle(ctx, frame.operationId);
        handle.append(event, {
          wire: { seq: frame.seq, runtimeId: link.runtimeId }
        });
        await this.#project(link.sessionId, frame.operationId, event);
        return handle;
      }
    }
  }

  /** The log a frame belongs on: its operation's, or the session's. */
  async #handle(
    ctx: HarnessDriveContext<P>,
    operationId: string | null
  ): Promise<HarnessOperationHandle<P>> {
    if (operationId === null) return ctx.session();
    const open = ctx.operation(operationId);
    if (open && !open.closed) return open;
    return ctx.begin(operationId);
  }

  /** Finished messages and tool results are the transcript; the rest is only a frame. */
  async #project(
    sessionId: string,
    operationId: string | null,
    body: HarnessEventBody<P>
  ): Promise<void> {
    const metadata = operationId === null ? {} : { metadata: { operationId } };
    // A tool result belongs in the display transcript too: without it a
    // reader sees the call and never what came back. Idempotent on the id.
    if (body.type === "tool_end") {
      await this.#options.sessions.session(sessionId).appendMessage({
        id: `tool:${body.toolCallId}`,
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: body.toolCallId,
            output: body.output,
            state: "output-available"
          }
        ],
        ...metadata
      });
      return;
    }
    if (body.type !== "message_end") return;
    if (body.role !== "user" && body.role !== "assistant") return;
    await this.#options.sessions.session(sessionId).appendMessage({
      id: body.messageId,
      role: body.role,
      parts: [...body.parts],
      ...metadata
    });
  }

  // ── Link teardown ────────────────────────────────────────────────────────

  async #detach(reason: string, code = 1000): Promise<void> {
    const link = this.#link;
    this.#link = undefined;
    if (!link) return;
    link.closed = true;
    const reader = link.reader;
    link.reader = undefined;
    if (reader) {
      // Cancelling tells the daemon to drop its subscriber, but the answer
      // travels over the socket this call is about to close: never block on
      // it, or a detach can outlive the Tasks run that asked for it.
      await Promise.race([
        reader.cancel(reason).catch(() => undefined),
        sleep(CANCEL_GRACE_MS)
      ]);
    }
    try {
      link.socket.close(code, reason.slice(0, 120));
    } catch {
      // Already closed, or closed by the far side.
    }
  }

  // ── Durable state ────────────────────────────────────────────────────────

  #sql<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...params: (string | number | null)[]
  ): Row[] {
    const storage = this.#storage;
    if (!storage) return [];
    return storage.sql.exec<Row>(query, ...params).toArray();
  }

  #row(sessionId: string): RemoteRow | undefined {
    return this.#sql<RemoteRow>(
      "SELECT * FROM cf_agents_harness_remote WHERE session_id = ?",
      sessionId
    )[0];
  }

  /** The singleton row, minted with a fresh secret before anything starts. */
  async #ensureRow(sessionId: string): Promise<RemoteRow> {
    const existing = this.#row(sessionId);
    if (existing) return existing;
    this.#storage?.sql.exec(
      `INSERT OR IGNORE INTO cf_agents_harness_remote
         (session_id, secret, runtime_id, launch_digest, last_wire_seq, updated_at)
       VALUES (?, ?, NULL, NULL, 0, ?)`,
      sessionId,
      randomHex(16),
      Date.now()
    );
    const row = this.#row(sessionId);
    if (!row) {
      throw new HarnessDetachedError(
        `Harness runtime state for ${sessionId} is unavailable`
      );
    }
    return row;
  }

  /** One row write; the caller batches it with a whole ingested batch. */
  #write(
    sessionId: string,
    patch: {
      readonly runtime_id?: string | null;
      readonly launch_digest?: string;
      readonly last_wire_seq?: number;
      readonly exit_code?: number | null;
      readonly exit_reason?: string | null;
      readonly engine_session_id?: string | null;
      readonly restore_pending?: number;
      readonly restore_runtime_id?: string | null;
    }
  ): void {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    const values = columns.map(
      (column) => (patch as Record<string, string | number | null>)[column]
    );
    this.#storage?.sql.exec(
      `UPDATE cf_agents_harness_remote
         SET ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ?
       WHERE session_id = ?`,
      ...values,
      Date.now(),
      sessionId
    );
  }

  // ── The engine's transcript mirror ───────────────────────────────────────

  /** Remember a new engine session id; the batch's commit makes it durable. */
  #noteEngineSession(link: DaemonLink<P>, engineSessionId: string): void {
    if (link.engineSession === engineSessionId) return;
    // A changed id is a new transcript: the older session's entries stay
    // until the session is deleted, and a restore ships only the current id.
    link.engineSession = engineSessionId;
    link.engineSessionDirty = true;
  }

  /** Say on the session log that the engine did not resume what we sent. */
  #reportResumeFailure(
    sessionId: string,
    link: DaemonLink<P>,
    log: HarnessOperationHandle<P>
  ): void {
    log.append({
      type: "error",
      error: { code: "E_ENGINE_RESUME", message: RESUME_FAILED_MESSAGE }
    });
    // Reported once: the restore record is spent, so neither a reconnect nor
    // a later frame says it again, and nothing re-ships a refused transcript.
    link.restoreSent = false;
    this.#write(sessionId, { restore_runtime_id: null });
  }

  /** Cross-generation append order, assigned on ingest. */
  #nextOrdinal(sessionId: string): number {
    if (this.#logOrdinal === undefined) {
      const high = this.#sql<{ high: number | null }>(
        "SELECT MAX(ordinal) AS high FROM cf_agents_harness_engine_log WHERE session_id = ?",
        sessionId
      )[0]?.high;
      this.#logOrdinal = high ?? 0;
    }
    this.#logOrdinal += 1;
    return this.#logOrdinal;
  }

  /** Write the batch's `engine_log` frames inside its commit. */
  #commitEngineLog(link: DaemonLink<P>): void {
    for (const row of link.pendingLog) {
      this.#storage?.sql.exec(
        `INSERT OR IGNORE INTO cf_agents_harness_engine_log
           (session_id, engine_session_id, runtime_id, wire_seq, ordinal,
            subpath, entries, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        link.sessionId,
        row.engineSessionId,
        link.runtimeId,
        row.wireSeq,
        row.ordinal,
        row.subpath,
        row.entries,
        row.bytes
      );
    }
    link.pendingLog.length = 0;
  }

  /** How many batches of this engine session are stored. */
  #engineLogRows(sessionId: string, engineSessionId: string): number {
    return (
      this.#sql<{ rows: number }>(
        `SELECT COUNT(*) AS rows FROM cf_agents_harness_engine_log
         WHERE session_id = ? AND engine_session_id = ?`,
        sessionId,
        engineSessionId
      )[0]?.rows ?? 0
    );
  }

  /**
   * The stored transcript as `configure({ engineLog })` chunks: append order
   * per transcript, deduped by `uuid`, each chunk under the batch ceiling.
   */
  #restoreChunks(
    sessionId: string,
    engineSessionId: string
  ): readonly EngineLogChunk[] {
    const rows = this.#sql<EngineLogRow>(
      `SELECT subpath, entries, bytes FROM cf_agents_harness_engine_log
       WHERE session_id = ? AND engine_session_id = ?
       ORDER BY ordinal ASC`,
      sessionId,
      engineSessionId
    );
    // One group per stored batch, in the order the engine appended them.
    // The main transcript comes first because it was written first.
    const grouped = new Map<
      string,
      { entries: JsonValue[]; bytes: number }[]
    >();
    const seen = new Set<string>();
    for (const row of rows) {
      const stored = JSON.parse(row.entries) as JsonValue[];
      const kept: JsonValue[] = [];
      for (const entry of stored) {
        const uuid = entryUuid(entry);
        if (uuid !== undefined) {
          // Scoped: a subagent transcript numbers its own entries.
          const key = `${row.subpath}\u0000${uuid}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        kept.push(entry);
      }
      if (kept.length === 0) continue;
      const groups = grouped.get(row.subpath) ?? [];
      groups.push({
        entries: kept,
        // `bytes` is what the batch was stored as, so only a batch the
        // dedupe shortened has to be measured again.
        bytes: kept.length === stored.length ? row.bytes : jsonBytes(kept)
      });
      grouped.set(row.subpath, groups);
    }
    const chunks: { subpath: string; entries: JsonValue[] }[] = [];
    for (const [subpath, groups] of grouped) {
      let open: { subpath: string; entries: JsonValue[] } | undefined;
      let openBytes = 0;
      for (const group of groups) {
        if (
          open !== undefined &&
          openBytes + group.bytes <= HARNESS_MAX_BATCH_BYTES
        ) {
          open.entries.push(...group.entries);
          openBytes += group.bytes;
          continue;
        }
        if (group.bytes <= HARNESS_MAX_BATCH_BYTES) {
          open = { subpath, entries: [...group.entries] };
          openBytes = group.bytes;
          chunks.push(open);
          continue;
        }
        // One batch is bigger than a chunk: split it entry by entry, and
        // let an entry that is oversized on its own ride alone.
        for (const entry of group.entries) {
          const size = jsonBytes(entry);
          if (
            open === undefined ||
            openBytes + size > HARNESS_MAX_BATCH_BYTES
          ) {
            open = { subpath, entries: [] };
            openBytes = 0;
            chunks.push(open);
          }
          open.entries.push(entry);
          openBytes += size;
        }
      }
    }
    return chunks.map((chunk, index) => ({
      engineSessionId,
      subpath: chunk.subpath === "" ? null : chunk.subpath,
      entries: chunk.entries,
      chunk: index,
      chunks: chunks.length
    }));
  }
}

/** The host method the doorbell entrypoint reaches by name. */
type HarnessDoorbellHost = {
  harnessDoorbell(request: Request): Promise<Response>;
};

/**
 * The Worker entrypoint a host re-exports so the daemon can ring the
 * Durable Object by name: `POST <doorbellUrl>?name=<sessionName>` with the
 * secret header. Props name the Durable Object namespace binding.
 */
export class HarnessDoorbell extends WorkerEntrypoint<
  Record<string, unknown>,
  { readonly namespace: string }
> {
  override async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name");
    if (name === null || name === "") {
      return new Response("Missing ?name", { status: 400 });
    }
    // Any name reaches an object: the secret check happens inside it. The
    // bound keeps a stranger from minting objects with kilobyte names.
    if (name.length > MAX_DOORBELL_NAME_LENGTH) {
      return new Response("Name too long", { status: 400 });
    }
    const binding = this.env[this.ctx.props.namespace];
    if (!binding) {
      return new Response(`Unknown namespace ${this.ctx.props.namespace}`, {
        status: 500
      });
    }
    const namespace = binding as DurableObjectNamespace;
    // Structural: the host names the method, the namespace types nothing.
    const host = namespace.getByName(name) as unknown as HarnessDoorbellHost;
    return host.harnessDoorbell(request);
  }
}
