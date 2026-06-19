/**
 * E2E: the SHARED recovery engine + handshake against a REAL Workers AI provider
 * stream — the single genuinely-untested codec axis (rfc-chat-recovery-foundation,
 * Phase 5 "Second harness", open item #1).
 *
 * The deterministic faux e2e (`recovery.test.ts`) proves the recovery PROTOCOL
 * with exact continuation math. This proves the same protocol survives a real,
 * NON-DETERMINISTIC provider: `@tanstack/ai`'s `chat()` over
 * `@cloudflare/tanstack-ai`'s `createWorkersAiChat` (model
 * `@cf/moonshotai/kimi-k2.7-code`) bound to the `AI` binding. The real model's
 * AG-UI `StreamChunk`s flow through the SAME `TanStackRecoveryCodec`, `ws-bridge`,
 * and `ChatRecoveryEngine` — no engine change is specific to the provider.
 *
 * Because a real model can't reproduce a partial's exact suffix, the assertion
 * relaxes from byte-exact math to the continuation INVARIANT the engine
 * guarantees regardless of the provider:
 *   - recovery took the `continue` path (a partial survived and was preserved),
 *   - the survived prefix was kept (`partialPrefixChars > 0`),
 *   - the recovered turn generated a non-empty continuation, and
 *   - the committed reply is exactly `prefix + continuation`
 *     (`partialPrefixChars + recoveryGeneratedChars === finalLength`) — which
 *     holds by construction of the merge even when the model doesn't resume
 *     perfectly.
 *
 * GATED: skipped unless `RUN_WORKERS_AI_E2E=1`, because `wrangler dev`'s `AI`
 * binding proxies to REAL Workers AI and needs network + Cloudflare auth. CI runs
 * the faux e2e only. Run locally with:
 *
 *   RUN_WORKERS_AI_E2E=1 pnpm --filter @cloudflare/agents-tanstack-recovery test:e2e
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily, Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryConnection } from "../src/ws-adapter";
import type { RecoveryBridgeConnection } from "../src/ws-bridge";

const RUN = process.env.RUN_WORKERS_AI_E2E === "1";

// Same teardown hardening as the faux e2e (see its header for the rationale).
setDefaultAutoSelectFamily(false);
{
  const proto = Socket.prototype as unknown as {
    setTypeOfService?: (tos: number) => unknown;
  };
  const original = proto.setTypeOfService;
  if (typeof original === "function") {
    proto.setTypeOfService = function (this: unknown, tos: number) {
      try {
        return original.call(this, tos);
      } catch {
        return this;
      }
    };
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 18903;
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST_DIR = path.join(__dirname, ".wrangler-tanstack-ai-e2e-state");

type Status = {
  transcript: Array<{ role: string; text: string }>;
  assistantCount: number;
  fiberRows: number;
  incidentCount: number;
  recovering: boolean;
  progress: number;
  recoveredVia: "continue" | "retry" | null;
  recoveryGeneratedChars: number;
  partialPrefixChars: number;
  persistPolicy: boolean;
  partialHadSettledTool: boolean;
  bufferedChars: number;
};

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
        // Already dead.
      }
    }
  } catch {
    // lsof unavailable.
  }
}

function startWrangler(): ChildProcess {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      path.join(ROOT, "wrangler.jsonc"),
      "--port",
      String(PORT),
      "--persist-to",
      PERSIST_DIR,
      "--inspector-port",
      "0"
    ],
    {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );
  child.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });
  return child;
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
        // Already dead.
      }
    }
  });
}

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // Not ready.
    }
    await sleep(delayMs);
  }
  throw new Error("Wrangler did not start in time");
}

async function waitForPortFree(maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      await res.body?.cancel();
    } catch {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`Port ${PORT} did not free in time`);
}

async function startTurn(session: string, text: string): Promise<void> {
  const res = await fetch(`${BASE}/start?session=${session}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, provider: "workers-ai" })
  });
  await res.body?.cancel();
}

async function getStatus(session: string): Promise<Status> {
  const res = await fetch(`${BASE}/status?session=${session}`);
  return (await res.json()) as Status;
}

async function pollUntil(
  session: string,
  label: string,
  done: (status: Status) => boolean,
  attempts = 60,
  delayMs = 1000
): Promise<Status> {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const last = await getStatus(session);
      console.log(`[test] ${label} poll ${i + 1}:`, {
        assistantCount: last.assistantCount,
        fiberRows: last.fiberRows,
        recoveredVia: last.recoveredVia,
        prefix: last.partialPrefixChars,
        generated: last.recoveryGeneratedChars
      });
      if (done(last)) return last;
    } catch {
      console.log(`[test] ${label} poll ${i + 1}: error (agent not ready)`);
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Wait until a real-provider turn has actually streamed CONTENT into the durable
 * buffer (not just created its fiber row). A real model has a non-trivial
 * time-to-first-token, so the fiber row exists well before any
 * `TEXT_MESSAGE_CONTENT` flushes — killing on `fiberRows > 0` alone races the
 * TTFT and leaves an EMPTY partial (→ a `retry`, not the `continue` we want to
 * prove). Gating on `bufferedChars` guarantees a non-empty survived prefix. The
 * system prompt forces a long reply, so a small buffered prefix leaves plenty of
 * suffix for the continuation. */
