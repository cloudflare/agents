/**
 * Integration tests for the unified execute tool (Stage 3b): a real Think
 * agent, a real codemode runtime facet, and a real DynamicWorkerExecutor
 * sandbox. Connector calls travel over genuine Workers RPC.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

async function freshAgent(name?: string) {
  return getAgentByName(env.ThinkExecuteToolAgent, name ?? crypto.randomUUID());
}

describe("Computer workspace state connector", () => {
  it("preserves state.* for the backend-free Computer provider", async () => {
    const agent = await getAgentByName(
      env.ThinkComputerWorkspaceExecuteAgent,
      crypto.randomUUID()
    );

    const stateResult = await agent.runWorkspaceExecute(`async () => {
        await state.writeFile({ path: "/notes.txt", content: "hello" });
        await state.replaceInFile({
          path: "/notes.txt",
          search: "hello",
          replacement: "updated"
        });
        const file = await state.readFile({ path: "/notes.txt" });
        const listing = await state.glob({ pattern: "**/*.txt" });
        return file === "updated" && listing.includes("/notes.txt");
      }`);
    expect(stateResult).toMatchObject({ status: "completed", result: true });

    await expect(
      agent.runExplicitWorkspaceExecute(`async () => {
        return await state.readFile({ path: "/notes.txt" });
      }`)
    ).resolves.toMatchObject({ status: "completed", result: "updated" });
  });

  it("re-executes state reads without repeating writes after approval", async () => {
    const agent = await getAgentByName(
      env.ThinkComputerWorkspaceExecuteAgent,
      crypto.randomUUID()
    );

    const paused = await agent.runWorkspaceReplay(`async () => {
      await state.writeFile({ path: "/replay.txt", content: "initial" });
      const before = await state.readFile({ path: "/replay.txt" });
      await tools.checkpoint({});
      const after = await state.readFile({ path: "/replay.txt" });
      return before === "external" && after === "external";
    }`);
    expect(paused).toMatchObject({ status: "paused" });
    if (!paused.executionId) throw new Error("Missing paused execution id");

    await agent.writeWorkspaceFile("/replay.txt", "external");
    await expect(
      agent.approveWorkspaceReplay(paused.executionId)
    ).resolves.toMatchObject({ status: "completed", result: true });
  });
});

describe("Computer Bash workspace", () => {
  it("runs turn-level bash against the durable Computer filesystem", async () => {
    const agent = await getAgentByName(
      env.ThinkBashWorkspaceAgent,
      crypto.randomUUID()
    );

    await expect(
      agent.runBash("printf 'from shell' > /workspace/result.txt")
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(agent.readFile("/workspace/result.txt")).resolves.toBe(
      "from shell"
    );
  });

  it("keeps codemode on state.* without adding workspace.bash", async () => {
    const agent = await getAgentByName(
      env.ThinkBashWorkspaceAgent,
      crypto.randomUUID()
    );

    await agent.runBash("printf codemode > /workspace/codemode.txt");
    await expect(
      agent.runCodemodeState(`async () => {
        const file = await state.readFile({ path: "/workspace/codemode.txt" });
        return file === "codemode" && typeof workspace === "undefined";
      }`)
    ).resolves.toMatchObject({ status: "completed", result: true });
  });
});

describe("execute tool on the codemode runtime", () => {
  it("runs sandbox code against tools.* (ToolSetConnector)", async () => {
    const agent = await freshAgent();
    const out = await agent.runExecute(
      `async () => {
        const { sum } = await tools.add({ a: 2, b: 3 });
        return sum;
      }`
    );
    expect(out.status).toBe("completed");
    expect(out.result).toBe(5);
  });

  it("runs sandbox code against state.* with object args", async () => {
    const agent = await freshAgent();
    const out = await agent.runExecute(
      `async () => {
        await state.writeFile({ path: "/notes.txt", content: "hello" });
        await state.replaceInFile({
          path: "/notes.txt",
          search: "hello",
          replacement: "bye"
        });
        return await state.readFile({ path: "/notes.txt" });
      }`
    );
    expect(out.status).toBe("completed");
    expect(out.result).toBe("bye");
  });

  it("maps needsApproval AI SDK tools to requiresApproval — the call pauses durably", async () => {
    const agent = await freshAgent();

    // Advertised in the sandbox type surface like any other tool…
    const types = await agent.toolsConnectorTypes();
    expect(types).toContain("add");
    expect(types).toContain("launchMissiles");

    // …and calling it pauses the run for approval instead of executing.
    const out = await agent.runExecute(
      `async () => await tools.launchMissiles({})`
    );
    expect(out.status).toBe("paused");
    expect(out.executionId).toBeTruthy();
    expect(out.pending?.[0]?.connector).toBe("tools");
    expect(out.pending?.[0]?.method).toBe("launchMissiles");
  });

  it("surfaces sandbox errors as error outcomes with an executionId", async () => {
    const agent = await freshAgent();
    const out = await agent.runExecute(
      `async () => { throw new Error("kaboom"); }`
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/kaboom/);
    expect(out.executionId).toBeTruthy();
  });

  it("one-liner: createExecuteTool(agent) defaults state from the workspace and records on this.codemode", async () => {
    const agent = await freshAgent();
    const out = await agent.runOneLiner(
      `async () => {
        await state.writeFile({ path: "/one-liner.txt", content: "default state" });
        return await state.readFile({ path: "/one-liner.txt" });
      }`
    );
    expect(out.status).toBe("completed");
    expect(out.result).toBe("default state");

    // createExecuteRuntime(agent) assigned the handle to agent.codemode —
    // the audit trail is reachable from agent code (callables, hooks).
    const statuses = await agent.codemodeExecutionStatuses();
    expect(statuses).toContain("completed");
  });

  it("shares one durable history across explicit and one-liner runtimes (same name)", async () => {
    const agent = await freshAgent();
    await agent.runExecute(`async () => 1`);
    await agent.runOneLiner(`async () => 2`);
    const statuses = await agent.codemodeExecutionStatuses();
    expect(
      statuses.filter((s) => s === "completed").length
    ).toBeGreaterThanOrEqual(2);
  });
});
