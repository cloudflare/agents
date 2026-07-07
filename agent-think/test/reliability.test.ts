import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { ThinkAgent } from "../src/agent";
import type { CommandCenterAgent } from "../src/command-center";
import { WarmPool } from "../src/warm-pool";
import { classifyRunOutcome } from "../src/run-lifecycle";

describe("agent-think reliability", () => {
  it("classifies a final assistant report as done", () => {
    expect(
      classifyRunOutcome({ status: "completed", assistantText: "PR opened" })
    ).toEqual({ status: "done" });
  });

  it("classifies tool-only step exhaustion as an error", () => {
    expect(
      classifyRunOutcome({ status: "completed", assistantText: "" })
    ).toEqual({
      status: "error",
      error:
        "Turn ended without a final assistant report (step budget exhausted)."
    });
  });

  it("preserves an explicit provider error", () => {
    expect(
      classifyRunOutcome({
        status: "error",
        assistantText: "partial",
        error: "provider failed"
      })
    ).toEqual({ status: "error", error: "provider failed" });
  });

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

  it("does not externalize media without an attachment store", async () => {
    const id = env.ThinkAgent.idFromName(`media-${crypto.randomUUID()}`);
    const stub = env.ThinkAgent.get(id);
    await runInDurableObject(stub, (agent: ThinkAgent) => {
      expect(agent.mediaEviction).toEqual({ externalizeToWorkspace: false });
    });
  });
});
