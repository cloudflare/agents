import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Assistant } from "./worker";

type TestEnv = typeof env & {
  Assistant: DurableObjectNamespace<Assistant>;
};

function uniqueAssistantName(): string {
  return `agent-tools-${crypto.randomUUID()}`;
}

function subAgentPath(name: string, agentType: string, runId: string): string {
  return `/agents/assistant/${name}/sub/${agentType}/${runId}`;
}

async function getAssistant(name: string): Promise<Assistant> {
  return (await getAgentByName(
    (env as TestEnv).Assistant,
    name
  )) as unknown as Assistant;
}

describe("agents-as-tools example", () => {
  it("stores retained runs in the framework agent-tool registry", async () => {
    const assistant = await getAssistant(uniqueAssistantName());

    await assistant.testSeedAgentToolRun({
      runId: "research-run",
      parentToolCallId: "tool-call-1",
      agentType: "Researcher",
      inputPreview: "Workers AI routing",
      summary: "Routing summary"
    });

    expect(await assistant.testReadAgentToolRuns()).toEqual([
      expect.objectContaining({
        run_id: "research-run",
        parent_tool_call_id: "tool-call-1",
        agent_type: "Researcher",
        status: "completed",
        summary: "Routing summary",
        display_order: 0
      })
    ]);
    expect(
      await assistant.testHasAgentToolRun("Researcher", "research-run")
    ).toBe(true);
  });

  it("gates drill-in to retained agent-tool runs", async () => {
    const name = uniqueAssistantName();
    const assistant = await getAssistant(name);

    const missing = await exports.default.fetch(
      `http://example.com${subAgentPath(name, "Researcher", "missing")}`
    );
    expect(missing.status).toBe(404);

    await assistant.testSeedAgentToolRun({
      runId: "visible-run",
      agentType: "Researcher",
      inputPreview: "visible run"
    });

    expect(
      await assistant.testHasAgentToolRun("Researcher", "visible-run")
    ).toBe(true);
  });

  it("clears retained agent-tool runs through the example clear method", async () => {
    const assistant = await getAssistant(uniqueAssistantName());

    await assistant.testSeedAgentToolRun({
      runId: "planner-run",
      agentType: "Planner",
      inputPreview: "write a migration plan"
    });
    expect(await assistant.testReadAgentToolRuns()).toHaveLength(1);

    await assistant.clearHelperRuns();

    expect(await assistant.testReadAgentToolRuns()).toEqual([]);
    expect(await assistant.testHasAgentToolRun("Planner", "planner-run")).toBe(
      false
    );
  });
});
