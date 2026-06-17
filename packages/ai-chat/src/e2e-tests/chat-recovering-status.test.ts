/**
 * E2E test: live "recovering…" status broadcast (#1620).
 *
 * When a durable chat turn is interrupted (process eviction) and the framework
 * schedules a recovery continuation, it sets a durable "recovering" flag
 * (`cf:chat:recovering`) and broadcasts a `cf_agent_chat_recovering` frame so
 * connected clients can render a "recovering…" indicator. The flag/frame is
 * cleared on the terminal outcome (the continuation completing).
 *
 * ai-chat broadcasts the recovering frame LIVE and (since the Phase 2 #1620
 * convergence onto @cloudflare/think) also REPLAYS it on connect — but only when
 * no stream is active (between the scheduled continuation and its first chunk).
 * Once the continuation is streaming, a fresh connect gets STREAM_RESUMING
 * instead, so the on-connect replay window is timing-dependent and asserted
 * deterministically by the `durable-chat-recovery` unit test
 * (`getRecoveringConnectFrameForTest`). Here the active→cleared TRANSITION is
 * asserted deterministically against the durable flag (a @callable returning the
 * framework's `cf:chat:recovering` key), a live collector reliably observes the
 * `recovering:false` CLEAR frame, and a freshly-connected collector
 * opportunistically observes the on-connect `true` replay when it lands in the
 * no-active-stream window.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  createFrameCollector,
  createWranglerHarness,
  killProcess,
  killProcessOnPort,
  pollUntil,
  rpcCall,
  sendChatMessage,
  sleep
} from "./harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18804;
const PERSIST_DIR = path.join(__dirname, ".wrangler-chat-recovering-state");

const harness = createWranglerHarness({
  port: PORT,
  persistDir: PERSIST_DIR,
  configPath: path.join(__dirname, "wrangler.jsonc"),
  cwd: __dirname,
  label: "recovering"
});

const AGENT_NAME = "chat-recovering-e2e";
const agentUrl = `${harness.url}/agents/chat-recovery-test-agent/${AGENT_NAME}`;

type RecoveringFlag = { requestId?: string; at?: number } | null;

const RECOVERING_FRAME = "cf_agent_chat_recovering";

describe("chat recovering-status broadcast e2e (#1620)", () => {
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

  it("sets and clears the recovering flag and broadcasts the clear frame during recovery", async () => {
    wrangler = harness.start();
    await harness.waitForReady();

    // Not recovering before anything happens.
    expect(
      (await rpcCall(agentUrl, "getRecoveringFlag")) as RecoveringFlag
    ).toBe(null);

    await sendChatMessage(agentUrl, "Tell me something interesting");

    // Wait long enough for the slow mock model (20 deltas @ 500ms) to flush a
    // non-empty partial to its durable buffer (ResumableStream flushes in
    // batches of 10), so recovery takes the CONTINUE path and schedules a
    // continuation that re-runs the (slow) turn — keeping the "recovering"
    // window open long enough to observe deterministically.
    await sleep(6000);
    expect((await rpcCall(agentUrl, "hasFiberRows")) as boolean).toBe(true);

    // SIGKILL mid-turn, then restart against the same persist dir so the
    // recovery alarm fires and schedules the continuation.
    await killProcess(wrangler);
    wrangler = null;
    await harness.waitForPortFree();
    wrangler = harness.start();
    await harness.waitForReady();

    // Connect a live frame collector immediately so it is present for the
    // duration of the continuation (and can observe broadcasts). It sends
    // nothing, so it does not perturb recovery.
    const collector = createFrameCollector(agentUrl);
    try {
      await collector.ready();

      // DETERMINISTIC: the durable flag transitions to active while the
      // continuation is scheduled/running.
      const active = await pollUntil(
        "recovering flag active",
        () => rpcCall(agentUrl, "getRecoveringFlag") as Promise<RecoveringFlag>,
        (flag) => flag !== null,
        { attempts: 40, delayMs: 500 }
      );
      expect(active).not.toBe(null);
      expect(typeof active?.at).toBe("number");

      // ON-CONNECT REPLAY (#1620 convergence): a client that connects while
      // recovery is in progress is re-told the turn is recovering rather than
      // left frozen. A connect that lands in the no-active-stream window
      // receives the replayed `recovering:true` frame directly on connect
      // (deterministic guarantee lives in the unit test; this exercises the real
      // socket path). Best-effort because the continuation may already be
      // streaming, in which case the connect gets STREAM_RESUMING instead.
      const replayCollector = createFrameCollector(agentUrl);
      try {
        await replayCollector.ready();
        const replayed = await replayCollector
          .waitForFrame(
            RECOVERING_FRAME,
            (frame) => frame.recovering === true,
            4000
          )
          .catch(() => null);
        if (replayed) {
          expect(replayed.recovering).toBe(true);
          expect(
            typeof replayed.id === "string" || replayed.id === undefined
          ).toBe(true);
        }
      } finally {
        replayCollector.close();
      }

      // DETERMINISTIC: the flag is cleared once the continuation reaches its
      // terminal (completed) outcome.
      const cleared = await pollUntil(
        "recovering flag cleared",
        () => rpcCall(agentUrl, "getRecoveringFlag") as Promise<RecoveringFlag>,
        (flag) => flag === null,
        { attempts: 60, delayMs: 1000 }
      );
      expect(cleared).toBe(null);

      // REAL BROADCAST PATH: the collector, connected for the whole
      // continuation, observes the `recovering:false` CLEAR frame. (The `true`
      // frame may fire before the collector connects — it is not replayed on
      // connect — so it is asserted only opportunistically below.)
      const clearFrame = await collector.waitForFrame(
        RECOVERING_FRAME,
        (frame) => frame.recovering === false,
        30000
      );
      expect(clearFrame.recovering).toBe(false);

      // Opportunistic: if the collector also caught the `true` transition,
      // verify its shape (advisory progress hint carrying the root request id).
      const activeFrames = collector
        .framesOfType(RECOVERING_FRAME)
        .filter((frame) => frame.recovering === true);
      for (const frame of activeFrames) {
        expect(frame.recovering).toBe(true);
        expect(typeof frame.id === "string" || frame.id === undefined).toBe(
          true
        );
      }
    } finally {
      collector.close();
    }
  });
});
