/**
 * E2E test: resumable-stream buffer cleanup alarm (#1706).
 *
 * A completed chat turn leaves a resumable-stream buffer (a
 * `cf_ai_chat_stream_metadata` row + packed `cf_ai_chat_stream_chunks` rows)
 * that is redundant with the persisted assistant message. The lazy sweep in
 * `ResumableStream` only fires when a *subsequent* stream completes, which never
 * happens for an idle/one-off chat DO — so the framework arms a
 * `_cleanupStreamBuffers` cleanup alarm whenever a stream finishes, and that
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

  it("arms one cleanup alarm per DO and reclaims buffers on a forced future sweep", async () => {
    wrangler = harness.start();
    await harness.waitForReady();

    // Turn #1: complete a chat turn so a buffer row + a cleanup alarm exist.
    await sendChatMessage(agentUrl, "first turn");

    // The buffer row is written when the stream completes; poll for it rather
    // than racing the (fast) stream.
    await pollUntil(
      "buffer row after turn 1",
      () => rpcCall(agentUrl, "bufferRowCount") as Promise<number>,
      (count) => count >= 1
    );

    const bufferRows1 = (await rpcCall(agentUrl, "bufferRowCount")) as number;
    const chunkRows1 = (await rpcCall(agentUrl, "chunkRowCount")) as number;
    expect(bufferRows1).toBe(1);
    expect(chunkRows1).toBeGreaterThanOrEqual(1);

    // A single cleanup alarm is armed for this DO (so idle DOs still reclaim).
    const schedules1 = (await rpcCall(
      agentUrl,
      "cleanupScheduleCount"
    )) as number;
    expect(schedules1).toBe(1);

    // Reclaimable while a completed buffer remains.
    expect((await rpcCall(agentUrl, "hasReclaimableStreams")) as boolean).toBe(
      true
    );

    // Turn #2: a second completed turn must NOT stack a duplicate cleanup alarm
    // — `_ensureStreamCleanupScheduled` arms idempotently (dedupe on
    // callback+payload+owner).
    await sendChatMessage(agentUrl, "second turn");
    await pollUntil(
      "buffer rows after turn 2",
      () => rpcCall(agentUrl, "bufferRowCount") as Promise<number>,
      (count) => count >= 2
    );
    expect((await rpcCall(agentUrl, "bufferRowCount")) as number).toBe(2);

    const schedules2 = (await rpcCall(
      agentUrl,
      "cleanupScheduleCount"
    )) as number;
    expect(schedules2).toBe(1);

    // Force a sweep with an injected "now" two hours in the future — past both
    // the 10-minute completed-retention and the 1-hour abandoned windows — so
    // every completed buffer is reclaimed without waiting out the real timers.
    const farFutureNow = Date.now() + 2 * 60 * 60 * 1000;
    await rpcCall(agentUrl, "forceSweep", [farFutureNow]);

    // Buffers are reclaimed: no metadata rows, no chunk rows.
    expect((await rpcCall(agentUrl, "bufferRowCount")) as number).toBe(0);
    expect((await rpcCall(agentUrl, "chunkRowCount")) as number).toBe(0);

    // A fully-swept DO reports no reclaimable streams — so the next
    // `_cleanupStreamBuffers` run would NOT re-arm and the DO stops waking
    // itself.
    expect((await rpcCall(agentUrl, "hasReclaimableStreams")) as boolean).toBe(
      false
    );
  });
});
