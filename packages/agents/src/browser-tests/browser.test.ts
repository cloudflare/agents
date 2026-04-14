import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18798;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_NAME = "browser-test";
const PERSIST_DIR = path.join(__dirname, ".wrangler-browser-state");
const WRANGLER_PACKAGE = process.env.WRANGLER_PACKAGE || "wrangler";

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
      WRANGLER_PACKAGE,
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

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
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

describe("browser tools e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    wrangler = startWrangler();
    await waitForReady();
  }, 120000);

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
  }, 30000);

  describe("cdp spec search", () => {
    it("should fetch and query the CDP spec", async () => {
      const result = (await callAgent("testSearch", [
        `async () => {
          const s = await spec.get();
          return {
            domainCount: s.domains.length,
            hasNetwork: s.domains.some(d => d.name === "Network"),
            hasDOM: s.domains.some(d => d.name === "DOM")
          };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.domainCount).toBeGreaterThan(50);
      expect(parsed.hasNetwork).toBe(true);
      expect(parsed.hasDOM).toBe(true);
    });

    it("should find Network domain commands", async () => {
      const result = (await callAgent("testSearch", [
        `async () => {
          const s = await spec.get();
          const network = s.domains.find(d => d.name === "Network");
          return {
            hasEnable: network.commands.some(c => c.name === "enable"),
            method: network.commands.find(c => c.name === "enable")?.method
          };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.hasEnable).toBe(true);
      expect(parsed.method).toBe("Network.enable");
    });

    it("should handle errors in search code gracefully", async () => {
      const result = (await callAgent("testSearch", [
        "async () => { throw new Error('search test error'); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.text).toContain("search test error");
    });
  });

  describe("browser execute", () => {
    it("should get browser version", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { return await cdp.send("Browser.getVersion"); }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const version = JSON.parse(result.text);
      expect(version).toHaveProperty("product");
      expect(version).toHaveProperty("userAgent");
      expect(version).toHaveProperty("protocolVersion");
    });

    it("should list targets", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { const { targetInfos } = await cdp.send("Target.getTargets"); return targetInfos.length; }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const count = JSON.parse(result.text);
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("should create target and navigate", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
          const sessionId = await cdp.attachToTarget(targetId);
          await cdp.send("Page.enable", {}, { sessionId });
          const nav = await cdp.send("Page.navigate", { url: "data:text/html,<h1>Test Page</h1>" }, { sessionId });
          return { targetId, frameId: nav.frameId };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.targetId).toBeTruthy();
      expect(parsed.frameId).toBeTruthy();
    });

    it("should get DOM document", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
          const sessionId = await cdp.attachToTarget(targetId);
          await cdp.send("DOM.enable", {}, { sessionId });
          const { root } = await cdp.send("DOM.getDocument", {}, { sessionId });
          return { nodeId: root.nodeId, nodeType: root.nodeType };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.nodeId).toBeGreaterThan(0);
      expect(parsed.nodeType).toBe(9); // DOCUMENT_NODE
    });

    it("should use debug log", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await cdp.send("Browser.getVersion");
          await cdp.send("Target.getTargets");
          const log = await cdp.getDebugLog(5);
          return { logLength: log.length, hasSends: log.some(e => e.type === "send") };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.logLength).toBeGreaterThan(0);
      expect(parsed.hasSends).toBe(true);
    });

    it("should handle CDP command errors", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { return await cdp.send("InvalidDomain.invalidMethod"); }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
    });

    it("should handle code execution errors", async () => {
      const result = (await callAgent("testExecute", [
        "async () => { throw new Error('execute test error'); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.text).toContain("execute test error");
    });

    it("should handle missing required parameters", async () => {
      const result = (await callAgent("testExecute", [
        "async () => { return await cdp.send(); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
    });
  });

  describe("integration scenarios", () => {
    it("should navigate to a page and get its title", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
          const sessionId = await cdp.attachToTarget(targetId);
          await cdp.send("Runtime.enable", {}, { sessionId });
          await cdp.send("Page.navigate", { url: "data:text/html,<title>Test Title</title><body>Hello</body>" }, { sessionId });
          // Small delay for page load
          await new Promise(r => setTimeout(r, 100));
          const { result: titleResult } = await cdp.send("Runtime.evaluate", { expression: "document.title" }, { sessionId });
          return { title: titleResult.value };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.title).toBe("Test Title");
    });

    it("should take a screenshot", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
          const sessionId = await cdp.attachToTarget(targetId);
          await cdp.send("Page.enable", {}, { sessionId });
          await cdp.send("Page.navigate", { url: "data:text/html,<body style='background:red;width:100px;height:100px;'>" }, { sessionId });
          await new Promise(r => setTimeout(r, 100));
          const { data } = await cdp.send("Page.captureScreenshot", {}, { sessionId });
          return { hasData: !!data, dataLength: data?.length || 0 };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.hasData).toBe(true);
      expect(parsed.dataLength).toBeGreaterThan(0);
    });
  });
});
