import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ChatRecoveryTestAgent } from "./worker";

async function legacyAgent(
  lastClientTools: string | null,
  lastBody: string | null
) {
  const name = crypto.randomUUID();
  const agent = () =>
    getAgentByName(
      env.ChatRecoveryTestAgent as unknown as DurableObjectNamespace<ChatRecoveryTestAgent>,
      name
    );
  await (
    await agent()
  ).seedLegacyRequestContextForTest(lastClientTools, lastBody);
  await (await agent()).resetIsolateForTest().catch(() => {});
  return agent;
}

describe("AIChatAgent request context from an earlier release", () => {
  it("is read on a cold start, carried into the session value once, and the table dropped", async () => {
    const agent = await legacyAgent(
      JSON.stringify([{ name: "pick" }]),
      JSON.stringify({ theme: "dark" })
    );
    const state = await (await agent()).requestContextStateForTest();
    expect(state.clientTools).toEqual(["pick"]);
    expect(JSON.parse(state.body ?? "null")).toEqual({ theme: "dark" });
    expect(JSON.parse(state.stored ?? "null")).toEqual({
      clientTools: [{ name: "pick" }],
      body: { theme: "dark" }
    });
    expect(state.tableLeft).toBe(false);
  });

  it("drops the table even when the two rows together are over the row budget, so they cannot come back", async () => {
    const agent = await legacyAgent(
      JSON.stringify([{ name: "pick" }]),
      JSON.stringify({ big: "x".repeat(8_000_000) })
    );
    // One over the row budget is not kept, in storage or in memory: a
    // server turn reads the context when it starts, from storage.
    const carried = await (await agent()).requestContextStateForTest();
    expect(carried.clientTools).toBeNull();
    expect(carried.stored).toBeNull();
    expect(carried.tableLeft).toBe(false);
    await (await agent()).resetIsolateForTest().catch(() => {});
    const after = await (await agent()).requestContextStateForTest();
    expect(after.clientTools).toBeNull();
    expect(after.body).toBe("null");
  });

  it("drops the empty table an earlier release created when there was nothing to carry", async () => {
    const agent = await legacyAgent(null, null);
    const state = await (await agent()).requestContextStateForTest();
    expect(state.stored).toBeNull();
    expect(state.tableLeft).toBe(false);
  });
});
