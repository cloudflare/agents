import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  deliveryDefinition,
  registerDeliverySink,
  releaseDelivery,
  sendDelivery
} from "../../internal/delivery";
import type { Tasks } from "../../tasks/tasks";
import { seedTaskRun, type TaskHarnessObject } from "../capabilities/tasks";

/** The harness's Tasks as a host's untyped one, as deliveries take it. */
function tasksOf(instance: TaskHarnessObject): Tasks {
  return instance.tasks as unknown as Tasks;
}

type RunRow = {
  run_id: string;
  status: string;
  wait_reason: string | null;
  next_at: number | null;
  attempt: number;
};

function runs(storage: DurableObjectStorage): RunRow[] {
  return storage.sql
    .exec<RunRow>(
      "SELECT run_id, status, wait_reason, next_at, attempt FROM cf_agents_task_runs"
    )
    .toArray();
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
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
        const payloads: string[] = [];
        let failures = 1;
        registerDeliverySink<{ text: string }>(tasksOf(instance), "flaky", {
          deliver: (payload) => {
            payloads.push(payload.text);
            if (failures-- > 0) throw new Error("down");
          }
        });
        const before = Date.now();
        await sendDelivery(tasksOf(instance), "flaky", "k1", { text: "hi" });
        const [waiting] = runs(state.storage);
        expect(waiting).toMatchObject({
          status: "pending",
          wait_reason: "retry",
          attempt: 1
        });
        // Equal jitter over [base / 2, base): 1 s to 2 s.
        expect(waiting.next_at).toBeGreaterThanOrEqual(before + 1_000);
        expect(waiting.next_at).toBeLessThan(Date.now() + 2_000);

        await until(() => runs(state.storage).length === 0);
        expect(payloads).toEqual(["hi", "hi"]);
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

  it("gives up on a failure past the window, reports it, and does not wait for the report", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const gaveUp: string[] = [];
      registerDeliverySink<null>(tasksOf(instance), "gone", {
        deliver: () => {
          // Text Tasks would read as a platform failure if it were thrown.
          throw new Error("Network connection lost.");
        },
        onGiveUp: (error) => {
          gaveUp.push(error.message);
          // A hook that never returns.
          return new Promise<never>(() => {});
        }
      });
      await sendDelivery(tasksOf(instance), "gone", "g", null, {
        sentAt: Date.now() - 13 * 60 * 60 * 1000,
        attempts: 4
      });
      await tasksOf(instance).runDue(deliveryDefinition("gone"));
      expect(instance.tasks.peek("g")).toBeUndefined();
      expect(gaveUp).toEqual([
        "Delivery g gave up after 5 attempts: Network connection lost."
      ]);
    });
  });

  it("backs off after a reset cut an attempt short, then delivers", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const payloads: string[] = [];
        registerDeliverySink<string>(tasksOf(instance), "cut", {
          deliver: (payload) => {
            payloads.push(payload);
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
        await instance.tasks.runDue(deliveryDefinition("cut"));
        // The lost attempt backs off: the sink has not run, the run waits.
        expect(payloads).toEqual([]);
        const [waiting] = runs(state.storage);
        expect(waiting).toMatchObject({
          status: "pending",
          wait_reason: "retry",
          attempt: 2
        });
        expect(waiting.next_at).toBeGreaterThan(Date.now());
        await until(() => runs(state.storage).length === 0);
        expect(payloads).toEqual(["owed"]);
      }
    );
  });

  it("backs off, and does not give up, when a reset cut short an attempt that started inside the window", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const gaveUp: string[] = [];
        const sends: unknown[] = [];
        registerDeliverySink<string>(tasksOf(instance), "late", {
          deliver: (payload) => {
            sends.push(payload);
          },
          onGiveUp: (error) => {
            gaveUp.push(error.message);
          }
        });
        // Accepted 13 h ago; its first attempt was lost; no send failed.
        await tasksOf(instance).importRun({
          runId: "late",
          definition: deliveryDefinition("late"),
          status: "running",
          attempt: 1,
          input: "result",
          retain: false,
          createdAt: Date.now() - 13 * 60 * 60 * 1000
        });
        await instance.tasks.onStart();
        await instance.tasks.runDue(deliveryDefinition("late"));
        // Backing off: nothing sent yet, nothing given up.
        expect(sends).toEqual([]);
        expect(gaveUp).toEqual([]);
        expect(runs(state.storage)).toMatchObject([
          { run_id: "late", status: "pending", wait_reason: "retry" }
        ]);
        // The next attempt sends once, and it lands.
        await until(() => runs(state.storage).length === 0);
        expect(sends).toEqual(["result"]);
        expect(gaveUp).toEqual([]);
      }
    );
  });

  it("gives up, and reports it, after three attempts in a row never reported back", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const calls: unknown[] = [];
      const gaveUp: string[] = [];
      registerDeliverySink<null>(tasksOf(instance), "poison", {
        deliver: (payload) => {
          calls.push(payload);
        },
        onGiveUp: (error) => {
          gaveUp.push(error.message);
        }
      });
      // Five attempts counted: two lost before attempt 4 ended, and attempt
      // 5 lost since. The next attempt finds the third loss in a row.
      await tasksOf(instance).importRun({
        runId: "p",
        definition: deliveryDefinition("poison"),
        status: "running",
        attempt: 5,
        input: null,
        retain: false,
        createdAt: Date.now(),
        checkpoint: { "__delivery:ended": 4, "__delivery:lost": 2 }
      });
      await instance.tasks.onStart();
      await instance.tasks.runDue(deliveryDefinition("poison"));
      await until(() => gaveUp.length === 1);
      expect(calls).toEqual([]);
      expect(gaveUp).toEqual([
        "Delivery p gave up after 6 attempts: 3 attempts in a row never reported back"
      ]);
      expect(instance.tasks.peek("p")).toBeUndefined();
    });
  });

  it("gives up, and reports it, before Tasks' attempt cap would end it silently", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: TaskHarnessObject) => {
      await instance.lifecycle.start();
      const gaveUp: string[] = [];
      registerDeliverySink<null>(tasksOf(instance), "long", {
        deliver: () => {
          throw new Error("down");
        },
        onGiveUp: (error) => {
          gaveUp.push(error.message);
        }
      });
      await sendDelivery(tasksOf(instance), "long", "l", null, {
        sentAt: Date.now(),
        attempts: 196
      });
      await tasksOf(instance).runDue(deliveryDefinition("long"));
      await until(() => gaveUp.length === 1);
      expect(gaveUp).toEqual(["Delivery l gave up after 197 attempts: down"]);
      expect(instance.tasks.peek("l")).toBeUndefined();
    });
  });

  it("starts a held delivery's give-up window when it is released", async () => {
    const stub = env.TaskHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(
      stub,
      async (instance: TaskHarnessObject, state) => {
        await instance.lifecycle.start();
        const gaveUp: string[] = [];
        registerDeliverySink<null>(tasksOf(instance), "held", {
          deliver: (_payload, attempt) => {
            if (attempt.checkpoint.get("go") === undefined) return "hold";
            throw new Error("down");
          },
          onGiveUp: (error) => {
            gaveUp.push(error.message);
          }
        });
        await sendDelivery(tasksOf(instance), "held", "h", null);
        // Held for 13 h before recovery released it.
        state.storage.sql.exec(
          "UPDATE cf_agents_task_runs SET created_at = ? WHERE run_id = 'h'",
          Date.now() - 13 * 60 * 60 * 1000
        );
        expect(await releaseDelivery(tasksOf(instance), "h", { go: 1 })).toBe(
          true
        );
        await tasksOf(instance).runDue(deliveryDefinition("held"));
        // Its first failed send backs off instead of giving up.
        expect(gaveUp).toEqual([]);
        expect(runs(state.storage)).toMatchObject([
          { run_id: "h", status: "pending", wait_reason: "retry" }
        ]);
      }
    );
  });
});
