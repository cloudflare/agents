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
const PLAIN_AGENT_PATH =
  "/agents/aborting-recovery-hook-agent/aborting-plain-e2e";

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
    // The hook logs a line each time it runs; storage would roll back.
    // Count over the whole output, so a marker split across chunks counts.
    let output = "";
    wrangler.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const hookRuns = () => output.split("[aborting-hook] ran").length - 1;
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
    // stdout can trail the status reply, so wait for the marker.
    for (let attempt = 0; attempt < 20 && hookRuns() === 0; attempt++) {
      await sleep(250);
    }
    expect(hookRuns()).toBeGreaterThanOrEqual(1);
    const runs = hookRuns();
    await sleep(5000);
    expect(
      await callAgentByPath(harness, AGENT_PATH, "fiberStatus", [fiberId])
    ).toBe("interrupted");
    expect(hookRuns()).toBe(runs);
  });

  it("gives up on a plain fiber whose recovery hook keeps killing the isolate", async () => {
    wrangler = startWrangler(harness);
    let output = "";
    wrangler.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const hookRuns = () => output.split("[aborting-hook] ran").length - 1;
    await waitForReady(harness);

    await callAgentByPath(harness, PLAIN_AGENT_PATH, "startAbortingPlainFiber");

    // Each wake runs the hook, which kills the isolate. After the crash
    // budget the row is dropped and requests are served again.
    let rows: number | null = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(1000);
      try {
        rows = (await callAgentByPath(
          harness,
          PLAIN_AGENT_PATH,
          "runRowCount"
        )) as number;
      } catch {
        rows = null;
      }
      if (rows === 0 && hookRuns() > 0) break;
    }
    expect(rows).toBe(0);
    for (let attempt = 0; attempt < 20 && hookRuns() === 0; attempt++) {
      await sleep(250);
    }
    expect(hookRuns()).toBeGreaterThanOrEqual(1);
    expect(hookRuns()).toBeLessThanOrEqual(4);

    const runs = hookRuns();
    await sleep(5000);
    expect(
      await callAgentByPath(harness, PLAIN_AGENT_PATH, "runRowCount")
    ).toBe(0);
    expect(hookRuns()).toBe(runs);
  });
});
