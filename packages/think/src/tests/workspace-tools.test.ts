import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { getWorkspace, type WorkspaceHandle } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";
import type { ThinkWorkspaceToolsAgent } from "./agents/workspace-tools";

const FILE_TOOLS = ["delete", "edit", "find", "grep", "ls", "read", "write"];

async function freshAgent() {
  return getAgentByName(
    env.ThinkWorkspaceToolsAgent as unknown as DurableObjectNamespace<ThinkWorkspaceToolsAgent>,
    `workspace-tools-${crypto.randomUUID()}`
  );
}

describe("Think workspace tools", () => {
  it("adds the file tools, and no exec, to a default agent", async () => {
    const agent = await freshAgent();
    const { toolNames, system } = await agent.captureTurn();
    expect(toolNames).toEqual(expect.arrayContaining(FILE_TOOLS));
    expect(toolNames).not.toContain("exec");
    expect(system).toContain(
      "You can inspect and edit the agent workspace using the available file tools."
    );
  });

  it("omits every workspace tool when workspaceTools is false", async () => {
    const agent = await freshAgent();
    await agent.disableWorkspaceTools();
    const { toolNames, system } = await agent.captureTurn();
    for (const name of [...FILE_TOOLS, "exec"]) {
      expect(toolNames).not.toContain(name);
    }
    expect(system).not.toContain("agent workspace");
  });

  it("writes and reads files through the tools", async () => {
    const agent = await freshAgent();
    await agent.captureTurn();
    await agent.callTool("write", {
      path: "/workspace/notes/today.md",
      content: "ship it\n"
    });
    const read = JSON.parse(
      await agent.callTool("read", { path: "/workspace/notes/today.md" })
    );
    expect(JSON.stringify(read)).toContain("ship it");
  });

  it("adds exec when the Workspace has a backend, with the configured description", async () => {
    const agent = await freshAgent();
    await agent.addJavaScriptBackend("Try this first.");
    const { toolNames } = await agent.captureTurn();
    expect(toolNames).toContain("exec");
    expect(await agent.toolDescription("exec")).toContain("Try this first.");
  });

  it("runs code on the Workspace's backend through exec", async () => {
    const agent = await freshAgent();
    await agent.addJavaScriptBackend();
    await agent.captureTurn();
    const output = await agent.callTool("exec", {
      command: "export default async function () { return 6 * 7; }"
    });
    expect(output).toContain("42");
  });

  it("hands its Workspace to getWorkspace(stub)", async () => {
    const agent = await freshAgent();
    // SAFETY: Think implements `__getWorkspaceStub()`. The DO stub types its
    // result as `Stub<WorkspaceStub>`, which TypeScript cannot relate to
    // WorkspaceHandle's `WorkspaceStub`.
    using workspace = await getWorkspace(agent as unknown as WorkspaceHandle);
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile(
      "/workspace/from-outside.txt",
      new TextEncoder().encode("hello")
    );

    await agent.captureTurn();
    const read = await agent.callTool("read", {
      path: "/workspace/from-outside.txt"
    });
    expect(read).toContain("hello");
  });
});
