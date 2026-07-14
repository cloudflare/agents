/**
 * Ported from: packages/think/src/e2e-tests/action-pause-recovery.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E test: durable-pause action approval survives a deploy and resumes with no
 * live connection (actions RFC Step 5).
 *
 * Drives the full path inside a real `wrangler dev` runtime:
 *  1. a chat turn calls a `kind: "durable-pause"` action, which parks a row in
 *     `cf_think_action_pending_approvals` and ends the turn
 *  2. a real SIGKILL + restart proves the pending row + its approval descriptor
 *     survive the deploy (rebuilt from the durable store on cold start)
 *  3. `approveExecution` with NO open socket runs the action exactly once and
 *     the connection-independent continuation drives the model to completion
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
  pollUntil,
  restartWrangler,
  startWrangler,
  waitForReady,
  type StartWranglerOptions
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18804;
const AGENT_SLUG = "think-action-pause-recovery-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-think-action-pause-e2e-state"
);

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: `/agents/${AGENT_SLUG}/action-pause-deploy`
};

function startWranglerForTest(): ChildProcess {
  return startWrangler(WRANGLER_OPTS);
}

async function restartWranglerForTest(
  child: ChildProcess
): Promise<ChildProcess> {
  return restartWrangler(child, WRANGLER_OPTS);
}

async function callAgent(
  agentName: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(`/agents/${AGENT_SLUG}/${agentName}`, method, args);
}

describe("Think durable-pause action recovery e2e", () => {
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

  it("parks across a deploy and resumes on approve with no open connection", async () => {
    const agent = "action-pause-deploy";

    wrangler = startWranglerForTest();
    await waitForReady();

    // 1. A chat turn calls the durable-pause action, which parks and ends.
    const turn = (await callAgent(agent, "startActionPauseTurn", [
      "please deploy"
    ])) as { done: boolean };
    expect(turn.done).toBe(true);

    // The pending row exists and the action has NOT executed yet.
    const pendingBefore = (await callAgent(agent, "pendingCount")) as number;
    expect(pendingBefore).toBe(1);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // The approval descriptor is present before the restart.
    const descriptorJson = (await callAgent(agent, "firstPendingJson")) as
      | string
      | null;
    expect(descriptorJson).toBeTruthy();
    const parsed = JSON.parse(descriptorJson as string) as {
      executionId: string;
      source: string;
      descriptor: Record<string, unknown>;
    };
    expect(parsed.source).toBe("action");
    expect(parsed.executionId.startsWith("actpause_")).toBe(true);
    expect(parsed.descriptor).toMatchObject({
      action: "pauseAction",
      kind: "durable-pause",
      summary: "Deploy the thing",
      risk: "high",
      permissions: ["deploy:run"]
    });

    // 2. Real deploy churn: SIGKILL + restart with the same persist dir.
    wrangler = await restartWranglerForTest(wrangler);

    // The pending row + descriptor survived the deploy (rebuilt from the store).
    const survived = (await callAgent(agent, "firstPendingJson")) as
      | string
      | null;
    expect(survived).toBeTruthy();
    const survivedParsed = JSON.parse(survived as string) as {
      executionId: string;
    };
    expect(survivedParsed.executionId).toBe(parsed.executionId);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // 3. Approve with NO open connection → runs the action once and the
    //    connection-independent continuation drives the model to completion.
    const approved = (await callAgent(agent, "approveFirstPending")) as {
      executionId: string | null;
      result: string;
    };
    expect(approved.executionId).toBe(parsed.executionId);
    expect(approved.result).toContain("deployed: deploy me");

    // The action executed exactly once and the pending row is cleared.
    expect((await callAgent(agent, "getExecCount")) as number).toBe(1);

    const finalText = await pollUntil(
      "final assistant text",
      () => callAgent(agent, "getFinalText") as Promise<string>,
      (text) => text.includes("approved and acknowledged"),
      { attempts: 30, delayMs: 1000 }
    );
    expect(finalText).toContain("approved and acknowledged");

    const pendingAfter = (await callAgent(agent, "pendingCount")) as number;
    expect(pendingAfter).toBe(0);
  });
});
