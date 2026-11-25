import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TaskHarnessObject } from "../capabilities/tasks";

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

const harness = () => env.TaskHarnessObject.getByName(crypto.randomUUID());

describe("Tasks lane arrival policies", () => {
  it("latest skips the waiting runs that came with latest, keeps plain queued and running ones, and names them", async () => {
    await runInDurableObject(harness(), async (instance: TaskHarnessObject) => {
      const a = gate();
      instance.lanedGates.set("a", a.promise);
      const lane = { lane: "l" };
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", ...lane }
      );
      await until(() => instance.lanedStarted.includes("a"));
      await instance.tasks.run(
        "laned",
        { label: "b" },
        { runId: "b", ...lane }
      );
      // b queued plainly (a tool continuation, say); c came with latest.
      await instance.tasks.run(
        "laned",
        { label: "c" },
        { runId: "c", ...lane, policy: "latest" }
      );
      const receipt = await instance.tasks.run(
        "laned",
        { label: "d" },
        { runId: "d", ...lane, policy: "latest" }
      );
      expect(receipt).toMatchObject({ accepted: true, superseded: ["c"] });
      expect((await instance.tasks.get("b"))?.status).toBe("pending");
      expect((await instance.tasks.get("c"))?.status).toBe("skipped");
      expect((await instance.tasks.get("a"))?.status).toBe("running");
      a.open();
      await until(
        async () => (await instance.tasks.get("d"))?.status === "completed"
      );
      expect(instance.lanedStarted).toEqual(["a", "b", "d"]);
    });
  });

  it("drop stores nothing at a busy lane and runs at a free one", async () => {
    await runInDurableObject(harness(), async (instance: TaskHarnessObject) => {
      const a = gate();
      instance.lanedGates.set("a", a.promise);
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", lane: "l", policy: "drop" }
      );
      await until(() => instance.lanedStarted.includes("a"));
      const dropped = await instance.tasks.run(
        "laned",
        { label: "b" },
        { runId: "b", lane: "l", policy: "drop" }
      );
      expect(dropped).toMatchObject({ accepted: false, dropped: true });
      expect(await instance.tasks.get("b")).toBeNull();
      a.open();
      await until(
        async () => (await instance.tasks.get("a"))?.status === "completed"
      );
    });
  });

  it("two latest arrivals at once leave only the second waiting", async () => {
    await runInDurableObject(harness(), async (instance: TaskHarnessObject) => {
      const a = gate();
      instance.lanedGates.set("a", a.promise);
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", lane: "l" }
      );
      await until(() => instance.lanedStarted.includes("a"));
      await instance.tasks.run(
        "laned",
        { label: "b" },
        { runId: "b", lane: "l" }
      );
      const latest = { lane: "l", policy: "latest" } as const;
      await Promise.all([
        instance.tasks.run("laned", { label: "c" }, { runId: "c", ...latest }),
        instance.tasks.run("laned", { label: "d" }, { runId: "d", ...latest })
      ]);
      const open: string[] = [];
      for (const id of ["c", "d"]) {
        if ((await instance.tasks.get(id))?.status === "pending") open.push(id);
      }
      expect(open).toHaveLength(1);
      a.open();
      await until(
        async () => (await instance.tasks.get(open[0]!))?.status === "completed"
      );
      expect(instance.lanedStarted).toEqual(["a", "b", open[0]]);
    });
  });

  it("debounce starts at once at a free lane", async () => {
    await runInDurableObject(harness(), async (instance: TaskHarnessObject) => {
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", lane: "l", policy: { debounceMs: 60_000 } }
      );
      await until(
        async () => (await instance.tasks.get("a"))?.status === "completed"
      );
    });
  });

  it("at a busy lane, debounce keeps its quiet period past the head, and a later arrival replaces it", async () => {
    await runInDurableObject(
      harness(),
      async (instance: TaskHarnessObject, state) => {
        const a = gate();
        instance.lanedGates.set("a", a.promise);
        await instance.tasks.run(
          "laned",
          { label: "a" },
          { runId: "a", lane: "l" }
        );
        await until(() => instance.lanedStarted.includes("a"));
        const debounce = { lane: "l", policy: { debounceMs: 60_000 } } as const;
        const before = Date.now();
        await instance.tasks.run(
          "laned",
          { label: "b" },
          { runId: "b", ...debounce }
        );
        expect(await instance.tasks.get("b")).toMatchObject({
          status: "pending",
          waitReason: "debounce"
        });
        const receipt = await instance.tasks.run(
          "laned",
          { label: "c" },
          { runId: "c", ...debounce }
        );
        expect(receipt.superseded).toEqual(["b"]);
        a.open();
        await until(
          async () => (await instance.tasks.get("a"))?.status === "completed"
        );
        // c is the head now, but its quiet period has not passed.
        const { next_at } = state.storage.sql
          .exec<{ next_at: number }>(
            "SELECT next_at FROM cf_agents_task_runs WHERE run_id = 'c'"
          )
          .one();
        expect(next_at).toBeGreaterThanOrEqual(before + 60_000);
        expect((await instance.tasks.get("c"))?.status).toBe("pending");
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = 'task:c'")
            .toArray()
        ).toHaveLength(1);
      }
    );
  });

  it("a debounced run whose quiet period ends while queued starts as soon as the head ends", async () => {
    await runInDurableObject(harness(), async (instance: TaskHarnessObject) => {
      const a = gate();
      instance.lanedGates.set("a", a.promise);
      await instance.tasks.run(
        "laned",
        { label: "a" },
        { runId: "a", lane: "l" }
      );
      await until(() => instance.lanedStarted.includes("a"));
      await instance.tasks.run(
        "laned",
        { label: "b" },
        { runId: "b", lane: "l", policy: { debounceMs: 1 } }
      );
      // Its wake comes due while a still runs: it goes on waiting its turn.
      await until(async () => {
        await instance.tasks.runDue("laned");
        return (await instance.tasks.get("b"))?.waitReason === "overlap";
      });
      expect((await instance.tasks.get("b"))?.status).toBe("pending");
      a.open();
      await until(
        async () => (await instance.tasks.get("b"))?.status === "completed"
      );
    });
  });

  it("arms the wake of a debounced run whose caller holds its local", async () => {
    await runInDurableObject(
      harness(),
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        instance.lanedGates.set("a", gate().promise);
        await instance.tasks.run(
          "laned",
          { label: "a" },
          { runId: "a", lane: "l" }
        );
        await until(() => instance.lanedStarted.includes("a"));
        await instance.tasks.run(
          "laned",
          { label: "b" },
          { runId: "b", lane: "l", policy: { debounceMs: 60_000 }, local: "B" }
        );
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = 'task:b'")
            .toArray()
        ).toHaveLength(1);
      }
    );
  });

  it("refuses a policy without a lane", async () => {
    await runInDurableObject(harness(), async (instance: TaskHarnessObject) => {
      await expect(
        instance.tasks.run("laned", { label: "x" }, { policy: "latest" })
      ).rejects.toThrow(/needs a lane/);
    });
  });
});
