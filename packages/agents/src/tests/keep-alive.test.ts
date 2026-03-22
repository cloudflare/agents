import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { TestKeepAliveAgent } from "./agents/keep-alive";

describe("keepAlive", () => {
  it("should increment _keepAliveRefs when started", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "create-heartbeat"
    );

    expect(await getKeepAliveRefs(agent)).toBe(0);

    await agent.startKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);
  });

  it("should not create any schedule rows", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "no-schedule-rows"
    );

    await agent.startKeepAlive();

    const scheduleCount = (await agent.getScheduleCount()) as unknown as number;
    expect(scheduleCount).toBe(0);
  });

  it("should decrement refs when disposed", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "dispose-heartbeat"
    );

    await agent.startKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("should be idempotent when disposed multiple times", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "double-dispose"
    );

    await agent.startKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);

    // Second dispose is a no-op (doesn't go negative)
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("keepAliveWhile should return the function result and clean up", async () => {
    const agent = await getAgentByName(env.TestKeepAliveAgent, "while-success");

    expect(await getKeepAliveRefs(agent)).toBe(0);

    const result = await agent.runWithKeepAliveWhile();
    expect(result).toBe("completed");

    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("keepAliveWhile should clean up even when the function throws", async () => {
    const agent = await getAgentByName(env.TestKeepAliveAgent, "while-error");

    expect(await getKeepAliveRefs(agent)).toBe(0);

    const result = await agent.runWithKeepAliveWhileError();
    expect(result).toBe("caught");

    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("should support multiple concurrent keepAlive calls", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "multiple-keepalive"
    );

    await agent.startKeepAlive();
    await agent.startKeepAlive();

    expect(await getKeepAliveRefs(agent)).toBe(2);

    // Disposing one should decrement, not clear
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("refs should never go below zero", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "no-negative-refs"
    );

    // Dispose without ever starting
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);

    // Start once, dispose twice
    await agent.startKeepAlive();
    await agent.stopKeepAlive();
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });
});

async function getKeepAliveRefs(
  stub: DurableObjectStub<TestKeepAliveAgent>
): Promise<number> {
  return runInDurableObject(stub, (instance) => {
    return instance._keepAliveRefs;
  });
}
