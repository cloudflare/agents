/**
 * `harnessd`: PID 1 inside the harness container.
 *
 * Being PID 1 is the point. "The daemon died" and "the container died"
 * collapse into one signal the Durable Object already watches
 * (`container.monitor()`) and into one fence (`runtimeId`), so there is no
 * third state where a live container hosts a dead engine.
 *
 * This file is the process: it reads `CF_HARNESS_*` out of the environment,
 * starts the daemon, and translates signals and unhandled errors into exit
 * codes. The daemon itself is `./server.ts`.
 */
import { HARNESS_ENV } from "../../../shared/src/protocol.ts";
import { startDaemon } from "./server.ts";

const DEFAULT_PORT = 8787;

/** A JSON object of header names to values, or nothing. */
function parseHeaders(
  raw: string | undefined
): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") headers[name] = value;
    }
    return headers;
  } catch {
    return undefined;
  }
}

function log(...args: readonly unknown[]): void {
  console.log("[harnessd]", ...args);
}

async function main(): Promise<void> {
  const env = process.env;
  let engineOptions: unknown = {};
  try {
    engineOptions = JSON.parse(env[HARNESS_ENV.engineOptions] ?? "{}");
  } catch (error) {
    log("ignoring unparsable engine options", error);
  }

  const daemon = await startDaemon({
    sessionId: env[HARNESS_ENV.sessionId] ?? "main",
    secret: env[HARNESS_ENV.secret] ?? "",
    engineId: env[HARNESS_ENV.engine] ?? "claude-code",
    engineOptions,
    doorbellUrl: env[HARNESS_ENV.doorbellUrl],
    doorbellHeaders: parseHeaders(env[HARNESS_ENV.doorbellHeaders]),
    expectedRuntimeId: env[HARNESS_ENV.runtimeId],
    port: Number(env[HARNESS_ENV.port] ?? DEFAULT_PORT),
    log
  });

  // The platform sends SIGTERM and then SIGKILL, so a clean stop is a
  // best-effort flush rather than a guarantee. Exit 0 and 143 are the two
  // codes the runtime treats as resumable.
  process.on("SIGTERM", () => {
    void daemon.stop(0, "SIGTERM");
  });
  process.on("SIGINT", () => {
    void daemon.stop(0, "SIGINT");
  });
  process.on("uncaughtException", (error) => {
    log("uncaught exception", error);
    void daemon.stop(1, "uncaughtException");
  });
  process.on("unhandledRejection", (error) => {
    log("unhandled rejection", error);
    void daemon.stop(1, "unhandledRejection");
  });
}

main().catch((error: unknown) => {
  log("failed to start", error);
  process.exit(1);
});
