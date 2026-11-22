import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  turnCaller,
  type ChatLaneHarnessObject
} from "../capabilities/chat-lane";

function harness() {
  return env.ChatLaneHarnessObject.getByName(crypto.randomUUID());
}

describe("ChatLane", () => {
  it("runs turns one at a time, in order, in the context that queued them", async () => {
    await runInDurableObject(harness(), async (h: ChatLaneHarnessObject) => {
      const order: string[] = [];
      const gate = h.gate();
      const first = turnCaller.run("caller-a", () =>
        h.lane.enqueue("a", async () => {
          order.push(`a:${turnCaller.getStore()}`);
          await gate.promise;
          return 1;
        })
      );
      const second = turnCaller.run("caller-b", () =>
        h.lane.enqueue("b", async () => {
          order.push(`b:${turnCaller.getStore()}`);
          return 2;
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.lane.activeRequestId).toBe("a");
      expect(h.lane.queuedCount()).toBe(2);
      gate.open();
      expect(await first).toEqual({ status: "completed", value: 1 });
      expect(await second).toEqual({ status: "completed", value: 2 });
      expect(order).toEqual(["a:caller-a", "b:caller-b"]);
      await h.lane.waitForIdle();
      expect(h.lane.isActive).toBe(false);
      expect(h.lane.queuedCount()).toBe(0);
      // Nothing is kept once a turn's record ended.
      for (let i = 0; i < 100 && h.lane.inbox.list().length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.lane.inbox.list()).toEqual([]);
    });
  });

  it("a reset makes queued turns stale and lets the running one finish", async () => {
    await runInDurableObject(harness(), async (h: ChatLaneHarnessObject) => {
      const gate = h.gate();
      let ranQueued = false;
      const running = h.lane.enqueue("a", async () => {
        await gate.promise;
        return "done";
      });
      const queued = h.lane.enqueue("b", async () => {
        ranQueued = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = h.lane.generation;
      h.lane.reset();
      expect(h.lane.generation).toBe(before + 1);
      expect(await queued).toEqual({ status: "stale" });
      // A turn queued with the old generation after the reset is stale too.
      const late = h.lane.enqueue("c", async () => "late", {
        generation: before
      });
      gate.open();
      expect(await running).toEqual({ status: "completed", value: "done" });
      expect(await late).toEqual({ status: "stale" });
      expect(ranQueued).toBe(false);
      expect(await h.lane.enqueue("d", async () => "after")).toEqual({
        status: "completed",
        value: "after"
      });
    });
  });

  it("rejects the caller when its turn throws, and moves on", async () => {
    await runInDurableObject(harness(), async (h: ChatLaneHarnessObject) => {
      await expect(
        h.lane.enqueue("a", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      expect(await h.lane.enqueue("b", async () => 2)).toEqual({
        status: "completed",
        value: 2
      });
    });
  });

  it("hands a turn left by a reset to replay, with its stored data", async () => {
    const stub = harness();
    await runInDurableObject(stub, async (h: ChatLaneHarnessObject) => {
      const gate = h.gate();
      void h.lane
        .enqueue("a", () => gate.promise, { replay: { question: "q1" } })
        .catch(() => {});
      void h.lane
        .enqueue("b", async () => {}, { replay: { question: "q2" } })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (h: ChatLaneHarnessObject) => {
      await h.lane.inbox.wait("missing");
      for (let i = 0; i < 100 && h.replays.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(h.replays).toEqual([
        { requestId: "a", replay: { question: "q1" } },
        { requestId: "b", replay: { question: "q2" } }
      ]);
    });
  });
});
