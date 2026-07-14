/**
 * Ported from: packages/think/src/e2e-tests/context-overflow-recovery.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E test: Think context-overflow compaction recovery (in-process; no kills).
 *
 * Runs the agent inside a real `wrangler dev` Workers runtime and drives a chat
 * turn via a `@callable` RPC. A mock model surfaces an in-stream provider
 * context-overflow error; Think's opt-in `contextOverflow` recovery:
 *  - REACTIVE recover: compact + retry, the retry succeeds, final answer present.
 *  - REACTIVE exhaust: model keeps overflowing, retry budget spent → terminal
 *    overflow error surfaced (classified `context_overflow`).
 *  - PROACTIVE: model-reported usage crosses the headroom budget → pre-step
 *    compaction runs before the provider ever rejects.
 *
 * No process kills: the overflow is injected deterministically via the model, so
 * this exercises the full recovery path quickly and reliably.
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
  type StartWranglerOptions
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18802;
const AGENT_SLUG = "think-context-overflow-e2-e-agent";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-overflow-e2e-state");

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: `/agents/${AGENT_SLUG}/overflow-reactive-recover`
};

type OverflowChatOutcome = {
  done: boolean;
  error: string | null;
  compactionCount: number;
  compactionReasons: string[];
  modelCalls: number;
  assistantMessages: number;
  finalText: string;
  errorClassification: string | null;
};

function startWranglerForTest(): ChildProcess {
  return startWrangler(WRANGLER_OPTS);
}

async function callAgent(
  agentName: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(`/agents/${AGENT_SLUG}/${agentName}`, method, args);
}

describe("Think context-overflow recovery e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(async () => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
    wrangler = startWranglerForTest();
    await waitForReady();
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

  it("reactive: compacts and retries an overflowing turn to a successful answer", async () => {
    const outcome = (await callAgent(
      "overflow-reactive-recover",
      "runOverflowChat",
      ["Summarize the long history", "recover"]
    )) as OverflowChatOutcome;

    // The turn completed (no terminal error) after a compact-and-retry.
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeNull();
    // Compaction actually ran (reactive backstop), and the model was invoked
    // more than once (overflow attempt + recovered retry).
    expect(outcome.compactionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.compactionReasons).toContain("reactive");
    expect(outcome.modelCalls).toBeGreaterThanOrEqual(2);
    // The recovered assistant message is the final answer; the truncated partial
    // is intentionally not persisted as a separate orphan.
    expect(outcome.finalText).toContain("recovered after compaction");
    expect(outcome.finalText).not.toContain("partial answer before overflow");
  });

  it("reactive: surfaces a terminal overflow error when the retry budget is exhausted", async () => {
    const outcome = (await callAgent(
      "overflow-reactive-exhaust",
      "runOverflowChat",
      ["Summarize the long history", "exhaust"]
    )) as OverflowChatOutcome;

    // maxRetries (default 1) spent: the overflow surfaces terminally, classified
    // as context_overflow, and the turn never loops or ends silently.
    expect(outcome.error).not.toBeNull();
    expect(outcome.error ?? "").toContain("prompt is too long");
    expect(outcome.errorClassification).toBe("context_overflow");
    // Compaction was attempted on the (single) retry before giving up.
    expect(outcome.compactionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.compactionReasons).toContain("reactive");
  });

  it("proactive: compacts pre-step when reported usage crosses the headroom budget", async () => {
    const outcome = (await callAgent("overflow-proactive", "runOverflowChat", [
      "Do an echo step then answer",
      "proactive"
    ])) as OverflowChatOutcome;

    // The turn completed without ever hitting a provider overflow because the
    // proactive guard compacted in place before step 2.
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.compactionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.compactionReasons).toContain("proactive");
    expect(outcome.finalText).toContain("answered with headroom to spare");
  });
});
