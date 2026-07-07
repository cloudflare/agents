import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { CommandCenterAgent } from "../src/command-center";
import { WarmPool } from "../src/warm-pool";

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

  it("advances an existing alarm when the refresh cadence shrinks", async () => {
    const id = env.WarmPool.idFromName(`config-${crypto.randomUUID()}`);
    const stub = env.WarmPool.get(id);
    const before = Date.now();
    await stub.configure({ refreshInterval: 100, assignmentIdleTtl: 1_000 });

    await runInDurableObject(stub, async (_pool: WarmPool, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm as number).toBeLessThanOrEqual(before + 1_000);
    });
  });
});
