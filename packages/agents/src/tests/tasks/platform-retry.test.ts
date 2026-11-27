import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TaskHarnessObject } from "../capabilities/tasks";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("Tasks after a transient platform failure", () => {
  it("strips the claim and replays the run after a short wait, not at its claim deadline", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        instance.platformFailures = 1;
        const before = Date.now();
        await instance.tasks.run("flakyPlatform" as never, undefined as never, {
          runId: "p"
        });
        const row = () =>
          state.storage.sql
            .exec<{
              status: string;
              generation: string | null;
              next_at: number;
            }>(
              "SELECT status, generation, next_at FROM cf_agents_task_runs WHERE run_id = 'p'"
            )
            .one();
        await until(() => row().generation === null);
        // Still `running` (replayed as interrupted), its claim stripped and
        // its deadline the short wait, mirrored by its wake job.
        expect(row().status).toBe("running");
        expect(row().next_at).toBeGreaterThanOrEqual(before + 30_000);
        expect(row().next_at).toBeLessThan(before + 60_000);
        const { time } = state.storage.sql
          .exec<{ time: number }>(
            "SELECT time FROM cf_agents_jobs WHERE id = 'task:p'"
          )
          .one();
        expect(time).toBe(row().next_at);

        // When the wait is over, its wake job runs it again through the
        // alarm and it completes.
        const due = Date.now() - 1;
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET next_at = ? WHERE run_id = 'p'",
          due
        );
        state.storage.sql.exec(
          "UPDATE cf_agents_jobs SET time = ? WHERE id = 'task:p'",
          due
        );
        await instance.lifecycle.alarm();
        await until(
          async () => (await instance.tasks.get("p"))?.status === "completed"
        );
        expect(await instance.tasks.get("p")).toMatchObject({
          status: "completed",
          result: "ok"
        });
      }
    );
  });
});
