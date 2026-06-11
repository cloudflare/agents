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

  it("strips needsApproval AI SDK tools from the sandbox", async () => {
    const agent = await freshAgent();

    // Not advertised in the sandbox type surface…
    const types = await agent.toolsConnectorTypes();
    expect(types).toContain("add");
    expect(types).not.toContain("launchMissiles");

    // …and not callable from the sandbox.
    const out = await agent.runExecute(
      `async () => await tools.launchMissiles({})`
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/launchMissiles/);
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
