/**
 * E2E test: a fiber recovery hook that kills the isolate before any I/O.
 *
 * The scan marks a managed fiber `interrupted` before running the hook. If
 * the hook resets the object before the mark is committed, the mark rolls
 * back, startup runs the hook again, and the agent fails every request.
 * The scan syncs storage before the hook so the mark sticks.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  type Harness,
  callAgentByPath,
  killProcess,
  killProcessOnPort,
  sleep,
  startWrangler,
  waitForReady
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18826;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-aborting-hook");
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR
};
const AGENT_PATH = "/agents/aborting-recovery-hook-agent/aborting-hook-e2e";

describe("aborting recovery hook e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (wrangler) await killProcess(wrangler);
    wrangler = null;
    killProcessOnPort(PORT);
    fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
  });

  it("marks the fiber interrupted once and keeps serving requests", async () => {
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    const fiberId = (await callAgentByPath(
      harness,
      AGENT_PATH,
      "startAbortingFiber"
    )) as string;

    // The body aborts, the recovery wake fires, the hook aborts again.
    let status: string | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(1000);
      try {
        status = (await callAgentByPath(harness, AGENT_PATH, "fiberStatus", [
          fiberId
        ])) as string | null;
      } catch {
        status = null;
      }
      if (status === "interrupted") break;
    }
    expect(status).toBe("interrupted");

    // The hook ran, and it is not run again on later startups: the count
    // stays put while requests keep being served.
    const runs = (await callAgentByPath(
      harness,
      AGENT_PATH,
      "hookRuns"
    )) as number;
    expect(runs).toBeGreaterThanOrEqual(1);
    await sleep(5000);
    expect(
      await callAgentByPath(harness, AGENT_PATH, "fiberStatus", [fiberId])
    ).toBe("interrupted");
    expect(await callAgentByPath(harness, AGENT_PATH, "hookRuns")).toBe(runs);
  });
});
