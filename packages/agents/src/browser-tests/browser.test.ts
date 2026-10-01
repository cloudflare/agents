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
      // No stdin pipe: `wrangler dev` never reads it here, and leaving a live
      // writable pipe open is one more surface that can emit an unhandled EPIPE
      // (and crash this forked vitest worker) when we SIGKILL the process group.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  // A kill-time EPIPE/ECONNRESET on the child or its pipes must never become an
  // uncaught exception — that would take down the whole forked vitest worker and
  // make tinypool report "Worker exited unexpectedly" even though every test
  // passed. These no-op error handlers stay attached for the child's lifetime.
  child.on("error", () => {});
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});

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

    // Detach the data relays and stop reading the pipes BEFORE killing. We
    // SIGKILL the whole `wrangler dev` process group (workerd + Chromium
    // included) while its stdio is piped into this forked vitest worker; a
    // kill-time EPIPE or late write would otherwise race the worker's own
    // shutdown and make tinypool report "Worker exited unexpectedly" (failing
    // the run even though every test passed).
    //
    // NOTE: only the "data" listeners are removed — the no-op "error" handlers
    // installed in startWrangler MUST stay attached, otherwise a teardown EPIPE
    // becomes an uncaught exception and crashes this worker.
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.once("exit", done);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    setTimeout(done, 3000).unref();
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
      reject(new Error(`RPC call ${method} timed out after 60s`));
    }, 60_000);

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

interface RunOutput {
  status: "completed" | "paused" | "error";
  executionId: string;
  result?: unknown;
  error?: string;
  pending?: Array<{ connector: string; method: string }>;
}

type StoredSessions = Record<
  string,
  { sessionId: string; createdAt: number; updatedAt: number }
>;

interface NamedRunOutput extends RunOutput {
  report: {
    restarted: boolean;
    newTabs: Array<{ targetId: string; url?: string }>;
  } | null;
}

/** Run code against the persistent named browser. */
async function runNamed(code: string): Promise<NamedRunOutput> {
  return (await callAgent("runNamed", [code])) as NamedRunOutput;
}

async function run(
  code: string,
  mode: "one-shot" | "reuse" | "dynamic" = "one-shot"
): Promise<RunOutput> {
  return (await callAgent("run", [code, mode])) as RunOutput;
}

