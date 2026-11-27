import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TestChatAgent } from "./worker";

describe("a turn that waits on an agent-tool child", () => {
  // The child's forwarded chunks count as the turn's own progress, so its
  // no-progress window does not run out while the child streams: at most
  // one credit per 5 s, as released.
  it("is credited with the child's progress, once per 5 s", async () => {
    const agent = await getAgentByName(
      env.TestChatAgent as unknown as DurableObjectNamespace<TestChatAgent>,
      `progress-credit-${crypto.randomUUID()}`
    );
    expect(await agent.progressCreditWhileTurnRunsForTest()).toBe(1);
  });
});
