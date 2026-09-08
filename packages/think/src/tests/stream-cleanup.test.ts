import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

// Resumable-stream buffers are reclaimed without an alarm: the cutover
// deletes a finished stream's rows in the transaction that persists its
// message, and the next stream start reclaims anything a crash left behind —
// finished streams of any age and in-flight rows abandoned past the stale
// window. Uses ThinkRecoveryTestAgent, which carries the stream test helpers.

const CLEANUP_CALLBACK = "_cleanupStreamBuffers";

async function freshAgent(name?: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name ?? crypto.randomUUID()
  );
}

describe("Think — stream reclaim (no cleanup alarm)", () => {
  it("never arms a cleanup alarm when a stream starts or finishes", async () => {
    const agent = await freshAgent();
    await agent.startStreamForTest("req-1");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);
    await agent.insertAgedStreamForTest("s1", "req-2", "streaming", 1000);
    await agent.completeStreamForTest("s1");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);
  });

  it("reclaims finished streams of any age and abandoned in-flight rows past the stale window", async () => {
    const agent = await freshAgent();
    await agent.insertAgedStreamForTest(
      "done-recent",
      "req-d",
      "completed",
      5_000
    );
    await agent.insertAgedStreamForTest(
      "old-errored",
      "req-e",
      "error",
      25 * 60 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "inflight-recent",
      "req-r",
      "streaming",
      30 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "inflight-stale",
      "req-s",
      "streaming",
      70 * 60 * 1000
    );

    expect(await agent.runStreamCleanupForTest()).toBe(3);
    expect(await agent.getStreamStatusForTest("done-recent")).toBeNull();
    expect(await agent.getStreamStatusForTest("old-errored")).toBeNull();
    expect(await agent.getStreamStatusForTest("inflight-stale")).toBeNull();
    expect(await agent.getStreamStatusForTest("inflight-recent")).toBe(
      "streaming"
    );
  });

  it("does not reclaim a long-running stream that is still emitting chunks", async () => {
    const agent = await freshAgent();
    await agent.insertAgedStreamForTest(
      "long-active",
      "req-a",
      "streaming",
      25 * 60 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("long-active", 60 * 1000);
    await agent.insertAgedStreamForTest(
      "long-silent",
      "req-s",
      "streaming",
      25 * 60 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("long-silent", 25 * 60 * 60 * 1000);

    await agent.runStreamCleanupForTest();
    expect(await agent.getStreamStatusForTest("long-active")).toBe("streaming");
    expect(await agent.getStreamStatusForTest("long-silent")).toBeNull();
  });

  it("keeps an in-flight buffer's chunks reconstructable within the stale window", async () => {
    const agent = await freshAgent();
    await agent.insertAgedStreamForTest(
      "recovering",
      "req-recovering",
      "streaming",
      30 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("recovering", 20 * 60 * 1000);

    await agent.runStreamCleanupForTest();
    expect(await agent.getStreamStatusForTest("recovering")).toBe("streaming");
    const snapshot = await agent.getLatestStreamSnapshot();
    expect(snapshot?.requestId).toBe("req-recovering");
    expect(snapshot?.chunkCount).toBeGreaterThan(0);
  });

  it("a real turn leaves no stream rows behind", async () => {
    const agent = await freshAgent();
    const result = await agent.testChat("Cut over");
    expect(result.done).toBe(true);
    expect(await agent.getLatestStreamSnapshot()).toBeNull();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);
  });
});
