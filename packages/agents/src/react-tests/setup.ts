/**
 * Global setup for React/Client integration tests.
 * Starts a miniflare worker that tests can connect to via WebSocket.
 *
 * Note: In vitest browser mode, globalSetup may be called multiple times.
 * We use port availability check to ensure only one worker is started.
 */
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixed port for test worker - must match TEST_WORKER_PORT in vitest.config.ts
export const TEST_WORKER_PORT = 18787;

let worker: Unstable_DevWorker | undefined;
let signalHandlersInstalled = false;

// Check if port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Kill any process listening on the given port.
 * Handles stale processes left behind by previous test runs that were
 * forcefully terminated (e.g., Ctrl+C, timeout kill) before teardown ran.
 */
function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      .toString()
      .trim();
    if (output) {
      const pids = output.split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
          console.log(`[setup] Killed stale process ${pid} on port ${port}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // lsof not available or other error — ignore
  }
}

async function stopWorker() {
  if (worker) {
    console.log("[teardown] Stopping test worker...");
    try {
      await worker.stop();
    } catch (error) {
      console.error("[teardown] Error stopping worker:", error);
      // If graceful stop fails, force-kill whatever is on our port
      killProcessOnPort(TEST_WORKER_PORT);
    }
    worker = undefined;
  }
}

export async function setup() {
  // Kill any stale processes left on the port from a previous run
  // that was forcefully terminated before teardown could run.
  const portAvailable = await isPortAvailable(TEST_WORKER_PORT);
  if (!portAvailable) {
    console.log(
      `[setup] Port ${TEST_WORKER_PORT} in use — killing stale process...`
    );
    killProcessOnPort(TEST_WORKER_PORT);
    // Brief wait for the OS to release the port
    await new Promise((r) => setTimeout(r, 500));
  }

  // Install signal handlers so teardown runs even on Ctrl+C / kill.
  // Only install once to avoid stacking handlers across setup calls.
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    const onSignal = () => {
      stopWorker().finally(() => process.exit(1));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  console.log("[setup] Starting test worker...");
  const testsDir = path.resolve(__dirname, "../tests");
  const workerPath = path.join(testsDir, "worker.ts");
  const configPath = path.join(testsDir, "wrangler.jsonc");

  try {
    worker = await unstable_dev(workerPath, {
      config: configPath,
      experimental: {
        disableExperimentalWarning: true
      },
      port: TEST_WORKER_PORT,
      // Bind to all interfaces so Playwright browser can access it
      ip: "0.0.0.0",
      persist: false,
      logLevel: "warn"
    });

    console.log(
      `[setup] Test worker started at http://127.0.0.1:${TEST_WORKER_PORT}`
    );
  } catch (error) {
    console.error("[setup] Failed to start test worker:", error);
    throw error;
  }
}

export async function teardown() {
  await stopWorker();
}
