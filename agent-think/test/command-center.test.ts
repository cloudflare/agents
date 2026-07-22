import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { CommandCenterAgent } from "../src/command-center";

async function commandCenter() {
  return getAgentByName<Env, CommandCenterAgent>(env.CommandCenter, "main");
}

describe("command-center recovery status", () => {
  it("reports recovering, resumed running, and the terminal outcome in order", async () => {
    const session = `recovery-status-${crypto.randomUUID()}`;
    const center = await commandCenter();
    await center.recordDispatch({
      session,
      repo: "cloudflare/agents",
      issueNumber: 1,
      instruction: "recover"
    });

    await center.recordRecovery({ session });
    expect((await center.getSnapshot()).threads[session]?.status).toBe(
      "recovering"
    );

    await center.recordRunning({ session });
    expect((await center.getSnapshot()).threads[session]?.status).toBe(
      "running"
    );

    await center.recordTurn({ session, outcome: "done" });
    expect((await center.getSnapshot()).threads[session]?.status).toBe("done");
  });
});
