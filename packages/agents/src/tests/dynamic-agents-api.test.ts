import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";

function uniqueName() {
  return `dynamic-agents-api-test-${Math.random().toString(36).slice(2)}`;
}

// The `this.dynamicAgents` facade is the new public surface over the
// same machinery the deprecated `subAgent()`/`hasSubAgent()`/... methods
// use. These tests pin that both names observe the same child.
describe("dynamicAgents facade", () => {
  it("get() spawns a child that the legacy subAgent() API also sees", async () => {
    const agent = await getAgentByName(env.TestSubAgentParent, uniqueName());
    const childName = "facade-child";

    expect((await agent.dynamicAgentsHas(childName)).facade).toBe(false);

    const value = await agent.dynamicAgentsIncrement(childName, "k");
    expect(value).toBe(1);

    // Same storage through the deprecated path.
    const legacyValue = await agent.subAgentIncrement(childName, "k");
    expect(legacyValue).toBe(2);

    const has = await agent.dynamicAgentsHas(childName);
    expect(has).toEqual({ facade: true, legacy: true });
  });

  it("list() mirrors listSubAgents()", async () => {
    const agent = await getAgentByName(env.TestSubAgentParent, uniqueName());
    await agent.dynamicAgentsIncrement("list-a", "k");
    await agent.dynamicAgentsIncrement("list-b", "k");

    const { facade, legacy } = await agent.dynamicAgentsListNames();
    expect(facade).toEqual(["list-a", "list-b"]);
    expect(legacy).toEqual(facade);
  });

  it("abort() preserves storage; the next get() restarts the child", async () => {
    const agent = await getAgentByName(env.TestSubAgentParent, uniqueName());
    const childName = "facade-abort";

    await agent.dynamicAgentsIncrement(childName, "k");
    await agent.dynamicAgentsAbort(childName);

    // Restarted child still has its SQLite row.
    const value = await agent.dynamicAgentsIncrement(childName, "k");
    expect(value).toBe(2);
  });

  it("delete() wipes storage and the registry row for both APIs", async () => {
    const agent = await getAgentByName(env.TestSubAgentParent, uniqueName());
    const childName = "facade-delete";

    await agent.dynamicAgentsIncrement(childName, "k");
    await agent.dynamicAgentsDelete(childName);

    expect(await agent.dynamicAgentsHas(childName)).toEqual({
      facade: false,
      legacy: false
    });

    // Respawn starts from empty storage.
    const value = await agent.dynamicAgentsIncrement(childName, "k");
    expect(value).toBe(1);
  });
});
