import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

describe("Think Code Mode bash", () => {
  it("exposes MCP through the server namespace without direct MCP tools", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await expect(agent.runMcpBashTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["bash", "edit", "read", "write"],
      mcpToolCount: 313,
      getAIToolsCalls: 0,
      sawMcpResult: true
    });
  });

  it("exposes session tools under context without direct context tools", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await expect(agent.runContextBashTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["bash", "edit", "read", "write"],
      sawContextResult: true
    });
  });

  it("exposes skill tools under skills without direct skill tools", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await expect(agent.runSkillBashTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["bash", "edit", "read", "write"],
      sawSkillResult: true
    });
    await expect(agent.getSkillCatalogPrompt()).resolves.toContain(
      "skills.activate_skill({ name }) inside the built-in bash"
    );
  });

  it("exposes the durable filesystem under workspace", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await expect(agent.runWorkspaceBashTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["bash", "edit", "read", "write"],
      sawWorkspaceResult: true
    });
  });

  it("exposes loaded extension tools under extensions", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await expect(agent.runExtensionBashTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["bash", "edit", "read", "write"],
      sawExtensionResult: true
    });
  });

  it("keeps platform tools direct when the built-in bash is disabled", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    const names = await agent.captureDirectOptOutTools();
    expect(names).not.toContain("bash");
    expect(names).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "list",
        "find",
        "grep",
        "delete",
        "set_context",
        "activate_skill",
        "read_skill_resource",
        "test_extension_echo",
        "fetch_fixture"
      ])
    );
  });

  it("rebuilds the built-in bash runtime after losing the in-memory handle", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await agent.runWorkspaceBashTurn();
    await expect(agent.rebuildBuiltinBashRuntime()).resolves.toBe(true);
  });

  it("exposes configured fetch tools under fetch", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeBashAgent,
      crypto.randomUUID()
    );

    await expect(agent.runFetchBashTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["bash", "edit", "read", "write"],
      sawFetchResult: true
    });
  });
});
