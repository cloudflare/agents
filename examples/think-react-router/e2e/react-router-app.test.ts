import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "..");
const PORT = 18808;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(
      `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`
    )
      .toString()
      .trim();
    for (const pid of output.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  } catch {
    // lsof may not be available.
  }
}

function startViteDev(): ChildProcess {
  const child = spawn(
    "npx",
    ["vite", "dev", "--host", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: APP_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[vite] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[vite:err] ${line}`);
  });

  return child;
}

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${BASE_URL}/host`);
      if (response.status === 200) return;
    } catch {
      // Vite/workerd is still starting.
    }
    await sleep(delayMs);
  }
  throw new Error("React Router Think app did not start in time");
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    const fallback = setTimeout(resolve, 3000);
    child.on("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  });
}

async function openAgentWebSocket(pathname: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${BASE_URL}${pathname}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out opening WebSocket for ${pathname}`));
    }, 10_000);

    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Failed to open WebSocket for ${pathname}`));
    };
  });
}

describe("React Router host app with Think", () => {
  let devServer: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    devServer = startViteDev();
    await waitForReady();
  }, 90_000);

  afterAll(async () => {
    if (devServer) {
      await killProcess(devServer);
      devServer = null;
    }
    killProcessOnPort(PORT);
  });

  it("serves React Router document routes through the host app", async () => {
    const response = await fetch(`${BASE_URL}/host`);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("React Router host:");
    expect(body).toContain("env");
    expect(body).toContain("ctx");
  });

  it("falls through to Think routes for generated agents", async () => {
    await openAgentWebSocket("/api/agents/host/e2e-room");
  });
});
