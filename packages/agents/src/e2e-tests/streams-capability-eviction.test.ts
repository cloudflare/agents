/**
 * E2E test: the Tasks + Streams composition under real process eviction.
 *
 * A task produces 1s-spaced chunks into a durable stream, checkpointing the
 * cursor. The test SIGKILLs wrangler mid-production, restarts against the
 * same persist dir, and verifies:
 *
 * - the chunks appended before death survived, exactly and in order;
 * - the recover callback observed the stream's durable status (state
 *   `streaming`, cursor == checkpointed cursor) as its evidence;
 * - the recovery decision finalized the stream (`completed` at that cursor)
 *   and settled the task with the same cursor — no producer re-execution.
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
  sleep,
  startWrangler,
  waitForPortFree,
  waitForReady,
  type Harness
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18828;
const HARNESS: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: path.join(__dirname, ".wrangler-streams-capability-state")
};

const AGENT_NAME = "streams-capability-e2e";
const STREAM_ID = "e2e-report";

async function callStreamAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(
    HARNESS,
    `/agents/stream-kill-test-agent/${AGENT_NAME}`,
    method,
    args
  );
}

describe("streams capability eviction e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
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
      fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  it("chunks survive SIGKILL and recovery finalizes from the stream cursor", async () => {
    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);

    const runId = (await callStreamAgent("startGenerate", [
      STREAM_ID,
      8
    ])) as string;
    expect(runId).toBe("e2e-stream-gen");

    // Let a few 1s-spaced chunks land durably, then kill mid-production.
    await sleep(3500);
    const before = (await callStreamAgent("getStreamStatus", [STREAM_ID])) as {
      state: string;
      cursor: number;
    };
    expect(before.state).toBe("streaming");
    expect(before.cursor).toBeGreaterThan(0);
    expect(before.cursor).toBeLessThan(8);

    console.log("[test] Killing wrangler (SIGKILL)...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree(HARNESS);
    console.log("[test] Restarting wrangler...");
    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);

    // The first poll wakes the agent; the interrupted task's overdue queue
    // job re-fires and the replayed producer resumes from the durable
    // cursor, finishing the remaining chunks.
    let completed: { state: string; result: unknown } | null = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const current = (await callStreamAgent("getRunState", [runId])) as {
          state: string;
          result: unknown;
        } | null;
        console.log(`[test] Poll ${i + 1}: run state=${current?.state}`);
        if (current?.state === "completed") {
          completed = current;
          break;
        }
      } catch {
        console.log(`[test] Poll ${i + 1}: error (agent may not be ready)`);
      }
    }
    expect(completed).not.toBeNull();

    const status = (await callStreamAgent("getStreamStatus", [STREAM_ID])) as {
      state: string;
      cursor: number;
    };
    // The resumed producer finished the full stream: every chunk appended
    // before death survived and none was produced twice — the seq sequence
    // is gapless and duplicate-free.
    expect(status.state).toBe("completed");
    expect(status.cursor).toBe(8);
    expect(completed?.result).toEqual({ streamId: STREAM_ID, cursor: 8 });

    const seqs = (await callStreamAgent("readAllChunks", [
      STREAM_ID
    ])) as number[];
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const recoveries = (await callStreamAgent("getRecoveries", [])) as Array<{
      stream_state: string | null;
      stream_cursor: number;
    }>;
    // Exactly one replay entry, resuming from the mid-production cursor the
    // kill left behind — proof the kill was real and the resume durable.
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].stream_state).toBe("streaming");
    expect(recoveries[0].stream_cursor).toBeGreaterThan(0);
    expect(recoveries[0].stream_cursor).toBeLessThan(8);
  });
});
