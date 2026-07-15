/**
 * Ported from ORIGINAL Think:
 * - packages/think/src/tests/onstart-degraded.test.ts
 * - last original change: unknown
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `partyserver` and `agents/observability` imports to
 *   `./compat.js`.
 * - Re-pointed original fixture type imports to `./fixtures/index.js`.
 * - Added `@ts-nocheck` for original-style indexed assertions under the
 *   rebuild's stricter test tsconfig.
 */
// @ts-nocheck
import { env } from "cloudflare:workers";
import { getServerByName, subscribe } from "./compat.js";
import { describe, expect, it } from "vitest";
import type {
  OnStartDegradationForTest
} from "./fixtures/index.js";
import type { UIMessage } from "ai";

type TestChatResult = { done: boolean; error?: string };

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

      const degradations = await agent.getOnStartDegradationsForTest();
      expect(degradations).toHaveLength(1);
      expect(degradations[0].step).toBe("transcript-hydration");
      expect(degradations[0].error).toContain("SQLITE_NOMEM");
      expect(await agent.getHydrationReadsFailedForTest()).toBe(1);

      expect(await agent.getStoredMessages()).toEqual([]);
    });

    it("persistence keeps working and a later sync recovers the history", async () => {
      const agent = (await getServerByName(
        env.ThinkOnStartHydrationFailureAgent,
        uniqueName("hydration-fail-recover")
      )) as unknown as HydrationFailureStub;

      const degradations = await agent.getOnStartDegradationsForTest();
      expect(degradations.map((d) => d.step)).toEqual(["transcript-hydration"]);

      const result = await agent.testChat("are you alive?");
      expect(result.done).toBe(true);
      expect(result.error).toBeUndefined();

      const resynced = await agent.resyncForTest();
      expect(resynced.length).toBeGreaterThanOrEqual(2);
      expect(resynced.some((m) => m.role === "user")).toBe(true);
      expect(resynced.some((m) => m.role === "assistant")).toBe(true);

      const messages = await agent.getStoredMessages();
      expect(messages.map((m) => m.id)).toEqual(resynced.map((m) => m.id));
    });
  });
});
