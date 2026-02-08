/**
 * E2E Test Setup - Spawns wrangler dev server
 *
 * This runs before all E2E tests and starts a wrangler dev server.
 * The server URL is written to a file that tests can read.
 *
 * Usage:
 *   npm run test:e2e                    # Auto-starts wrangler dev
 *   E2E_URL=https://... npm run test:e2e # Uses external URL (CI)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  rmSync
} from "node:fs";
import { join } from "node:path";

const E2E_PORT = process.env.E2E_PORT || "8799";
const STARTUP_TIMEOUT = 60000; // 60 seconds for wrangler to start
const HEALTH_CHECK_INTERVAL = 500;

// File to store server info between setup and tests
const CONFIG_FILE = join(process.cwd(), "e2e", ".e2e-config.json");

// Separate persistence directory for e2e tests (avoids polluting dev .wrangler state)
const E2E_PERSIST_DIR = join(process.cwd(), ".wrangler-e2e");

let wranglerProcess: ChildProcess | null = null;

/**
 * Load .env file manually (no dotenv dependency needed)
 */
function loadEnvFile(): void {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Only set if not already in environment
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    console.log("[E2E] Loaded .env file");
  } catch (error) {
    console.warn("[E2E] Could not load .env file:", error);
  }
}

export async function setup() {
  // Load .env file for API keys
  loadEnvFile();

  // Clean up any stale config file
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }

  // If external URL provided, skip spawning wrangler
  if (process.env.E2E_URL) {
    console.log(`\n[E2E] Using external URL: ${process.env.E2E_URL}`);
    writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        baseUrl: process.env.E2E_URL,
        pid: null,
        hasApiKey: !!process.env.OPENAI_API_KEY
      })
    );
    return;
  }

  console.log(`\n[E2E] Starting wrangler dev on port ${E2E_PORT}...`);

  // Clean up previous e2e persistence state for a fresh start
  if (existsSync(E2E_PERSIST_DIR)) {
    rmSync(E2E_PERSIST_DIR, { recursive: true, force: true });
    console.log("[E2E] Cleaned up previous e2e state");
  }

  // Build wrangler args with --var for each needed variable
  // Use --persist-to to isolate e2e state from dev .wrangler
  const wranglerArgs = [
    "wrangler",
    "dev",
    "--port",
    E2E_PORT,
    "--local",
    "--persist-to",
    E2E_PERSIST_DIR,
    "--var",
    "ENABLE_SUBAGENT_API:true"
  ];

  // Pass API keys via --var if available
  if (process.env.OPENAI_API_KEY) {
    wranglerArgs.push("--var", `OPENAI_API_KEY:${process.env.OPENAI_API_KEY}`);
    console.log("[E2E] OPENAI_API_KEY found - LLM tests will run");
  } else {
    console.log("[E2E] No OPENAI_API_KEY - LLM tests will be skipped");
  }

  if (process.env.BRAVE_API_KEY) {
    wranglerArgs.push("--var", `BRAVE_API_KEY:${process.env.BRAVE_API_KEY}`);
  }

  // Spawn wrangler dev with subagent API enabled via --var
  wranglerProcess = spawn("npx", wranglerArgs, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    // Detach so we can kill it cleanly
    detached: false
  });

  // Collect output for debugging
  let stdout = "";
  let stderr = "";

  wranglerProcess.stdout?.on("data", (data) => {
    stdout += data.toString();
    // Log wrangler output in real-time for debugging
    if (process.env.E2E_VERBOSE) {
      process.stdout.write(data);
    }
  });

  wranglerProcess.stderr?.on("data", (data) => {
    stderr += data.toString();
    if (process.env.E2E_VERBOSE) {
      process.stderr.write(data);
    }
  });

  wranglerProcess.on("error", (error) => {
    console.error("[E2E] Failed to start wrangler:", error.message);
  });

  wranglerProcess.on("exit", (code, _signal) => {
    if (code !== null && code !== 0) {
      console.error(`[E2E] Wrangler exited with code ${code}`);
      console.error("[E2E] stdout:", stdout.slice(-1000));
      console.error("[E2E] stderr:", stderr.slice(-1000));
    }
  });

  // Wait for server to be ready
  const baseUrl = `http://localhost:${E2E_PORT}`;
  await waitForServer(baseUrl, STARTUP_TIMEOUT);

  // Write config for tests to read (including API key availability)
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      baseUrl,
      pid: wranglerProcess.pid,
      hasApiKey: !!process.env.OPENAI_API_KEY
    })
  );

  console.log(`[E2E] Server ready at ${baseUrl}\n`);
}

async function waitForServer(baseUrl: string, timeout: number): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      // Try to hit a simple endpoint
      const controller = new AbortController();
      const timeoutId = globalThis.setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_INTERVAL
      );

      const response = await fetch(`${baseUrl}/`, {
        method: "GET",
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Any response means server is up (even 404 is fine)
      if (response.status) {
        return;
      }
    } catch {
      // Server not ready yet, keep trying
    }

    await sleep(HEALTH_CHECK_INTERVAL);
  }

  // Timeout reached
  throw new Error(
    `[E2E] Server failed to start within ${timeout}ms. ` +
      "Check wrangler output with E2E_VERBOSE=true"
  );
}

export async function teardown() {
  // Read config to get PID
  let pid: number | null = null;

  try {
    if (existsSync(CONFIG_FILE)) {
      const config = JSON.parse(
        require("node:fs").readFileSync(CONFIG_FILE, "utf-8")
      );
      pid = config.pid;
      // Clean up config file
      unlinkSync(CONFIG_FILE);
    }
  } catch {
    // Config file might not exist
  }

  if (pid) {
    console.log(`\n[E2E] Stopping wrangler dev (PID: ${pid})...`);

    try {
      // Kill the process group
      process.kill(pid, "SIGTERM");

      // Give it a moment to clean up
      await sleep(1000);

      // Force kill if still running
      try {
        process.kill(pid, 0); // Check if still alive
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already exited, which is fine
      }

      console.log("[E2E] Wrangler stopped\n");
    } catch (error) {
      // Process might already be dead
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error("[E2E] Error stopping wrangler:", error);
      }
    }
  }

  // Clean up e2e persistence directory
  if (existsSync(E2E_PERSIST_DIR)) {
    rmSync(E2E_PERSIST_DIR, { recursive: true, force: true });
    console.log("[E2E] Cleaned up e2e state");
  }
}