async function waitForBufferedContent(
  session: string,
  minChars = 40,
  attempts = 80,
  delayMs = 250
): Promise<Status> {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const s = await getStatus(session);
      // Already committed before we could kill it mid-stream — bail to retry.
      if (s.assistantCount > 0) {
        throw new Error("turn committed before it could be killed mid-stream");
      }
      if (s.fiberRows > 0 && s.bufferedChars >= minChars) return s;
    } catch (error) {
      if (error instanceof Error && error.message.includes("committed")) {
        throw error;
      }
      // agent not ready yet.
    }
  }
  throw new Error("real provider turn never buffered streaming content");
}

function startBridge(session: string): {
  conn: RecoveryBridgeConnection;
  stop: () => void;
} {
  const conn = createRecoveryConnection(BASE, session);
  const abort = new AbortController();
  void (async () => {
    try {
      for await (const _chunk of conn.subscribe(abort.signal)) {
        // Observations accumulate on `conn.observations`.
      }
    } catch {
      // Connection torn down at teardown.
    }
  })();
  return {
    conn,
    stop: () => {
      abort.abort();
      conn.close();
    }
  };
}

describe.skipIf(!RUN)(
  "tanstack-recovery e2e (REAL Workers AI provider, non-deterministic)",
  () => {
    let wrangler: ChildProcess | null = null;

    beforeEach(() => {
      killProcessOnPort(PORT);
      try {
        fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
      } catch {
        // OK.
      }
    });

    afterEach(async () => {
      if (wrangler) {
        await killProcess(wrangler);
        wrangler = null;
      }
      killProcessOnPort(PORT);
      try {
        fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
      } catch {
        // OK.
      }
    });

    it("continues a real-model turn from its survived partial after a SIGKILL", async () => {
      const SESSION = "tanstack-workers-ai-e2e";
      wrangler = startWrangler();
      await waitForReady();

      // A real Workers AI turn: the system prompt forces a long, multi-paragraph
      // reply so the stream lasts several seconds — wide enough to SIGKILL
      // mid-stream.
      await startTurn(
        SESSION,
        "Write a long, detailed essay about the history of computing."
      );

      // Wait until the real model has streamed CONTENT into the durable buffer
      // (past its time-to-first-token), so the survived partial is non-empty.
      const before = await waitForBufferedContent(SESSION);
      console.log("[test] before kill (workers-ai):", {
        fiberRows: before.fiberRows,
        assistantCount: before.assistantCount,
        bufferedChars: before.bufferedChars
      });
      expect(before.fiberRows).toBeGreaterThan(0);
      expect(before.assistantCount).toBe(0);
      expect(before.bufferedChars).toBeGreaterThan(0);

      console.log("[test] SIGKILL wrangler mid-stream...");
      await killProcess(wrangler);
      wrangler = null;
      await waitForPortFree();

      console.log("[test] restarting wrangler...");
      wrangler = startWrangler();
      await waitForReady();

      // A foreign TanStack bridge client reconnects; the shared engine
      // reconstructs the orphaned partial (via the AG-UI codec), preserves it,
      // and schedules a `continue` that re-prompts the real model from the
      // survived prefix.
      const bridge = startBridge(SESSION);
      try {
        const recovered = await pollUntil(
          SESSION,
          "real assistant committed",
          (s) => s.assistantCount >= 1 && s.recoveredVia !== null
        );

        expect(recovered.assistantCount).toBe(1);
        expect(recovered.transcript[0].role).toBe("user");
        expect(recovered.transcript.at(-1)?.role).toBe("assistant");
        const assistantText = recovered.transcript.at(-1)?.text ?? "";
        expect(assistantText.length).toBeGreaterThan(0);

        // Continuation, NOT regeneration: a real partial survived, was preserved,
        // and the recovered turn continued from it. The merge invariant
        // (prefix + continuation === final) holds even though the model's
        // continuation is non-deterministic.
        expect(recovered.recoveredVia).toBe("continue");
        expect(recovered.partialPrefixChars).toBeGreaterThan(0);
        expect(recovered.recoveryGeneratedChars).toBeGreaterThan(0);
        expect(
          recovered.partialPrefixChars + recovered.recoveryGeneratedChars
        ).toBe(assistantText.length);

        // The foreign client drove the resume handshake during recovery.
        expect(bridge.conn.observations.resumingFrames).toBeGreaterThan(0);
        expect(bridge.conn.observations.acksSent).toBeGreaterThan(0);

        // The continued turn settles: the orphaned fiber row is reclaimed.
        const cleaned = await pollUntil(
          SESSION,
          "fiber cleanup",
          (s) => s.fiberRows === 0 && s.assistantCount === 1
        );
        expect(cleaned.fiberRows).toBe(0);
      } finally {
        bridge.stop();
      }
    });
  }
);
