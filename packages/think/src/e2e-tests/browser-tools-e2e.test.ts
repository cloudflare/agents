import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18799;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-browser-e2-e-agent";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-browser-e2e-state");

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
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already dead
        }
      }
    }
  } catch {
    // lsof may be unavailable
  }
}

function startWrangler(): ChildProcess {
  const configPath = path.join(__dirname, "wrangler.browser.jsonc");
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--port",
      String(PORT),
      "--persist-to",
      PERSIST_DIR,
      "--inspector-port",
      "0"
    ],
    {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });

  return child;
}

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status > 0) return;
    } catch {
      // Not ready
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
    setTimeout(resolve, 3000);
  });
}

async function callAgent(
  room: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${BASE_URL}/agents/${AGENT_SLUG}/${room}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out`));
    }, 30_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type?: string;
          id?: string;
          success?: boolean;
          result?: unknown;
          error?: string;
        };
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error || "RPC failed"));
          }
        }
      } catch {
        // Ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

describe("think browser tools e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    wrangler = startWrangler();
    await waitForReady();
  }, 120_000);

  afterAll(async () => {
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  }, 30_000);

  it("reuses a real Browser Run session through Think browser tools", async () => {
    const room = `browser-e2e-${Date.now()}`;

    const first = (await callAgent(room, "executeBrowserTool", [
      `async () => {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const sessionId = await cdp.attachToTarget(targetId);
        await cdp.send("Runtime.enable", {}, { sessionId });
        await cdp.send("Page.navigate", { url: "data:text/html,<title>Think Browser E2E</title><body>persisted</body>" }, { sessionId });
        for (let i = 0; i < 20; i++) {
          const { result } = await cdp.send("Runtime.evaluate", { expression: "document.title" }, { sessionId });
          if (result.value === "Think Browser E2E") break;
          await new Promise(r => setTimeout(r, 50));
        }
        return { targetId };
      }`
    ])) as string;

    const { targetId } = JSON.parse(first) as { targetId: string };
    expect(targetId).toBeTruthy();

    const second = (await callAgent(room, "executeBrowserTool", [
      `async () => {
        const { targetInfos } = await cdp.send("Target.getTargets");
        const target = targetInfos.find(t => t.targetId === ${JSON.stringify(targetId)});
        if (!target) return { found: false };
        const sessionId = await cdp.attachToTarget(target.targetId);
        const { result } = await cdp.send("Runtime.evaluate", { expression: "document.title" }, { sessionId });
        return { found: true, title: result.value };
      }`
    ])) as string;

    expect(JSON.parse(second)).toEqual({
      found: true,
      title: "Think Browser E2E"
    });

    const info = (await callAgent(room, "browserSessionInfo")) as string;
    const parsedInfo = JSON.parse(info) as {
      sessionId?: string;
      targets?: Array<{ id: string; devtoolsFrontendUrl?: string }>;
    };
    expect(parsedInfo.sessionId).toBeTruthy();
    expect(parsedInfo.targets?.some((target) => target.id === targetId)).toBe(
      true
    );
    expect(
      parsedInfo.targets?.some((target) => target.devtoolsFrontendUrl)
    ).toBe(true);

    await callAgent(room, "closeBrowserSession");
  });
});
