import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Helper to extract task handle id from callable return
const getTaskId = (handle: unknown): string => (handle as { id: string }).id;

describe("task system", () => {
  describe("task lifecycle", () => {
    it("creates a task and returns a handle with id", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "lifecycle-create");
      const handle = await agent.startSimpleTask({ value: 42 });
      const id = getTaskId(handle);

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
    });

    it("transitions task from pending to completed with result", async () => {
      const agent = await getAgentByName(
        env.TestTaskAgent,
        "lifecycle-complete"
      );
      const handle = await agent.startSimpleTask({ value: 5 });
      const id = getTaskId(handle);

      await agent.waitForTask(id, 5000);

      const task = (await agent.getTaskById(id)) as {
        status: string;
        result: unknown;
      } | null;
      expect(task).not.toBeNull();
      expect(task!.status).toBe("completed");
      expect(task!.result).toEqual({ doubled: 10 });
    });

    it("marks task as failed when method throws", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "lifecycle-failed");
      const handle = await agent.startFailingTask();
      const id = getTaskId(handle);

      await agent.waitForTask(id, 5000);

      const task = (await agent.getTaskById(id)) as {
        status: string;
        error: string;
      } | null;
      expect(task).not.toBeNull();
      expect(task!.status).toBe("failed");
      expect(task!.error).toContain("intentional");
    });
  });

  describe("task cancellation", () => {
    it("cancels a running task", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "cancel-running");
      const handle = await agent.startSlowTask(10000);
      const id = getTaskId(handle);

      // Give it time to start
      await new Promise((r) => setTimeout(r, 100));

      const cancelled = await agent.cancelTaskById(id);
      expect(cancelled).toBe(true);

      await agent.waitForTask(id, 5000);

      const task = (await agent.getTaskById(id)) as { status: string } | null;
      expect(task!.status).toBe("aborted");
    });

    it("returns false when cancelling non-existent task", async () => {
      const agent = await getAgentByName(
        env.TestTaskAgent,
        "cancel-nonexistent"
      );
      const cancelled = await agent.cancelTaskById("does-not-exist");
      expect(cancelled).toBe(false);
    });
  });

  describe("task timeout", () => {
    it("aborts task when timeout exceeded", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "timeout-test");
      const handle = await agent.startTimeoutTask();
      const id = getTaskId(handle);

      await agent.waitForTask(id, 5000);

      const task = (await agent.getTaskById(id)) as {
        status: string;
        error: string;
      } | null;
      expect(task!.status).toBe("aborted");
      expect(task!.error).toContain("timed out");
    });
  });

  describe("progress and events", () => {
    it("tracks progress updates", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "progress-test");
      const handle = await agent.startProgressTask();
      const id = getTaskId(handle);

      await agent.waitForTask(id, 5000);

      const task = (await agent.getTaskById(id)) as { progress: number } | null;
      expect(task!.progress).toBe(100);
    });

    it("records emitted events", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "events-test");
      const handle = await agent.startEventTask();
      const id = getTaskId(handle);

      await agent.waitForTask(id, 5000);

      const task = (await agent.getTaskById(id)) as {
        events: Array<{ type: string }>;
      } | null;
      expect(task!.events.length).toBeGreaterThan(0);

      const phaseEvents = task!.events.filter((e) => e.type === "phase");
      expect(phaseEvents.length).toBe(2);
    });
  });

  describe("task listing and deletion", () => {
    it("lists all tasks", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "list-test");

      const h1 = await agent.startSimpleTask({ value: 1 });
      const h2 = await agent.startSimpleTask({ value: 2 });

      await agent.waitForTask(getTaskId(h1), 5000);
      await agent.waitForTask(getTaskId(h2), 5000);

      const tasks = (await agent.listAllTasks()) as Array<{ id: string }>;
      expect(tasks.length).toBeGreaterThanOrEqual(2);
    });

    it("filters tasks by status", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "filter-test");

      const handle = await agent.startSimpleTask({ value: 1 });
      const id = getTaskId(handle);
      await agent.waitForTask(id, 5000);

      const completed = (await agent.listTasksByStatus("completed")) as Array<{
        id: string;
      }>;
      const found = completed.some((t) => t.id === id);
      expect(found).toBe(true);
    });

    it("deletes a completed task", async () => {
      const agent = await getAgentByName(env.TestTaskAgent, "delete-test");

      const handle = await agent.startSimpleTask({ value: 1 });
      const id = getTaskId(handle);
      await agent.waitForTask(id, 5000);

      const deleted = await agent.deleteTaskById(id);
      expect(deleted).toBe(true);

      const task = await agent.getTaskById(id);
      expect(task).toBeNull();
    });
  });
});
