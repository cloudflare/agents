import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkMcpToolMaterializationAgent, name);
}

describe("Think MCP tool materialization", () => {
  it("skips automatic AI tool conversion in transport-only mode while preserving raw connector calls", async () => {
    const agent = await freshAgent(`transport-only-${crypto.randomUUID()}`);

    const result = await agent.runTransportOnlyMaterializationTurn();

    expect(result).toEqual({
      status: "completed",
      getAIToolsCalls: 0,
      waitForConnectionsCalls: 1,
      mcpToolCountBeforeTurn: 0,
      rawConnectorResult: {
        name: "bulk_tool_0",
        arguments: { value: "raw" }
      }
    });
  });

  it("automatically exposes MCP tools by default for compatibility", async () => {
    const agent = await freshAgent(`default-${crypto.randomUUID()}`);

    const result = await agent.runDefaultMaterializationTurn();

    expect(result.status).toBe("completed");
    expect(result.getAIToolsCalls).toBe(1);
    expect(result.waitForConnectionsCalls).toBe(1);
    expect(result.mcpToolCountBeforeTurn).toBe(313);
    expect(result.rawConnectorResult).toEqual({
      name: "bulk_tool_0",
      arguments: { value: "raw" }
    });
  });
});
