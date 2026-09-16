/**
 * Composition: the outbox, the engine, the doorbell and the Cap'n Web
 * server wired into one running daemon.
 *
 * It is separate from `./main.ts` so a test can start a real daemon on an
 * ephemeral port, drive it over a real socket and stop it again without a
 * process exiting underneath. Everything that reads the environment or
 * touches process signals lives in `main.ts`; everything that has behaviour
 * lives here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocketServer } from "ws";
import {
  HARNESS_HEALTH_PATH,
  HARNESS_RPC_PATH,
  HARNESS_SECRET_HEADER
} from "../../../shared/src/protocol.ts";
import { DaemonRoot } from "./daemon.ts";
import { Doorbell } from "./doorbell.ts";
import { Outbox } from "./outbox.ts";
import type { Engine } from "./engine.ts";
import { EchoEngine } from "./engines/echo.ts";
import { ClaudeCodeEngine } from "./engines/claude-code.ts";
import type { ClaudeCodeOptions } from "../../src/claude-code-types.ts";

/** Bumped when the daemon's own behaviour changes, independently of the engine. */
/**
 * The daemon build, so a runtime can tell which image answered: the
 * package version plus a digest of the running bundle (`dev` when the
 * daemon runs from sources).
 */
export const DAEMON_VERSION = `0.1.0+${bundleDigest()}`;

function bundleDigest(): string {
  try {
    const own = process.argv[1];
    if (!own || !own.endsWith(".mjs")) return "dev";
    return createHash("sha256")
      .update(readFileSync(own))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return "dev";
  }
}
/** One Cap'n Web message from the Durable Object may not exceed this. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const META_RUNTIME_ID = "runtimeId";
const META_ENGINE_SESSION = "engineSessionId";
const META_EXIT = "priorExit";

export type StartOptions = {
  readonly sessionId: string;
  readonly secret: string;
  /** `"claude-code"` or `"echo"`. */
  readonly engineId: string;
  readonly engineOptions: unknown;
  readonly doorbellUrl?: string | undefined;
  /** Extra headers on every doorbell POST (a Cloudflare Access service token). */
  readonly doorbellHeaders?: Readonly<Record<string, string>> | undefined;
  /** 0 asks the operating system for an ephemeral port. */
  readonly port: number;
  /** The generation the Durable Object expected, when it named one. */
  readonly expectedRuntimeId?: string | undefined;
  /** Where the outbox lives. Tests pass `":memory:"`. */
  readonly outboxPath?: string | undefined;
  readonly log?: (...args: readonly unknown[]) => void;
  /** How the process ends. The default kills it; a test swaps this out. */
  readonly exit?: (code: number) => void;
};

export type DaemonHandle = {
  readonly port: number;
  readonly runtimeId: string;
  readonly engine: Engine;
  stop(code: number, reason: string): Promise<void>;
};

/** Build the engine named by `CF_HARNESS_ENGINE`. */
export function createEngine(
  id: string,
  options: unknown,
  resume: string | undefined
): Engine {
  if (id === "echo") return new EchoEngine();
  if (id !== "claude-code") {
    throw new Error(`Unknown engine ${JSON.stringify(id)}`);
  }
  return new ClaudeCodeEngine({
    options: options as ClaudeCodeOptions,
    resume
  });
}

export async function startDaemon(
  options: StartOptions
): Promise<DaemonHandle> {
  const log = options.log ?? ((...args) => console.log("[harnessd]", ...args));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const outbox = new Outbox({
    session: options.sessionId,
    ...(options.outboxPath === undefined ? {} : { path: options.outboxPath })
  });

  // One generation per process, persisted so a daemon restarted under the
  // same container keeps it. A new container brings a new outbox and
  // therefore a new generation, which is exactly the fence the wire wants.
  const runtimeId = outbox.getMeta(META_RUNTIME_ID) ?? crypto.randomUUID();
  outbox.setMeta(META_RUNTIME_ID, runtimeId);
  if (
    options.expectedRuntimeId !== undefined &&
    options.expectedRuntimeId !== "" &&
    options.expectedRuntimeId !== runtimeId
  ) {
    log(
      `the runtime expected generation ${options.expectedRuntimeId}; this one is ${runtimeId}`
    );
  }

  const priorExitRaw = outbox.getMeta(META_EXIT);
  outbox.deleteMeta(META_EXIT);
  const priorExit =
    priorExitRaw === undefined
      ? null
      : (JSON.parse(priorExitRaw) as {
          readonly code: number | null;
          readonly reason: string;
        });

  // The stored engine session is a fallback for a daemon restarted inside a
  // surviving container, where the engine's own transcript is still on the
  // local disk. A `configure({ resume })` from the Durable Object supersedes
  // it: that one comes with the transcript attached.
  const engine = createEngine(
    options.engineId,
    options.engineOptions,
    outbox.getMeta(META_ENGINE_SESSION)
  );
  const doorbell = new Doorbell({
    url: options.doorbellUrl,
    headers: options.doorbellHeaders,
    secret: options.secret,
    sessionId: options.sessionId,
    log
  });

  let closing = false;
  const stop = async (code: number, reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`stopping: ${reason}`);
    outbox.setMeta(META_EXIT, JSON.stringify({ code, reason }));
    const session = engine.engineSession;
    if (session) outbox.setMeta(META_ENGINE_SESSION, session.id);
    try {
      await daemon.dispose(reason);
    } catch (error) {
      log("dispose failed", error);
    }
    sockets.close();
    server.close();
    for (const socket of open) socket.destroy();
    outbox.close();
    exit(code);
  };

  const daemon = new DaemonRoot({
    sessionId: options.sessionId,
    secret: options.secret,
    runtimeId,
    daemonVersion: DAEMON_VERSION,
    engine,
    outbox,
    doorbell,
    priorExit,
    log,
    onShutdown: (reason) => {
      // Reply first, then leave: the Durable Object is awaiting this call.
      setTimeout(() => {
        void stop(0, reason);
      }, 50).unref?.();
    }
  });
  await engine.start(daemon.engineContext());
  daemon.restoreOpenRequests();

  const open = new Set<Duplex>();
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://harnessd").pathname;
    if (path === HARNESS_HEALTH_PATH) {
      // Never authenticated: the platform and the runtime both probe it
      // before either holds a secret to offer.
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.method === "HEAD" ? undefined : "ok");
      return;
    }
    response.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    const path = new URL(request.url ?? "/", "http://harnessd").pathname;
    if (path !== HARNESS_RPC_PATH) {
      socket.destroy();
      return;
    }
    if (
      !secretMatches(request.headers[HARNESS_SECRET_HEADER], options.secret)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      // The Durable Object exports nothing: `DaemonRoot` is the only
      // capability on the wire, and events ride the stream `subscribe()`
      // hands back.
      // `ws` implements the parts of the standard interface Cap'n Web uses;
      // the Node typing simply lacks `dispatchEvent`.
      newWebSocketRpcSession(ws as unknown as WebSocket, daemon);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, "0.0.0.0", resolve);
  });
  const address = server.address() as AddressInfo;
  log(
    `listening on ${address.port} (session ${options.sessionId}, engine ${engine.id} ${engine.version}, generation ${runtimeId})`
  );
  return { port: address.port, runtimeId, engine, stop };
}

/** Length-safe, constant-time comparison of the shared secret. */
export function secretMatches(
  header: string | readonly string[] | undefined,
  secret: string
): boolean {
  const given = Array.isArray(header) ? header[0] : header;
  if (typeof given !== "string" || given.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index += 1) {
    difference |= given.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return difference === 0;
}
