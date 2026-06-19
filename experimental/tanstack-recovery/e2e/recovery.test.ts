/**
 * E2E: a foreign `@tanstack/ai` WebSocket client drives the SHARED
 * `ResumeHandshake` + `ChatRecoveryEngine` — the Phase-5 second-harness proof
 * (rfc-chat-recovery-foundation).
 *
 * Two scenarios share one `wrangler dev` + the real client `ws-bridge`:
 *
 *  1. **Handshake against a foreign transport (deterministic, no crash).** A turn
 *     streams server-side; a headless TanStack bridge client connects MID-STREAM
 *     and observes `STREAM_RESUMING` → ACK → buffered replay → live completion.
 *     This is the clean proof the resume PROTOCOL drives a foreign client with
 *     only a thin `cf_agent_* <-> AG-UI` bridge and NO `agents` change.
 *
 *  2. **Crash recovery + continuation (SIGKILL mid-stream).** Mirrors the pi
 *     fixture: kill `wrangler dev` mid-stream, restart, and the shared engine
 *     reconstructs the orphaned partial (via the AG-UI codec), preserves it, and
 *     CONTINUES the turn — regenerating only the suffix, which merges onto the
 *     survived prefix. Asserts exact continuation math + `recoveredVia`.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily, Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryConnection } from "../src/ws-adapter";
import type { RecoveryBridgeConnection } from "../src/ws-bridge";

// Disable happy-eyeballs racing + swallow the benign teardown `setTypeOfService`
// EINVAL that surfaces when probing a server mid-SIGKILL/restart (see the
// ai-chat / pi e2e harnesses for the full rationale).
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
const PORT = 18902;
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST_DIR = path.join(__dirname, ".wrangler-tanstack-e2e-state");

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

async function startTurn(
  session: string,
  text: string,
  opts: { withTool?: boolean; persist?: boolean } = {}
): Promise<void> {
  const res = await fetch(`${BASE}/start?session=${session}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...opts })
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
  attempts = 40,
  delayMs = 1000
): Promise<Status> {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const last = await getStatus(session);
      console.log(`[test] ${label} poll ${i + 1}:`, last);
      if (done(last)) return last;
    } catch {
      console.log(`[test] ${label} poll ${i + 1}: error (agent not ready)`);
    }
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Drive a headless TanStack bridge client's subscribe loop in the background. */
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

