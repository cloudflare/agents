import { env } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { AgentThinkPromptTestAgent } from "./worker";

async function freshPromptAgent(name: string) {
  return getServerByName(
    env.AgentThinkPromptTestAgent as unknown as DurableObjectNamespace<AgentThinkPromptTestAgent>,
    name
  );
}

describe("agent-think prompt context", () => {
  it("assembles the operating contract and skills catalog as context blocks", async () => {
    const agent = await freshPromptAgent("prompt-context");

    const prompt = await agent.getFrozenPrompt();

    expect(prompt).toContain(
      "AGENT-THINK (Run identity, user instruction, and operating contract.) [readonly]"
    );
    expect(prompt).toContain("You are working on issue #1871");
    expect(prompt).toContain("Open a focused fix PR.");
    expect(prompt).toContain("THINK_SKILLS");
    expect(prompt).toContain("prompt-test");
  });

  it("refreshes the frozen context for a later dispatch", async () => {
    const agent = await freshPromptAgent("prompt-refresh");
    await agent.getFrozenPrompt();

    await agent.setInstruction("Use the newest instruction.");

    const prompt = await agent.getFrozenPrompt();
    expect(prompt).toContain("Use the newest instruction.");
    expect(prompt).not.toContain("Open a focused fix PR.");
  });
});
