import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("keepAlive", () => {
  it("should create a heartbeat schedule when started", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "create-heartbeat"
    );

    // No heartbeat schedules initially
    expect(await agent.getHeartbeatScheduleCount()).toBe(0);

    await agent.startKeepAlive();

    // Should have created exactly one heartbeat schedule
    expect(await agent.getHeartbeatScheduleCount()).toBe(1);

    // Verify the schedule properties
    const schedule = await agent.getHeartbeatSchedule();
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
    expect(await agent.getHeartbeatScheduleCount()).toBe(1);

    await agent.stopKeepAlive();
    expect(await agent.getHeartbeatScheduleCount()).toBe(0);
  });

  it("should be idempotent when disposed multiple times", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "double-dispose"
    );

    await agent.startKeepAlive();
    expect(await agent.getHeartbeatScheduleCount()).toBe(1);

    // First dispose removes the schedule
    await agent.stopKeepAlive();
    expect(await agent.getHeartbeatScheduleCount()).toBe(0);

    // Second dispose is a no-op (doesn't throw)
    await agent.stopKeepAlive();
    expect(await agent.getHeartbeatScheduleCount()).toBe(0);
  });

  it("should support multiple concurrent keepAlive calls", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "multiple-keepalive"
    );

    await agent.startKeepAlive();
    await agent.startKeepAlive();

    // Each call creates its own schedule
    expect(await agent.getHeartbeatScheduleCount()).toBe(2);
    expect(await agent.getKeepAliveCallCount()).toBe(2);

    // Stopping only cancels the latest disposer
    await agent.stopKeepAlive();
    expect(await agent.getHeartbeatScheduleCount()).toBe(1);
    expect(await agent.getKeepAliveCallCount()).toBe(1);
  });
});
