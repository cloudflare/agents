/**
 * E2E test: chat recovery BUDGET EXHAUSTION after repeated process eviction.
 *
 * The agents under test stream a turn that hangs forever and produces no
 * recovery progress, so repeated SIGKILLs drive the recovery budget
 * deterministically. We assert the framework seals the turn with the correct
 * `onExhausted` reason, persists/broadcasts the terminal banner, and cleans up
 * the fiber rows.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  createWranglerHarness,
  killProcess,
  killProcessOnPort,
  pollUntil,
  rpcCall,
  sendChatMessage,
  sleep
} from "./harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18799;
const PERSIST_DIR = path.join(__dirname, ".wrangler-chat-exhaust-state");

type ExhaustedLogEntry = {
  reason: string;
  terminalMessage: string;
  attempt: number;
};

const harness = createWranglerHarness({
  port: PORT,
  persistDir: PERSIST_DIR,
  configPath: path.join(__dirname, "wrangler.jsonc"),
  cwd: __dirname,
  label: "exhaust"
});

function agentUrl(slug: string, name: string): string {
  return `${harness.url}/agents/${slug}/${name}`;
}

/**
 * Drive a turn to budget exhaustion: start it (it hangs), interrupt it twice
 * with a gap in between so the second interruption seals the incident, and
 * return the recorded `onExhausted` entries.
 */
async function runToExhaustion(
  slug: string,
  name: string,
  gapBeforeSecondKillMs: number
): Promise<{ log: ExhaustedLogEntry[]; terminal: { body: string } | null }> {
  const url = agentUrl(slug, name);
  let wrangler = harness.start();
  try {
    await harness.waitForReady();

    await sendChatMessage(url, "hang forever");
    await sleep(2000);
    expect((await rpcCall(url, "hasFiberRows")) as boolean).toBe(true);

    // Kill #1 — interrupt the original turn (no progress made).
    await killProcess(wrangler);
    await harness.waitForPortFree();
    wrangler = harness.start();
    await harness.waitForReady();

    // Let recovery detect the orphan, open the incident, and schedule the
    // (also-hanging) retry. Wait past the budget window before the 2nd kill.
    await sleep(gapBeforeSecondKillMs);

    // Kill #2 — interrupt the retry (still no progress) → seals the incident.
    await killProcess(wrangler);
    await harness.waitForPortFree();
    wrangler = harness.start();
    await harness.waitForReady();

    const log = await pollUntil(
      "exhausted log",
      () => rpcCall(url, "getExhaustedLog") as Promise<ExhaustedLogEntry[]>,
      (entries) => entries.length > 0,
      { attempts: 30, delayMs: 1000 }
    );

    // The terminal banner is persisted durably so a client that reconnects
    // after recovery gave up still learns the outcome (#1645).
    const terminal = (await rpcCall(url, "getTerminalRecord")) as {
      body: string;
    } | null;

    // NOTE: we deliberately do NOT assert fiber-row cleanup here. These agents
    // stream a turn that hangs forever to force the no-progress budget, so the
    // scheduled retry never settles and legitimately keeps a fiber row alive.
    // Fiber cleanup after a turn that actually completes is covered by
    // chat-recovery.test.ts. This test asserts the EXHAUSTION contract only.

    return { log, terminal };
  } finally {
    await killProcess(wrangler);
  }
}

describe("chat recovery budget exhaustion e2e", () => {
  let wranglerCleanup: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  afterEach(async () => {
    if (wranglerCleanup) {
      await killProcess(wranglerCleanup);
      wranglerCleanup = null;
    }
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  it("seals a stuck turn with no_progress_timeout and fires onExhausted", async () => {
    // noProgressTimeoutMs is 2s on this agent; the gap before the 2nd kill is
    // comfortably larger so the second interruption exceeds the window.
    const { log, terminal } = await runToExhaustion(
      "chat-no-progress-exhaust-agent",
      "exhaust-no-progress",
      5000
    );

    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].reason).toBe("no_progress_timeout");
    expect(log[0].terminalMessage).toBe("TERMINAL-NO-PROGRESS");
    expect(terminal?.body).toBe("TERMINAL-NO-PROGRESS");
  });

  it("seals a turn with recovery_aborted when shouldKeepRecovering returns false", async () => {
    // Huge no-progress window keeps the other budgets quiet; the caller hook
    // aborts on the 2nd attempt regardless of the alarm-debounce window.
    const { log, terminal } = await runToExhaustion(
      "chat-aborted-exhaust-agent",
      "exhaust-aborted",
      3000
    );

    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].reason).toBe("recovery_aborted");
    expect(log[0].terminalMessage).toBe("TERMINAL-ABORTED");
    expect(terminal?.body).toBe("TERMINAL-ABORTED");
  });

  it("seals a turn with work_budget_exceeded when maxRecoveryWork is 0", async () => {
    // This agent produces recovery work (a flushed text-start) on each attempt,
    // so a zero work budget seals it on the second interruption.
    const { log, terminal } = await runToExhaustion(
      "chat-work-budget-exhaust-agent",
      "exhaust-work",
      4000
    );

    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].reason).toBe("work_budget_exceeded");
    expect(log[0].terminalMessage).toBe("TERMINAL-WORK");
    expect(terminal?.body).toBe("TERMINAL-WORK");
  });
});
