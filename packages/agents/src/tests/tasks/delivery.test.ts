import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deliveryDefinition,
  registerDeliverySink,
  sendDelivery,
  type DeliveryAttempt
} from "../../internal/delivery";
import type { Tasks } from "../../tasks/tasks";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

/** The harness's Tasks as a host's untyped one, as deliveries take it. */
function tasksOf(instance: TaskHarnessObject): Tasks {
  return instance.tasks as unknown as Tasks;
}

type Seen = Pick<DeliveryAttempt, "id" | "attempt" | "idempotencyKey">;

function openRuns(storage: DurableObjectStorage): Array<{
  run_id: string;
  status: string;
  wait_reason: string | null;
  next_at: number | null;
}> {
  return storage.sql
    .exec<{
      run_id: string;
      status: string;
      wait_reason: string | null;
      next_at: number | null;
    }>("SELECT run_id, status, wait_reason, next_at FROM cf_agents_task_runs")
    .toArray();
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("deliveries", () => {
  it("retries a failing sink with backoff until it acknowledges, then keeps nothing", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const seen: Seen[] = [];
        let failures = 2;
        registerDeliverySink<{ text: string }>(tasksOf(instance), "flaky", {
          retry: { baseDelayMs: 100 },
          deliver: (payload, attempt) => {
            seen.push({
              id: attempt.id,
              attempt: attempt.attempt,
              idempotencyKey: attempt.idempotencyKey
            });
            if (failures-- > 0) throw new Error(`down: ${payload.text}`);
          }
        });
        const before = Date.now();
        await sendDelivery(tasksOf(instance), "flaky", "k1", { text: "hi" });
        await until(() => seen.length === 1);
        await until(() => openRuns(state.storage)[0]?.status === "pending");
        const [waiting] = openRuns(state.storage);
        expect(waiting.wait_reason).toBe("retry");
        // Equal jitter over [base / 2, base).
        expect(waiting.next_at).toBeGreaterThanOrEqual(before + 50);
        expect(waiting.next_at).toBeLessThan(Date.now() + 100);

        await until(() => seen.length === 3);
        await until(() => openRuns(state.storage).length === 0);
        expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
        expect(new Set(seen.map((s) => s.idempotencyKey)).size).toBe(1);
        expect(seen.every((s) => s.id === "k1")).toBe(true);
      }
    );
  });

  it("joins a delivery that is still open instead of sending it twice", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const payloads: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      registerDeliverySink<string>(tasksOf(instance), "slow", {
        deliver: async (payload) => {
          payloads.push(payload);
          await gate;
        }
      });
      const first = sendDelivery(tasksOf(instance), "slow", "k", "first");
      await until(() => payloads.length === 1);
      await sendDelivery(tasksOf(instance), "slow", "k", "second");
      release();
      await first;
      expect(instance.tasks.peek("k")).toBeUndefined();
      expect(payloads).toEqual(["first"]);
    });
  });

  it("fails an attempt whose sink hangs past the attempt timeout, and tries again", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const attempts: number[] = [];
      let aborted = false;
      registerDeliverySink<null>(tasksOf(instance), "hung", {
        retry: { baseDelayMs: 50, attemptTimeoutMs: 100 },
        deliver: (_payload, attempt) => {
          attempts.push(attempt.attempt);
          if (attempt.attempt > 1) return;
          attempt.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise<never>(() => {});
        }
      });
      await sendDelivery(tasksOf(instance), "hung", "h", null);
      await until(() => instance.tasks.peek("h") === undefined);
      expect(attempts).toEqual([1, 2]);
      expect(aborted).toBe(true);
    });
  });

  it("gives up once the next attempt would start past the window, and reports it", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      registerDeliverySink<null>(tasksOf(instance), "gone", {
        retry: { baseDelayMs: 100, giveUpAfterMs: 250 },
        deliver: () => {
          throw new Error("unreachable");
        }
      });
      await tasksOf(instance).run(deliveryDefinition("gone"), null, {
        runId: "g"
      });
      await until(() => instance.tasks.peek("g")?.status === "error");
      const record = instance.tasks.peek("g");
      expect(record?.error?.message).toMatch(
        /^Delivery g gave up after \d+ attempts: unreachable$/
      );
      expect(record!.attempt).toBeGreaterThan(1);
      expect(instance.runErrors.some((e) => e.includes("gave up"))).toBe(true);
    });
  });

  it("delivers again after a reset cut an attempt short", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        registerDeliverySink<string>(tasksOf(instance), "cut", {
          deliver: (payload, attempt) => {
            (instance as unknown as { delivered: unknown[] }).delivered = [
              payload,
              attempt.attempt
            ];
          }
        });
        seedTaskRun(state.storage, {
          runId: "c",
          definition: deliveryDefinition("cut"),
          input: "owed",
          status: "running",
          generation: "dead-generation",
          attempt: 1,
          retain: false,
          nextAt: Date.now() + 60_000
        });
        await instance.tasks.onStart();
      }
    );
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await until(() => instance.tasks.peek("c") === undefined);
      expect(
        (instance as unknown as { delivered: unknown[] }).delivered
      ).toEqual(["owed", 2]);
    });
  });

  it("resumes a delivery an earlier version tried, keeping its window and backoff", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      registerDeliverySink<null>(tasksOf(instance), "old", {
        deliver: () => {
          throw new Error("still down");
        }
      });
      await sendDelivery(tasksOf(instance), "old", "o", null, {
        sentAt: Date.now() - 13 * 60 * 60 * 1000,
        attempts: 4
      });
      await tasksOf(instance).runDue(deliveryDefinition("old"));
      // Given up on its first attempt here (attempt 5); nothing is kept.
      expect(instance.tasks.peek("o")).toBeUndefined();
      expect(instance.runErrors).toContainEqual(
        expect.stringContaining("Delivery o gave up after 5 attempts")
      );
    });
  });
});
