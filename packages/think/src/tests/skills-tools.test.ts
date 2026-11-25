import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkSkillsToolsTestAgent } from "./agents/skills-tools";

async function agent(name: string) {
  return getAgentByName(
    env.ThinkSkillsToolsTestAgent as unknown as DurableObjectNamespace<ThinkSkillsToolsTestAgent>,
    name
  );
}

describe("Think skills", () => {
  it("sends the workspace and skill tools as they are given directly, in that order, byte for byte", async () => {
    const a = await agent(`skills-bytes-${crypto.randomUUID()}`);
    await a.writeSkill("map-reading", "How to read a map.");
    await a.turn("hello");
    const { turn, direct } = await a.toolRequests();
    expect(direct).toContain("activate_skill");
    expect(turn).toBe(direct);
  });

  it("sends a changed catalog once, as a reminder, without rewriting the system prompt", async () => {
    const a = await agent(`skills-remind-${crypto.randomUUID()}`);
    await a.writeSkill("map-reading", "How to read a map.");
    const first = await a.turn("hello");
    expect(first.system).toContain("- map-reading: How to read a map.");

    await a.writeSkill("knots", "How to tie knots.");
    const second = await a.turn("again");
    expect(second.system).toBe(first.system);
    expect(second.last).toContain("- knots: How to tie knots.");

    const third = await a.turn("thanks");
    expect(third.system).toBe(first.system);
    expect(third.last).not.toContain("knots");
  });
});
