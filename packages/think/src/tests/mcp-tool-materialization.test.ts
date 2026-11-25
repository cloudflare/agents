import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkMcpToolMaterializationAgent, name);
}

describe("Think MCP tool materialization", () => {
  it("skips automatic AI tool conversion while preserving MCP connector access", async () => {
    const agent = await freshAgent(`without-direct-mcp-${crypto.randomUUID()}`);

    const result = await agent.runWithoutDirectMcpTools();

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

  it("sends the MCP tools as getAITools() gives them, byte for byte, after the workspace's", async () => {
    const agent = await freshAgent(`bytes-${crypto.randomUUID()}`);
    const { turn, direct, order } = await agent.mcpToolRequests();
    const mcp = (JSON.parse(direct) as { name: string }[]).map((t) => t.name);
    expect(mcp).toHaveLength(313);
    expect(turn).toBe(direct);
    // MCP tools come after the workspace's tools, as Think merges them.
    expect(order.indexOf("read")).toBeLessThan(order.indexOf(mcp[0]));
    expect(order.slice(-mcp.length)).toEqual(mcp);
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
