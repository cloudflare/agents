/**
 * E2E test: chat recovery OUTCOME options after a real process kill.
 *
 * Covers the two `onChatRecovery` return-value branches that suppress the
 * default continue behavior:
 *   - `{ continue: false }`        — persist the partial, do NOT re-run.
 *   - `{ persist: false, continue: false }` — drop a plain-text partial and do
 *     NOT re-run.
 *
 * Both interrupt a turn AFTER it has flushed a non-empty partial (so there is
 * real content to persist or drop).
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
const PORT = 18800;
const PERSIST_DIR = path.join(__dirname, ".wrangler-chat-outcomes-state");

type RecoveryStatus = {
  recoveryCount: number;
  contexts: Array<{ streamId: string; requestId: string; partialText: string }>;
  messageCount: number;
  assistantMessages: number;
};

const harness = createWranglerHarness({
  port: PORT,
  persistDir: PERSIST_DIR,
  configPath: path.join(__dirname, "wrangler.jsonc"),
  cwd: __dirname,
  label: "outcomes"
});

function agentUrl(slug: string, name: string): string {
  return `${harness.url}/agents/${slug}/${name}`;
}

/** Interrupt a turn after it has flushed a non-empty partial, then restart. */
async function interruptAfterPartial(
  url: string,
  wrangler: ChildProcess
): Promise<ChildProcess> {
  await sendChatMessage(url, "tell me something long");
  // 6s: the 500ms/chunk mock streams past the 10-chunk flush threshold, so the
  // partial is recoverable (non-empty) when killed.
  await sleep(6000);
  expect((await rpcCall(url, "hasFiberRows")) as boolean).toBe(true);

  await killProcess(wrangler);
  await harness.waitForPortFree();
  const next = harness.start();
  await harness.waitForReady();
  return next;
}

describe("chat recovery outcome options e2e", () => {
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

  it("persists the partial but does not re-run the turn when onChatRecovery returns { continue: false }", async () => {
    const url = agentUrl("chat-no-continue-agent", "outcome-no-continue");
    wrangler = harness.start();
    await harness.waitForReady();

    wrangler = await interruptAfterPartial(url, wrangler);

    const status = await pollUntil(
      "no-continue recovery",
      () => rpcCall(url, "getRecoveryStatus") as Promise<RecoveryStatus>,
      (s) => s.recoveryCount > 0
    );
    expect(status.contexts[0].partialText.length).toBeGreaterThan(0);

    // The partial is persisted as a durable assistant message...
    const settled = await pollUntil(
      "no-continue assistant persisted",
      () => rpcCall(url, "getRecoveryStatus") as Promise<RecoveryStatus>,
      (s) => s.assistantMessages >= 1
    );
    expect(settled.assistantMessages).toBe(1);
    expect((await rpcCall(url, "getAssistantText")) as string).toContain(
      "chunk"
    );

    // ...but the turn was NOT re-run: onChatMessage ran exactly once.
    expect((await rpcCall(url, "getChatMessageInvocations")) as number).toBe(1);

    const fiberRowsAfter = await pollUntil(
      "no-continue fiber cleanup",
      () => rpcCall(url, "hasFiberRows") as Promise<boolean>,
      (has) => has === false
    );
    expect(fiberRowsAfter).toBe(false);
  });

  it("drops a plain-text partial and does not re-run when onChatRecovery returns { persist: false, continue: false }", async () => {
    const url = agentUrl(
      "chat-no-persist-no-continue-agent",
      "outcome-no-persist"
    );
    wrangler = harness.start();
    await harness.waitForReady();

    wrangler = await interruptAfterPartial(url, wrangler);

    const status = await pollUntil(
      "no-persist recovery",
      () => rpcCall(url, "getRecoveryStatus") as Promise<RecoveryStatus>,
      (s) => s.recoveryCount > 0
    );
    // Recovery still SEES the partial — it just chooses to discard it.
    expect(status.contexts[0].partialText.length).toBeGreaterThan(0);

    // Give any (incorrect) continuation/persist a chance to land before
    // asserting the negative.
    await sleep(3000);
    const after = (await rpcCall(url, "getRecoveryStatus")) as RecoveryStatus;
    // Plain-text partial with no settled tool results is dropped.
    expect(after.assistantMessages).toBe(0);
    expect(after.messageCount).toBe(1);
    // And the turn was not re-run.
    expect((await rpcCall(url, "getChatMessageInvocations")) as number).toBe(1);

    const fiberRowsAfter = await pollUntil(
      "no-persist fiber cleanup",
      () => rpcCall(url, "hasFiberRows") as Promise<boolean>,
      (has) => has === false
    );
    expect(fiberRowsAfter).toBe(false);
  });
});
