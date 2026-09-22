import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callAgentByPath,
  killProcess,
  killProcessOnPort,
  sleep,
  startWrangler,
  waitForPortFree,
  waitForReady,
  type Harness
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: 18829,
  persistDir: path.join(__dirname, ".wrangler-state-machine-state")
};

async function call(method: string, args: unknown[] = []): Promise<unknown> {
  return callAgentByPath(
    harness,
    "/agents/state-machine-kill-agent/state-machine-recovery",
    method,
    args
  );
}

describe("StateMachine process recovery", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(harness.port);
    fs.rmSync(harness.persistDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (wrangler) await killProcess(wrangler);
    wrangler = null;
    killProcessOnPort(harness.port);
    fs.rmSync(harness.persistDir, { recursive: true, force: true });
  });

  it("continues from its committed checkpoint after SIGKILL", async () => {
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    const receipt = (await call("startStateMachine", [5])) as { runId: string };
    await sleep(2_200);
    const before = (await call("getStateMachineRun", [receipt.runId])) as {
      status: string;
      revision: number;
    };
    expect(before.status).toBe("running");
    expect(before.revision).toBeGreaterThan(0);

    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree(harness);
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    for (let attempt = 0; attempt < 30; attempt++) {
      const snapshot = (await call("getStateMachineRun", [receipt.runId])) as {
        status: string;
        revision: number;
        result?: { completed: number };
      };
      if (snapshot.status === "completed") {
        expect(snapshot.result).toEqual({ completed: 5 });
        expect(snapshot.revision).toBe(5);
        return;
      }
      await sleep(500);
    }
    throw new Error("StateMachine run did not recover after process restart");
  });
});
