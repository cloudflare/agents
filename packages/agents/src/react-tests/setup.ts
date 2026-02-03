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
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixed port for test worker - must match TEST_WORKER_PORT in vitest.config.ts
export const TEST_WORKER_PORT = 18787;

let worker: Unstable_DevWorker | undefined;

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

// Wait for port to become available with retries
async function waitForPort(
  port: number,
  maxAttempts = 30,
  delayMs = 1000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok || response.status === 404) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export async function setup() {
  // Check if port is already in use (worker already running from another setup call)
  const portAvailable = await isPortAvailable(TEST_WORKER_PORT);
  if (!portAvailable) {
    console.log(
      `[setup] Port ${TEST_WORKER_PORT} already in use, waiting for worker to be ready...`
    );
    // Wait for the worker to be fully ready
    const ready = await waitForPort(TEST_WORKER_PORT, 30, 1000);
    if (ready) {
      console.log("[setup] Worker is ready");
    } else {
      console.warn("[setup] Worker may not be fully ready");
    }
    return;
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
  if (worker) {
    console.log("[teardown] Stopping test worker...");
    try {
      await worker.stop();
    } catch (error) {
      console.error("[teardown] Error stopping worker:", error);
    }
    worker = undefined;
  }
}
