import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18798;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_NAME = "browser-test";
const PERSIST_DIR = path.join(__dirname, ".wrangler-browser-state");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      .toString()
      .trim();
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  } catch {
    // ignore
  }
}

function startWrangler(): ChildProcess {
  const configPath = path.join(__dirname, "wrangler.jsonc");
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
      PERSIST_DIR
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

async function waitForReady(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status > 0) return;
    } catch {
      // not ready
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
        // already dead
      }
    }
    setTimeout(resolve, 3000);
  });
}

async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${BASE_URL}/agents/browser-test-agent/${AGENT_NAME}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out after 30s`));
    }, 30_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
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
        // ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("browser tools integration", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    wrangler = startWrangler();
    await waitForReady();
  });

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
  });

  // ── Search tool tests ───────────────────────────────────────────

  describe("search", () => {
    it("should list CDP domain names", async () => {
      const result = (await callAgent("testSearch", [
        "async () => { const s = await spec.get(); return s.domains.map(d => d.name); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const domains = JSON.parse(result.text);
      expect(domains).toContain("Network");
      expect(domains).toContain("DOM");
      expect(domains).toContain("Page");
      expect(domains).toContain("Runtime");
      expect(domains).toContain("Browser");
    });

    it("should find specific commands in a domain", async () => {
      const result = (await callAgent("testSearch", [
        `async () => {
          const s = await spec.get();
          const network = s.domains.find(d => d.name === "Network");
          return network.commands.map(c => c.method);
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const methods = JSON.parse(result.text);
      expect(methods).toContain("Network.enable");
      expect(methods).toContain("Network.disable");
    });

    it("should return spec totals", async () => {
      const result = (await callAgent("testSearch", [
        `async () => {
          const s = await spec.get();
          return {
            domains: s.domains.length,
            commands: s.domains.reduce((n, d) => n + d.commands.length, 0)
          };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const totals = JSON.parse(result.text);
      expect(totals.domains).toBeGreaterThan(50);
      expect(totals.commands).toBeGreaterThan(600);
    });

    it("should handle code errors gracefully", async () => {
      const result = (await callAgent("testSearch", [
        "async () => { throw new Error('intentional test error'); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.text).toContain("intentional test error");
    });
  });

  // ── Execute tool tests ──────────────────────────────────────────

  describe("execute", () => {
    it("should get browser version via CDP", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { return await cdp.send("Browser.getVersion"); }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const version = JSON.parse(result.text);
      expect(version).toHaveProperty("product");
      expect(version).toHaveProperty("userAgent");
    });

    it("should list browser targets", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetInfos } = await cdp.send("Target.getTargets");
          return targetInfos.map(t => ({ type: t.type, url: t.url }));
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const targets = JSON.parse(result.text);
      expect(Array.isArray(targets)).toBe(true);
    });

    it("should create a page and navigate", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
          const sessionId = await cdp.attachToTarget(targetId);
          await cdp.send("Page.enable", {}, { sessionId });
          const nav = await cdp.send("Page.navigate", { url: "data:text/html,<h1>Hello CDP</h1>" }, { sessionId });
          const { root } = await cdp.send("DOM.getDocument", {}, { sessionId });
          const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId: root.nodeId }, { sessionId });
          await cdp.send("Target.closeTarget", { targetId });
          return { frameId: nav.frameId, html: outerHTML };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const page = JSON.parse(result.text);
      expect(page.frameId).toBeTruthy();
      expect(page.html).toContain("Hello CDP");
    });

    it("should access the debug log", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await cdp.send("Browser.getVersion");
          const log = await cdp.getDebugLog(10);
          return { logLength: log.length, hasSend: log.some(e => e.type === "send") };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const debug = JSON.parse(result.text);
      expect(debug.logLength).toBeGreaterThan(0);
      expect(debug.hasSend).toBe(true);
    });

    it("should handle CDP errors gracefully", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { return await cdp.send("NonExistent.method"); }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
    });

    it("should handle code errors gracefully", async () => {
      const result = (await callAgent("testExecute", [
        "async () => { throw new Error('execute test error'); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.text).toContain("Error");
    });
  });
});
