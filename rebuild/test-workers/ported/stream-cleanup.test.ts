/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/stream-cleanup.test.ts
 * - last original change: f6a8bc4a
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents` import to `./compat.js`.
 * - Re-pointed original fixture type import to `./fixtures/index.js`.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "./compat.js";
import type { ThinkRecoveryTestAgent } from "./fixtures/index.js";

const CLEANUP_CALLBACK = "_cleanupStreamBuffers";

async function freshAgent(name?: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name ?? crypto.randomUUID()
  );
}

describe("Think — alarm-driven stream cleanup (#1706)", () => {
  it("arms a single cleanup alarm when a stream finishes, deduping repeats", async () => {
    const agent = await freshAgent();

    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);

    await agent.insertAgedStreamForTest("s1", "req-1", "streaming", 1000);
    await agent.completeStreamForTest("s1");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);

    await agent.insertAgedStreamForTest("s2", "req-2", "streaming", 1000);
    await agent.completeStreamForTest("s2");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("reclaims aged buffers when the alarm fires without a new stream completing", async () => {
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "old-errored",
      "req-errored",
      "error",
      25 * 60 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "abandoned",
      "req-abandoned",
      "streaming",
      25 * 60 * 60 * 1000
    );

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("old-errored")).toBeNull();
    expect(await agent.getStreamStatusForTest("abandoned")).toBeNull();
  });

  it("re-arms only while reclaimable buffers remain", async () => {
    const agent = await freshAgent();

    await agent.runStreamCleanupForTest();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);

    await agent.insertAgedStreamForTest(
      "recent",
      "req-recent",
      "streaming",
      60 * 1000
    );
    await agent.runStreamCleanupForTest();
    expect(await agent.getStreamStatusForTest("recent")).toBe("streaming");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("survives the real alarm fire and re-arms when a younger buffer remains", async () => {
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "young",
      "req-young",
      "streaming",
      60 * 1000
    );
    await agent.completeStreamForTest("young");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);

    await agent.fireDueCleanupAlarmForTest();

    expect(await agent.getStreamStatusForTest("young")).toBe("completed");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("stops re-arming after the real alarm sweeps the last buffer", async () => {
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "old",
      "req-old",
      "completed",
      25 * 60 * 60 * 1000
    );
    await agent.armStreamCleanupForTest();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);

    await agent.fireDueCleanupAlarmForTest();

    expect(await agent.getStreamStatusForTest("old")).toBeNull();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);
  });

  it("does not sweep a long-running stream that is still emitting chunks", async () => {
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "long-active",
      "req-active",
      "streaming",
      25 * 60 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("long-active", 60 * 1000);

    await agent.insertAgedStreamForTest(
      "long-silent",
      "req-silent",
      "streaming",
      25 * 60 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("long-silent", 25 * 60 * 60 * 1000);

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("long-active")).toBe("streaming");
    expect(await agent.getStreamStatusForTest("long-silent")).toBeNull();
  });

  it("arms cleanup when a stream starts (covers never-finished orphans)", async () => {
    const agent = await freshAgent();

    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);

    await agent.startStreamForTest("req-orphan");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("arms the cleanup alarm at the completion-grace delay (10 minutes)", async () => {
    const agent = await freshAgent();

    await agent.armStreamCleanupForTest();
    expect(await agent.streamCleanupScheduleDelaySecondsForTest()).toBe(
      10 * 60
    );
  });

  it("sweeps a finished buffer past the 10-minute grace, keeps a recent one", async () => {
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "done-stale",
      "req-done-stale",
      "completed",
      11 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "done-recent",
      "req-done-recent",
      "completed",
      5 * 60 * 1000
    );

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("done-stale")).toBeNull();
    expect(await agent.getStreamStatusForTest("done-recent")).toBe("completed");
  });

  it("keeps an abandoned in-flight buffer until the 1-hour stale window", async () => {
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "inflight-recent",
      "req-inflight-recent",
      "streaming",
      30 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "inflight-stale",
      "req-inflight-stale",
      "streaming",
      70 * 60 * 1000
    );

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("inflight-recent")).toBe(
      "streaming"
    );
    expect(await agent.getStreamStatusForTest("inflight-stale")).toBeNull();
  });

  it("keeps an in-flight buffer's chunks reconstructable past the completion grace", async () => {
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
});
