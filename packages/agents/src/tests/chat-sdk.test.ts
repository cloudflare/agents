import { env } from "cloudflare:workers";
import { getAgentByName } from "../index";
import { describe, expect, it } from "vitest";
import type { TestChatSdkStateHostAgent } from "./agents";

type TestEnv = typeof env & {
  TestChatSdkStateHostAgent: DurableObjectNamespace<TestChatSdkStateHostAgent>;
};

function uniqueName(): string {
  return `chat-sdk-state-${crypto.randomUUID()}`;
}

async function getHost(): Promise<TestChatSdkStateHostAgent> {
  return (await getAgentByName(
    (env as TestEnv).TestChatSdkStateHostAgent,
    uniqueName()
  )) as unknown as TestChatSdkStateHostAgent;
}

describe("agents/chat-sdk StateAdapter", () => {
  it("requires connect before use", async () => {
    const host = await getHost();

    await expect(host.testDisconnectedGuard()).resolves.toBe(
      "ChatSdkStateAdapter is not connected"
    );
  });

  it("persists subscription state", async () => {
    const host = await getHost();

    await expect(host.testSubscriptions("telegram:sub")).resolves.toEqual([
      false,
      true,
      false
    ]);
  });

  it("enforces lock ownership and expiry", async () => {
    const host = await getHost();

    await expect(host.testLocks("telegram:locks")).resolves.toEqual({
      first: true,
      second: false,
      extended: true,
      afterRelease: true
    });
    await expect(host.testExpiredLock("telegram:expired-lock")).resolves.toBe(
      true
    );
  });

  it("queues messages in FIFO order after max-size trimming", async () => {
    const host = await getHost();

    await expect(host.testQueue("telegram:queue")).resolves.toEqual({
      first: "b",
      second: "c",
      third: null
    });
    await expect(host.testExpiredQueue("telegram:expired-queue")).resolves.toBe(
      true
    );
  });

  it("stores cache entries with set-if-not-exists, delete, and TTL behavior", async () => {
    const host = await getHost();

    await expect(
      host.testCache("thread-state:telegram:cache")
    ).resolves.toEqual([{ value: 1 }, false, null, true, { value: 3 }, null]);
  });

  it("stores lists with insertion order, max length, and TTL behavior", async () => {
    const host = await getHost();

    await expect(host.testList("msg-history:telegram:list")).resolves.toEqual([
      ["b", "c"],
      []
    ]);
  });

  it("refreshes list TTLs for the whole logical list", async () => {
    const host = await getHost();

    await expect(
      host.testListTtlRefresh("msg-history:telegram:list-ttl-refresh")
    ).resolves.toEqual([]);
  });

  it("routes known ChatSdk keys to stable state shards", async () => {
    const host = await getHost();

    await expect(host.testShardRouting()).resolves.toEqual({
      thread: "telegram:123",
      channel: "telegram:123",
      history: "telegram:123",
      transcript: "acme:user-123",
      callback: undefined,
      fallbackThread: "telegram:123"
    });
  });

  it("supports ChatSdk feature paths backed by state", async () => {
    const host = await getHost();

    await expect(host.testChatFeaturePaths()).resolves.toEqual({
      channelState: { topic: "support" },
      dedupeHandledCount: 1,
      history: ["third", "second"],
      threadState: { mode: "alpha", count: 2 },
      transcriptAfterDelete: 0,
      transcriptCount: 2,
      transcriptList: ["assistant reply", "handoff marker"]
    });
  });
});
