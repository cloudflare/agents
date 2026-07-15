import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Tool } from "ai";
import { assertThinkCodeToolOwnership } from "../tools/code";

describe("Think Code Mode code tool", () => {
  it("rejects competing code execution surfaces", () => {
    const builtin = {} as Tool;
    expect(() =>
      assertThinkCodeToolOwnership({ code: {} as Tool }, builtin)
    ).toThrow("custom code tool");
    expect(() =>
      assertThinkCodeToolOwnership({ code: builtin, bash: {} as Tool }, builtin)
    ).toThrow("custom bash tool");
    expect(() =>
      assertThinkCodeToolOwnership({ code: builtin }, builtin)
    ).not.toThrow();
  });

  it("exposes MCP through the server namespace without direct MCP tools", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.runMcpCodeTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["code", "edit", "read", "write"],
      mcpToolCount: 313,
      getAIToolsCalls: 0,
      sawMcpResult: true
    });
  });

  it("exposes session tools under context without direct context tools", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.runContextCodeTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["code", "edit", "read", "write"],
      sawContextResult: true
    });
  });

  it("exposes skill tools under skills without direct skill tools", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.runSkillCodeTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["code", "edit", "read", "write"],
      sawSkillResult: true
    });
    await expect(agent.getSkillCatalogPrompt()).resolves.toContain(
      "skills.activate_skill({ name }) inside the built-in code tool"
    );
  });

  it("exposes the durable filesystem under workspace", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.runWorkspaceCodeTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["code", "edit", "read", "write"],
      sawWorkspaceResult: true
    });
  });

  it("exposes loaded extension tools under extensions", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.runExtensionCodeTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["code", "edit", "read", "write"],
      sawExtensionResult: true
    });
  });

  it("keeps platform tools direct when the built-in code tool is disabled", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeDisabledAgent,
      crypto.randomUUID()
    );

    const names = await agent.captureDirectTools();
    expect(names).not.toContain("code");
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

  it("rebuilds the built-in code runtime after losing the in-memory handle", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await agent.runWorkspaceCodeTurn();
    await expect(agent.rebuildBuiltinCodeRuntime()).resolves.toBe(true);
  });

  it("rejects a second application-owned Code Mode runtime", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.explicitRuntimeConflictError()).resolves.toContain(
      "Set codeTool = false"
    );
  });

  it("exposes configured fetch tools under fetch", async () => {
    const agent = await getAgentByName(
      env.ThinkCodemodeCodeAgent,
      crypto.randomUUID()
    );

    await expect(agent.runFetchCodeTurn()).resolves.toEqual({
      done: true,
      modelToolNames: ["code", "edit", "read", "write"],
      sawFetchResult: true
    });
  });
});
