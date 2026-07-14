/**
 * Ported from: packages/think/src/e2e-tests/stall-recovery.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E: a stream-stall watchdog abort routes into bounded recovery instead of a
 * terminal error (#1626).
 *
 * The agent's model streams a little text on its FIRST inference then hangs
 * forever (a parked provider/transport). With `chatStreamStallTimeoutMs` armed
 * and chatRecovery on, the inactivity watchdog aborts that attempt and routes
 * it into bounded recovery; the framework's real alarm fires the scheduled
 * continuation, whose (non-stalling) inference completes the turn. No process
 * kill is involved — a stall is an in-isolate hang.
 *
 * Asserts the turn RECOVERS (a completed assistant message containing the
 * continuation's output appears, no orphaned fiber rows), rather than ending in
 * a terminal stream error.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  callAgentByPath,
  killProcess,
  killProcessOnPort,
  sendChatMessage,
  sleep,
  startWrangler,
  waitForReady,
  type StartWranglerOptions
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18801;
const AGENT_SLUG = "think-stall-recovery-e2-e-agent";
const AGENT_NAME = "stall-recovery-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-stall-recovery-state");
const AGENT_PATH = `/agents/${AGENT_SLUG}/${AGENT_NAME}`;

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: AGENT_PATH
};

type StallStatus = {
  assistantMessages: number;
  finalText: string;
  hasFiberRows: boolean;
};

function startWranglerForTest(): ChildProcess {
  return startWrangler(WRANGLER_OPTS);
}

async function callAgent(method: string): Promise<unknown> {
  return callAgentByPath(AGENT_PATH, method, []);
}

async function readStatus(): Promise<StallStatus | null> {
  try {
    return (await callAgent("getStallStatus")) as StallStatus;
  } catch {
    return null;
  }
}

describe("stream-stall watchdog routes into bounded recovery", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
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
      // OK
    }
  });

  it("recovers a stalled turn via the scheduled continuation instead of failing terminally (#1626)", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    await sendChatMessage("stall then recover");

    // Wait for: watchdog (~2s) → schedule continue → real alarm fires →
    // continuation streams the rest → turn completes with no orphaned fibers.
    let status: StallStatus | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      status = await readStatus();
      if (status) {
        console.log(`[stall-recovery] poll: ${JSON.stringify(status)}`);
        if (status.finalText.includes("RECOVERED") && !status.hasFiberRows) {
          break;
        }
      }
    }

    expect(status).not.toBeNull();
    const final = status as StallStatus;
    console.log(`[stall-recovery] FINAL: ${JSON.stringify(final)}`);

    // The turn recovered: the continuation's output landed in a completed
    // assistant message (rather than a terminal stream error), and no orphaned
    // fiber rows remain.
    expect(final.assistantMessages).toBeGreaterThanOrEqual(1);
    expect(final.finalText).toContain("RECOVERED");
    expect(final.hasFiberRows).toBe(false);
  }, 120_000);
});