describe("tanstack-recovery e2e (shared engine + handshake, foreign client)", () => {
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

  it("resumes an in-flight stream to a foreign TanStack client mid-stream", async () => {
    const SESSION = "tanstack-handshake-e2e";
    wrangler = startWrangler();
    await waitForReady();

    // Start a slow turn server-side (no client tied to it).
    await startTurn(SESSION, "resume me live");
    // Let a few chunks buffer so a mid-stream reconnect has a partial to replay.
    await sleep(1500);

    // A foreign TanStack bridge client connects MID-STREAM: onConnect notifies
    // STREAM_RESUMING, the bridge ACKs, and receives the buffered replay then
    // the live tail through the shared handshake.
    const bridge = startBridge(SESSION);
    try {
      const settled = await pollUntil(
        SESSION,
        "live turn committed",
        (s) => s.assistantCount >= 1
      );
      expect(settled.assistantCount).toBe(1);
      expect(settled.transcript.at(-1)?.text).toContain("tanstack reply to");

      // The foreign client drove the resume handshake over a non-AI-SDK transport.
      expect(bridge.conn.observations.resumingFrames).toBeGreaterThan(0);
      expect(bridge.conn.observations.acksSent).toBe(1);
      expect(bridge.conn.observations.replayResponseFrames).toBeGreaterThan(0);
      expect(bridge.conn.observations.accumulatedText).toContain(
        "tanstack reply to"
      );
    } finally {
      bridge.stop();
    }
  });

  it("continues a turn from its survived partial after a SIGKILL mid-stream", async () => {
    const SESSION = "tanstack-recovery-e2e";
    wrangler = startWrangler();
    await waitForReady();

    await startTurn(SESSION, "recover me");

    // Let the turn stream a few chunks into the durable buffer, then confirm
    // it's in-flight: an orphaned fiber row exists and no assistant committed.
    await sleep(3000);
    const before = await getStatus(SESSION);
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

    // A foreign TanStack bridge client reconnects to the recovering session and
    // observes the resume handshake (STREAM_RESUMING → ACK → replayed partial).
    const bridge = startBridge(SESSION);
    try {
      // Accessing the DO wakes it; the shared engine reconstructs the orphaned
      // partial, preserves it, and schedules a `continue` that regenerates only
      // the remaining suffix.
      const recovered = await pollUntil(
        SESSION,
        "assistant committed",
        (s) => s.assistantCount >= 1
      );
      expect(recovered.assistantCount).toBe(1);
      expect(recovered.transcript[0].role).toBe("user");
      expect(recovered.transcript.at(-1)?.role).toBe("assistant");
      const assistantText = recovered.transcript.at(-1)?.text ?? "";
      expect(assistantText).toContain("tanstack reply to");

      // Continuation, NOT full regeneration: the engine took the `continue`
      // path, the survived prefix was preserved, and the recovered turn
      // generated ONLY the remaining suffix. Prefix + suffix === full reply.
      expect(recovered.recoveredVia).toBe("continue");
      expect(recovered.partialPrefixChars).toBeGreaterThan(0);
      expect(recovered.recoveryGeneratedChars).toBeGreaterThan(0);
      expect(recovered.recoveryGeneratedChars).toBeLessThan(
        assistantText.length
      );
      expect(
        recovered.partialPrefixChars + recovered.recoveryGeneratedChars
      ).toBe(assistantText.length);

      // The foreign client saw the resume handshake fire during recovery.
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

  // ── Settled-tool persist gate against a FOREIGN tool vocabulary ─────────────
  // The shared engine never drops settled (non-idempotent) tool work, even when
  // the user `onChatRecovery` policy says `{ persist: false }` (#1631). These two
  // tests prove that gate — `partialHasSettledToolResults` — works when the parts
  // are reconstructed from AG-UI `TOOL_CALL_*` chunks, not AI-SDK SSE. They share
  // the same `persist: false` policy and differ ONLY in whether the interrupted
  // turn had settled a tool, so the divergent outcome isolates the gate.

  it("preserves a settled-tool partial on SIGKILL even under persist:false", async () => {
    const SESSION = "tanstack-tool-persist-e2e";
    wrangler = startWrangler();
    await waitForReady();

    // A turn that settles a tool call FIRST, then streams a long text tail. The
    // recovery policy is persist:false — a text-only partial would be dropped.
    await startTurn(SESSION, "tool then text", {
      withTool: true,
      persist: false
    });

    // Let the tool settle + a few text deltas buffer, then confirm in-flight.
    await sleep(3500);
    const before = await getStatus(SESSION);
    console.log("[test] before kill (tool):", before);
    expect(before.fiberRows).toBeGreaterThan(0);
    expect(before.assistantCount).toBe(0);
    expect(before.persistPolicy).toBe(false);

    console.log("[test] SIGKILL wrangler mid-text-tail...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    wrangler = startWrangler();
    await waitForReady();

    const bridge = startBridge(SESSION);
    try {
      const recovered = await pollUntil(
        SESSION,
        "tool-turn recovered",
        (s) => s.assistantCount >= 1
      );

      // The settled tool result was reconstructed from the AG-UI parts, so the
      // shared gate kept the partial despite persist:false — and the turn
      // CONTINUED from the survived prefix rather than regenerating.
      expect(recovered.partialHadSettledTool).toBe(true);
      expect(recovered.recoveredVia).toBe("continue");
      expect(recovered.partialPrefixChars).toBeGreaterThan(0);
      const assistantText = recovered.transcript.at(-1)?.text ?? "";
      expect(
        recovered.partialPrefixChars + recovered.recoveryGeneratedChars
      ).toBe(assistantText.length);
    } finally {
      bridge.stop();
    }
  });

  it("drops a text-only partial on SIGKILL under persist:false (regenerates)", async () => {
    const SESSION = "tanstack-text-nopersist-e2e";
    wrangler = startWrangler();
    await waitForReady();

    // Same persist:false policy, but NO tool — the partial carries no settled
    // work, so the gate is free to drop it.
    await startTurn(SESSION, "text only", { withTool: false, persist: false });

    await sleep(3000);
    const before = await getStatus(SESSION);
    console.log("[test] before kill (text):", before);
    expect(before.fiberRows).toBeGreaterThan(0);
    expect(before.assistantCount).toBe(0);
    expect(before.persistPolicy).toBe(false);

    console.log("[test] SIGKILL wrangler mid-stream...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    wrangler = startWrangler();
    await waitForReady();

    const bridge = startBridge(SESSION);
    try {
      const recovered = await pollUntil(
        SESSION,
        "text-turn recovered",
        (s) => s.assistantCount >= 1
      );

      // No settled tool work → the persist:false policy dropped the partial, so
      // there was no merge target and the turn REGENERATED from scratch.
      expect(recovered.partialHadSettledTool).toBe(false);
      expect(recovered.recoveredVia).toBe("retry");
      expect(recovered.partialPrefixChars).toBe(0);
      const assistantText = recovered.transcript.at(-1)?.text ?? "";
      expect(assistantText).toContain("tanstack reply to");
    } finally {
      bridge.stop();
    }
  });
});
