import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Approval, TaskFacetAgent, type TestTaskAgent } from "../agents/tasks";

/**
 * Cross-facet children: a run on one Agent spawns a child onto one of its
 * sub-agents. The child runs and journals on the facet; its settlement note,
 * the abort cascade and every verb addressed to the parent's Agent are
 * routed through the root's route index.
 */

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting; last value ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("cross-facet children", () => {
  it("spawns onto a sub-agent, lists the routed child and joins its result", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      await instance.dynamicAgents.get(TaskFacetAgent, "kid");
      const receipt = await instance.tasks.run("fanout", {
        owner: "kid",
        definition: "napper",
        input: { ms: 1_000 }
      });
      const childId = `${receipt.runId}:child`;
      const parked = await waitFor(
        () => instance.tasks.view(receipt.runId),
        (view) => view?.snapshot.state === "waiting"
      );
      expect(parked?.children).toEqual([
        {
          runId: childId,
          definition: "napper",
          background: false,
          ownerKey: instance.subAgentRouteAddress(TaskFacetAgent, "kid").key
        }
      ]);
      // A verb addressed to the root reaches the owner through its route row.
      const child = await instance.tasks.get(childId);
      expect(child?.definition).toBe("napper");
      expect(["running", "waiting"]).toContain(child?.state);
      const done = await waitFor(
        () => instance.tasks.get(receipt.runId),
        (snapshot) => snapshot?.state === "completed"
      );
      if (done?.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe('"rested"');
      expect((await instance.tasks.view(receipt.runId))?.children).toEqual([]);
      expect((await instance.tasks.get(childId))?.state).toBe("completed");
    });
  }, 20_000);

  it("cancels a routed child with its parent", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      await instance.dynamicAgents.get(TaskFacetAgent, "kid");
      const receipt = await instance.tasks.run("fanout", {
        owner: "kid",
        definition: "napper",
        input: { ms: 60_000 }
      });
      const childId = `${receipt.runId}:child`;
      await waitFor(
        () => instance.tasks.get(childId),
        (snapshot) => snapshot?.state === "waiting"
      );
      await waitFor(
        () => instance.tasks.get(receipt.runId),
        (snapshot) => snapshot?.state === "waiting"
      );
      expect(await instance.tasks.cancel(receipt.runId, "stop")).toBe(true);
      expect((await instance.tasks.get(receipt.runId))?.state).toBe(
        "cancelled"
      );
      const child = await waitFor(
        () => instance.tasks.get(childId),
        (snapshot) => snapshot?.state === "cancelled"
      );
      expect(child?.state).toBe("cancelled");
      // The route row is what the forwarded verbs above resolved through;
      // a second cancel is refused by the owner, not by a missing row.
      expect(await instance.tasks.cancel(childId)).toBe(false);
    });
  }, 20_000);

  it("answers a facet-hosted ask from the root while it holds no wake", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      await instance.dynamicAgents.get(TaskFacetAgent, "kid");
      const receipt = await instance.tasks.run("fanout", {
        owner: "kid",
        definition: "approver",
        input: null
      });
      const childId = `${receipt.runId}:child`;
      const asking = await waitFor(
        () => instance.tasks.view(childId),
        (view) =>
          view?.snapshot.state === "waiting" &&
          view.asks.some((ask) => ask.state === "open")
      );
      const askId = asking?.asks.find((ask) => ask.state === "open")?.askId;
      if (askId === undefined) throw new Error("unreachable");
      expect(await instance.tasks.answer(askId, Approval, "yes")).toEqual({
        accepted: true
      });
      const done = await waitFor(
        () => instance.tasks.get(receipt.runId),
        (snapshot) => snapshot?.state === "completed"
      );
      if (done?.state !== "completed") throw new Error("unreachable");
      expect(done.result).toBe('"yes"');
    });
  }, 20_000);

  it("relays a nested sub-agent's note back to its facet parent through the root", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      const facet = await instance.dynamicAgents.get(TaskFacetAgent, "a");
      const runId = await facet.fanOut({
        owner: "b",
        definition: "greet",
        input: { name: "nested" }
      });
      const done = await waitFor(
        () => facet.runOf(runId),
        (snapshot) => snapshot?.state === "completed"
      );
      if (done?.state !== "completed") throw new Error("unreachable");
      expect(done.result).toContain("hello nested");
      // The root indexes every routed run, two levels down included.
      const grandchild = await instance.tasks.get(`${runId}:child`);
      expect(grandchild?.state).toBe("completed");
      const parentView = await instance.tasks.view(runId);
      expect(parentView?.snapshot.state).toBe("completed");
      expect(parentView?.children).toEqual([]);
    });
  }, 20_000);

  it("refuses a spawn onto a sub-agent that does not exist", async () => {
    const stub = env.TestTaskAgent.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TestTaskAgent) => {
      const receipt = await instance.tasks.run("fanout", {
        owner: "nobody",
        definition: "greet",
        input: { name: "x" }
      });
      const failed = await waitFor(
        () => instance.tasks.get(receipt.runId),
        (snapshot) => snapshot?.state === "failed"
      );
      if (failed?.state !== "failed") throw new Error("unreachable");
      expect(failed.error.message).toContain("no Lifecycle at");
    });
  }, 20_000);
});
