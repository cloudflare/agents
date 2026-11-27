import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TestChatAgent } from "./worker";

async function agent() {
  return getAgentByName(
    env.TestChatAgent as unknown as DurableObjectNamespace<TestChatAgent>,
    `agent-tool-host-${crypto.randomUUID()}`
  );
}

describe("an AIChatAgent agent-tool run behind other turns", () => {
  it("hands back its tail while it waits, and gives its output hook only its own turn", async () => {
    const result = await (await agent()).queuedAgentToolRunForTest();
    // Returned while queued: the parent's own deadlines apply.
    expect(result.tailWhileQueued).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.tailChunks).toBeGreaterThan(0);
    // Its input and its reply, not the reply of the turn ahead of it.
    expect(result.hookRoles).toEqual(["user", "assistant"]);
  });

  it("forgets the replies settled runs kept when the chat is cleared", async () => {
    const result = await (await agent()).clearedAgentToolRepliesForTest();
    expect(result.before).toBeGreaterThan(0);
    expect(result.after).toBe(0);
  });
});
