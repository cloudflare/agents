import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { CommandCenterAgent } from "../src/command-center";

describe("agent-think reliability", () => {
  it("records terminal command-center state through the real DO", async () => {
    const session = `reliability-${crypto.randomUUID()}`;
    const commandCenter = await getAgentByName<Env, CommandCenterAgent>(
      env.CommandCenter,
      session
    );
    await commandCenter.recordDispatch({
      session,
      repo: "cloudflare/agents",
      issueNumber: 1,
      instruction: "test"
    });
    await commandCenter.recordTurn({
      session,
      outcome: "error",
      error: "recovery exhausted"
    });

    expect((await commandCenter.getSnapshot()).threads[session]).toMatchObject({
      status: "error",
      lastError: "recovery exhausted"
    });
  });
});
