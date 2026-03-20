import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { TestKeepAliveAgent } from "./agents/keep-alive";

describe("keepAlive", () => {
  it("should create a heartbeat schedule when started", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "create-heartbeat"
    );

    // No heartbeat schedules initially
    expect(await getHeartbeatCount(agent)).toBe(0);

    await agent.startKeepAlive();

    // Should have created exactly one heartbeat schedule
    expect(await getHeartbeatCount(agent)).toBe(1);

    // Verify the schedule properties
    const schedule = await getHeartbeatSchedule(agent);
    expect(schedule).toBeDefined();
    expect(schedule?.callback).toBe("_cf_keepAliveHeartbeat");
    expect(schedule?.type).toBe("interval");
    expect(schedule?.intervalSeconds).toBe(30);
  });

  it("should remove the heartbeat schedule when disposed", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "dispose-heartbeat"
    );

    await agent.startKeepAlive();
    expect(await getHeartbeatCount(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getHeartbeatCount(agent)).toBe(0);
  });

  it("should be idempotent when disposed multiple times", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "double-dispose"
    );

    await agent.startKeepAlive();
    expect(await getHeartbeatCount(agent)).toBe(1);

    // First dispose removes the schedule
    await agent.stopKeepAlive();
    expect(await getHeartbeatCount(agent)).toBe(0);

    // Second dispose is a no-op (doesn't throw)
    await agent.stopKeepAlive();
    expect(await getHeartbeatCount(agent)).toBe(0);
  });

  it("keepAliveWhile should return the function result and clean up", async () => {
    const agent = await getAgentByName(env.TestKeepAliveAgent, "while-success");

    expect(await getHeartbeatCount(agent)).toBe(0);

    const result = await agent.runWithKeepAliveWhile();
    expect(result).toBe("completed");

    // Heartbeat should be cleaned up after the function completes
    expect(await getHeartbeatCount(agent)).toBe(0);
  });

  it("keepAliveWhile should clean up even when the function throws", async () => {
    const agent = await getAgentByName(env.TestKeepAliveAgent, "while-error");

    expect(await getHeartbeatCount(agent)).toBe(0);

    const result = await agent.runWithKeepAliveWhileError();
    expect(result).toBe("caught");

    // Heartbeat should be cleaned up despite the error
    expect(await getHeartbeatCount(agent)).toBe(0);
  });

  it("should support multiple concurrent keepAlive calls", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "multiple-keepalive"
    );

    await agent.startKeepAlive();
    await agent.startKeepAlive();

    // Each call creates its own schedule
    expect(await getHeartbeatCount(agent)).toBe(2);
    expect(await getKeepAliveCallCount(agent)).toBe(2);

    // Stopping only cancels the latest disposer
    await agent.stopKeepAlive();
    expect(await getHeartbeatCount(agent)).toBe(1);
    expect(await getKeepAliveCallCount(agent)).toBe(1);
  });
});

// Helper functions using runInDurableObject for direct internal access
async function getHeartbeatCount(
  stub: DurableObjectStub<TestKeepAliveAgent>
): Promise<number> {
  return runInDurableObject(stub, (instance) => {
    const result = instance.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE callback = '_cf_keepAliveHeartbeat'
    `;
    return result[0].count;
  });
}

async function getHeartbeatSchedule(
  stub: DurableObjectStub<TestKeepAliveAgent>
) {
  return runInDurableObject(stub, (instance) => {
    const result = instance.sql<{
      id: string;
      callback: string;
      type: string;
      intervalSeconds: number;
    }>`
      SELECT id, callback, type, intervalSeconds FROM cf_agents_schedules
      WHERE callback = '_cf_keepAliveHeartbeat'
      LIMIT 1
    `;
    return result[0] ?? null;
  });
}

async function getKeepAliveCallCount(
  stub: DurableObjectStub<TestKeepAliveAgent>
): Promise<number> {
  return runInDurableObject(stub, (instance) => {
    return instance.keepAliveCallCount;
  });
}