function execEntries(sessions: StoredSessions) {
  return Object.entries(sessions).filter(([key]) =>
    key.startsWith("cdp:exec:")
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("browser connector e2e", () => {
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

  describe("cdp spec", () => {
    it("should fetch and query the CDP spec", async () => {
      const output = await run(
        `async () => {
          const s = await cdp.spec({});
          return {
            domainCount: s.domains.length,
            hasNetwork: s.domains.some((d) => d.name === "Network"),
            hasDOM: s.domains.some((d) => d.name === "DOM")
          };
        }`
      );

      expect(output.status).toBe("completed");
      const parsed = output.result as Record<string, unknown>;
      expect(parsed.domainCount).toBeGreaterThan(50);
      expect(parsed.hasNetwork).toBe(true);
      expect(parsed.hasDOM).toBe(true);
    });

    it("should find Network domain commands", async () => {
      const output = await run(
        `async () => {
          const s = await cdp.spec({});
          const network = s.domains.find((d) => d.name === "Network");
          return {
            hasEnable: network.commands.some((c) => c.name === "enable"),
            method: network.commands.find((c) => c.name === "enable")?.method
          };
        }`
      );

      expect(output.status).toBe("completed");
      const parsed = output.result as Record<string, unknown>;
      expect(parsed.hasEnable).toBe(true);
      expect(parsed.method).toBe("Network.enable");
    });
  });

  describe("browser execute", () => {
    it("should get browser version", async () => {
      const output = await run(
        `async () => await cdp.send({ method: "Browser.getVersion" })`
      );

      expect(output.status).toBe("completed");
      const version = output.result as Record<string, unknown>;
      expect(version).toHaveProperty("product");
      expect(version).toHaveProperty("userAgent");
      expect(version).toHaveProperty("protocolVersion");
    });

    it("should create target, navigate, and evaluate via the attach handle", async () => {
      const output = await run(
        `async () => {
          const { targetId } = await cdp.send({
            method: "Target.createTarget",
            params: { url: "about:blank" }
          });
          const { sessionId } = await cdp.attachToTarget({ targetId });
          await cdp.send({ method: "Runtime.enable", sessionId });
          await cdp.send({
            method: "Page.navigate",
            params: { url: "data:text/html,<title>Test Title</title><body>Hello</body>" },
            sessionId
          });
          await codemode.step("wait", async () => {
            await new Promise((r) => setTimeout(r, 200));
            return true;
          });
          const { result } = await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "document.title" },
            sessionId
          });
          return { sessionId, title: result.value };
        }`
      );

      expect(output.status).toBe("completed");
      const parsed = output.result as { sessionId: string; title: string };
      expect(parsed.sessionId).toMatch(/^target:/);
      expect(parsed.title).toBe("Test Title");
    });

    it("should use the debug log", async () => {
      const output = await run(
        `async () => {
          await cdp.send({ method: "Browser.getVersion" });
          await cdp.send({ method: "Target.getTargets" });
          const log = await cdp.getDebugLog({ limit: 5 });
          return {
            logLength: log.length,
            hasSends: log.some((e) => e.type === "send")
          };
        }`
      );

      expect(output.status).toBe("completed");
      const parsed = output.result as Record<string, unknown>;
      expect(parsed.logLength).toBeGreaterThan(0);
      expect(parsed.hasSends).toBe(true);
    });

    it("should surface CDP command errors as run errors", async () => {
      const output = await run(
        `async () => await cdp.send({ method: "InvalidDomain.invalidMethod" })`
      );

      expect(output.status).toBe("error");
      expect(output.error).toBeTruthy();
    });

    it("should surface code execution errors", async () => {
      const output = await run(
        `async () => { throw new Error("execute test error"); }`
      );

      expect(output.status).toBe("error");
      expect(output.error).toContain("execute test error");
    });
  });

  // Notes on `wrangler dev`'s local Browser Rendering simulator: DELETE on a
  // session is a no-op (the browser stays up), so these tests assert
  // store-level cleanup rather than browser-level death. Target titles also
  // populate asynchronously, so cross-run continuity is asserted with
  // Runtime-evaluated markers instead of tab titles.
  describe("session lifecycle", () => {
    it("one-shot: survives a pause and is disposed on terminal", async () => {
      const output = await run(
        `async () => {
          const { targetId } = await cdp.send({
            method: "Target.createTarget",
            params: { url: "about:blank" }
          });
          const { sessionId } = await cdp.attachToTarget({ targetId });
          await cdp.send({ method: "Runtime.enable", sessionId });
          await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "globalThis.__MARK = 'alive'" },
            sessionId
          });
          await gate.confirm({ label: "continue" });
          const { result } = await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "globalThis.__MARK", returnByValue: true },
            sessionId
          });
          return { mark: result.value };
        }`
      );

      expect(output.status).toBe("paused");
      const executionId = output.executionId;

      // The Browser Run session is stored per-execution and still alive.
      const stored = (await callAgent("storedSessions")) as StoredSessions;
      const entry = stored[`cdp:exec:${executionId}`];
      expect(entry).toBeTruthy();
      expect(await callAgent("sessionAlive", [entry.sessionId])).toBe(true);

      // Approve — the run resumes against the same browser (reconnecting and
      // re-attaching via the session handle) and sees the mark.
      const resumed = (await callAgent("approve", [
        executionId,
        "one-shot"
      ])) as RunOutput;
      expect(resumed.status).toBe("completed");
      expect((resumed.result as { mark: string }).mark).toBe("alive");

      // Terminal: per-execution entry removed.
      const after = (await callAgent("storedSessions")) as StoredSessions;
      expect(after[`cdp:exec:${executionId}`]).toBeUndefined();
    });

    it("one-shot: fails clearly when the session expires during a pause", async () => {
      const output = await run(
        `async () => {
          await cdp.send({ method: "Browser.getVersion" });
          await gate.confirm({ label: "wait" });
          return await cdp.send({ method: "Target.getTargets" });
        }`
      );

      expect(output.status).toBe("paused");
      const executionId = output.executionId;

      // Simulate Browser Run reclaiming the session while paused.
      await callAgent("corruptStoredSession", [`cdp:exec:${executionId}`]);

      const resumed = (await callAgent("approve", [
        executionId,
        "one-shot"
      ])) as RunOutput;
      expect(resumed.status).toBe("error");
      expect(resumed.error).toContain(
        "expired or was swept while this execution was paused"
      );

      const after = (await callAgent("storedSessions")) as StoredSessions;
      expect(after[`cdp:exec:${executionId}`]).toBeUndefined();
    });

    it("dynamic: startSession promotes the session past the execution", async () => {
      const output = await run(
        `async () => {
          const { targetId } = await cdp.send({
            method: "Target.createTarget",
            params: { url: "about:blank" }
          });
          const { sessionId } = await cdp.attachToTarget({ targetId });
          await cdp.send({ method: "Runtime.enable", sessionId });
          await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "globalThis.__PROMOTED = 'yes'" },
            sessionId
          });
          const info = await cdp.startSession({});
          return { sessionId: info.sessionId, targetId };
        }`,
        "dynamic"
      );

      expect(output.status).toBe("completed");
      const { sessionId, targetId } = output.result as {
        sessionId: string;
        targetId: string;
      };

      // Terminal, but promoted — the shared slot owns it now.
      const stored = (await callAgent("storedSessions")) as StoredSessions;
      expect(execEntries(stored)).toHaveLength(0);
      expect(stored["cdp:reuse:default"]?.sessionId).toBe(sessionId);
      expect(await callAgent("sessionAlive", [sessionId])).toBe(true);

      // A later dynamic execution rides the promoted session and still sees
      // the tab state from the first run.
      const second = await run(
        `async () => {
          const { sessionId } = await cdp.attachToTarget({ targetId: ${JSON.stringify(
            targetId
          )} });
          const { result } = await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "globalThis.__PROMOTED", returnByValue: true },
            sessionId
          });
          return { promoted: result.value };
        }`,
        "dynamic"
      );
      expect(second.status).toBe("completed");
      expect((second.result as { promoted: string }).promoted).toBe("yes");

      // No per-execution entry was created for the second run.
      const after = (await callAgent("storedSessions")) as StoredSessions;
      expect(execEntries(after)).toHaveLength(0);

      await callAgent("closeSession", ["dynamic"]);
      const closed = (await callAgent("storedSessions")) as StoredSessions;
      expect(closed["cdp:reuse:default"]).toBeUndefined();
    });

    it("dynamic: un-promoted sessions are disposed on terminal", async () => {
      const output = await run(
        `async () => await cdp.send({ method: "Browser.getVersion" })`,
        "dynamic"
      );

      expect(output.status).toBe("completed");
      const stored = (await callAgent("storedSessions")) as StoredSessions;
      expect(execEntries(stored)).toHaveLength(0);
    });

    it("reuse: shares one session across executions and sweeps it when idle", async () => {
      const first = await run(
        `async () => {
          const { targetId } = await cdp.send({
            method: "Target.createTarget",
            params: { url: "about:blank" }
          });
          const { sessionId } = await cdp.attachToTarget({ targetId });
          await cdp.send({ method: "Runtime.enable", sessionId });
          await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "globalThis.__REUSE = 'shared'" },
            sessionId
          });
          const info = await cdp.sessionInfo({});
          return { sessionId: info.sessionId, targetId };
        }`,
        "reuse"
      );
      expect(first.status).toBe("completed");
      const info = first.result as { sessionId: string; targetId: string };
      expect(info.sessionId).toBeTruthy();

      const verify = await run(
        `async () => {
          const { sessionId } = await cdp.attachToTarget({ targetId: ${JSON.stringify(
            info.targetId
          )} });
          const { result } = await cdp.send({
            method: "Runtime.evaluate",
            params: { expression: "globalThis.__REUSE", returnByValue: true },
            sessionId
          });
          const sessionInfo = await cdp.sessionInfo({});
          return { reuse: result.value, sessionId: sessionInfo.sessionId };
        }`,
        "reuse"
      );
      expect(verify.status).toBe("completed");
      const verified = verify.result as { reuse: string; sessionId: string };
      expect(verified.reuse).toBe("shared");
      expect(verified.sessionId).toBe(info.sessionId);

      // Not idle yet — sweep keeps it.
      const kept = (await callAgent("sweep", ["reuse", 60_000])) as {
        swept: Array<{ key: string; sessionId: string }>;
      };
      expect(kept.swept.some((s) => s.sessionId === info.sessionId)).toBe(
        false
      );

      // Idle past the threshold — swept from the store.
      await sleep(50);
      const swept = (await callAgent("sweep", ["reuse", 1])) as {
        swept: Array<{ key: string; sessionId: string }>;
      };
      expect(swept.swept.some((s) => s.sessionId === info.sessionId)).toBe(
        true
      );
      const after = (await callAgent("storedSessions")) as StoredSessions;
      expect(after["cdp:reuse:default"]).toBeUndefined();
    });

    it("probes concurrent sockets to one Browser Run session", async () => {
      const output = await run(
        `async () => (await cdp.startSession({})).sessionId`,
        "reuse"
      );
      expect(output.status).toBe("completed");
      const sessionId = output.result as string;

      const probe = (await callAgent("multiSocketProbe", [sessionId])) as {
        concurrent: boolean;
        error?: string;
      };
      // Platform-dependent: record the answer, don't assert it.
      console.log(
        `[probe] concurrent sockets to one session: ${probe.concurrent}` +
          (probe.error ? ` (${probe.error})` : "")
      );
      expect(typeof probe.concurrent).toBe("boolean");

      await callAgent("closeSession", ["reuse"]);
    });
  });
  // The persistent named browser behind BrowserSessionConnector. These run
  // against real Chrome, so they also check what the unit-test fake assumes.
  describe("persistent named browser", () => {
    afterAll(async () => {
      await callAgent("closeNamed");
    });

    const setTitle = (title: string) => `async () => {
      await cdp.send({
        method: "Runtime.evaluate",
        params: { expression: "document.title = '${title}'" },
        sessionId: "active"
      });
    }`;
    const readTitle = `async () => {
      const { result } = await cdp.send({
        method: "Runtime.evaluate",
        params: { expression: "document.title", returnByValue: true },
        sessionId: "active"
      });
      return result.value;
    }`;

    it("keeps the active tab's page between executions", async () => {
      const first = await runNamed(setTitle("kept"));
      expect(first.status).toBe("completed");

      const second = await runNamed(readTitle);
      expect(second.status).toBe("completed");
      expect(second.result).toBe("kept");
      expect(second.report?.restarted).toBe(false);
    });

    it("reports a popup as a new tab without switching to it", async () => {
      await runNamed(setTitle("opener"));
      const output = await runNamed(`async () => {
        await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "void window.open('about:blank', '_blank')", userGesture: true },
          sessionId: "active"
        });
      }`);
      expect(output.status).toBe("completed");
      expect(output.report?.newTabs).toHaveLength(1);

      const title = await runNamed(readTitle);
      expect(title.result).toBe("opener");
    });

    it("reports noopener popups as new tabs too", async () => {
      await runNamed(setTitle("noopener-opener"));
      // Chrome still sets openerId on these; only canAccessOpener is false.
      const output = await runNamed(`async () => {
        const open = (expression) => cdp.send({
          method: "Runtime.evaluate",
          params: { expression, userGesture: true },
          sessionId: "active"
        });
        await open("void window.open('about:blank#noopener', '_blank', 'noopener')");
        await open("(() => { const a = document.createElement('a'); a.href = 'about:blank#rel-noopener'; a.target = '_blank'; a.rel = 'noopener noreferrer'; document.body.appendChild(a); a.click(); })()");
      }`);
      expect(output.status).toBe("completed");
      const urls = (output.report?.newTabs ?? []).map((tab) => tab.url);
      expect(urls).toEqual(
        expect.arrayContaining([
          "about:blank#noopener",
          "about:blank#rel-noopener"
        ])
      );
    });

    it("keeps the active tab across a pause for approval", async () => {
      const output = await runNamed(`async () => {
        await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "document.title = 'paused'" },
          sessionId: "active"
        });
        await gate.confirm({ label: "continue" });
        const { result } = await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "document.title", returnByValue: true },
          sessionId: "active"
        });
        return result.value;
      }`);
      expect(output.status).toBe("paused");

      const resumed = (await callAgent("approveNamed", [
        output.executionId
      ])) as RunOutput;
      expect(resumed.status).toBe("completed");
      expect(resumed.result).toBe("paused");
    });

    it("passes a raw Target.attachToTarget through to Chrome", async () => {
      await runNamed(setTitle("raw-attach"));
      const output = await runNamed(`async () => {
        const { targetInfos } = await cdp.send({ method: "Target.getTargets" });
        const page = targetInfos.find((t) => t.type === "page" && t.title === "raw-attach");
        const { sessionId } = await cdp.send({
          method: "Target.attachToTarget",
          params: { targetId: page.targetId, flatten: true }
        });
        const { result } = await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "document.title", returnByValue: true },
          sessionId
        });
        return { sessionId, title: result.value };
      }`);
      expect(output.status).toBe("completed");
      const { sessionId, title } = output.result as {
        sessionId: string;
        title: string;
      };
      expect(sessionId).not.toMatch(/^target:/);
      expect(title).toBe("raw-attach");

      const later = await runNamed(`async () => {
        await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "${sessionId}"
        });
      }`);
      expect(later.status).toBe("error");
      expect(later.error).toContain("don't carry over between runs");
    });

    it("doesn't report a tab opened with Target.createTarget as a popup", async () => {
      const output = await runNamed(`async () => {
        const { targetId } = await cdp.send({
          method: "Target.createTarget",
          params: { url: "about:blank" }
        });
        return targetId;
      }`);
      expect(output.status).toBe("completed");
      expect(output.report?.newTabs).toEqual([]);
    });

    it('teaches sessionId: "active" for a page command sent without one', async () => {
      const output = await runNamed(`async () => {
        await cdp.send({ method: "Runtime.evaluate", params: { expression: "1" } });
      }`);
      expect(output.status).toBe("error");
      expect(output.error).toContain('sessionId: "active"');
    });

    it("explains that a CDP event cannot be sent, using the live spec", async () => {
      const output = await runNamed(`async () => {
        await cdp.send({ method: "Page.loadEventFired" });
      }`);
      expect(output.status).toBe("error");
      expect(output.error).toContain("CDP *event*");
    });

    it("reattaches after the model detaches from the active tab", async () => {
      await runNamed(setTitle("detached"));
      const output = await runNamed(`async () => {
        const { targetInfos } = await cdp.send({ method: "Target.getTargets" });
        await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "active"
        });
        const page = targetInfos.find((t) => t.type === "page" && t.title === "detached");
        await cdp.send({
          method: "Target.detachFromTarget",
          params: { targetId: page.targetId }
        });
        const { result } = await cdp.send({
          method: "Runtime.evaluate",
          params: { expression: "document.title", returnByValue: true },
          sessionId: "active"
        });
        return result.value;
      }`);
      expect(output.status).toBe("completed");
      expect(output.result).toBe("detached");
    });

    it("refuses to close the browser", async () => {
      await runNamed(setTitle("survivor"));
      const output = await runNamed(`async () => {
        await cdp.send({ method: "Browser.close" });
      }`);
      expect(output.status).toBe("error");
      expect(output.error).toContain("managed for you");

      const after = await runNamed(readTitle);
      expect(after.result).toBe("survivor");
      expect(after.report?.restarted).toBe(false);
    });

    it("reports restarted when the browser was replaced", async () => {
      await runNamed(setTitle("lost"));
      const key = (await callAgent("namedSessionKey")) as string;
      await callAgent("corruptStoredSession", [key]);

      const output = await runNamed(readTitle);
      expect(output.status).toBe("completed");
      expect(output.report?.restarted).toBe(true);
      expect(output.result).not.toBe("lost");
    });
  });
});
