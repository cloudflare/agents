import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
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
        const wake = () =>
          state.storage.sql
            .exec<{ time: number }>(
              "SELECT time FROM cf_agents_jobs WHERE id = 'task:p'"
            )
            .toArray()[0]?.time;
        // Struck: its deadline is the short wait, not the claim's, and its
        // wake job carries it.
        await until(
          () =>
            row().next_at >= before + 30_000 &&
            row().next_at < before + 60_000 &&
            wake() === row().next_at
        );
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

  it("runs a struck run at once on the next start, without the short wait", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    const row = (state: DurableObjectState) =>
      state.storage.sql
        .exec<{ status: string; generation: string | null; next_at: number }>(
          "SELECT status, generation, next_at FROM cf_agents_task_runs WHERE run_id = 'p'"
        )
        .one();
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        instance.platformFailures = 1;
        await instance.tasks.run("flakyPlatform" as never, undefined as never, {
          runId: "p"
        });
        const before = Date.now();
        await until(
          () =>
            row(state).next_at >= before + 30_000 &&
            row(state).next_at < before + 60_000
        );
      }
    );
    // The reset: the wait was for an isolate that lives on.
    await evictDurableObject(stub);
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        const started = Date.now();
        await instance.lifecycle.start();
        expect(row(state).next_at).toBeLessThanOrEqual(Date.now());
        const { time } = state.storage.sql
          .exec<{ time: number }>(
            "SELECT time FROM cf_agents_jobs WHERE id = 'task:p'"
          )
          .one();
        expect(time).toBeLessThan(started + 30_000);
        await instance.lifecycle.alarm();
        await until(
          async () => (await instance.tasks.get("p"))?.status === "completed"
        );
      }
    );
  });
});
