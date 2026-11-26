import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { ThinkTestAgent } from "./agents";

type Stub = {
  reconcileDetachedWhileLaneBusyForTest(): Promise<{
    elapsedMs: number;
    deliveredBefore: number;
    deliveredAfter: number;
  }>;
};

describe("Think detached delivery and the chat lane", () => {
  it(
    "does not hold the reconcile tick on a delivery that waits for a busy chat lane",
    { timeout: 40_000 },
    async () => {
      const agent = (await getAgentByName(
        env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
        crypto.randomUUID()
      )) as unknown as Stub;
      const { elapsedMs, deliveredBefore, deliveredAfter } =
        await agent.reconcileDetachedWhileLaneBusyForTest();
      // The tick waited its bound, not for the turn holding the lane.
      expect(elapsedMs).toBeLessThan(8_000);
      expect(deliveredBefore).toBe(0);
      // The delivery went on by itself once the lane was free.
      expect(deliveredAfter).toBe(1);
    }
  );
});
