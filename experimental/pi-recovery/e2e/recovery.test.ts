/**
 * E2E: the REAL pi agent recovers a deploy/crash mid-stream through the SHARED
 * `ChatRecoveryEngine` — the Phase-5 genericity proof (rfc-chat-recovery-
 * foundation).
 *
 * 1. Start `wrangler dev` running the `PiAgent` Durable Object.
 * 2. POST /pi/start — pi streams a slow assistant turn inside a recovery fiber,
 *    buffering each delta durably into `ResumableStream`.
 * 3. SIGKILL the process MID-STREAM (before `message_end` commits the assistant
 *    message), leaving an orphaned fiber row, an unanswered user message, and a
 *    durable partial.
 * 4. Restart with the same persist dir; accessing the DO wakes it and the shared
 *    engine reconstructs the partial, preserves it, and schedules a `continue`.
 * 5. Verify CONTINUATION (not full regeneration): the recovered turn regenerates
 *    only the SUFFIX after the survived prefix and merges it onto the partial —
 *    one assistant message whose prefix length + generated suffix length equal
 *    its total length — via the shared engine, with NO `UIMessage` in the stack.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily, Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Disable happy-eyeballs racing + swallow the benign teardown `setTypeOfService`
// EINVAL that surfaces when probing a server mid-SIGKILL/restart (see the
// ai-chat e2e harness for the full rationale).
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
const PORT = 18901;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION = "pi-recovery-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-pi-e2e-state");

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

async function startTurn(text: string): Promise<void> {
  const res = await fetch(`${BASE}/pi/start?session=${SESSION}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
  await res.body?.cancel();
}

async function getStatus(): Promise<Status> {
  const res = await fetch(`${BASE}/pi/status?session=${SESSION}`);
  return (await res.json()) as Status;
}

async function pollUntil(
  label: string,
  done: (status: Status) => boolean,
  attempts = 40,
  delayMs = 1000
): Promise<Status> {
  let last: Status | undefined;
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      last = await getStatus();
      console.log(`[test] ${label} poll ${i + 1}:`, last);
      if (done(last)) return last;
    } catch {
      console.log(`[test] ${label} poll ${i + 1}: error (agent not ready)`);
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("pi recovery e2e (shared engine, real pi runtime)", () => {
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

  it("continues a pi turn from its survived partial after a SIGKILL mid-stream", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await startTurn("recover me");

    // Let pi stream a few events into the durable buffer (so we crash genuinely
    // mid-stream with a non-empty partial), then confirm the turn is in-flight:
    // an orphaned fiber row exists and no assistant message has committed yet.
    await sleep(3000);
    const before = await getStatus();
    console.log("[test] before kill:", before);
    expect(before.fiberRows).toBeGreaterThan(0);
    expect(before.assistantCount).toBe(0);

    console.log("[test] SIGKILL wrangler mid-stream...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    console.log("[test] restarting wrangler...");
    wrangler = startWrangler();
    await waitForReady();

    // Accessing the DO wakes it; the shared engine reconstructs the orphaned
    // partial, preserves it, and schedules a `continue` that regenerates only
    // the remaining suffix through pi's real continue().
    const recovered = await pollUntil(
      "pi assistant committed",
      (s) => s.assistantCount >= 1
    );
    expect(recovered.assistantCount).toBe(1);
    expect(recovered.transcript[0].role).toBe("user");
    expect(recovered.transcript.at(-1)?.role).toBe("assistant");
    const assistantText = recovered.transcript.at(-1)?.text ?? "";
    expect(assistantText).toContain("pi reply to");

    // Continuation, NOT full regeneration: the engine took the `continue` path,
    // the survived prefix was preserved (prefixChars > 0), and the recovered
    // turn generated ONLY the remaining suffix (0 < generated < total). Prefix +
    // suffix reconstruct the full reply exactly.
    expect(recovered.recoveredVia).toBe("continue");
    expect(recovered.partialPrefixChars).toBeGreaterThan(0);
    expect(recovered.recoveryGeneratedChars).toBeGreaterThan(0);
    expect(recovered.recoveryGeneratedChars).toBeLessThan(assistantText.length);
    expect(
      recovered.partialPrefixChars + recovered.recoveryGeneratedChars
    ).toBe(assistantText.length);

    // The continued turn settles: the orphaned fiber row is reclaimed.
    const settled = await pollUntil(
      "pi fiber cleanup",
      (s) => s.fiberRows === 0 && s.assistantCount === 1
    );
    expect(settled.fiberRows).toBe(0);
  });
});
