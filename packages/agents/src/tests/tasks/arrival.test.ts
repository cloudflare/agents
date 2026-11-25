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
  it("latest skips the runs that have not started, keeps the running one, and names them", async () => {
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
      await instance.tasks.run(
        "laned",
        { label: "c" },
        { runId: "c", ...lane }
      );
      const receipt = await instance.tasks.run(
        "laned",
        { label: "d" },
        { runId: "d", ...lane, policy: "latest" }
      );
      expect(receipt).toMatchObject({ accepted: true, superseded: ["b", "c"] });
      expect((await instance.tasks.get("b"))?.status).toBe("skipped");
      expect((await instance.tasks.get("c"))?.status).toBe("skipped");
      expect((await instance.tasks.get("a"))?.status).toBe("running");
      a.open();
      await until(
        async () => (await instance.tasks.get("d"))?.status === "completed"
      );
      expect(instance.lanedStarted).toEqual(["a", "d"]);
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

  it("debounce waits its quiet period, and a later arrival replaces it", async () => {
    await runInDurableObject(
      harness(),
      async (instance: TaskHarnessObject, state) => {
        const before = Date.now();
        await instance.tasks.run(
          "laned",
          { label: "a" },
          { runId: "a", lane: "l", policy: { debounceMs: 60_000 } }
        );
        const { next_at } = state.storage.sql
          .exec<{ next_at: number }>(
            "SELECT next_at FROM cf_agents_task_runs WHERE run_id = 'a'"
          )
          .one();
        expect(next_at).toBeGreaterThanOrEqual(before + 60_000);
        // Its deadline is the quiet period, so nothing claims it before then.
        expect((await instance.tasks.get("a"))?.status).toBe("pending");
        const receipt = await instance.tasks.run(
          "laned",
          { label: "b" },
          { runId: "b", lane: "l", policy: { debounceMs: 60_000 } }
        );
        expect(receipt.superseded).toEqual(["a"]);
        expect((await instance.tasks.get("a"))?.status).toBe("skipped");
        expect((await instance.tasks.get("b"))?.status).toBe("pending");
      }
    );
  });

  it("arms the wake of a debounced run whose caller holds its local", async () => {
    await runInDurableObject(
      harness(),
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        await instance.tasks.run(
          "laned",
          { label: "a" },
          { runId: "a", lane: "l", policy: { debounceMs: 60_000 }, local: "A" }
        );
        expect(
          state.storage.sql
            .exec("SELECT id FROM cf_agents_jobs WHERE id = 'task:a'")
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
