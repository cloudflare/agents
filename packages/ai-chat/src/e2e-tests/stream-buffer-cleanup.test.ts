/**
 * E2E test: resumable-stream buffer cleanup alarm (#1706).
 *
 * A completed chat turn leaves a resumable-stream buffer (a
 * `cf_ai_chat_stream_metadata` row + packed `cf_ai_chat_stream_chunks` rows)
 * that is redundant with the persisted assistant message. The lazy sweep in
 * `ResumableStream` only fires when a *subsequent* stream completes, which never
 * happens for an idle/one-off chat DO — so the framework arms a
 * no cleanup alarm any more: the cutover deletes the buffer, and that
 * alarm re-arms only while reclaimable rows remain.
 *
 * The real retention windows (10 min completed / 1 h abandoned) and cleanup
 * delay (10 min) are far too long to wait in e2e, so this test drives the sweep
 * DETERMINISTICALLY: it injects a far-future "now" into `cleanup(now)` via a
 * @callable on the test agent rather than sleeping out the windows.
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
  sendChatMessage
} from "./harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18803;
const PERSIST_DIR = path.join(__dirname, ".wrangler-stream-cleanup-state");

const harness = createWranglerHarness({
  port: PORT,
  persistDir: PERSIST_DIR,
  configPath: path.join(__dirname, "wrangler.jsonc"),
  cwd: __dirname,
  label: "stream-cleanup"
});

const AGENT_NAME = "stream-cleanup-e2e";
const agentUrl = `${harness.url}/agents/chat-buffer-cleanup-agent/${AGENT_NAME}`;

describe("resumable-stream buffer cleanup alarm e2e (#1706)", () => {
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

  it("a completed turn leaves no stream buffer and arms no cleanup alarm", async () => {
    wrangler = harness.start();
    await harness.waitForReady();

    // Turn #1: the cutover persists the message, settles the stream and
    // deletes its rows in one transaction. Poll for the message, then assert
    // the buffer is gone.
    await sendChatMessage(agentUrl, "first turn");
    await pollUntil(
      "buffer rows after turn 1",
      () => rpcCall(agentUrl, "bufferRowCount") as Promise<number>,
      (count) => count === 0
    );
    expect((await rpcCall(agentUrl, "chunkRowCount")) as number).toBe(0);
    expect((await rpcCall(agentUrl, "cleanupScheduleCount")) as number).toBe(0);

    // Turn #2: same, and still no alarm.
    await sendChatMessage(agentUrl, "second turn");
    await pollUntil(
      "buffer rows after turn 2",
      () => rpcCall(agentUrl, "bufferRowCount") as Promise<number>,
      (count) => count === 0
    );
    expect((await rpcCall(agentUrl, "chunkRowCount")) as number).toBe(0);
    expect((await rpcCall(agentUrl, "cleanupScheduleCount")) as number).toBe(0);

    // A reclaim finds nothing to do.
    expect(
      (await rpcCall(agentUrl, "forceSweep", [Date.now()])) as number
    ).toBe(0);
  });
});
