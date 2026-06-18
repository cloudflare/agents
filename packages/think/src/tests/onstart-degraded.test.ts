import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import { subscribe } from "agents/observability";
import type {
  OnStartDegradationForTest,
  TestChatResult
} from "./agents/think-session";
import type { UIMessage } from "ai";

/**
 * onStart degradation (#1710).
 *
 * A throw out of `onStart` is terminal: partyserver resets its init state
 * and rethrows, so every wake — including platform alarm retries — re-runs
 * the failing onStart. A data-driven failure (e.g. SQLITE_NOMEM hydrating an
 * oversized transcript, a throwing getScheduledTasks()) would permanently
 * brick the DO and drive an unbounded alarm-retry loop. These tests verify
 * such failures degrade: the agent comes up, records the degradation, stays
 * functional, and recovers on the next safe-boundary sync.
 */

type ReconcileFailureStub = {
  getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]>;
  testChat(message: string): Promise<TestChatResult>;
  getStoredMessages(): Promise<UIMessage[]>;
};

type HydrationFailureStub = ReconcileFailureStub & {
  getHydrationReadsFailedForTest(): Promise<number>;
  resyncForTest(): Promise<UIMessage[]>;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("Think onStart degradation (#1710)", () => {
  describe("scheduled-task reconcile failure", () => {
    it("agent starts and serves despite getScheduledTasks() throwing", async () => {
      const agent = (await getServerByName(
        env.ThinkOnStartReconcileFailureAgent,
        uniqueName("reconcile-fail")
      )) as unknown as ReconcileFailureStub;

      // The first RPC triggers onStart. Before the fix this rejected with
      // "simulated getScheduledTasks failure" and the DO never came up.
      const degradations = await agent.getOnStartDegradationsForTest();
      expect(degradations).toHaveLength(1);
      expect(degradations[0].step).toBe("scheduled-task-reconcile");
      expect(degradations[0].error).toContain(
        "simulated getScheduledTasks failure"
      );
    });

    it("emits a chat:onstart:degraded observability event", async () => {
      const events: Array<{
        type: string;
        payload: { step?: string; error?: string };
      }> = [];
      const unsubscribe = subscribe("chat", (event) => {
        if (event.type === "chat:onstart:degraded") {
          events.push(
            event as unknown as {
              type: string;
              payload: { step?: string; error?: string };
            }
          );
        }
      });

      try {
        const agent = (await getServerByName(
          env.ThinkOnStartReconcileFailureAgent,
          uniqueName("reconcile-fail-event")
        )) as unknown as ReconcileFailureStub;
        await agent.getOnStartDegradationsForTest();

        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          step: "scheduled-task-reconcile"
        });
        expect(events[0].payload.error).toContain(
          "simulated getScheduledTasks failure"
        );
      } finally {
        unsubscribe();
      }
    });

    it("chat still works on the degraded agent", async () => {
      const agent = (await getServerByName(
        env.ThinkOnStartReconcileFailureAgent,
        uniqueName("reconcile-fail-chat")
      )) as unknown as ReconcileFailureStub;

      const result = await agent.testChat("hello");
      expect(result.done).toBe(true);
      expect(result.error).toBeUndefined();

      const messages = await agent.getStoredMessages();
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.at(-1)?.role).toBe("assistant");
    });
  });

  describe("transcript hydration failure (simulated SQLITE_NOMEM)", () => {
    it("agent starts with an empty in-memory view instead of bricking", async () => {
      const agent = (await getServerByName(
        env.ThinkOnStartHydrationFailureAgent,
        uniqueName("hydration-fail")
      )) as unknown as HydrationFailureStub;

      // The first RPC triggers onStart, whose hydration read throws.
      const degradations = await agent.getOnStartDegradationsForTest();
      expect(degradations).toHaveLength(1);
      expect(degradations[0].step).toBe("transcript-hydration");
      expect(degradations[0].error).toContain("SQLITE_NOMEM");
      expect(await agent.getHydrationReadsFailedForTest()).toBe(1);

      // Degraded view is empty, not an exception.
      expect(await agent.getStoredMessages()).toEqual([]);
    });

    it("persistence keeps working and a later sync recovers the history", async () => {
      const agent = (await getServerByName(
        env.ThinkOnStartHydrationFailureAgent,
        uniqueName("hydration-fail-recover")
      )) as unknown as HydrationFailureStub;

      // Boot degraded.
      const degradations = await agent.getOnStartDegradationsForTest();
      expect(degradations.map((d) => d.step)).toEqual(["transcript-hydration"]);

      // A turn after the degraded boot still persists messages.
      const result = await agent.testChat("are you alive?");
      expect(result.done).toBe(true);
      expect(result.error).toBeUndefined();

      // The next safe-boundary sync reads through to storage (the simulated
      // allocator pressure only affected the boot-time read) and the live
      // cache converges with the durable transcript.
      const resynced = await agent.resyncForTest();
      expect(resynced.length).toBeGreaterThanOrEqual(2);
      expect(resynced.some((m) => m.role === "user")).toBe(true);
      expect(resynced.some((m) => m.role === "assistant")).toBe(true);

      const messages = await agent.getStoredMessages();
      expect(messages.map((m) => m.id)).toEqual(resynced.map((m) => m.id));
    });
  });
});
