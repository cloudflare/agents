import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TestHostAgent } from "./worker";

type TestEnv = typeof env & {
  TestHostAgent: DurableObjectNamespace<TestHostAgent>;
};

function uniqueName(): string {
  return `chat-sdk-messenger-${crypto.randomUUID()}`;
}

async function getHost(): Promise<TestHostAgent> {
  return (await getAgentByName(
    (env as TestEnv).TestHostAgent,
    uniqueName()
  )) as unknown as TestHostAgent;
}

describe("ChatSdkStateAdapter", () => {
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

  it("routes known Chat SDK keys to stable state shards", async () => {
    const host = await getHost();

    await expect(host.testShardRouting()).resolves.toEqual({
      thread: "telegram:123",
      channel: "telegram:123",
      history: "telegram:123",
      dedupe: "telegram:123",
      callback: undefined,
      fallbackThread: "telegram:123"
    });
  });
});
