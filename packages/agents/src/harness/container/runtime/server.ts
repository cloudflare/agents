/**
 * The daemon's transport: an HTTP server that answers the health check and
 * upgrades `/sessions/<id>` to a WebSocket for the daemon core. The Durable
 * Object reaches it through `ctx.container.getTcpPort(port)`.
 *
 * Every request except the health check must carry the token the object
 * started the container with. The health check stays open so that a wrong
 * token looks different from a dead container.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  CLOSE_UNAUTHORIZED,
  CONTAINER_ENV,
  CONTAINER_HEALTH_PATH,
  CONTAINER_SESSION_PATH,
  CONTAINER_TOKEN_HEADER
} from "../protocol";
import { ContainerDaemon, type ContainerAdapter } from "../daemon-core";
import { acceptWebSocket, type ServerSocket } from "./websocket";

/** `serve`'s options. */
export type ServeOptions = {
  readonly adapter: ContainerAdapter;
  /** This container's id, from `CF_HARNESS_RUNTIME_ID`. */
  readonly runtimeId: string;
  /** The shared secret, from `CF_HARNESS_TOKEN`. */
  readonly token: string;
  /** Port to listen on; 0 picks one. */
  readonly port: number;
  /** Interface to bind. Default all interfaces. */
  readonly host?: string;
};

/** A running daemon. */
export type DaemonServer = {
  /** The port it listens on. */
  readonly port: number;
  /** Stop accepting connections and close every adapter session. */
  close(): Promise<void>;
};

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Start the daemon.
 *
 * @param options - The adapter, identity, secret, and port.
 * @returns The running server, once it listens.
 *
 * @experimental The API may change before it stabilizes.
 */
export async function serve(options: ServeOptions): Promise<DaemonServer> {
  const daemon = new ContainerDaemon({
    adapter: options.adapter,
    runtimeId: options.runtimeId
  });
  const sockets = new Set<ServerSocket>();
  const server: Server = createServer((request, response) => {
    if (request.url === CONTAINER_HEALTH_PATH) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://container");
      if (!url.pathname.startsWith(CONTAINER_SESSION_PATH)) {
        socket.destroy();
        return;
      }
      const session = decodeURIComponent(
        url.pathname.slice(CONTAINER_SESSION_PATH.length)
      );
      const header = request.headers[CONTAINER_TOKEN_HEADER];
      const authorized = tokenMatches(
        options.token,
        Array.isArray(header) ? header[0] : header
      );
      if (!authorized || session.length === 0) {
        const refused = acceptWebSocket(request, socket, head, {
          message: () => {},
          closed: () => {}
        });
        refused?.close(CLOSE_UNAUTHORIZED, "unauthorized");
        return;
      }
      // Turns can be silent for many minutes while a tool runs; a quiet
      // socket is never dropped.
      let connection: ReturnType<ContainerDaemon["connect"]> | undefined;
      const ws = acceptWebSocket(request, socket, head, {
        message: (text) => connection?.receive(text),
        closed: () => {
          if (ws) sockets.delete(ws);
          connection?.closed();
        }
      });
      if (!ws) return;
      sockets.add(ws);
      connection = daemon.connect(session, ws);
    }
  );

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host ?? "0.0.0.0", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    async close() {
      for (const client of sockets) client.close(1001, "shutting down");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await daemon.close();
    }
  };
}

/**
 * Start the daemon with the identity, secret, and port the Durable Object
 * started the container with, and stop it on SIGTERM. The entrypoint of an
 * image: `serveFromEnv(cliAdapter({ ... }))`.
 *
 * @param adapter - The agent to run.
 * @param env - The environment. Default `process.env`.
 * @returns The running server.
 *
 * @experimental The API may change before it stabilizes.
 */
export async function serveFromEnv(
  adapter: ContainerAdapter,
  env: NodeJS.ProcessEnv = process.env
): Promise<DaemonServer> {
  const token = env[CONTAINER_ENV.token];
  const runtimeId = env[CONTAINER_ENV.runtimeId];
  const port = Number(env[CONTAINER_ENV.port] ?? "8080");
  if (!token || !runtimeId || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `${CONTAINER_ENV.token}, ${CONTAINER_ENV.runtimeId} and ${CONTAINER_ENV.port} must be set; ContainerHarness sets them`
    );
  }
  // The agent's tools run arbitrary commands; they need not see the token.
  delete env[CONTAINER_ENV.token];
  const server = await serve({ adapter, runtimeId, token, port });
  console.log(`harness-daemon: ${adapter.id} on ${server.port} (${runtimeId})`);
  const stop = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}
