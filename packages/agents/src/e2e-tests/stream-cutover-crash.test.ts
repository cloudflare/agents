/**
 * E2E test: the block log and the stream → message cutover under real
 * Durable Object death, at the points that matter:
 *
 *   1. before a block append commits
 *   2. immediately after it commits
 *   3. during rollover to the next block (before and after commit)
 *   4. after session persistence but before cleanup — the non-atomic path
 *      hosts use today, and the atomic cutover, killed inside and after
 *
 * Each restart must find either the exact committed stream prefix or the
 * final session message: never neither, never both applied twice. Death is
 * `ctx.abort()` from inside the object (deterministic to the statement),
 * and the inspection runs on the fresh instance that replaces it.
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
  startWrangler,
  waitForReady,
  type Harness
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18829;
const HARNESS: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: path.join(__dirname, ".wrangler-cutover-crash-state")
};

type Inspection = {
  state: string | null;
  cursor: number | null;
  chunks: number[];
  blocks: Array<{ block: number; seq_from: number; seq_to: number }>;
  messageRows: number;
};

async function crash(
  name: string,
  method: string,
  args: unknown[]
): Promise<Inspection> {
  const agentPath = `/agents/cutover-kill-agent/${name}`;
  // The abort kills the object mid-call: the RPC rejects, which is expected.
  await callAgentByPath(HARNESS, agentPath, method, args).catch(() => {});
  return (await callAgentByPath(HARNESS, agentPath, "inspect", [
    args[0]
  ])) as Inspection;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("stream cutover crash matrix e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(async () => {
    killProcessOnPort(PORT);
    fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);
  });

  afterEach(async () => {
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    killProcessOnPort(PORT);
    fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
  });

  it("1. crash before a block append commits: the exact prior prefix survives", async () => {
    const after = await crash("p1", "crashBeforeAppendCommits", ["s1"]);
    expect(after.state).toBe("streaming");
    expect(after.chunks).toEqual(range(10));
    expect(after.cursor).toBe(10);
    expect(after.messageRows).toBe(0);
  });

  it("2. crash immediately after the append commits: the append survives", async () => {
    const after = await crash("p2", "crashAfterAppendCommits", ["s2"]);
    expect(after.state).toBe("streaming");
    expect(after.chunks).toEqual(range(11));
    expect(after.cursor).toBe(11);
  });

  it("3. crash during rollover: block 1 is all-or-nothing and the log stays contiguous", async () => {
    const before = await crash("p3a", "crashDuringRollover", ["s3a", false]);
    expect(before.chunks).toEqual([0]);
    expect(before.blocks).toEqual([{ block: 0, seq_from: 0, seq_to: 1 }]);

    const committed = await crash("p3b", "crashDuringRollover", ["s3b", true]);
    expect(committed.chunks).toEqual([0, 1]);
    expect(committed.blocks).toEqual([
      { block: 0, seq_from: 0, seq_to: 1 },
      { block: 1, seq_from: 1, seq_to: 2 }
    ]);
  });

  it("4a. non-atomic path, crash after persist before discard: message once, stream settled with its prefix", async () => {
    const after = await crash("p4a", "crashAfterPersistBeforeDiscard", ["s4a"]);
    expect(after.messageRows).toBe(1);
    expect(after.state).toBe("completed");
    expect(after.chunks).toEqual(range(10));
    // Both present, neither duplicated: the completed stream is redundant
    // and is what the next start() reclaims.
  });

  it("4b. atomic cutover: a crash inside commit lands nothing; after it, everything", async () => {
    const inside = await crash("p4b-in", "crashAroundCutover", [
      "s4b-in",
      "inside"
    ]);
    expect(inside.messageRows).toBe(0);
    expect(inside.state).toBe("streaming");
    expect(inside.chunks).toEqual(range(10));

    const done = await crash("p4b-out", "crashAroundCutover", [
      "s4b-out",
      "after"
    ]);
    expect(done.messageRows).toBe(1);
    expect(done.state).toBeNull();
    expect(done.blocks).toEqual([]);
  });
});
