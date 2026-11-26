import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents";

type Stub = {
  startDetachedWhileLaneBusyForTest(): Promise<string>;
  releaseHeldTurnForTest(): Promise<{ before: number; after: number }>;
};

describe("Think detached delivery and the chat lane", () => {
  it(
    "does not hold the alarm on a detached delivery that waits for a busy chat lane",
    { timeout: 40_000 },
    async () => {
      const stub = await getAgentByName(
        env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
        crypto.randomUUID()
      );
      const agent = stub as unknown as Stub;
      await agent.startDetachedWhileLaneBusyForTest();
      // The run's check delivers behind the lane; the alarm that runs it
      // returns all the same, so the lane's own jobs can run.
      const startedAt = Date.now();
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      // The delivery lands once the turn holding the lane ends.
      expect(await agent.releaseHeldTurnForTest()).toEqual({
        before: 0,
        after: 1
      });
    }
  );
});
